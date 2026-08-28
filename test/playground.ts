/**
 * Interactive CLI playground — quickly test the graph with different inputs.
 *
 * Edit the `tests` array below with whatever you want to test.
 * Run with: pnpm tsx test/playground.ts
 *
 * Each test runs the full graph (parse → simulate → enrich → risk → explain),
 * prints formatted results, and includes timing.
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

// ── State (same as hello-graph.ts) ────────────────────────────────────────

const AgentState = Annotation.Root({
  rawPtb:         Annotation<string>,
  walletAddress:  Annotation<string>,
  operations:     Annotation<string[]>,
  simulation:     Annotation<{ status: string; balanceChanges: { coinType: string; amount: string }[] } | null>,
  protocols:      Annotation<{ name: string; audited: boolean }[]>,
  history:        Annotation<string>,
  riskScore:      Annotation<number>,
  riskFlags:      Annotation<string[]>,
  explanation:    Annotation<string>,
  recommendation: Annotation<"approve" | "caution" | "reject">,
});

type State = typeof AgentState.State;

// ── Nodes (mocked Sui, real Gemini) ───────────────────────────────────────

async function parseNode(_state: State) {
  // In real code: Transaction.from(state.rawPtb)
  return {
    operations: ["MoveCall:0xa9556bc::pool::swap", "split_coins", "transfer_objects"],
  };
}

async function simulateNode(_state: State) {
  // In real code: client.dryRunTransactionBlock(...)
  return {
    simulation: {
      status: "success",
      balanceChanges: [
        { coinType: "0x2::sui::SUI", amount: "-1000000000" },
        { coinType: "0x...::usdc::USDC", amount: "+3120000" },
      ],
    },
  };
}

async function enrichNode(_state: State) {
  // In real code: protocols.json + wallet history from RPC
  return {
    protocols: [{ name: "Cetus", audited: true }],
    history: "Wallet has 10 recent transactions. This is an active wallet.",
  };
}

async function riskNode(state: State) {
  // Pure rule-based scoring
  const flags: string[] = [];
  let score = 0;
  if (state.operations.includes("transfer_objects")) {
    score += 15;
    flags.push("Transfers objects out of wallet");
  }
  return {
    riskScore: score,
    riskFlags: flags,
    recommendation: (score >= 60 ? "reject" : score >= 30 ? "caution" : "approve") as State["recommendation"],
  };
}

async function explainNode(state: State) {
  // Real Gemini call
  const llm = new ChatGoogleGenerativeAI({
    model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
  });

  const facts = {
    operations:     state.operations,
    protocols:      state.protocols,
    balanceChanges: state.simulation?.balanceChanges,
    riskScore:      state.riskScore,
    riskFlags:      state.riskFlags,
    walletHistory:  state.history,
  };

  const response = await llm.invoke([
    {
      role: "system",
      content:
        "You are a Sui transaction analyst. Explain transactions to non-technical users " +
        "in plain English, 3-5 sentences, naming protocols by name. Never invent facts.",
    },
    {
      role: "user",
      content: `Transaction facts:\n${JSON.stringify(facts, null, 2)}\n\nExplain this transaction.`,
    },
  ]);

  return { explanation: response.content as string };
}

// ── Graph ────────────────────────────────────────────────────────────────

const graph = new StateGraph(AgentState)
  .addNode("parse",    parseNode)
  .addNode("simulate", simulateNode)
  .addNode("enrich",   enrichNode)
  .addNode("risk",     riskNode)
  .addNode("explain",  explainNode)
  .addEdge(START,      "parse")
  .addEdge("parse",    "simulate")
  .addEdge("simulate", "enrich")
  .addEdge("enrich",   "risk")
  .addEdge("risk",     "explain")
  .addEdge("explain",  END)
  .compile();

// ── Test cases: edit these to experiment ──────────────────────────────────

const tests = [
  {
    name: "Safe swap on Cetus",
    rawPtb: "FAKE_PTB_1",
    walletAddress: "0x1234abcd",
  },
  {
    name: "Another transaction",
    rawPtb: "FAKE_PTB_2",
    walletAddress: "0x5678efgh",
  },
];

// ── Run all tests ────────────────────────────────────────────────────────

async function main() {
  console.log("\n🎮 LangGraph Playground\n");

  for (const test of tests) {
    console.log(`${"─".repeat(70)}`);
    console.log(`📋 Test: ${test.name}`);
    console.log(`   PTB: ${test.rawPtb}`);
    console.log(`   Wallet: ${test.walletAddress}`);
    console.log(`${"─".repeat(70)}`);

    const t0 = Date.now();

    try {
      const result = await graph.invoke({
        rawPtb: test.rawPtb,
        walletAddress: test.walletAddress,
      });

      const elapsed = Date.now() - t0;

      console.log(`\n✅ Risk Score: ${result.riskScore}`);
      console.log(`📊 Recommendation: ${result.recommendation.toUpperCase()}`);
      console.log(`🚩 Flags: ${result.riskFlags.length > 0 ? result.riskFlags.join(", ") : "(none)"}`);
      console.log(`\n📝 Explanation:\n${result.explanation}`);
      console.log(`\n⏱️  Time: ${elapsed}ms\n`);
    } catch (error) {
      console.error(`❌ Error:`, (error as any).message);
    }
  }

  console.log(`${"─".repeat(70)}\n`);
}

main();
