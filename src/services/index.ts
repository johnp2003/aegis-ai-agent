/**
 * Single construction point for the SuiService.
 * Instantiates RpcSuiService against the configured SUI_RPC_URL.
 */

import { RpcSuiService } from "./rpc-sui-service.js";
import { SuiService } from "./sui-service.js";

export type { SuiService } from "./sui-service.js";

export function getSuiMode(): string {
  return "rpc";
}

let instance: SuiService | null = null;

export function createSuiService(): SuiService {
  if (!instance) {
    instance = new RpcSuiService(
      process.env.SUI_RPC_URL ?? "https://fullnode.testnet.sui.io:443"
    );
  }
  return instance;
}

export * from "./gonka-service.js";

