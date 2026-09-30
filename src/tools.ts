/**
 * The 6 deterministic tools of the Solana Copilot pipeline.
 * No LLM is called inside any tool — the LLM only runs once, in the
 * graph's explain node, over the structured facts these tools produce.
 *
 * dry_run and wallet_history delegate to the SolanaService abstraction (Solana RPC).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { tool } from "@langchain/core/tools";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { QdrantClient } from "@qdrant/js-client-rest";
import { Transaction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { z } from "zod";
import { createSolanaService, SolanaCluster } from "./services/index.js";
import { Protocol, SimResult } from "./state.js";

function parseBuffer(rawTx: string): Buffer {
  const trimmed = rawTx.trim();
  if (/^[A-Za-z0-9+/=]+$/.test(trimmed) && (trimmed.includes("+") || trimmed.includes("/") || trimmed.endsWith("="))) {
    return Buffer.from(trimmed, "base64");
  }
  try {
    const b58 = bs58.decode(trimmed);
    if (b58.length > 0) return Buffer.from(b58);
  } catch {
    // fallback
  }
  return Buffer.from(trimmed, "base64");
}

function decodeInstructionType(programId: string, data: Uint8Array | Buffer): string {
  // System Program
  if (programId === "11111111111111111111111111111111") {
    const type = data[0];
    if (type === 2) return "system:transfer";
    if (type === 0) return "system:createAccount";
    if (type === 1) return "system:assign";
    return "system:instruction";
  }
  // SPL Token & Token-2022
  if (
    programId === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" ||
    programId === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
  ) {
    const type = data[0];
    if (type === 3) return "token:transfer";
    if (type === 4) return "token:approve";
    if (type === 6) return "token:setAuthority";
    if (type === 7) return "token:mintTo";
    if (type === 9) return "token:closeAccount";
    if (type === 12) return "token:transferChecked";
    if (type === 13) return "token:approveChecked";
    return "token:instruction";
  }
  // Associated Token Program
  if (programId === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL") {
    return "ata:createAssociatedTokenAccount";
  }
  // Compute Budget
  if (programId === "ComputeBudget111111111111111111111111111111") {
    const type = data[0];
    if (type === 2) return "compute_budget:setLimit";
    if (type === 3) return "compute_budget:setPrice";
    return "compute_budget:instruction";
  }
  // Well-known DEX / DeFi
  if (programId === "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4") return "jupiter:swap";
  if (programId === "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8") return "raydium:swap";
  if (programId === "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK") return "raydium:clmm_swap";
  if (programId === "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc") return "orca:whirlpool_swap";
  if (programId === "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD") return "kamino:lending";
  if (programId === "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD") return "marinade:stake";

  return `program:${programId.slice(0, 8)}...`;
}

// ── Tool 1: parse_transaction ─────────────────────────────────────

export const parseTransaction = tool(
  async ({ rawTransaction, rawPtb }) => {
    const raw = rawTransaction || rawPtb;
    if (!raw) return { operations: [], programIds: [] };

    // Support JSON mock representation if passed
    if (raw.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.operations && (parsed.programIds || parsed.packageIds)) {
          return {
            operations: parsed.operations,
            programIds: parsed.programIds || parsed.packageIds,
          };
        }
      } catch {
        // proceed to buffer parsing
      }
    }

    try {
      const buf = parseBuffer(raw);

      // Try VersionedTransaction
      try {
        const vTx = VersionedTransaction.deserialize(buf);
        const staticKeys = vTx.message.staticAccountKeys.map((k) => k.toBase58());
        const operations: string[] = [];
        const programIdsSet = new Set<string>();

        for (const ix of vTx.message.compiledInstructions) {
          const programId = staticKeys[ix.programIdIndex];
          if (programId) {
            programIdsSet.add(programId);
            operations.push(decodeInstructionType(programId, ix.data));
          }
        }

        return {
          operations,
          programIds: Array.from(programIdsSet),
        };
      } catch {
        // Try legacy Transaction
        const lTx = Transaction.from(buf);
        const operations: string[] = [];
        const programIdsSet = new Set<string>();

        for (const ix of lTx.instructions) {
          const programId = ix.programId.toBase58();
          programIdsSet.add(programId);
          operations.push(decodeInstructionType(programId, ix.data));
        }

        return {
          operations,
          programIds: Array.from(programIdsSet),
        };
      }
    } catch (err) {
      console.error("parse_transaction error:", err instanceof Error ? err.message : err);
      return { operations: ["unknown_transaction"], programIds: [] };
    }
  },
  {
    name: "parse_transaction",
    description: "Parse raw Solana transaction bytes into operations and invoked program IDs",
    schema: z.object({
      rawTransaction: z.string().optional(),
      rawPtb: z.string().optional(),
    }),
  }
);

// Backward-compatibility alias
export const parsePtb = parseTransaction;

// ── Tool 2: dry_run ───────────────────────────────────────────────

export const dryRun = tool(
  async ({ rawTransaction, rawPtb, cluster }) => {
    const raw = rawTransaction || rawPtb;
    try {
      return await createSolanaService().simulate(raw, cluster as SolanaCluster);
    } catch (err) {
      const failed: SimResult = {
        status: "error",
        balanceChanges: [],
        objectChanges: [],
        gasUsed: { computationCost: "0", storageCost: "0" },
        events: [],
      };
      console.error("dry_run failed:", err instanceof Error ? err.message : err);
      return failed;
    }
  },
  {
    name: "dry_run",
    description:
      "Simulate Solana transaction execution. Returns status, compute units, balance changes, and logs.",
    schema: z.object({
      rawTransaction: z.string().optional(),
      rawPtb: z.string().optional(),
      cluster: z.enum(["devnet", "mainnet"]).optional(),
    }),
  }
);

// ── Tool 3: lookup_protocol ───────────────────────────────────────

const REGISTRY_CANDIDATES = [
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/protocols.json"),
  path.resolve(process.cwd(), "data/protocols.json"),
];

function loadRegistry(): Protocol[] {
  const registryPath = REGISTRY_CANDIDATES.find((p) => fs.existsSync(p));
  if (!registryPath) return [];
  return JSON.parse(fs.readFileSync(registryPath, "utf-8"));
}

export const lookupProtocol = tool(
  async ({ programIds, packageIds }) => {
    const ids = programIds || packageIds || [];
    const registry = loadRegistry();
    return ids.map((id: string) => {
      const found = registry.find(
        (p) => (p.programId && p.programId === id) || (p.packageId && p.packageId === id)
      );
      return (
        found ?? {
          programId: id,
          packageId: id,
          name: "Unknown",
          category: "unknown",
          audited: false,
          risk: "high" as const,
        }
      );
    });
  },
  {
    name: "lookup_protocol",
    description: "Resolve Solana program IDs to protocol metadata (name, category, audit status, risk)",
    schema: z.object({
      programIds: z.array(z.string()).optional(),
      packageIds: z.array(z.string()).optional(),
    }),
  }
);

// ── Tool 4: score_risk ────────────────────────────────────────────

export const scoreRisk = tool(
  async ({ operations, protocols, simulation, similarPatterns }) => {
    let score = 0;
    const flags: string[] = [];

    const unknownProtocols = (protocols as Protocol[]).filter(
      (p) => p.name === "Unknown"
    );
    if (unknownProtocols.length > 0) {
      score += 40;
      flags.push(
        `Interacts with ${unknownProtocols.length} unverified program(s)`
      );
    }

    const unauditedProtocols = (protocols as Protocol[]).filter(
      (p) => !p.audited && p.name !== "Unknown"
    );
    if (unauditedProtocols.length > 0) {
      score += 20;
      flags.push(
        `Uses unaudited protocol: ${unauditedProtocols.map((p) => p.name).join(", ")}`
      );
    }

    const ops = (operations as string[]).map((o) => o.toLowerCase());

    // Flag SetAuthority (account takeover vector)
    if (ops.some((o) => o.includes("setauthority") || o.includes("set_authority"))) {
      score += 35;
      flags.push("Attempts to reassign token account owner or mint authority (SetAuthority)");
    }

    // Flag Approve / delegate (drainer approval vector)
    if (ops.some((o) => o.includes("token:approve"))) {
      score += 30;
      flags.push("Grants token delegate spending approval (Approve)");
    }

    // Flag CloseAccount
    if (ops.some((o) => o.includes("closeaccount") || o.includes("close_account"))) {
      score += 20;
      flags.push("Closes token account and sweeps rent lamports");
    }

    // Check large SOL moves (> 10 SOL = 10_000_000_000 Lamports)
    const largeMoves = ((simulation as SimResult)?.balanceChanges ?? []).filter(
      (b) => b.coinType.toUpperCase().includes("SOL") && Number(b.amount) < -10_000_000_000
    );
    if (largeMoves.length > 0) {
      score += 20;
      flags.push("Moves more than 10 SOL out of wallet");
    }

    if (ops.length > 4) {
      score += 15;
      flags.push("Complex multi-step transaction");
    }

    if (ops.some((o) => o.includes("borrow") || o.includes("lending"))) {
      score += 15;
      flags.push("Opens debt or leveraged borrow position");
    }

    if ((protocols as Protocol[]).length >= 3) {
      score += 15;
      flags.push("Interacts across 3+ protocols in a single transaction");
    }

    const exploitMatches = ((similarPatterns ?? []) as {
      description: string;
      category: string;
      similarity: number;
    }[]).filter((p) => p.category === "exploit" && p.similarity >= 0.8);

    if (exploitMatches.length > 0) {
      const top = exploitMatches.reduce((a, b) =>
        b.similarity > a.similarity ? b : a
      );
      score += 25;
      flags.push(
        `Resembles known exploit pattern: ${top.description.slice(0, 60)}`
      );
    }

    const finalScore = Math.min(score, 100);
    const recommendation =
      finalScore >= 60 ? "reject" : finalScore >= 30 ? "caution" : "approve";

    return { score: finalScore, flags, recommendation };
  },
  {
    name: "score_risk",
    description:
      "Score transaction risk from 0–100 using Solana rule-based analysis. Returns score, flags, and recommendation.",
    schema: z.object({
      operations: z.array(z.string()),
      protocols: z.array(z.any()),
      simulation: z.any().nullable(),
      similarPatterns: z.array(z.any()).optional(),
    }),
  }
);

// ── Tool 5: wallet_history ────────────────────────────────────────

export const getHistory = tool(
  async ({ walletAddress, cluster }) => {
    try {
      return await createSolanaService().getHistorySummary(walletAddress, cluster as SolanaCluster);
    } catch {
      return "Could not fetch wallet history.";
    }
  },
  {
    name: "wallet_history",
    description: "Get a brief summary of the wallet's recent activity on Solana",
    schema: z.object({
      walletAddress: z.string(),
      cluster: z.enum(["devnet", "mainnet"]).optional(),
    }),
  }
);

// ── Tool 6: vector_search ─────────────────────────────────────────

let qdrantClient: QdrantClient | null = null;
function getQdrant(): QdrantClient {
  if (!qdrantClient) {
    qdrantClient = new QdrantClient({
      url: process.env.QDRANT_URL,
      apiKey: process.env.QDRANT_API_KEY,
    });
  }
  return qdrantClient;
}

let embeddings: GoogleGenerativeAIEmbeddings | null = null;
function getEmbeddings(): GoogleGenerativeAIEmbeddings {
  if (!embeddings) {
    embeddings = new GoogleGenerativeAIEmbeddings({
      model: "gemini-embedding-001",
    });
  }
  return embeddings;
}

function localPatternSearch(operations: string[], protocols: Protocol[]) {
  try {
    const patternsPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../data/patterns.json"
    );
    if (!fs.existsSync(patternsPath)) return [];
    const patterns: Array<{ description: string; category: string; risk_level: string }> = JSON.parse(
      fs.readFileSync(patternsPath, "utf-8")
    );
    const hasUnknown = protocols.some((p) => p.name === "Unknown");
    const opStr = operations.join(" ").toLowerCase();

    return patterns
      .filter((p) => {
        if (p.category === "exploit") {
          if (hasUnknown && (opStr.includes("setauthority") || opStr.includes("set_authority")) && p.description.includes("SetAuthority")) return true;
          if (hasUnknown && opStr.includes("token:approve") && p.description.includes("approval")) return true;
          if (hasUnknown && (opStr.includes("closeaccount") || opStr.includes("close_account")) && p.description.includes("CloseAccount")) return true;
          if (hasUnknown && opStr.includes("system:transfer") && p.description.includes("drain")) return true;
          if (hasUnknown && p.description.includes("Fake airdrop")) return true;
        }
        return false;
      })
      .map((p) => ({
        description: p.description,
        category: p.category,
        riskLevel: p.risk_level,
        similarity: 0.92,
      }))
      .slice(0, 3);
  } catch {
    return [];
  }
}

export const vectorSearch = tool(
  async ({ operations, protocols }) => {
    try {
      if (!process.env.QDRANT_URL) {
        const localMatches = localPatternSearch(operations as string[], protocols as Protocol[]);
        console.log(`[qdrant] Searching local Solana exploit patterns: found ${localMatches.length} match(es)`);
        return { matches: localMatches };
      }

      const opText = (operations as string[]).join(", ");
      const protoText = (protocols as Protocol[])
        .map((p) =>
          p.name === "Unknown"
            ? "an unknown unverified program"
            : `${p.name} (audited ${p.category})`
        )
        .join(", ");
      const query = `${opText} on Solana involving ${protoText}`;

      console.log(`[qdrant] Querying vector threat database: "${query}"`);
      const vector = await getEmbeddings().embedQuery(query);
      const response = await getQdrant().query(
        process.env.QDRANT_COLLECTION ?? "solana_patterns",
        { query: vector, limit: 3, score_threshold: 0.6, with_payload: true }
      );

      const points = response.points ?? [];
      const matches = points.map((r: { payload?: Record<string, unknown>; score?: number }) => ({
        description: (r.payload?.description as string) ?? "",
        category: (r.payload?.category as string) ?? "exploit",
        riskLevel: (r.payload?.risk_level as string) ?? "high",
        similarity: Number((r.score ?? 0).toFixed(2)),
      }));

      const finalMatches =
        matches.length > 0 ? matches : localPatternSearch(operations as string[], protocols as Protocol[]);

      return { matches: finalMatches };
    } catch (err) {
      console.error(
        "vector_search fallback to local patterns:",
        err instanceof Error ? err.message : err
      );
      const fallbackMatches = localPatternSearch(operations as string[], protocols as Protocol[]);
      return { matches: fallbackMatches };
    }
  },
  {
    name: "vector_search",
    description:
      "Search vector database of known exploit and benign Solana transaction patterns.",
    schema: z.object({
      operations: z.array(z.string()),
      protocols: z.array(z.any()),
    }),
  }
);
