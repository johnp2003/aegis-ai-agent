/**
 * Demo PTBs for testing the agent without a real wallet.
 *
 * Instead of hardcoded base64 blobs, the three scenarios are built with the
 * real Sui SDK and serialized with tx.serialize() — JSON serialization needs
 * no sender/gas resolution, and Transaction.from() (used by parse_ptb and the
 * mock dry-run) accepts it directly. Package IDs come from data/protocols.json
 * so registry lookups resolve exactly as they will with real package IDs.
 *
 * Run the server first (pnpm dev), then: pnpm test:demo
 */

import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { Transaction } from "@mysten/sui/transactions";
import { Protocol } from "../src/state.js";

// ── package IDs (single source of truth: the protocol registry) ──────────

const registry: Protocol[] = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "data/protocols.json"), "utf-8")
);

function pkg(name: string): string {
  const entry = registry.find((p) => p.name === name);
  if (!entry) throw new Error(`Protocol "${name}" not found in registry`);
  return entry.packageId;
}

const CETUS = pkg("Cetus");
const NAVI = pkg("NAVI Protocol");
const BUCKET = pkg("Bucket Protocol"); // unaudited in the registry → medium risk

// Deliberately NOT in the registry → resolves to "Unknown", risk high
const UNKNOWN_PKG =
  "0xdeadbeef00000000000000000000000000000000000000000000000000000099";

const DEMO_WALLET =
  "0x7d20dcdb2bca4f508ea9613994683eb4e76e9c4ed371169677c1be02aaf0b58e";
const ATTACKER_ADDRESS =
  "0x6660000000000000000000000000000000000000000000000000000000000666";
const NFT_OBJECT_ID =
  "0xabc1230000000000000000000000000000000000000000000000000000000011";
const CAP_OBJECT_ID =
  "0xabc4560000000000000000000000000000000000000000000000000000000022";

// ── the three scenarios ───────────────────────────────────────────────────

/** Simple 5 SUI → USDC swap on Cetus. Expected: riskScore < 30, "approve". */
function buildSafePtb(): string {
  const tx = new Transaction();
  tx.setSender(DEMO_WALLET);
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(5_000_000_000n)]);
  tx.moveCall({
    target: `${CETUS}::pool::swap_exact_input`,
    arguments: [coin],
  });
  return tx.serialize();
}

/**
 * Swap on Cetus + deposit/borrow on NAVI + stake on unaudited Bucket.
 * 5 commands (+10) and an unaudited protocol (+20).
 * Expected: riskScore 30–59, "caution".
 */
function buildMediumPtb(): string {
  const tx = new Transaction();
  tx.setSender(DEMO_WALLET);
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(10_000_000_000n)]);
  const [swapped] = tx.moveCall({
    target: `${CETUS}::pool::swap_exact_input`,
    arguments: [coin],
  });
  tx.moveCall({
    target: `${NAVI}::lending::deposit_collateral`,
    arguments: [swapped],
  });
  const [borrowed] = tx.moveCall({
    target: `${NAVI}::lending::borrow`,
    arguments: [tx.pure.u64(3_000_000_000n)],
  });
  tx.moveCall({
    target: `${BUCKET}::farm::stake`,
    arguments: [borrowed],
  });
  return tx.serialize();
}

/**
 * Unknown package (+40) + NFT transfer out of wallet (+15) + capability
 * deletion (+30). Expected: riskScore >= 60, "reject".
 */
function buildMaliciousPtb(): string {
  const tx = new Transaction();
  tx.setSender(DEMO_WALLET);
  tx.moveCall({ target: `${UNKNOWN_PKG}::rewards::claim_airdrop` });
  tx.transferObjects([tx.object(NFT_OBJECT_ID)], ATTACKER_ADDRESS);
  tx.moveCall({
    target: `${UNKNOWN_PKG}::vault::delete_owner_cap`,
    arguments: [tx.object(CAP_OBJECT_ID)],
  });
  return tx.serialize();
}

export const DEMO_PTBS = {
  safe: { rawPtb: buildSafePtb(), walletAddress: DEMO_WALLET },
  medium: { rawPtb: buildMediumPtb(), walletAddress: DEMO_WALLET },
  malicious: { rawPtb: buildMaliciousPtb(), walletAddress: DEMO_WALLET },
};

// ── test runner with done-criteria assertions ─────────────────────────────

interface AnalyzeResponse {
  explanation: string;
  riskScore: number;
  riskFlags: string[];
  recommendation: "approve" | "caution" | "reject";
  operations: string[];
  similarPatterns: {
    description: string;
    category: string;
    riskLevel: string;
    similarity: number;
  }[];
  plannedSteps: string[];
  planReasoning: string;
  planSource: string;
}

const AGENT_SERVER_URL = process.env.AGENT_SERVER_URL ?? "http://localhost:3001";
// The deterministic path must stay under 3s. When the plan came from the
// LLM (AGENT_REASONING=full), the analysis includes two free-tier Gemini
// round trips at ~1.5–2s each, so the budget is wider.
const MAX_LATENCY_MS = 3000;
const MAX_LATENCY_LLM_MS = 12000;

const CHECKS: Record<string, (d: AnalyzeResponse) => string[]> = {
  safe: (d) => [
    d.riskScore < 30 ? "" : `expected riskScore < 30, got ${d.riskScore}`,
    d.recommendation === "approve" ? "" : `expected "approve", got "${d.recommendation}"`,
    /cetus/i.test(d.explanation) ? "" : "explanation does not name Cetus",
    !d.plannedSteps?.includes("wallet_history") ? "" : "expected plan to skip wallet_history",
    (d.planReasoning ?? "").length > 0 ? "" : "planReasoning is empty",
    !d.plannedSteps?.includes("vector_search") ? "" : "expected plan to skip vector_search",
  ],
  medium: (d) => [
    d.riskScore >= 30 && d.riskScore < 60 ? "" : `expected riskScore in [30,60), got ${d.riskScore}`,
    d.recommendation === "caution" ? "" : `expected "caution", got "${d.recommendation}"`,
    !d.plannedSteps?.includes("vector_search") ? "" : "expected plan to skip vector_search",
  ],
  malicious: (d) => [
    d.riskScore >= 60 ? "" : `expected riskScore >= 60, got ${d.riskScore}`,
    d.recommendation === "reject" ? "" : `expected "reject", got "${d.recommendation}"`,
    d.riskFlags.some((f) => /unverified/i.test(f)) ? "" : "no flag mentions an unverified contract",
    d.plannedSteps?.includes("wallet_history") ? "" : "expected plan to include wallet_history",
    d.plannedSteps?.includes("vector_search") ? "" : "expected plan to include vector_search",
    (d.similarPatterns ?? []).length > 0 ? "" : "no similar patterns returned",
    d.riskFlags.some((f) => /known exploit pattern/i.test(f)) ? "" : "no exploit-pattern risk flag",
  ],
};

async function test() {
  let failed = false;

  for (const [label, body] of Object.entries(DEMO_PTBS)) {
    const t0 = Date.now();
    const res = await fetch(`${AGENT_SERVER_URL}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const latency = Date.now() - t0;

    console.log(`\n── ${label} ── (${latency}ms)`);

    if (!res.ok) {
      console.log(`  ✗ HTTP ${res.status}: ${await res.text()}`);
      failed = true;
      continue;
    }

    const data = (await res.json()) as AnalyzeResponse;
    console.log(`Risk: ${data.riskScore} | ${data.recommendation}`);
    console.log(`Flags: ${data.riskFlags?.join(", ") || "(none)"}`);
    console.log(
      `Plan: [${data.plannedSteps?.join(", ")}] (${data.planSource}) — ${data.planReasoning}`
    );
    console.log(
      `Patterns: ${data.similarPatterns?.map((p) => `${p.similarity} ${p.category}`).join(", ") || "(none)"}`
    );
    console.log(`Explanation: ${data.explanation}`);

    const problems = CHECKS[label](data).filter(Boolean);
    const maxLatency =
      data.planSource === "llm" ? MAX_LATENCY_LLM_MS : MAX_LATENCY_MS;
    if (latency >= maxLatency) {
      problems.push(`latency ${latency}ms exceeds ${maxLatency}ms`);
    }

    if (problems.length === 0) {
      console.log("  ✓ all checks passed");
    } else {
      failed = true;
      for (const p of problems) console.log(`  ✗ ${p}`);
    }
  }

  console.log(failed ? "\nRESULT: FAILED" : "\nRESULT: ALL PASSED");
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  test();
}
