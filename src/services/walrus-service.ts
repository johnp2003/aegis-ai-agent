import fs from "fs";
import path from "path";
import dns from "dns";
import { MongoClient, type Collection } from "mongodb";

// Ensure reliable SRV resolution across all ISPs & OS environments
try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch {}

export interface WalrusAuditPayload {
  timestamp: string;
  sender?: string;
  operations: string[];
  protocols: any[];
  simulation: any;
  riskScore: number;
  riskFlags: string[];
  recommendation: string;
  explanation: string;
  gonkaVerification?: any;
}

export interface WalrusPublishResult {
  blobId: string;
  blobObjectUri?: string;
  explorerUrl: string;
  aggregatorUrl: string;
  costMist?: number;
  epochs?: number;
}

export interface WalrusAuditRecord {
  walletAddress: string;
  blobId: string;
  timestamp: string;
  operations: string[];
  protocols: string[];
  riskScore: number;
  recommendation: "approve" | "caution" | "reject";
  truthScore: number;
  summary: string;
  explorerUrl: string;
  aggregatorUrl: string;
}

const AUDITS_FILE = path.join(process.cwd(), "data", "wallet_audits.json");

function loadAuditsFromDisk(): WalrusAuditRecord[] {
  try {
    if (fs.existsSync(AUDITS_FILE)) {
      const raw = fs.readFileSync(AUDITS_FILE, "utf-8");
      return JSON.parse(raw);
    }
  } catch (err: any) {
    console.warn("[walrus] Error reading wallet_audits.json:", err.message);
  }
  return [];
}

function persistAuditsToDisk(records: WalrusAuditRecord[]): void {
  try {
    const dir = path.dirname(AUDITS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(AUDITS_FILE, JSON.stringify(records, null, 2), "utf-8");
  } catch (err: any) {
    console.warn("[walrus] Error writing wallet_audits.json:", err.message);
  }
}

let auditStore: WalrusAuditRecord[] = loadAuditsFromDisk();

let mongoClient: MongoClient | null = null;
let mongoCollection: Collection<WalrusAuditRecord> | null = null;
let mongoConnecting = false;

export async function getMongoCollection(): Promise<Collection<WalrusAuditRecord> | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;

  if (mongoCollection) return mongoCollection;
  if (mongoConnecting) return null;

  try {
    mongoConnecting = true;
    if (!mongoClient) {
      mongoClient = new MongoClient(uri, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 8000,
      });
      await mongoClient.connect();
      console.log("🍃 [mongodb] Connected successfully to MongoDB Atlas (aegis cluster)");
    }
    const db = mongoClient.db("aegis");
    mongoCollection = db.collection<WalrusAuditRecord>("wallet_audits");
    mongoCollection.createIndex({ walletAddress: 1, timestamp: -1 }).catch(() => {});
    return mongoCollection;
  } catch (err: any) {
    console.warn(`🍃 [mongodb] Connection warning (${err.message}). Using local fallback.`);
    return null;
  } finally {
    mongoConnecting = false;
  }
}

export async function saveWalletAudit(record: WalrusAuditRecord): Promise<void> {
  // 1. Save to MongoDB Atlas
  try {
    const col = await getMongoCollection();
    if (col) {
      await col.updateOne(
        { blobId: record.blobId },
        { $set: record },
        { upsert: true }
      );
      console.log(
        `🍃 [mongodb] Audit record saved to MongoDB Atlas for ${record.walletAddress.slice(0, 10)}... (blob: ${record.blobId.slice(0, 10)}...)`
      );
    }
  } catch (err: any) {
    console.warn("[mongodb] Error saving to MongoDB:", err.message);
  }

  // 2. Local fallback sync
  auditStore.unshift(record);
  if (auditStore.length > 200) auditStore = auditStore.slice(0, 200);
  persistAuditsToDisk(auditStore);
}

export async function getWalletAudits(walletAddress: string): Promise<WalrusAuditRecord[]> {
  if (!walletAddress) return [];
  const normalized = walletAddress.toLowerCase();

  // Try MongoDB Atlas first
  try {
    const col = await getMongoCollection();
    if (col) {
      const records = await col
        .find({ walletAddress: new RegExp(`^${walletAddress}$`, "i") })
        .sort({ timestamp: -1 })
        .limit(100)
        .toArray();

      if (records && records.length > 0) {
        return records.map((r: any) => {
          const { _id, ...rest } = r;
          return rest as WalrusAuditRecord;
        });
      }
    }
  } catch (err: any) {
    console.warn("[mongodb] Query error, falling back to local store:", err.message);
  }

  // Local fallback
  auditStore = loadAuditsFromDisk();
  return auditStore.filter(
    (a) => a.walletAddress && a.walletAddress.toLowerCase() === normalized
  );
}

const DEFAULT_PUBLISHER = "https://publisher.walrus-testnet.walrus.space/v1/blobs";
const DEFAULT_AGGREGATOR = "https://aggregator.walrus-testnet.walrus.space/v1/blobs";
const DEFAULT_EXPLORER = "https://walruscan.com/testnet/blob";

export async function publishAuditToWalrus(
  payload: WalrusAuditPayload,
  timeoutMs = Number(process.env.WALRUS_TIMEOUT_MS) || 20000
): Promise<WalrusPublishResult | null> {
  const publisherUrl = process.env.WALRUS_PUBLISHER_URL ?? DEFAULT_PUBLISHER;
  const aggregatorBase = process.env.WALRUS_AGGREGATOR_URL ?? DEFAULT_AGGREGATOR;
  const explorerBase = process.env.WALRUS_EXPLORER_URL ?? DEFAULT_EXPLORER;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const serialized = JSON.stringify(payload, null, 2);
    const res = await fetch(`${publisherUrl}?epochs=1`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: serialized,
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`[walrus] Publisher returned ${res.status}: ${await res.text().catch(() => "")}`);
      return null;
    }

    const data: any = await res.json();
    const blobId =
      data.newlyCreated?.blobObject?.blobId ??
      data.alreadyCertified?.blobId ??
      data.blobId;

    if (!blobId) {
      console.warn("[walrus] No blobId in Walrus response", data);
      return null;
    }

    const costMist = data.newlyCreated?.cost ?? 0;
    const explorerUrl = `${explorerBase}/${blobId}`;
    const aggregatorUrl = `${aggregatorBase}/${blobId}`;

    console.log(`[walrus] Security audit dossier published to Walrus:`);
    console.log(`   Blob ID     : ${blobId}`);
    console.log(`   Explorer    : ${explorerUrl}`);
    console.log(`   Aggregator  : ${aggregatorUrl}`);

    // Index audit by wallet address for the frontend dashboard
    if (payload.sender) {
      const protocols = (payload.protocols || []).map((p) => p.name || p);
      const truthScore = Number(payload.gonkaVerification?.consensusTruthScore) || 75;
      saveWalletAudit({
        walletAddress: payload.sender,
        blobId,
        timestamp: payload.timestamp,
        operations: payload.operations || [],
        protocols,
        riskScore: payload.riskScore,
        recommendation: (payload.recommendation as any) || "approve",
        truthScore,
        summary: payload.explanation?.slice(0, 150) || "Transaction analyzed by AEGIS",
        explorerUrl,
        aggregatorUrl,
      });
    }

    return {
      blobId,
      explorerUrl,
      aggregatorUrl,
      costMist,
      epochs: 1,
    };
  } catch (err: any) {
    console.warn(`[walrus] Publishing to Walrus timed out or failed (${err.message}). Continuing gracefully.`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
