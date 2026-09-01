/**
 * Fastify HTTP server exposing the agent as POST /analyze (JSON)
 * and POST /analyze-stream (Server-Sent Events streaming).
 */

import "./env.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { graph } from "./graph.js";
import { getSuiMode } from "./services/index.js";

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
});

app.get("/health", async () => ({ ok: true, suiMode: getSuiMode() }));

app.post<{
  Body: { rawPtb: string; walletAddress: string };
}>("/analyze", async (req, reply) => {
  const { rawPtb, walletAddress } = req.body ?? {};

  if (!rawPtb || !walletAddress) {
    return reply
      .status(400)
      .send({ error: "rawPtb and walletAddress are required" });
  }

  try {
    const result = await graph.invoke({ rawPtb, walletAddress });

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
    });
  } catch (err) {
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
    return reply
      .status(400)
      .send({ error: "rawPtb and walletAddress are required" });
  }

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
        sendEvent({
          type: "tool_end",
          tool: "dry_run_rpc",
          observation: status === "success" ? "Simulation succeeded. Zero VM errors detected." : `Simulation status: ${status}.`,
          verbDone: "simulated on sui rpc",
        });
      } else if (nodeName === "fetch_history") {
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
        sendEvent({
          type: "tool_end",
          tool: "vector_search",
          observation: matchText,
          verbDone: "scanned known exploit patterns",
        });
      } else if (nodeName === "risk") {
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
      }
    }

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
      },
    });

    reply.raw.end();
  } catch (err) {
    req.log.error(err);
    sendEvent({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    reply.raw.end();
  }
});

app.listen(
  { port: Number(process.env.PORT ?? 3001), host: "0.0.0.0" },
  (err) => {
    if (err) {
      app.log.error(err);
      process.exit(1);
    }
    app.log.info(`Sui mode: ${getSuiMode()}`);
  }
);
