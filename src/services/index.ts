/**
 * Single construction point for the SolanaService.
 * Instantiates RpcSolanaService against configured RPC URLs.
 */

import { RpcSolanaService } from "./rpc-solana-service.js";
import { SolanaService, SolanaCluster } from "./solana-service.js";

export type { SolanaService, SolanaCluster } from "./solana-service.js";

export function getSolanaCluster(): SolanaCluster {
  const cluster = (process.env.SOLANA_DEFAULT_CLUSTER || "mainnet").toLowerCase();
  return cluster === "devnet" ? "devnet" : "mainnet";
}

let instance: SolanaService | null = null;

export function createSolanaService(): SolanaService {
  if (!instance) {
    instance = new RpcSolanaService(
      process.env.SOLANA_DEVNET_RPC_URL,
      process.env.SOLANA_MAINNET_RPC_URL || process.env.SOLANA_RPC_URL,
      getSolanaCluster()
    );
  }
  return instance;
}

export * from "./gonka-service.js";
export * from "./walrus-service.js";
