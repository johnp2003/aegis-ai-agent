/**
 * Demo Solana transactions for testing the AEGIS agent.
 * Constructs realistic Safe, Medium, and Malicious transactions using @solana/web3.js.
 *
 * Run the server first (pnpm dev), then in another terminal: pnpm test:demo
 */

import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

// Valid base58 32-byte public keys
const SENDER_PUBKEY = new PublicKey("4Nd1mBQtrMJVYVfKf2PJy9NZzqdPE635D44KcxFpx5T8");
const RECIPIENT_PUBKEY = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const ATTACKER_PUBKEY = new PublicKey("EvN4PnpKUsqGhaCgP81fF1m7yX3a11q9W4c45PjSjUpt");
const UNKNOWN_PROGRAM = new PublicKey("HrvYwa8NL6vW2qYtZg2q5mH5n7d9pQk6L4k8xZ3vM9kP");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const JUPITER_PROGRAM = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const COMPUTE_BUDGET_PROGRAM = new PublicKey("ComputeBudget111111111111111111111111111111");

const FAKE_RECENT_BLOCKHASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

/** Safe Scenario: Simple 0.05 SOL transfer using audited System Program. Expected: riskScore < 30, "approve". */
function buildSafeTx(): string {
  const tx = new Transaction();
  tx.recentBlockhash = FAKE_RECENT_BLOCKHASH;
  tx.feePayer = SENDER_PUBKEY;
  tx.add(
    SystemProgram.transfer({
      fromPubkey: SENDER_PUBKEY,
      toPubkey: RECIPIENT_PUBKEY,
      lamports: 50_000_000n, // 0.05 SOL
    })
  );
  return tx.serialize({ requireAllSignatures: false }).toString("base64");
}

/** Medium Scenario: Compute budget optimization + Jupiter swap + multi-step. Expected: riskScore in [30, 60), "caution". */
function buildMediumTx(): string {
  const tx = new Transaction();
  tx.recentBlockhash = FAKE_RECENT_BLOCKHASH;
  tx.feePayer = RECIPIENT_PUBKEY;

  // 1. Compute budget limit
  tx.add(
    new TransactionInstruction({
      programId: COMPUTE_BUDGET_PROGRAM,
      keys: [],
      data: Buffer.from([2, 0, 0, 0, 160, 134, 1, 0]),
    })
  );

  // 2. Compute budget price
  tx.add(
    new TransactionInstruction({
      programId: COMPUTE_BUDGET_PROGRAM,
      keys: [],
      data: Buffer.from([3, 0, 0, 0, 100, 0, 0, 0]),
    })
  );

  // 3. Jupiter swap instruction
  tx.add(
    new TransactionInstruction({
      programId: JUPITER_PROGRAM,
      keys: [
        { pubkey: RECIPIENT_PUBKEY, isSigner: true, isWritable: true },
        { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1, 2, 3, 4]),
    })
  );

  // 4. Token transfer
  tx.add(
    new TransactionInstruction({
      programId: TOKEN_PROGRAM,
      keys: [
        { pubkey: RECIPIENT_PUBKEY, isSigner: true, isWritable: true },
        { pubkey: RECIPIENT_PUBKEY, isSigner: false, isWritable: true },
      ],
      data: Buffer.from([3, 100, 0, 0, 0, 0, 0, 0]), // transfer
    })
  );

  // 5. System transfer
  tx.add(
    SystemProgram.transfer({
      fromPubkey: RECIPIENT_PUBKEY,
      toPubkey: RECIPIENT_PUBKEY,
      lamports: 10_000n,
    })
  );

  return tx.serialize({ requireAllSignatures: false }).toString("base64");
}

/** Malicious Scenario: Unverified program + SetAuthority takeover + large SOL drain. Expected: riskScore >= 60, "reject". */
function buildMaliciousTx(): string {
  const tx = new Transaction();
  tx.recentBlockhash = FAKE_RECENT_BLOCKHASH;
  tx.feePayer = RECIPIENT_PUBKEY;

  // 1. Unverified phishing contract
  tx.add(
    new TransactionInstruction({
      programId: UNKNOWN_PROGRAM,
      keys: [{ pubkey: RECIPIENT_PUBKEY, isSigner: true, isWritable: true }],
      data: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
    })
  );

  // 2. SPL Token SetAuthority takeover
  tx.add(
    new TransactionInstruction({
      programId: TOKEN_PROGRAM,
      keys: [
        { pubkey: RECIPIENT_PUBKEY, isSigner: true, isWritable: true },
        { pubkey: ATTACKER_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([6, 0, 1, 2]), // 6 is SetAuthority
    })
  );

  // 3. Move large amount of SOL to attacker
  tx.add(
    SystemProgram.transfer({
      fromPubkey: RECIPIENT_PUBKEY,
      toPubkey: ATTACKER_PUBKEY,
      lamports: 50_000_000_000n, // 50 SOL
    })
  );

  return tx.serialize({ requireAllSignatures: false }).toString("base64");
}

export const DEMO_TXS = {
  safe: { rawTransaction: buildSafeTx(), walletAddress: SENDER_PUBKEY.toBase58(), cluster: "devnet" },
  medium: { rawTransaction: buildMediumTx(), walletAddress: SENDER_PUBKEY.toBase58(), cluster: "mainnet" },
  malicious: { rawTransaction: buildMaliciousTx(), walletAddress: SENDER_PUBKEY.toBase58(), cluster: "devnet" },
};

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
const MAX_LATENCY_MS = 10000;
const MAX_LATENCY_LLM_MS = 90000;

const CHECKS: Record<string, (d: AnalyzeResponse) => string[]> = {
  safe: (d) => [
    d.riskScore < 30 ? "" : `expected riskScore < 30, got ${d.riskScore}`,
    d.recommendation === "approve" ? "" : `expected "approve", got "${d.recommendation}"`,
    !d.plannedSteps?.includes("vector_search") ? "" : "expected plan to skip vector_search",
  ],
  medium: (d) => [
    d.riskScore >= 30 && d.riskScore < 60 ? "" : `expected riskScore in [30,60), got ${d.riskScore}`,
    d.recommendation === "caution" ? "" : `expected "caution", got "${d.recommendation}"`,
  ],
  malicious: (d) => [
    d.riskScore >= 60 ? "" : `expected riskScore >= 60, got ${d.riskScore}`,
    d.recommendation === "reject" ? "" : `expected "reject", got "${d.recommendation}"`,
    d.riskFlags.some((f) => /unverified/i.test(f)) ? "" : "no flag mentions an unverified program",
    d.riskFlags.some((f) => /SetAuthority/i.test(f)) ? "" : "no flag mentions SetAuthority takeover",
    d.plannedSteps?.includes("vector_search") ? "" : "expected plan to include vector_search",
  ],
};

async function waitForServer(): Promise<void> {
  process.stdout.write("Connecting to AI Agent server...");
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${AGENT_SERVER_URL}/health`);
      if (res.ok) {
        console.log(" connected! 🚀\n");
        return;
      }
    } catch {
      process.stdout.write(".");
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Could not connect to ${AGENT_SERVER_URL} within 30 seconds`);
}

async function test() {
  await waitForServer();
  let failed = false;

  for (const [label, body] of Object.entries(DEMO_TXS)) {
    const t0 = Date.now();
    const res = await fetch(`${AGENT_SERVER_URL}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const latency = Date.now() - t0;

    console.log(`\n── ${label.toUpperCase()} SCENARIO ── (${latency}ms)`);

    if (!res.ok) {
      console.log(`  ✗ HTTP ${res.status}: ${await res.text()}`);
      failed = true;
      continue;
    }

    const data = (await res.json()) as AnalyzeResponse;
    console.log(`Risk Score : ${data.riskScore}/100 | Recommendation: ${data.recommendation?.toUpperCase()}`);
    console.log(`Flags      : ${data.riskFlags?.join(" | ") || "(none)"}`);
    console.log(`Operations : ${data.operations?.join(", ")}`);
    console.log(`Plan       : [${data.plannedSteps?.join(", ")}] (${data.planSource})`);
    console.log(`Explanation: ${data.explanation}`);

    const problems = CHECKS[label](data).filter(Boolean);
    const maxLatency = data.planSource === "llm" ? MAX_LATENCY_LLM_MS : MAX_LATENCY_MS;
    if (latency >= maxLatency) {
      problems.push(`latency ${latency}ms exceeds ${maxLatency}ms`);
    }

    if (problems.length === 0) {
      console.log("  ✓ All assertions passed");
    } else {
      failed = true;
      for (const p of problems) console.log(`  ✗ ${p}`);
    }
  }

  console.log(failed ? "\nRESULT: FAILED" : "\nRESULT: ALL SOLANA TEST SCENARIOS PASSED 🚀");
  process.exit(failed ? 1 : 0);
}

test();
