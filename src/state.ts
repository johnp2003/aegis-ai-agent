/**
 * AgentState — the single object that flows through every node of the graph.
 * Each node receives the full state and returns a partial update that
 * LangGraph merges before calling the next node.
 */

import { Annotation } from "@langchain/langgraph";

export interface SimResult {
  status: string;
  balanceChanges: { coinType: string; amount: string }[];
  objectChanges: string[];
  gasUsed: { computationCost: string; storageCost: string };
  events: string[];
}

export interface Protocol {
  packageId: string;
  name: string;
  category: string;
  audited: boolean;
  risk: "low" | "medium" | "high" | "unknown";
}

export interface SimilarPattern {
  description: string;
  category: string;
  riskLevel: string;
  similarity: number;
}

export const AgentState = Annotation.Root({
  // inputs
  rawPtb:         Annotation<string>,
  walletAddress:  Annotation<string>,

  // filled by tools
  operations:     Annotation<string[]>,
  packageIds:     Annotation<string[]>,
  simulation:     Annotation<SimResult | null>,
  protocols:      Annotation<Protocol[]>,
  history:        Annotation<string>,
  similarPatterns: Annotation<SimilarPattern[]>,
  riskScore:      Annotation<number>,
  riskFlags:      Annotation<string[]>,

  // filled by the plan node
  plannedSteps:   Annotation<string[]>,
  planReasoning:  Annotation<string>,
  planSource:     Annotation<"llm" | "heuristic">,

  // outputs
  explanation:    Annotation<string>,
  recommendation: Annotation<"approve" | "caution" | "reject">,
});

export type State = typeof AgentState.State;
