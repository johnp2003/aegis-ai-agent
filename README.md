# 🧠 AEGIS AI Agent

> The LangGraph & Gonka Router pipeline that turns a raw, unsigned Sui transaction into a dual-model verified, plain-English verdict.

![Node.js](https://img.shields.io/badge/Node.js-24-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![LangGraph](https://img.shields.io/badge/LangGraph-StateGraph-1C3C3C?logo=langchain&logoColor=white)
![Gonka Router](https://img.shields.io/badge/Gonka_Router-Dual--Model_Consensus-00C7B7)
![Gemini](https://img.shields.io/badge/Gemini-2.5_Flash--Lite-4285F4?logo=googlegemini&logoColor=white)
![Sui](https://img.shields.io/badge/Sui-gRPC_Dry--Run-4DA2FF?logo=sui&logoColor=white)
![Qdrant](https://img.shields.io/badge/Qdrant-Vector_Search-DC244C)
![Walrus](https://img.shields.io/badge/Walrus-Blob_Audit_Storage-1B86FF)
![Fastify](https://img.shields.io/badge/Fastify-SSE_Server-000000?logo=fastify&logoColor=white)
![Status](https://img.shields.io/badge/status-hackathon_build-orange)

This is the **backend agent** for [AEGIS](https://github.com/Aidenthien/muba_hackathon_AEGIS) — the pre-execution security oracle for Sui. The Chrome extension and dApp SDK live in the sibling [muba_hackathon_AEGIS](https://github.com/Aidenthien/muba_hackathon_AEGIS) repo; this repo is the server they call to actually *decide* whether a transaction is safe.

---

## 📚 Table of Contents

- [📝 Description](#-description)
- [💡 Why We Built AEGIS](#-why-we-built-aegis)
- [✨ Features](#-features)
- [⚙️ How It Works](#️-how-it-works)
- [🤝 Dual-Model Consensus (Gonka Router)](#-dual-model-consensus-gonka-router)
- [🧮 The Risk Engine](#-the-risk-engine)
- [🔌 API Reference](#-api-reference)
- [🧱 Technology Stack](#-technology-stack)
- [🚀 Getting Started](#-getting-started)
- [👥 Team](#-team)

---

## 📝 Description

AEGIS is an AI Agent that answers one question: *"If I sign this exact transaction, what happens — and should I?"*

Users are forced to sign complex transactions that sometimes they can't understand. These transactions are too fast, once you click sign, it's too late. AEGIS solves this by decoding, simulating, and explaining the exact risk before you sign

## 💡 Why We Built AEGIS

Signing Web3 transactions blindly leads to lost funds. On Sui, this is driven by three key problems:

1. **Hidden Scams in Complex Transactions** — Multi-step transactions make it easy for attackers to hide malicious drainers inside innocent-looking interactions.
2. **User Signs Blindly** — Wallets display raw hex code and technical data instead of showing what will actually happen to your assets.
3. **Zero Room for Error** — Sui finalizes in ~400ms with no mempool waiting room. Once signed, funds are gone instantly with no way to undo or revoke.

**AEGIS simulates transactions before you sign**, catching hidden scams and giving you a clear, plain-English verdict so you never have to sign blindly.

## ✨ Features

- 🧭 **Constrained LLM routing** — the plan node picks from a closed `zod` enum of 3 known steps; it cannot invent a step or call an arbitrary tool.
- 🔬 **Deterministic Move simulation** — real gRPC dry-runs against live Sui chain state (`simulateTransaction`), not a guess about intent.
- 📖 **Known-protocol registry** — Cetus, NAVI, Scallop, Aftermath, Bucket Protocol pre-loaded with audit status and risk tier; anything else is explicitly labeled `Unknown` / `high risk`, never silently trusted.
- 🤝 **Dual-Model Cross-Verification (Gonka Router)** — dispatches parallel inference across two distinct decentralized models (`DeepSeek-V4-Flash` and `MiniMax-M2.7`) with neutral prompts and strict evidence citations.
- 🛡️ **Defense-in-Depth Consensus Engine** — automatically resolves model divergence by choosing the strictest conservative verdict and dynamically scoring Truth Confidence (0–100%).
- 🧮 **Transparent, auditable risk scoring** — a fixed, additive point system (see [The Risk Engine](#-the-risk-engine)) anyone can read top to bottom, with human-readable flags attached to every point.
- 🕵️ **Exploit pattern matching** — semantic vector search (Qdrant + Gemini embeddings) over a curated set of exploit / benign / edge-case transaction shapes, with a zero-infra local fallback.
- 📜 **Permanent Audit Proofs (Walrus Storage + MongoDB)** — stores cryptographic audit records, request proof IDs (`x-request-id`, `x-devshard-id`), and consensus verdicts on decentralized blob storage.
- 💬 **Plain-English explanations, grounded in facts** — the prompt explicitly forbids inventing facts, mandates correct SUI/MIST unit formatting, and requires naming protocols by name, not package ID.
- 🛟 **Fails safe, never fails silent** — every LLM call, every RPC call, and every vector search has a deterministic fallback path; the pipeline never crashes mid-analysis.
- 🌊 **Streaming, step-by-step transparency** — `/analyze-stream` emits SSE frames for every tool as it runs (`tool_start`/`tool_end`/`thought`), so the calling UI can show its work in real time instead of a blank spinner.
- 🔑 **zkLogin & Sponsored Transactions (Enoki)** — Seamless Web2 social login via zkLogin paired with Enoki sponsored gas pools so users can onboard and transact completely gasless without holding SUI.
- ⚡ **Low-latency execution** — thinking tokens are disabled where they don't add value, and network calls (dry-run, history, vector search, parallel model inference) execute concurrently.

## ⚙️ How It Works

![AEGIS Architecture and Concept](https://res.cloudinary.com/dzumvmtzs/image/upload/v1788535965/AEGIS_Pitching_Slides_cimmeo.png)

### Graph Nodes

| # | Node | What it does |
|---|------|---|
| 1 | **parse** | Decodes the raw PTB into a list of operations (`MoveCall:...`, `transfer_objects`, `split_coins`, ...) and extracts every package ID it touches. |
| 2 | **lookup** | Resolves each package ID against `data/protocols.json`. No match → `{ name: "Unknown", audited: false, risk: "high" }`. |
| 3 | **plan** | Decides whether `wallet_history` and/or `vector_search` are worth running, from precomputed booleans and an explicit rule. Falls back to an identical deterministic heuristic on LLM error or `AGENT_REASONING=lite`. |
| 4 | **simulate** | Dry-runs the PTB via Sui gRPC (`simulateTransaction`) — real balance changes, object changes, gas cost, events. Never touches on-chain state. |
| 5 | **fetch_history** *(conditional)* | Summarizes the wallet's recent on-chain activity (object count) via `listOwnedObjects`. |
| 6 | **vector_search** *(conditional)* | Embeds the transaction's operations/protocols and searches Qdrant for semantically similar known patterns; keyword-based local fallback if Qdrant isn't configured. |
| 7 | **risk** | Pure, additive rule engine — turns the facts gathered so far into a score, flags, and a recommendation. |
| 8 | **explain** | Dispatches dual-model consensus via **Gonka Router** (`DeepSeek-V4-Flash` + `MiniMax-M2.7`) to produce an objective, evidence-cited plain-English explanation. Fallback to Gemini when offline. |

---

## 🤝 Dual-Model Consensus (Gonka Router)

To prevent single-model hallucination or bias, AEGIS leverages **Gonka Router** (`https://api.gonkarouter.io/v1`) to run parallel decentralized inference across two independent foundation models:

- **Model A**: `deepseek-ai/DeepSeek-V4-Flash-0731`
- **Model B**: `MiniMaxAI/MiniMax-M2.7`

```
                      ┌──▶ Model A (DeepSeek) ──▶ Verdict A + Citations ──┐
Gonka Router Payload ─┤                                                    ├──▶ Consensus Engine
                      └──▶ Model B (MiniMax)  ──▶ Verdict B + Citations ──┘
```

### Consensus & Conflict Resolution Engine

1. **Unanimous Consensus**: If both Model A and Model B return the same verdict (`approve`, `caution`, or `reject`), the verdict is finalized and the **Truth Score** receives a confidence boost (up to 100%).
2. **Defense-in-Depth Divergence Policy**: If the models disagree (e.g. Model A says `approve` while Model B flags `caution` or `reject`), the consensus engine automatically enforces the **strictest conservative verdict** (`reject` > `caution` > `approve`) and lowers the Truth Score accordingly.
3. **Neutrality & Evidence Requirement**: Both models are instructed with strict neutrality prompts requiring them to cite specific data points (e.g. *"Net outflow -10 SUI"*, *"Interacts with unverified package"*).
4. **Verifiable Proof Headers**: Every request captures on-chain proof headers (`x-request-id`, `x-devshard-id`) to verify authentic decentralized execution.

## 🧮 The Risk Engine

`scoreRisk` in `src/tools.ts` — a fully transparent, additive point system, capped at 100:

| Condition | Points | Why it matters |
|---|:---:|---|
| 🚫 Interacts with an unverified contract | **+40** | Not in the known-protocol registry — the single strongest predictor of malicious intent |
| ⚠️ Uses an unaudited (but known) protocol | **+20** | Known code, but no third-party security review |
| 📤 Transfers objects out of the wallet | **+15** | Baseline signal for any asset outflow |
| 🗑️ Deletes/burns an object or capability | **+30** | Often irreversible — matches the "capability deletion attack" pattern |
| 💰 Moves more than 50 SUI | **+20** | Large-value moves warrant extra scrutiny |
| 🧵 More than 4 operations in one transaction | **+20** | Complexity makes a transaction hard for a human to verify by eye |
| 🏦 Opens a debt/leveraged borrow position | **+20** | Carries liquidation exposure the user may not expect |
| 🕸️ Touches 3+ protocols in one transaction | **+15** | Compounding surface area across multiple trust boundaries |
| 🧬 Matches a known exploit pattern (≥80% similarity) | **+20** | Semantic match against curated exploit signatures |

**Verdict thresholds:** `score ≥ 60` → **reject** · `score ≥ 30` → **caution** · else → **approve**

Every point comes with a plain-language flag (`riskFlags`), so a judge — or a user — can see exactly *why* a score is what it is. Nothing here is a black box.

## 🔌 API Reference

| Method & Path | Body | Response |
|---|---|---|
| `GET /health` | — | `{ ok: true, suiMode: "rpc" }` |
| `POST /analyze` | `{ rawPtb: string, walletAddress: string }` | Full analysis JSON (see example above) |
| `POST /analyze-stream` | `{ rawPtb: string, walletAddress: string }` | `text/event-stream` — a `tool_start`/`tool_end`/`thought` frame per node, then one final `{ type: "result", data: {...} }` frame |

SSE frame shapes match exactly what the AEGIS Chrome extension's confirmation popup consumes — see `test:demo` / `test:scenarios` in the [sibling frontend repo](https://github.com/Aidenthien/muba_hackathon_AEGIS) for the client side of this contract.

## 🧱 Technology Stack

- **Runtime & Language:** Node.js 24, TypeScript 5
- **Server:** Fastify 5
- **Agent Orchestration:** LangGraph (`@langchain/langgraph`)
- **Consensus & Decentralized AI:** [Gonka Router](https://api.gonkarouter.io/v1) (`DeepSeek-V4-Flash` + `MiniMax-M2.7`)
- **LLM & Embeddings:** Google Gemini (2.5 Flash-Lite & text-embedding-004)
- **Blockchain:** Sui (`@mysten/sui` gRPC SDK)
- **Auth & Gas:** Enoki (zkLogin & Sponsored Gas), Slush
- **Vector Database:** Qdrant
- **Audit & Storage:** Walrus Storage, MongoDB

## 🚀 Getting Started

### Prerequisites

- Node.js 24 (see `langgraph.json` / `.env.example`)
- `pnpm` (the project is pinned to `pnpm@10.26.2`)
- A [Google AI Studio](https://aistudio.google.com/) API key (`GOOGLE_API_KEY`)
- A [Gonka Router](https://api.gonkarouter.io/v1) API key (`GONKA_API_KEY`) for dual-model decentralized consensus
- *(Optional)* A [Qdrant](https://qdrant.tech/) instance for vector search — the agent runs fine without one, using the local keyword-pattern fallback
- *(Optional)* A [MongoDB](https://www.mongodb.com/) instance for audit log storage

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env.local`:

```bash
GOOGLE_API_KEY=your-google-api-key-here
GEMINI_MODEL=gemini-2.5-flash-lite

# Gonka Network Router (Dual-Model Consensus)
GONKA_API_KEY=your-gonka-api-key-here
GONKA_BASE_URL=https://api.gonkarouter.io/v1
GONKA_MODEL_PRIMARY=deepseek-ai/DeepSeek-V4-Flash-0731
GONKA_MODEL_SECONDARY=MiniMaxAI/MiniMax-M2.7
GONKA_TIMEOUT_MS=45000

# Sui RPC & Agent Config
SUI_RPC_URL=https://fullnode.testnet.sui.io:443
SUI_MODE=rpc
AGENT_REASONING=full
PORT=3001

# Optional — Vector Search & Audit DB
QDRANT_URL=
QDRANT_API_KEY=
MONGODB_URI=
```

### 3. Run the server

```bash
pnpm dev     # tsx watch src/server.ts — listens on http://localhost:3001
```

Check it's alive:

```bash
curl http://localhost:3001/health
```

### 4. (Optional) Seed Qdrant with the exploit-pattern library

```bash
pnpm seed:qdrant       # embeds data/patterns.json into your Qdrant collection
pnpm test:search       # sanity-check retrieval
```

### 5. Run the demo/integration scenarios

```bash
pnpm test:demo                              # scripted PTBs, standalone
pnpm tsx test/muba-scenarios.ts <address>   # replays the frontend's exact demo scenarios against a live server
```

### Connecting the frontend

The [AEGIS Chrome extension](https://github.com/Aidenthien/muba_hackathon_AEGIS) calls this server directly at `http://localhost:3001` — start this agent first, then load the extension and point its toolbar-icon "Agent server" field at this instance if it's running anywhere other than the default.

---

## 👥 Team

- **John Paulose** – Full Stack Developer
- **Thien Wei Jian** – Full Stack Developer

---

<p align="center">
  <strong>🛡️ Stop the exploit before the signature.</strong>
</p>

