/**
 * LangGraph test run — a miniature of the real Sui Copilot pipeline.
 *
 * Same graph shape as the real thing (parse → simulate → enrich → risk → explain),
 * but every node except `explain` returns MOCKED data. No Sui RPC is called.
 * The `explain` node makes ONE real Gemini call, exactly like the real agent will.
 *
 * Run with: pnpm tsx test/hello-graph.ts
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

// ── 1. State: the single object that flows through every node ─────────────
// Each node receives the full state and returns a PARTIAL update.
// LangGraph merges the update into the state before calling the next node.

const AgentState = Annotation.Root({
  // inputs
  rawPtb:         Annotation<string>,
  walletAddress:  Annotation<string>,

  // filled by nodes along the way
  operations:     Annotation<string[]>,
  simulation:     Annotation<{ status: string; balanceChanges: { coinType: string; amount: string }[] } | null>,
  protocols:      Annotation<{ name: string; audited: boolean }[]>,
  history:        Annotation<string>,
  riskScore:      Annotation<number>,
  riskFlags:      Annotation<string[]>,

  // outputs
  explanation:    Annotation<string>,
  recommendation: Annotation<"approve" | "caution" | "reject">,
});

type State = typeof AgentState.State;

function log(node: string, added: object) {
  console.log(`\n▶ node "${node}" ran, added to state:`);
  console.log(JSON.stringify(added, null, 2).split("\n").map(l => "   " + l).join("\n"));
}

// ── 2. Nodes: plain async functions. Mocked here; real tools later. ───────

async function parseNode(_state: State) {
  // Real version: Transaction.from(state.rawPtb) → extract commands
  const update = {
    operations: ["MoveCall:0xa9556bc::pool::swap", "split_coins", "transfer_objects"],
  };
  log("parse", update);
  return update;
}

async function simulateNode(_state: State) {
  // Real version: client.dryRunTransactionBlock(...) on Sui RPC
  const update = {
    simulation: {
      status: "success",
      balanceChanges: [
        { coinType: "0x2::sui::SUI", amount: "-1000000000" },   // -1 SUI
        { coinType: "0x...::usdc::USDC", amount: "+3120000" },  // +3.12 USDC
      ],
    },
  };
  log("simulate", update);
  return update;
}

async function enrichNode(_state: State) {
  // Real version: protocols.json lookup + wallet history from RPC
  const update = {
    protocols: [{ name: "Cetus", audited: true }],
    history: "Wallet has 10 recent transactions. This is an active wallet.",
  };
  log("enrich", update);
  return update;
}

async function riskNode(state: State) {
  // Real version: rule-based scorer over the accumulated state.
  // Note how this node READS what earlier nodes wrote:
  const flags: string[] = [];
  let score = 0;
  if (state.operations.includes("transfer_objects")) {
    score += 15;
    flags.push("Transfers objects out of wallet");
  }
  const update = {
    riskScore: score,
    riskFlags: flags,
    recommendation: (score >= 60 ? "reject" : score >= 30 ? "caution" : "approve") as State["recommendation"],
  };
  log("risk", update);
  return update;
}

async function explainNode(state: State) {
  // The ONLY node that touches the LLM — and it only sees verified facts.
  const llm = new ChatGoogleGenerativeAI({ model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash" });

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

  const update = { explanation: response.content as string };
  log("explain (real Gemini call)", update);
  return update;
}

// ── 3. Graph: wire nodes in a fixed sequence. No branching, no loops. ─────

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

export { graph };

// ── 4. Invoke: pass inputs, get the final accumulated state back ──────────

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("START → parse → simulate → enrich → risk → explain → END");

  const t0 = Date.now();
  const result = await graph.invoke({
    rawPtb: "FAKE_BASE64_PTB_FOR_TEST_RUN",
    walletAddress: "0x1234abcd",
  });

  console.log("\n" + "═".repeat(60));
  console.log("FINAL RESULT (what /analyze would return):");
  console.log("═".repeat(60));
  console.log({
    explanation:    result.explanation,
    riskScore:      result.riskScore,
    riskFlags:      result.riskFlags,
    recommendation: result.recommendation,
    operations:     result.operations,
  });
  console.log(`\nTotal time: ${Date.now() - t0}ms`);
}
