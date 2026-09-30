# 🧠 AEGIS Solana AI Agent

> The LangGraph & Gonka Router pipeline that turns a raw, unsigned Solana transaction into a dual-model verified, plain-English verdict.

![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![LangGraph](https://img.shields.io/badge/LangGraph-StateGraph-1C3C3C?logo=langchain&logoColor=white)
![Solana](https://img.shields.io/badge/Solana-Web3.js-9945FF?logo=solana&logoColor=white)
![Gonka Router](https://img.shields.io/badge/Gonka_Router-Dual--Model_Consensus-00C7B7)
![Gemini](https://img.shields.io/badge/Gemini-2.5_Flash--Lite-4285F4?logo=googlegemini&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-SSE_Server-000000?logo=fastify&logoColor=white)
![Status](https://img.shields.io/badge/status-active_build-green)

This is the **AI Agent backend** for AEGIS — the pre-execution security oracle for Solana. It receives raw unsigned Solana transactions, simulates them against live cluster state, validates programs against verified registries, scores threat risks, and produces plain-English verdicts.

---

## 📚 Table of Contents

- [📝 Description](#-description)
- [💡 Why We Built AEGIS for Solana](#-why-we-built-aegis-for-solana)
- [✨ Key Features](#-key-features)
- [⚙️ How It Works (Pipeline)](#️-how-it-works-pipeline)
- [🌐 Dual-Cluster Routing (Devnet & Mainnet)](#-dual-cluster-routing-devnet--mainnet)
- [🧮 Solana Risk Engine](#-solana-risk-engine)
- [🤝 Dual-Model Consensus (Gonka Router)](#-dual-model-consensus-gonka-router)
- [🔌 API Reference](#-api-reference)
- [🚀 Quick Start](#-quick-start)

---

## 📝 Description

AEGIS is an AI agent that answers: *"If I sign this exact Solana transaction, what happens — and should I?"*

On Solana, transactions execute in sub-second slots. Phishing sites and wallet drainers often deceive users into signing malicious `SetAuthority` or unbounded token `Approve` instructions that drain tokens or take over accounts. AEGIS inspects, simulates, and scores transactions **before the user ever signs**.

---

## 💡 Why We Built AEGIS for Solana

1. **Obscure Instruction Payloads**: Transactions contain compiled instruction data that wallets often show as raw base58/hex bytes.
2. **Dangerous Token Authority Changes**: A single SPL Token `SetAuthority` or unbounded `Approve` instruction can permanently grant attackers control over an Associated Token Account.
3. **No Undo in Sub-Second Finality**: Once signed, Solana confirms in ~400ms. Pre-flight simulation and risk scoring are the only line of defense.

---

## ✨ Key Features

- 🧭 **Constrained LLM Planning**: The plan node selects from a fixed set of analysis steps (`simulate`, `wallet_history`, `vector_search`) using deterministic rules and fallback heuristics.
- 🔬 **Deterministic SVM Simulation**: Real RPC simulation via `@solana/web3.js` (`simulateTransaction`) extracting compute units, program logs, and balance shifts.
- 🌐 **Dual-Cluster Routing**: Seamlessly test on **Devnet** for basic transfers/faucets and **Mainnet** for live DeFi protocols (Jupiter, Raydium, Orca).
- 📖 **Solana Protocol Registry**: Verified Program IDs (System Program, SPL Token, Token-2022, Jupiter v6, Raydium, Orca, Kamino). Unknown programs are strictly labeled `Unknown` / `high risk`.
- 🧮 **Additive Solana Risk Rules**: Specific detection for `SetAuthority` takeovers, unbounded `Approve` delegate spending, `CloseAccount` rent sweeps, and large SOL drains.
- 🤝 **Dual-Model Decentralized Consensus (Gonka)**: Dispatches parallel inference across `DeepSeek-V4` and `MiniMax-M2.7` to prevent hallucinations.
- 🌊 **Streaming SSE Transparency**: `/analyze-stream` streams step-by-step progress events in real time.

---

## ⚙️ How It Works (Pipeline)

```
START ─▶ parse ─▶ lookup ─▶ plan ──┬─▶ simulate ─────────┐
                                  ├─▶ fetch_history ────┤ (fan-in)
                                  └─▶ vector_search ────┴─▶ risk ─▶ explain ─▶ END
```

| Step | Node | Description |
| :--- | :--- | :--- |
| 1 | **parse** | Decodes `VersionedTransaction` or legacy `Transaction` into instruction kinds (`system:transfer`, `token:approve`, `jupiter:swap`, etc.) and program IDs. |
| 2 | **lookup** | Matches program IDs against `data/protocols.json`. |
| 3 | **plan** | Determines whether wallet history or semantic vector search are necessary. |
| 4 | **simulate** | Runs `simulateTransaction` on Solana RPC node for compute units, logs, and status. |
| 5 | **fetch_history** | Inspects wallet transaction count and SOL balance. |
| 6 | **vector_search** | Compares operations against known Solana drainer and exploit signatures. |
| 7 | **risk** | Applies rule-based scoring (0–100) to output a recommendation: `approve`, `caution`, or `reject`. |
| 8 | **explain** | Generates a 3–5 sentence plain-English explanation via Gonka dual-model consensus or Gemini. |

---

## 🌐 Dual-Cluster Routing (Devnet & Mainnet)

Configure both RPCs in your `.env`:

```env
SOLANA_DEVNET_RPC_URL=https://devnet.helius-rpc.com/?api-key=YOUR_KEY
SOLANA_MAINNET_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
SOLANA_DEFAULT_CLUSTER=mainnet
```

Pass `"cluster": "devnet"` or `"cluster": "mainnet"` in the request body to direct the agent.

---

## 🧮 Solana Risk Engine

Additive point system (0–100):

| Condition | Points | Risk Vector |
| :--- | :---: | :--- |
| 🚫 **Unverified Program ID** | **+40** | Unknown contract code not in verified registries |
| ⚠️ **SetAuthority Modification** | **+35** | Reassigning token account ownership or mint authority |
| 🔓 **Token Approve (Delegate)** | **+30** | Granting external delegate spending rights over SPL tokens |
| 💰 **Large SOL Outflow (>10 SOL)** | **+20** | High-value outbound transfer |
| 🗑️ **CloseAccount Sweep** | **+20** | Reclaiming rent lamports to an external counterparty |
| 🧬 **Known Exploit Pattern (≥80% match)** | **+25** | Matches known phishing/drainer vector |

**Verdict:** `score ≥ 60` $\rightarrow$ **reject** · `score ≥ 30` $\rightarrow$ **caution** · `< 30` $\rightarrow$ **approve**

---

## 🔌 API Reference

### `POST /analyze`
Analyzes a Solana transaction synchronously.

```json
{
  "rawTransaction": "<base64 or base58 serialized tx>",
  "walletAddress": "4Nd1mBQtrMJVYVfKf2PJy9NZzqdPE635D44KcxFpx5T8",
  "cluster": "mainnet"
}
```

### `POST /analyze-stream`
Streams SSE events for live execution inspection:
`parse_transaction` $\rightarrow$ `lookup_protocol` $\rightarrow$ `plan_agent` $\rightarrow$ `dry_run_rpc` $\rightarrow$ `score_risk` $\rightarrow$ `gonka_verification` $\rightarrow$ `result`.

---

## 🚀 Quick Start

1. Install dependencies:
   ```bash
   pnpm install
   ```

2. Start the agent server:
   ```bash
   pnpm dev
   ```

3. Run automated demo test scenarios:
   ```bash
   pnpm test:demo
   ```
