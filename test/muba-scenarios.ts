/**
 * Integration test: replays the muba-hackathon Transaction Lab scenarios
 * (src/components/demo/scenarios.ts in that repo) against a running agent
 * server, exactly as the frontend does — Transaction#toJSON with a real
 * connected-wallet sender. Run with the server in SUI_MODE=rpc to verify
 * the live integration.
 *
 *   pnpm tsx test/muba-scenarios.ts [senderAddress]
 */

import { Transaction } from "@mysten/sui/transactions";

const SERVER = process.env.AGENT_SERVER_URL ?? "http://localhost:3001";

// Same synthetic package IDs the muba-hackathon demo uses.
const CETUS_PACKAGE =
  "0xa9556bc9000000000000000000000000000000000000000000000000000000a1";
const UNKNOWN_PACKAGE =
  "0xdeadbeef00000000000000000000000000000000000000000000000000000bad";
const MIST_PER_SUI = 1_000_000_000n;

// A funded testnet address stands in for the connected wallet.
const SENDER =
  process.argv[2] ??
  "0xcca26f7ae2e40604498294e95bacccc4652cc8cb2aa074d7ee608c7e7bdf0c29";

function buildSafeTransfer(sender: string): Transaction {
  const tx = new Transaction();
  tx.setSender(sender);
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(50_000_000n)]);
  tx.transferObjects([coin], tx.pure.address(sender));
  return tx;
}

function buildCetusSwap(sender: string): Transaction {
  const tx = new Transaction();
  tx.setSender(sender);
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(MIST_PER_SUI)]);
  tx.moveCall({
    target: `${CETUS_PACKAGE}::router::swap_exact_input`,
    arguments: [coin],
  });
  return tx;
}

function buildWalletDrain(sender: string): Transaction {
  const tx = new Transaction();
  tx.setSender(sender);
  const [loot] = tx.splitCoins(tx.gas, [tx.pure.u64(60n * MIST_PER_SUI)]);
  tx.moveCall({
    target: `${UNKNOWN_PACKAGE}::rewards::burn_for_airdrop`,
    arguments: [],
  });
  tx.transferObjects(
    [loot],
    tx.pure.address(
      "0x0000000000000000000000000000000000000000000000000000000000000bad"
    )
  );
  return tx;
}

const SCENARIOS: {
  id: string;
  expected: "approve" | "caution" | "reject";
  build: (sender: string) => Transaction;
}[] = [
    { id: "safe-transfer", expected: "approve", build: buildSafeTransfer },
    { id: "cetus-swap", expected: "approve", build: buildCetusSwap },
    { id: "wallet-drain", expected: "reject", build: buildWalletDrain },
  ];

let failures = 0;

for (const s of SCENARIOS) {
  const tx = s.build(SENDER);
  const rawPtb = await tx.toJSON();

  const started = Date.now();
  const res = await fetch(`${SERVER}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rawPtb, walletAddress: SENDER }),
  });
  const ms = Date.now() - started;
  const data = await res.json();

  console.log(`\n── ${s.id} (${ms} ms) ──`);
  if (!res.ok) {
    failures++;
    console.log(`HTTP ${res.status}:`, JSON.stringify(data));
    continue;
  }
  console.log(
    `risk ${data.riskScore} | ${data.recommendation} (expected ${s.expected}) | sim: ${data.simulation?.status}`
  );
  console.log(`flags: ${data.riskFlags?.join(" · ") || "none"}`);
  console.log(
    `balances: ${JSON.stringify(data.simulation?.balanceChanges ?? [])}`
  );
  console.log(`explanation: ${data.explanation}`);

  if (data.recommendation !== s.expected) {
    failures++;
    console.log(`✗ recommendation mismatch`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(`\nAll scenarios matched.`);
