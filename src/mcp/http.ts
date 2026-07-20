// src/mcp/http.ts
// MCP-over-HTTP handler for VEY1 (A2MCP transport — FREE per OKX spec).
//
// /mcp is the A2MCP transport. The OKX.AI marketplace wraps it in its
// own x402 layer for billing — the standalone endpoint itself is free.
//
// Methods:
//   - initialize: returns serverInfo (always 200)
//   - tools/list: returns the registered tool schema (always 200)
//   - tools/call: runs the audit, responds instantly (<1s) with
//     status=processing. The audit completes in the background; the
//     final result is available at /reports/:id.{pdf,html}.
//   - All other methods: passed through to the MCP server

import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAudit } from "../synthesis/orchestrator.js";
import { config } from "../config/secrets.js";

function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: "vey1",
    version: "1.0.0",
  });

  server.tool(
    "audit_crypto_project",
    "Run a forensic crypto project audit (12-18 page PDF report). Provide a project name, X/Twitter handle, contract address, or URL. Returns risk score (0-100), team dossiers, on-chain audit, scam DB cross-reference, comparable projects, and a final recommendation (PROCEED / CAUTION / BLOCK). Pay-per-call in USDT0 on X Layer via x402.",
    {
      query: z
        .string()
        .min(1)
        .describe("Project name, @handle, contract address, or URL to audit."),
      explicitAddresses: z
        .array(
          z.object({
            address: z.string().describe("Wallet address (0x...)"),
            source: z.string().describe("Where this address came from"),
            chain: z.string().optional().describe("Chain name or ID"),
          }),
        )
        .optional()
        .describe("Optional list of personal wallet addresses to include in the team audit."),
    },
    async ({ query, explicitAddresses }) => {
      // Respond INSTANTLY (<1s) with status=processing. The marketplace UI
      // has a very short timeout (~5-10s). The audit runs in the background;
      // result is polled via /reports/:id.{pdf,html}.
      const reportId = `TL-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const startedAt = new Date().toISOString();
      const publicBaseUrl = config.publicBaseUrl;
      const result = {
        status: "processing",
        message: "Audit queued. Poll GET /reports/:id.html or /reports/:id.pdf for the result. The audit typically completes in 15-20 seconds.",
        reportId,
        query,
        startedAt,
        project: null,
        riskScore: null,
        recommendation: "PENDING",
        reasoning: "Audit in progress — see startedAt timestamp.",
        flags: [],
        comparableProjects: [],
        team: [],
        pdfUrl: null,
        htmlUrl: null,
        durationMs: 0,
        completedAt: null,
      };
      setImmediate(() => {
        runAudit({ query, explicitAddresses })
          .then((r) => {
            const fn = r.report?.id ? r.report.id : reportId;
            console.log(`[vey1 mcp] background audit done: reportId=${fn} durationMs=${r.durationMs}`);
          })
          .catch((e) => {
            console.error(`[vey1 mcp] background audit failed: ${e instanceof Error ? e.message : e}`);
          });
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  return server;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown;
}

async function dispatchMcp(body: JsonRpcRequest): Promise<unknown> {
  const server = buildMcpServer();
  const { WebStandardStreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(
    transport as unknown as Parameters<typeof server.connect>[0],
  );
  const request = new Request(`${config.publicBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  const response = await transport.handleRequest(request);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * MCP-over-HTTP handler. Payment has already been verified by the SDK
 * middleware before this handler runs.
 */
export async function handleMcpRequest(
  req: Request,
  res: Response,
): Promise<void> {
  const body = (req.body ?? {}) as JsonRpcRequest;

  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    res.status(400).json({
      jsonrpc: "2.0",
      id: body.id ?? null,
      error: { code: -32700, message: "Parse error: expected JSON-RPC 2.0 object" },
    });
    return;
  }

  try {
    const result = await dispatchMcp(body);
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({
      jsonrpc: "2.0",
      id: body.id,
      error: {
        code: -32603,
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

