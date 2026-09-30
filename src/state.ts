/**
 * AgentState — the single object that flows through every node of the graph.
 * Each node receives the full state and returns a partial update that
 * LangGraph merges before calling the next node.
 */

import { Annotation } from "@langchain/langgraph";

export interface SimResult {
  status: "success" | "failure" | "error";
  balanceChanges: {
    coinType: string; // e.g. "SOL", "USDC", or token mint
    amount: string;   // raw amount or formatted decimal
    symbol?: string;
    account?: string;
  }[];
  objectChanges: string[];
  gasUsed: { computationCost: string; storageCost: string };
  computeUnits?: number;
  logs?: string[];
  events: string[];
}

export interface Protocol {
  programId: string;
  packageId?: string; // alias for backwards compatibility
  name: string;
  category: string;
  audited: boolean;
  website?: string;
  risk: "low" | "medium" | "high" | "unknown";
}

export interface SimilarPattern {
  description: string;
  category: string;
  riskLevel: string;
  similarity: number;
}

export interface GonkaModelOutput {
  model: string;
  requestId: string;
  devshardId?: string;
  verdict: "approve" | "caution" | "reject";
  truthScore: number; // 0-100%
  evidenceCitations: string[];
  reasoningTrace: string;
  explanation: string;
  latencyMs?: number;
}

export interface GonkaVerificationResult {
  provider: "gonka";
  consensusAgreement: boolean;
  consensusVerdict: "approve" | "caution" | "reject";
  consensusTruthScore: number; // 0-100%
  conflictResolution?: string;
  models: {
    primary: GonkaModelOutput;
    secondary: GonkaModelOutput;
  };
}

export const AgentState = Annotation.Root({
  // inputs
  rawTransaction: Annotation<string>,
  rawPtb:         Annotation<string>, // alias for backwards compatibility
  walletAddress:  Annotation<string>,
  cluster:        Annotation<"mainnet" | "devnet">,

  // filled by tools
  operations:     Annotation<string[]>,
  programIds:     Annotation<string[]>,
  packageIds:     Annotation<string[]>, // alias for backwards compatibility
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
  gonkaVerification: Annotation<GonkaVerificationResult | null>,
  walrusBlobId:   Annotation<string | null>,
  walrusUrl:      Annotation<string | null>,
});

export type State = typeof AgentState.State;
