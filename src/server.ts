/**
 * Fastify HTTP server exposing the agent as POST /analyze (JSON)
 * and POST /analyze-stream (Server-Sent Events streaming).
 */

import "./env.js";
import Fastify from "fastify";
import { graph } from "./graph.js";
import { getSuiMode } from "./services/index.js";

const app = Fastify({ logger: true });

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
      label: "Parsing PTB commands & Move call targets",
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
          summary: `Extracted ${ops.length} operation(s): ${ops.join(", ") || "split_coins"}`,
        });
        sendEvent({
          type: "tool_start",
          tool: "lookup_protocol",
          label: "Querying protocol package registry",
        });
      } else if (nodeName === "lookup") {
        const protos = nodeOutput?.protocols ?? [];
        const names = protos.map((p: any) => p.name).join(", ") || "None";
        sendEvent({
          type: "tool_end",
          tool: "lookup_protocol",
          summary: `Identified ${protos.length} protocol(s): ${names}`,
        });
        sendEvent({
          type: "tool_start",
          tool: "plan_agent",
          label: "LLM Agent graph routing & safety strategy",
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
          summary: `Planned execution pipeline: ${steps.join(" → ")}`,
        });

        // Trigger tool_start for execution nodes
        sendEvent({
          type: "tool_start",
          tool: "dry_run_rpc",
          label: "Simulating transaction execution on Sui gRPC",
        });
        if (steps.includes("wallet_history")) {
          sendEvent({
            type: "tool_start",
            tool: "fetch_history",
            label: "Fetching target wallet transaction history & active objects",
          });
        }
        if (steps.includes("vector_search")) {
          sendEvent({
            type: "tool_start",
            tool: "vector_search",
            label: "Searching Qdrant vector database for exploit patterns",
          });
        }
      } else if (nodeName === "simulate") {
        const status = nodeOutput?.simulation?.status ?? "success";
        sendEvent({
          type: "tool_end",
          tool: "dry_run_rpc",
          summary: `RPC simulation completed (${status})`,
        });
      } else if (nodeName === "fetch_history") {
        const historyText = nodeOutput?.history ?? "Wallet history inspected";
        sendEvent({
          type: "tool_end",
          tool: "fetch_history",
          summary: historyText,
        });
      } else if (nodeName === "vector_search") {
        const matches = nodeOutput?.similarPatterns ?? [];
        const topMatch = matches[0];
        const matchText = topMatch
          ? `${Math.round(topMatch.similarity * 100)}% match with ${topMatch.description.slice(0, 45)}...`
          : "No matching exploit patterns found";
        sendEvent({
          type: "tool_end",
          tool: "vector_search",
          summary: matchText,
        });
        sendEvent({
          type: "tool_start",
          tool: "score_risk",
          label: "Computing composite risk score & safety rules",
        });
      } else if (nodeName === "risk") {
        sendEvent({
          type: "tool_end",
          tool: "score_risk",
          summary: `Computed risk score: ${nodeOutput?.riskScore}/100 (${nodeOutput?.recommendation?.toUpperCase()})`,
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
