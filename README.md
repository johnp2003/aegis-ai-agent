# 🧠 AEGIS AI Agent — The Reasoning Core of AEGIS

> The LangGraph pipeline that turns a raw, unsigned Sui transaction into a plain-English verdict — in under 3 seconds, with only 2 of 8 nodes ever touching an LLM.

![Node.js](https://img.shields.io/badge/Node.js-24-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![LangGraph](https://img.shields.io/badge/LangGraph-StateGraph-1C3C3C?logo=langchain&logoColor=white)
![Gemini](https://img.shields.io/badge/Gemini-2.5_Flash--Lite-4285F4?logo=googlegemini&logoColor=white)
![Sui](https://img.shields.io/badge/Sui-gRPC_Dry--Run-4DA2FF?logo=sui&logoColor=white)
![Qdrant](https://img.shields.io/badge/Qdrant-Vector_Search-DC244C)
![Fastify](https://img.shields.io/badge/Fastify-SSE_Server-000000?logo=fastify&logoColor=white)
![Status](https://img.shields.io/badge/status-hackathon_build-orange)

This is the **backend agent** for [AEGIS](../muba_hackathon_AEGIS-main) — the pre-execution security oracle for Sui. The Chrome extension and dApp SDK live in the sibling `muba_hackathon_AEGIS-main` repo; this repo is the server they call to actually *decide* whether a transaction is safe.

---

## 📚 Table of Contents

- [📝 Description](#-description)
- [✨ Features](#-features)
- [⚙️ How It Works](#️-how-it-works)
- [🧮 The Risk Engine](#-the-risk-engine)
- [🔌 API Reference](#-api-reference)
- [🚀 Getting Started](#-getting-started)
- [🧱 Technology Stack](#-technology-stack)
- [🗂️ Repository Layout](#️-repository-layout)

---

## 📝 Description

AEGIS AI Agent is a **LangGraph `StateGraph`** exposed over HTTP (Fastify) that answers one question: *"If I sign this exact transaction, what happens — and should I?"*

It receives a raw Programmable Transaction Block (PTB) and a wallet address, deterministically dry-runs it against live Sui chain state, resolves every contract it touches against a known-protocol registry, checks the shape of the transaction against a library of known exploit patterns, and produces a **risk score (0–100)**, a **verdict** (`approve` / `caution` / `reject`), and a **plain-English explanation** — all before any wallet is asked to sign anything.

Of the 8 nodes in the graph, only **2 ever call an LLM** — and neither of those two can move money, touch chain state, or override a rule-based score. The rest is deterministic TypeScript.

## ✨ Features

- 🧭 **Constrained LLM routing** — the plan node picks from a closed `zod` enum of 3 known steps; it cannot invent a step or call an arbitrary tool.
- 🔬 **Deterministic Move simulation** — real gRPC dry-runs against live Sui chain state (`simulateTransaction`), not a guess about intent.
- 📖 **Known-protocol registry** — Cetus, NAVI, Scallop, Aftermath, Bucket Protocol pre-loaded with audit status and risk tier; anything else is explicitly labeled `Unknown` / `high risk`, never silently trusted.
- 🧮 **Transparent, auditable risk scoring** — a fixed, additive point system (see [The Risk Engine](#-the-risk-engine)) anyone can read top to bottom, with human-readable flags attached to every point.
- 🕵️ **Exploit pattern matching** — semantic vector search (Qdrant + Gemini embeddings) over a curated set of exploit / benign / edge-case transaction shapes, with a zero-infra local fallback.
- 💬 **Plain-English explanations, grounded in facts** — the explain-node prompt explicitly forbids inventing facts, mandates correct SUI/MIST unit formatting, and requires naming protocols by name, not package ID.
- 🛟 **Fails safe, never fails silent** — every LLM call, every RPC call, and every vector search has a deterministic fallback path; the pipeline never crashes mid-analysis.
- 🌊 **Streaming, step-by-step transparency** — `/analyze-stream` emits SSE frames for every tool as it runs (`tool_start`/`tool_end`/`thought`), so the calling UI can show its work in real time instead of a blank spinner.
- ⚡ **Sub-3-second target latency** — only 2 of 8 nodes call an LLM, thinking tokens are disabled where they don't add value, and network calls (dry-run, history, vector search) run in parallel via LangGraph's fan-out.

## ⚙️ How It Works

### The graph

```
                                   ┌──────────────┐
                        ┌─────────▶│   simulate   │──┐
                        │          └──────────────┘  │
 START ──▶ parse ──▶ lookup ──▶ plan                 ├──▶ risk ──▶ explain ──▶ END
                        │          ┌──────────────┐  │
                        ├─────────▶│ fetch_history│──┤
                        │          └──────────────┘  │
                        │          ┌──────────────┐  │
                        └─────────▶│ vector_search│──┘
                                   └──────────────┘
        (plan always routes to `simulate`; the other two are conditional)
```

| # | Node | Calls an LLM? | What it does |
|---|------|:---:|---|
| 1 | **parse** | ❌ | Decodes the raw PTB into a list of operations (`MoveCall:...`, `transfer_objects`, `split_coins`, ...) and extracts every package ID it touches. |
| 2 | **lookup** | ❌ | Resolves each package ID against `data/protocols.json`. No match → `{ name: "Unknown", audited: false, risk: "high" }`. |
| 3 | **plan** | ✅ *(constrained)* | Decides whether `wallet_history` and/or `vector_search` are worth running, from precomputed booleans and an explicit rule. Falls back to an identical deterministic heuristic on LLM error or `AGENT_REASONING=lite`. |
| 4 | **simulate** | ❌ | Dry-runs the PTB via Sui gRPC (`simulateTransaction`) — real balance changes, object changes, gas cost, events. Never touches on-chain state. |
| 5 | **fetch_history** *(conditional)* | ❌ | Summarizes the wallet's recent on-chain activity (object count) via `listOwnedObjects`. |
| 6 | **vector_search** *(conditional)* | ❌ *(embeds, doesn't reason)* | Embeds the transaction's operations/protocols and searches Qdrant for semantically similar known patterns; keyword-based local fallback if Qdrant isn't configured. |
| 7 | **risk** | ❌ | Pure, additive rule engine — turns the facts gathered so far into a score, flags, and a recommendation. |
| 8 | **explain** | ✅ | Translates the accumulated structured facts into a 3–5 sentence, non-technical explanation. Deterministic template fallback if the LLM is unavailable. |

### End-to-end example

```bash
curl -X POST http://localhost:3001/analyze \
  -H "Content-Type: application/json" \
  -d '{ "rawPtb": "<tx.toJSON() output>", "walletAddress": "0x7af3...c21e" }'
```

```json
{
  "explanation": "This transaction swaps 0.05 SUI through Cetus DEX, an audited exchange, and sends the result back to your wallet. No funds leave your control and no unverified contracts are involved.",
  "riskScore": 0,
  "riskFlags": [],
  "recommendation": "approve",
  "operations": ["split_coins", "MoveCall:60391...router::swap_exact_input", "transfer_objects"],
  "protocols": [{ "packageId": "0x6039...", "name": "Cetus", "category": "DEX", "audited": true, "risk": "low" }],
  "simulation": { "status": "success", "balanceChanges": [...], "objectChanges": [...], "gasUsed": {...}, "events": [] },
  "plannedSteps": ["simulate"],
  "planReasoning": "All protocols are known and audited and nothing leaves the wallet — skipping wallet history.",
  "planSource": "llm"
}
```

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

SSE frame shapes match exactly what the AEGIS Chrome extension's confirmation popup consumes — see `test:demo` / `test:scenarios` in the [sibling frontend repo](../muba_hackathon_AEGIS-main) for the client side of this contract.

## 🚀 Getting Started

### Prerequisites

- Node.js 24 (see `langgraph.json` / `.env.example`)
- `pnpm` (the project is pinned to `pnpm@10.26.2`)
- A [Google AI Studio](https://aistudio.google.com/) API key (`GOOGLE_API_KEY`) — used for both the Gemini chat model and the embeddings model
- *(Optional)* A [Qdrant](https://qdrant.tech/) instance for vector search — the agent runs fine without one, using the local keyword-pattern fallback

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env.local` and fill in at least `GOOGLE_API_KEY`:

```bash
GOOGLE_API_KEY=your-google-api-key-here
GEMINI_MODEL=gemini-2.5-flash-lite
SUI_RPC_URL=https://fullnode.testnet.sui.io:443
SUI_MODE=rpc
AGENT_REASONING=full        # or "lite" to skip the plan-node LLM call entirely
PORT=3001

# Optional — LangSmith tracing
LANGSMITH_API_KEY=
LANGSMITH_TRACING=true
LANGSMITH_PROJECT=sui-copilot

# Optional — vector search; omit to use the local pattern fallback
QDRANT_URL=
QDRANT_API_KEY=
QDRANT_COLLECTION=ptb_patterns
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

The [AEGIS Chrome extension](../muba_hackathon_AEGIS-main) calls this server directly at `http://localhost:3001` — start this agent first, then load the extension and point its toolbar-icon "Agent server" field at this instance if it's running anywhere other than the default.

## 🧱 Technology Stack

**Core**
- Node.js 24, TypeScript 5, ESM (`"type": "module"`)
- Fastify 5 (+ `@fastify/cors`) — HTTP/SSE server
- `tsx` for dev/watch and scripted execution

**Agent orchestration**
- `@langchain/langgraph` — the `StateGraph` runtime
- `@langchain/core`, `langchain` — tool + prompt primitives
- `@langchain/google-genai` — `ChatGoogleGenerativeAI` (Gemini 2.5 Flash-Lite) for planning + explanation, `GoogleGenerativeAIEmbeddings` (`gemini-embedding-001`, 3072-dim) for semantic search
- `@langchain/anthropic`, `@langchain/openai` — available in the dependency tree for model swapping, not wired into the active graph
- `zod` — schema-constrained structured output (`PlanSchema`) and tool argument validation

**Sui**
- `@mysten/sui` — PTB parsing/building and the Sui 2.0 gRPC client (`SuiGrpcClient`) for `simulateTransaction` and `listOwnedObjects`

**Vector search**
- `@qdrant/js-client-rest` — optional semantic exploit-pattern matching, with a zero-dependency local fallback

**Tooling**
- ESLint 9 + `typescript-eslint`, `dotenv`, LangSmith tracing (optional)

## 🗂️ Repository Layout

```
src/
  server.ts                 Fastify HTTP/SSE API — /analyze, /analyze-stream, /health
  graph.ts                  LangGraph StateGraph definition + all node implementations
  state.ts                  AgentState — the shared object threaded through the graph
  tools.ts                  6 deterministic tools: parse_ptb, dry_run, lookup_protocol,
                             score_risk, wallet_history, vector_search
  prompts.ts                 The two LLM prompts in the system: PLAN_PROMPT, SYSTEM_PROMPT
  env.ts                     dotenv bootstrap (must be the first import in every entry point)
  services/
    sui-service.ts           SuiService interface — network abstraction boundary
    rpc-sui-service.ts        Real Sui gRPC implementation
    index.ts                  Singleton service factory
data/
  protocols.json             Known-protocol registry (name, category, audited, risk)
  patterns.json               24 curated exploit / benign / edge-case transaction patterns
scripts/
  seed-qdrant.ts              Embeds patterns.json into Qdrant
  test-search.ts               Sanity-checks vector retrieval
test/
  muba-scenarios.ts            Replays the frontend's demo scenarios against a live server
  demo-ptbs.ts, hello-graph.ts, playground.ts
```
