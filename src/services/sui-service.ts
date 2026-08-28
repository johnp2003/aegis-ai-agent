/**
 * SuiService — the abstraction boundary between the agent and the Sui network.
 *
 * Only network-touching operations live behind this interface. Everything else
 * in the pipeline (PTB parsing, protocol registry, risk rules) is deterministic
 * and wallet-independent, so it does not need to be mocked.
 *
 * Implementation:
 *  - RpcSuiService (src/services/rpc-sui-service.ts) — real Sui JSON-RPC calls
 */

import { SimResult } from "../state.js";

export interface SuiService {
  /**
   * Simulate PTB execution without modifying on-chain state.
   * Real implementation: client.dryRunTransactionBlock on Sui RPC.
   */
  dryRun(rawPtb: string): Promise<SimResult>;

  /**
   * Summarize the wallet's recent activity as a short human-readable string.
   * Real implementation: client.queryTransactionBlocks on Sui RPC.
   */
  getHistorySummary(walletAddress: string): Promise<string>;
}
