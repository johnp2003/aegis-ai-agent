/**
 * SolanaService — abstraction boundary between the agent and Solana network.
 */

import { SimResult } from "../state.js";

export type SolanaCluster = "mainnet" | "devnet";

export interface SolanaService {
  /**
   * Simulate transaction execution without modifying on-chain state.
   */
  simulate(rawTx: string, cluster?: SolanaCluster): Promise<SimResult>;

  /**
   * Summarize the wallet's recent transaction activity.
   */
  getHistorySummary(walletAddress: string, cluster?: SolanaCluster): Promise<string>;
}
