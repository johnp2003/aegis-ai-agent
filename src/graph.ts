/**
 * The Solana Copilot graph — a StateGraph with a single constrained routing
 * decision:
 *
 *   START → parse → lookup → plan ──┬────────────→ simulate ──┐
 *                                   ├→ fetch_history ─────────┤ (fan-in)
 *                                   │  (only if planned)      │
 *                                   └→ vector_search ─────────┤
 *                                      (only if planned)      ↓
 *                                                           risk → explain → END
 *
 * The plan node is the LLM's only routing decision, and it is constrained to
 * a zod enum of known steps ("simulate", "wallet_history", "vector_search") —
 * it cannot invent steps or call tools.
 */

import { StateGraph, START, END } from "@langchain/langgraph";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { z } from "zod";
import { AgentState, Protocol, SimResult, State } from "./state.js";
import { parseTransaction, dryRun, lookupProtocol, scoreRisk, getHistory, vectorSearch } from "./tools.js";
import { SYSTEM_PROMPT, PLAN_PROMPT } from "./prompts.js";
import { runGonkaExplainVerification, publishAuditToWalrus } from "./services/index.js";

// Created lazily so env vars are loaded (src/env.ts) before the key is read.
let llm: ChatGoogleGenerativeAI | null = null;
function getLlm(): ChatGoogleGenerativeAI {
  if (!llm) {
    llm = new ChatGoogleGenerativeAI({
      model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash-lite",
      temperature: 0,
      thinkingConfig: { thinkingBudget: 0 },
    });
  }
  return llm;
}

// ── node implementations ──────────────────────────────────────────

async function parseNode(state: State) {
  const raw = state.rawTransaction || state.rawPtb;
  const result = (await parseTransaction.invoke({ rawTransaction: raw })) as {
    operations: string[];
    programIds: string[];
  };
  return {
    operations: result.operations,
    programIds: result.programIds,
    packageIds: result.programIds, // backward compatibility
  };
}

async function lookupNode(state: State) {
  const ids = state.programIds || state.packageIds || [];
  const protocols = (await lookupProtocol.invoke({
    programIds: ids,
  })) as Protocol[];
  return { protocols };
}

async function historyNode(state: State) {
  console.log(`[node:fetch_history] Executing history lookup for wallet: ${state.walletAddress} on ${state.cluster || "mainnet"}`);
  const history = (await getHistory.invoke({
    walletAddress: state.walletAddress,
    cluster: state.cluster,
  })) as string;
  return { history };
}

async function simulateNode(state: State) {
  const raw = state.rawTransaction || state.rawPtb;
  const result = (await dryRun.invoke({
    rawTransaction: raw,
    cluster: state.cluster,
  })) as SimResult;
  return { simulation: result };
}

// ── plan node ─────────────────────────────────────────────────────

const PlanSchema = z.object({
  steps: z.array(z.enum(["simulate", "wallet_history", "vector_search"])),
  reasoning: z.string(),
});

const SKIPPED_HISTORY =
  "Skipped — transaction involves only well-known audited Solana programs.";

function heuristicPlan(state: State) {
  const steps = ["simulate"];
  const riskyProtocol = (state.protocols ?? []).some(
    (p) => p.name === "Unknown" || p.audited === false
  );
  const transfersOrDrains = (state.operations ?? []).some((op) => {
    const o = op.toLowerCase();
    return (
      o.includes("transfer") ||
      o.includes("setauthority") ||
      o.includes("approve") ||
      o.includes("closeaccount")
    );
  });
  const hasUnknownPrograms = (state.protocols ?? []).some(
    (p) => p.name === "Unknown"
  );

  let planReasoning: string;
  if (riskyProtocol || transfersOrDrains) {
    steps.push("wallet_history");
    planReasoning = riskyProtocol
      ? "Unknown or unaudited program involved — wallet history needed."
      : "Assets, delegations, or authorities modified — wallet history needed.";
  } else {
    planReasoning =
      "All programs are known and audited and no risky authority changes — skipping wallet history.";
  }

  if (hasUnknownPrograms) {
    steps.push("vector_search");
    planReasoning += "; checking known Solana exploit patterns for unknown program";
  }

  return {
    plannedSteps: steps,
    planReasoning,
    planSource: "heuristic" as const,
  };
}

async function planNode(state: State) {
  let plan: {
    plannedSteps: string[];
    planReasoning: string;
    planSource: "llm" | "heuristic";
  };

  if (process.env.AGENT_REASONING === "lite") {
    plan = heuristicPlan(state);
  } else {
    try {
      const protocols = state.protocols ?? [];
      const operations = state.operations ?? [];
      const facts = {
        operations,
        protocols: protocols.map((p) => ({
          name: p.name,
          category: p.category,
          audited: p.audited,
        })),
        allProtocolsKnownAndAudited:
          protocols.length > 0 &&
          protocols.every((p) => p.name !== "Unknown" && p.audited),
        includesTransferOrDrain: operations.some((op) => {
          const o = op.toLowerCase();
          return (
            o.includes("transfer") ||
            o.includes("setauthority") ||
            o.includes("approve") ||
            o.includes("closeaccount")
          );
        }),
        hasUnknownPrograms: protocols.some((p) => p.name === "Unknown"),
      };
      const result = (await getLlm()
        .withStructuredOutput(PlanSchema)
        .invoke([
          { role: "system", content: PLAN_PROMPT },
          {
            role: "user",
            content: `Transaction facts:\n${JSON.stringify(facts, null, 2)}`,
          },
        ])) as z.infer<typeof PlanSchema>;

      const steps = result.steps.includes("simulate")
        ? result.steps
        : ["simulate", ...result.steps];
      plan = {
        plannedSteps: steps,
        planReasoning: result.reasoning,
        planSource: "llm",
      };
    } catch (err) {
      console.error(
        "plan: LLM unavailable, using heuristic plan:",
        err instanceof Error ? err.message : err
      );
      plan = heuristicPlan(state);
    }
  }

  const defaults: { history?: string; similarPatterns?: [] } = {};
  if (!plan.plannedSteps.includes("wallet_history")) {
    defaults.history = SKIPPED_HISTORY;
  }
  if (!plan.plannedSteps.includes("vector_search")) {
    defaults.similarPatterns = [];
  }
  return { ...plan, ...defaults };
}

function routeAfterPlan(state: State): string[] {
  const targets = ["simulate"];
  if (state.plannedSteps?.includes("wallet_history")) {
    targets.push("fetch_history");
  }
  if (state.plannedSteps?.includes("vector_search")) {
    targets.push("vector_search");
  }
  return targets;
}

// ── remaining nodes ───────────────────────────────────────────────

async function vectorSearchNode(state: State) {
  const result = (await vectorSearch.invoke({
    operations: state.operations,
    protocols: state.protocols,
  })) as { matches: State["similarPatterns"] };
  return { similarPatterns: result.matches };
}

async function riskNode(state: State) {
  const result = (await scoreRisk.invoke({
    operations: state.operations,
    protocols: state.protocols,
    simulation: state.simulation,
    similarPatterns: state.similarPatterns,
  })) as {
    score: number;
    flags: string[];
    recommendation: State["recommendation"];
  };
  return {
    riskScore: result.score,
    riskFlags: result.flags,
    recommendation: result.recommendation,
  };
}

function formatBalanceChangesForPrompt(
  changes: SimResult["balanceChanges"] | undefined
) {
  if (!changes || changes.length === 0) return [];
  return changes.map((c) => {
    const isSol = /sol/i.test(c.coinType) || c.coinType === "11111111111111111111111111111111";
    const isUsdc = /usdc/i.test(c.coinType);
    const rawVal = Number(c.amount);
    if (isSol) {
      const solAmount = Math.abs(rawVal) > 1_000_000 ? rawVal / 1_000_000_000 : rawVal;
      return {
        token: "SOL",
        solAmountDecimal: solAmount,
        formattedAmount: `${solAmount > 0 ? "+" : ""}${solAmount.toFixed(4)} SOL`,
      };
    }
    if (isUsdc) {
      const usdcAmount = Math.abs(rawVal) > 1_000 ? rawVal / 1_000_000 : rawVal;
      return {
        token: "USDC",
        formattedAmount: `${usdcAmount > 0 ? "+" : ""}${usdcAmount.toFixed(2)} USDC`,
      };
    }
    return {
      token: c.coinType,
      formattedAmount: `${rawVal > 0 ? "+" : ""}${c.amount} ${c.coinType}`,
    };
  });
}

async function explainNode(state: State) {
  const facts = {
    operations: state.operations,
    protocols: state.protocols.map((p) => ({
      name: p.name,
      category: p.category,
      audited: p.audited,
    })),
    balanceChanges: formatBalanceChangesForPrompt(state.simulation?.balanceChanges),
    riskScore: state.riskScore,
    riskFlags: state.riskFlags,
    walletHistory: state.history,
    similarPatterns: state.similarPatterns,
  };

  let explanation = "";
  let gonkaVerification: State["gonkaVerification"] = null;

  // Primary: Decentralized Dual-Model Verification via Gonka Router
  if (process.env.GONKA_API_KEY) {
    try {
      const result = await runGonkaExplainVerification(facts);
      explanation = result.explanation;
      gonkaVerification = result.gonkaVerification;
    } catch (err) {
      console.error(
        "explain: Gonka Router verification failed, falling back to Gemini:",
        err instanceof Error ? err.message : err
      );
    }
  }

  if (!explanation) {
    try {
      const response = await getLlm().invoke([
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Transaction facts:\n${JSON.stringify(facts, null, 2)}\n\nExplain this Solana transaction to a non-technical user in 3–5 sentences. Use the pre-formatted token amounts (formattedAmount) directly.`,
        },
      ]);
      explanation = response.content as string;
    } catch (err) {
      console.error(
        "explain: LLM unavailable, using deterministic summary:",
        err instanceof Error ? err.message : err
      );
      explanation = fallbackExplanation(state);
    }
  }

  // Publish immutable security audit dossier to Walrus decentralized storage (if configured)
  let walrusBlobId: string | null = null;
  let walrusUrl: string | null = null;
  try {
    const walrusRes = await publishAuditToWalrus({
      timestamp: new Date().toISOString(),
      sender: state.walletAddress,
      operations: state.operations,
      protocols: state.protocols,
      simulation: state.simulation,
      riskScore: state.riskScore,
      riskFlags: state.riskFlags,
      recommendation: state.recommendation,
      explanation,
      gonkaVerification,
    });
    if (walrusRes) {
      walrusBlobId = walrusRes.blobId;
      walrusUrl = walrusRes.explorerUrl;
    }
  } catch (err: unknown) {
    console.warn(
      "[walrus] Audit publishing error:",
      err instanceof Error ? err.message : String(err)
    );
  }

  return {
    explanation,
    gonkaVerification,
    walrusBlobId,
    walrusUrl,
  };
}

function fallbackExplanation(state: State): string {
  const named = state.protocols.filter((p) => p.name !== "Unknown");
  const unknownCount = state.protocols.length - named.length;

  const parts: string[] = [];
  parts.push(
    `This Solana transaction runs ${state.operations.length} operation(s)` +
      (named.length > 0
        ? ` involving ${named.map((p) => p.name).join(", ")}.`
        : ".")
  );
  if (unknownCount > 0) {
    parts.push(
      `It interacts with ${unknownCount} unverified Solana program(s) that are not in the verified protocol registry.`
    );
  }
  if (state.riskFlags.length > 0) {
    parts.push(`Flagged concerns: ${state.riskFlags.join("; ")}.`);
  }
  const exploitMatch = (state.similarPatterns ?? []).find(
    (p) => p.category === "exploit" && p.similarity >= 0.8
  );
  if (exploitMatch) {
    parts.push(
      `It closely resembles a known exploit or drainer pattern: ${exploitMatch.description}`
    );
  }
  parts.push(
    `Rule-based risk score: ${state.riskScore}/100 — recommendation: ${state.recommendation}.`
  );
  return parts.join(" ");
}

// ── graph wiring ──────────────────────────────────────────────────

const builder = new StateGraph(AgentState)
  .addNode("parse", parseNode)
  .addNode("lookup", lookupNode)
  .addNode("plan", planNode)
  .addNode("simulate", simulateNode)
  .addNode("fetch_history", historyNode)
  .addNode("vector_search", vectorSearchNode)
  .addNode("risk", riskNode)
  .addNode("explain", explainNode)
  .addEdge(START, "parse")
  .addEdge("parse", "lookup")
  .addEdge("lookup", "plan")
  .addConditionalEdges("plan", routeAfterPlan, [
    "simulate",
    "fetch_history",
    "vector_search",
  ])
  .addEdge("simulate", "risk")
  .addEdge("fetch_history", "risk")
  .addEdge("vector_search", "risk")
  .addEdge("risk", "explain")
  .addEdge("explain", END);

export const graph = builder.compile();
