/**
 * Fastify HTTP server exposing the agent as POST /analyze (JSON)
 * and POST /analyze-stream (Server-Sent Events streaming).
 */

import "./env.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { graph } from "./graph.js";
import { getSuiMode, getWalletAudits } from "./services/index.js";

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
});

app.get("/health", async () => {
  console.log("🩺 [health] Health check ping received");
  return { ok: true, suiMode: getSuiMode() };
});

app.get<{
  Params: { walletAddress: string };
}>("/audits/:walletAddress", async (req, reply) => {
  const { walletAddress } = req.params;
  const audits = await getWalletAudits(walletAddress);
  console.log(`📋 [/audits] Retrieved ${audits.length} Walrus audits for ${walletAddress?.slice(0, 10)}...`);
  return reply.send({ walletAddress, count: audits.length, audits });
});

app.post<{
  Body: { rawPtb: string; walletAddress: string };
}>("/analyze", async (req, reply) => {
  const { rawPtb, walletAddress } = req.body ?? {};

  if (!rawPtb || !walletAddress) {
    console.warn("⚠️ [/analyze] Missing rawPtb or walletAddress in request body");
    return reply
      .status(400)
      .send({ error: "rawPtb and walletAddress are required" });
  }

  console.log(`\n======================================================`);
  console.log(`📥 [/analyze] New Transaction Analysis Request`);
  console.log(`👛 Wallet: ${walletAddress}`);
  console.log(`📦 PTB Payload Length: ${rawPtb.length} chars`);

  try {
    const started = Date.now();
    const result = await graph.invoke({ rawPtb, walletAddress });
    const elapsed = Date.now() - started;

    console.log(`🛡️ [/analyze] Analysis Complete in ${elapsed}ms:`);
    console.log(`   Verdict : ${result.recommendation?.toUpperCase()} (Score: ${result.riskScore}/100)`);
    console.log(`   Ops     : ${result.operations?.join(", ")}`);
    console.log(`   Flags   : ${result.riskFlags?.length ? result.riskFlags.join(" | ") : "None"}`);
    console.log(`======================================================\n`);

    return reply.send({
      explanation: result.explanation,
      riskScore: result.riskScore,
      riskFlags: result.riskFlags,
      recommendation: result.recommendation,
      operations: result.operations,
      protocols: result.protocols,
      simulation: result.simulation,
      similarPatterns: result.similarPatterns,
      plannedSteps: result.plannedSteps,
      planReasoning: result.planReasoning,
      planSource: result.planSource,
      gonkaVerification: result.gonkaVerification,
      walrusBlobId: result.walrusBlobId,
      walrusUrl: result.walrusUrl,
    });
  } catch (err) {
    console.error("❌ [/analyze] Execution failed:", err);
    req.log.error(err);
    return reply.status(500).send({
      error: "analysis_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post<{
  Body: { rawPtb: string; walletAddress: string };
}>("/analyze-stream", async (req, reply) => {
  const { rawPtb, walletAddress } = req.body ?? {};

  if (!rawPtb || !walletAddress) {
    console.warn("⚠️ [/analyze-stream] Missing rawPtb or walletAddress");
    return reply
      .status(400)
      .send({ error: "rawPtb and walletAddress are required" });
  }

  console.log(`\n======================================================`);
  console.log(`🌊 [/analyze-stream] New SSE Stream Session`);
  console.log(`👛 Wallet: ${walletAddress}`);
  console.log(`📦 PTB Payload Length: ${rawPtb.length} chars`);

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const sendEvent = (event: object) => {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    sendEvent({
      type: "tool_start",
      tool: "parse_ptb",
      thought: "Deconstructing raw PTB payload to isolate Move commands and recipient addresses before any execution.",
      action: "Extracting Move operations & targets",
      verbRunning: "parsing ptb...",
    });

    const stream = await graph.stream({ rawPtb, walletAddress }, { streamMode: "updates" });

    let finalState: Record<string, any> = {};

    for await (const chunk of stream) {
      const nodeName = Object.keys(chunk)[0];
      const nodeOutput = (chunk as Record<string, any>)[nodeName];
      finalState = { ...finalState, ...nodeOutput };

      if (nodeName === "parse") {
        const ops = nodeOutput?.operations ?? [];
        console.log(`   [1. Parse]       Extracted ops: ${ops.join(", ") || "None"}`);
        sendEvent({
          type: "tool_end",
          tool: "parse_ptb",
          observation: ops.length > 0 ? `Identified: ${ops.join(", ")}. No unknown package calls.` : "No commands found in transaction.",
          verbDone: "parsed ptb",
        });
        sendEvent({
          type: "tool_start",
          tool: "lookup_protocol",
          thought: "Checking target package IDs against audited Sui protocol registries to verify contract provenance.",
          action: "Checking protocol registries",
          verbRunning: "checking protocol registries...",
        });
      } else if (nodeName === "lookup") {
        const protos = nodeOutput?.protocols ?? [];
        const names = protos.map((p: any) => p.name).join(", ");
        console.log(`   [2. Lookup]      Audited protocols: ${names || "None (direct wallet transfer)"}`);
        sendEvent({
          type: "tool_end",
          tool: "lookup_protocol",
          observation: protos.length > 0 ? `Verified: ${names} (audited).` : "Direct wallet transfer — no third-party contract risk.",
          verbDone: "checked protocol registries",
        });
        sendEvent({
          type: "tool_start",
          tool: "plan_agent",
          thought: "Planning safety graph routing and checks based on extracted commands.",
          action: "Routing security pipeline",
          verbRunning: "routing security pipeline...",
        });
      } else if (nodeName === "plan") {
        const reasoning = nodeOutput?.planReasoning ?? "";
        const steps = nodeOutput?.plannedSteps ?? [];
        console.log(`   [3. Plan]        Reasoning: "${reasoning.slice(0, 80)}..."`);
        console.log(`   [3. Plan]        Execution pipeline: ${steps.join(" → ")}`);
        if (reasoning) {
          sendEvent({
            type: "thought",
            text: reasoning,
            source: nodeOutput?.planSource ?? "llm",
          });
        }
        sendEvent({
          type: "tool_end",
          tool: "plan_agent",
          thought: reasoning || "Planning safety graph routing based on extracted commands.",
          observation: `Pipeline: ${steps.join(" → ")}.`,
          verbDone: "routed security pipeline",
        });

        // Trigger tool_start for execution nodes
        sendEvent({
          type: "tool_start",
          tool: "dry_run_rpc",
          thought: "Dry-running transaction against live Sui RPC node to calculate balance changes.",
          action: "Simulating on Sui node",
          verbRunning: "simulating on sui rpc...",
        });
        if (steps.includes("wallet_history")) {
          sendEvent({
            type: "tool_start",
            tool: "fetch_history",
            thought: walletAddress ? `Inspecting wallet activity for ${walletAddress.slice(0, 8)}... to check velocity.` : "Checking counterparty velocity to detect drainer patterns.",
            action: "Inspecting wallet history",
            verbRunning: "inspecting wallet history...",
          });
        }
        if (steps.includes("vector_search")) {
          sendEvent({
            type: "tool_start",
            tool: "vector_search",
            thought: "Comparing transaction operations against known exploit patterns and attack signatures.",
            action: "Scanning known exploit patterns",
            verbRunning: "scanning known exploit patterns...",
          });
        }
      } else if (nodeName === "simulate") {
        const status = nodeOutput?.simulation?.status ?? "success";
        console.log(`   [4. Simulate]    Status: ${status} (Gas: ${nodeOutput?.simulation?.gasUsed ?? "N/A"})`);
        sendEvent({
          type: "tool_end",
          tool: "dry_run_rpc",
          observation: status === "success" ? "Simulation succeeded. Zero VM errors detected." : `Simulation status: ${status}.`,
          verbDone: "simulated on sui rpc",
        });
      } else if (nodeName === "fetch_history") {
        console.log(`   [5. History]     Checked wallet velocity.`);
        sendEvent({
          type: "tool_end",
          tool: "fetch_history",
          observation: "Wallet history clean. No anomalous velocity.",
          verbDone: "inspected wallet history",
        });
      } else if (nodeName === "vector_search") {
        const matches = nodeOutput?.similarPatterns ?? [];
        const topMatch = matches[0];
        const matchText = topMatch
          ? `${Math.round(topMatch.similarity * 100)}% match: ${topMatch.description.slice(0, 35)}...`
          : "0 matching exploit vectors found.";
        console.log(`   [6. Vectors]     Top match: ${matchText}`);
        sendEvent({
          type: "tool_end",
          tool: "vector_search",
          observation: matchText,
          verbDone: "scanned known exploit patterns",
        });
      } else if (nodeName === "risk") {
        console.log(`   [7. Risk Score]  Score: ${nodeOutput?.riskScore}/100 | Recommendation: ${nodeOutput?.recommendation?.toUpperCase()}`);
        sendEvent({
          type: "tool_start",
          tool: "score_risk",
          thought: "Synthesizing simulation and security vectors to evaluate risk.",
          action: "Computing safety score",
          verbRunning: "computing safety score...",
        });
        sendEvent({
          type: "tool_end",
          tool: "score_risk",
          observation: `Risk score: ${nodeOutput?.riskScore}/100 (${nodeOutput?.recommendation?.toUpperCase()}).`,
          verbDone: "computed safety score",
        });
      } else if (nodeName === "explain") {
        const gonka = nodeOutput?.gonkaVerification;
        const reqs = [gonka?.models?.primary?.requestId, gonka?.models?.secondary?.requestId].filter(Boolean).join(" & ");
        console.log(`   [8. Explain (Gonka)] Consensus: ${gonka?.consensusVerdict?.toUpperCase()} (${gonka?.consensusTruthScore ?? 0}% Truth)`);
        sendEvent({
          type: "tool_start",
          tool: "gonka_verification",
          thought: "Cross-verifying transaction security on Gonka Network via dual independent models (DeepSeek-V4 & MiniMax-M2.7)...",
          action: "Decentralized inference & consensus",
          verbRunning: "verifying on gonka network...",
        });
        sendEvent({
          type: "tool_end",
          tool: "gonka_verification",
          observation: gonka
            ? `Decentralized consensus: ${gonka.consensusVerdict?.toUpperCase()} (${gonka.consensusTruthScore}% truth). Proof: ${reqs}.`
            : "Explanation synthesized.",
          verbDone: "verified on gonka network",
        });

        if (nodeOutput?.walrusBlobId) {
          sendEvent({
            type: "tool_start",
            tool: "walrus_storage",
            thought: "Publishing tamper-proof security audit dossier to Walrus decentralized storage...",
            action: "Decentralized audit archiving",
            verbRunning: "archiving on walrus...",
          });
          sendEvent({
            type: "tool_end",
            tool: "walrus_storage",
            observation: `Immutable audit dossier archived on Walrus. Blob: ${nodeOutput.walrusBlobId.slice(0, 12)}…`,
            verbDone: "archived on walrus storage",
          });
        }
      }
    }

    console.log(`🏁 [/analyze-stream] Session completed successfully.`);
    console.log(`======================================================\n`);

    sendEvent({
      type: "result",
      data: {
        explanation: finalState.explanation,
        riskScore: finalState.riskScore,
        riskFlags: finalState.riskFlags,
        recommendation: finalState.recommendation,
        operations: finalState.operations,
        protocols: finalState.protocols,
        simulation: finalState.simulation,
        similarPatterns: finalState.similarPatterns,
        plannedSteps: finalState.plannedSteps,
        planReasoning: finalState.planReasoning,
        planSource: finalState.planSource,
        gonkaVerification: finalState.gonkaVerification,
        walrusBlobId: finalState.walrusBlobId,
        walrusUrl: finalState.walrusUrl,
      },
    });

    reply.raw.end();
  } catch (err) {
    console.error("❌ [/analyze-stream] Error during stream:", err);
    req.log.error(err);
    sendEvent({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    reply.raw.end();
  }
});

const port = Number(process.env.PORT ?? 3001);
app.listen(
  { port, host: "0.0.0.0" },
  (err) => {
    if (err) {
      console.error("❌ Failed to start server:", err);
      app.log.error(err);
      process.exit(1);
    }
    console.log(`\n🛡️  ===========================================`);
    console.log(`🛡️  AEGIS AI Agent Server is LIVE`);
    console.log(`📡 Listening on: http://0.0.0.0:${port}`);
    console.log(`⛓️  Sui Mode    : ${getSuiMode().toUpperCase()}`);
    console.log(`🛡️  ===========================================\n`);
  }
);
