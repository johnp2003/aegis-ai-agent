/**
 * The 6 deterministic tools of the Sui Copilot pipeline.
 * No LLM is called inside any tool — the LLM only runs once, in the
 * graph's explain node, over the structured facts these tools produce.
 *
 * dry_run and wallet_history delegate to the SuiService abstraction (Sui RPC).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { tool } from "@langchain/core/tools";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { QdrantClient } from "@qdrant/js-client-rest";
import { z } from "zod";
import { createSuiService } from "./services/index.js";
import { Protocol, SimResult } from "./state.js";

// ── Tool 1: parse_ptb ─────────────────────────────────────────────

export const parsePtb = tool(
  async ({ rawPtb }) => {
    const tx = Transaction.from(rawPtb);
    const commands = tx.getData().commands;
    const operations = commands.map((cmd) => {
      if (cmd.$kind === "MoveCall" && cmd.MoveCall) {
        const { package: pkg, module: mod, function: fn } = cmd.MoveCall;
        return `MoveCall:${pkg.slice(0, 8)}::${mod}::${fn}`;
      }
      if (cmd.$kind === "TransferObjects") return "transfer_objects";
      if (cmd.$kind === "SplitCoins") return "split_coins";
      if (cmd.$kind === "MergeCoins") return "merge_coins";
      return cmd.$kind ?? "unknown";
    });
    const packageIds = [
      ...new Set(
        commands.flatMap((c) =>
          c.$kind === "MoveCall" && c.MoveCall
            ? [normalizeSuiAddress(c.MoveCall.package)]
            : []
        )
      ),
    ];
    return { operations, packageIds };
  },
  {
    name: "parse_ptb",
    description:
      "Parse raw PTB bytes into a list of operations and extract package IDs",
    schema: z.object({ rawPtb: z.string() }),
  }
);

// ── Tool 2: dry_run (most important) ──────────────────────────────

export const dryRun = tool(
  async ({ rawPtb }) => {
    try {
      return await createSuiService().dryRun(rawPtb);
    } catch (err) {
      // Never crash mid-graph: surface the failure as a SimResult so the
      // risk engine and explanation still run over what we do know.
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
      "Simulate PTB execution. Returns balance/object changes, gas cost, events. Does NOT modify on-chain state.",
    schema: z.object({ rawPtb: z.string() }),
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
  async ({ packageIds }) => {
    const registry = loadRegistry();
    return packageIds.map(
      (id: string) =>
        registry.find(
          (p) => normalizeSuiAddress(p.packageId) === normalizeSuiAddress(id)
        ) ?? {
          packageId: id,
          name: "Unknown",
          category: "unknown",
          audited: false,
          risk: "high" as const,
        }
    );
  },
  {
    name: "lookup_protocol",
    description:
      "Resolve Sui package IDs to protocol metadata (name, category, audit status, risk)",
    schema: z.object({ packageIds: z.array(z.string()) }),
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
        `Interacts with ${unknownProtocols.length} unverified contract(s)`
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

    if ((operations as string[]).includes("transfer_objects")) {
      score += 15;
      flags.push("Transfers objects out of wallet");
    }

    if (
      (simulation as SimResult)?.objectChanges?.includes("deleted") ||
      (operations as string[]).some(
        (op) => op.toLowerCase().includes("delete") || op.toLowerCase().includes("burn")
      )
    ) {
      score += 30;
      flags.push("Permanently deletes an on-chain capability or object");
    }

    // Check if more than 50 SUI moves (50 SUI = 50_000_000_000 MIST)
    const largeMoves = ((simulation as SimResult)?.balanceChanges ?? []).filter(
      (b) => b.coinType.includes("SUI") && Number(b.amount) < -50_000_000_000
    );
    if (largeMoves.length > 0) {
      score += 20;
      flags.push("Moves more than 50 SUI");
    }

    if ((operations as string[]).length > 4) {
      score += 20;
      flags.push("Complex multi-step transaction");
    }

    if ((operations as string[]).some((op) => op.toLowerCase().includes("borrow") || op.toLowerCase().includes("lending"))) {
      score += 20;
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
      score += 20;
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
      "Score transaction risk from 0–100 using rule-based analysis. Returns score, flags, and recommendation.",
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
  async ({ walletAddress }) => {
    try {
      return await createSuiService().getHistorySummary(walletAddress);
    } catch {
      return "Could not fetch wallet history.";
    }
  },
  {
    name: "wallet_history",
    description: "Get a brief summary of the wallet's recent activity",
    schema: z.object({ walletAddress: z.string() }),
  }
);

// ── Tool 6: vector_search ─────────────────────────────────────────

// Lazy singletons (same pattern as getLlm in graph.ts) so env vars are
// loaded before the clients read them.
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
          if (hasUnknown && opStr.includes("delete_owner_cap") && p.description.includes("delete_owner_cap")) return true;
          if (hasUnknown && opStr.includes("claim_airdrop") && p.description.includes("claim_airdrop")) return true;
          if (hasUnknown && opStr.includes("transfer_objects") && p.description.includes("transfer_objects")) return true;
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
        console.log(`[qdrant] Searching local exploit patterns: found ${localMatches.length} match(es)`);
        return { matches: localMatches };
      }

      const opText = (operations as string[])
        .map((op) => {
          const m = op.match(/^MoveCall:0x[0-9a-fA-F]+::(.+)$/);
          return m ? `MoveCall to ${m[1]}` : op;
        })
        .join(", ");
      const protoText = (protocols as Protocol[])
        .map((p) =>
          p.name === "Unknown"
            ? "an unknown unverified package"
            : `${p.name} (audited ${p.category})`
        )
        .join(", ");
      const query = `${opText} involving ${protoText}`;

      console.log(`[qdrant] Querying vector threat database: "${query}"`);
      const vector = await getEmbeddings().embedQuery(query);
      const response = await getQdrant().query(
        process.env.QDRANT_COLLECTION ?? "ptb_patterns",
        { query: vector, limit: 3, score_threshold: 0.6, with_payload: true }
      );

      const points = response.points ?? [];
      const matches = points.map((r: any) => ({
        description: r.payload?.description ?? "",
        category: r.payload?.category ?? "exploit",
        riskLevel: r.payload?.risk_level ?? "high",
        similarity: Number((r.score ?? 0).toFixed(2)),
      }));

      const finalMatches =
        matches.length > 0 ? matches : localPatternSearch(operations as string[], protocols as Protocol[]);
      console.log(
        `[qdrant] Threat scan completed: ${finalMatches.length} exploit match(es) found (${finalMatches.map((m: any) => `${Math.round(m.similarity * 100)}% ${m.category}`).join(", ") || "none"})`
      );

      return {
        matches: finalMatches,
      };
    } catch (err) {
      console.error(
        "vector_search fallback to local patterns:",
        err instanceof Error ? err.message : err
      );
      const fallbackMatches = localPatternSearch(operations as string[], protocols as Protocol[]);
      console.log(`[qdrant] Fallback pattern matching: found ${fallbackMatches.length} match(es)`);
      return { matches: fallbackMatches };
    }
  },
  {
    name: "vector_search",
    description:
      "Search a vector database of known exploit and benign transaction patterns for semantically similar transactions.",
    schema: z.object({
      operations: z.array(z.string()),
      protocols: z.array(z.any()),
    }),
  }
);
