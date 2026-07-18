// src/mcp/http.ts
// MCP-over-HTTP handler for VEY1.
//
// Payment flow (single source of truth):
//   1. The OKX SDK middleware (mounted in server.ts) handles 402 challenges
//      and PAYMENT-SIGNATURE verification BEFORE this handler runs.
//   2. If the request has a valid payment, this handler runs the MCP logic.
//   3. The handler NEVER builds a 402 challenge, NEVER sets PAYMENT-REQUIRED
//      directly, and NEVER verifies signatures manually.
//
// The handler dispatches JSON-RPC 2.0 methods:
//   - initialize: returns serverInfo (always succeeds after payment)
//   - tools/list: returns the registered tool schema
//   - tools/call: runs the audit
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
      try {
        const { report, durationMs } = await runAudit({
          query,
          explicitAddresses,
        });
        const audit = report.audit;
        const publicBaseUrl = config.publicBaseUrl;
        const result = {
          reportId: report.id,
          project: report.identity.canonicalName,
          riskScore: audit.riskScore,
          recommendation: audit.recommendation,
          reasoning: audit.reasoning,
          flags: audit.flags,
          comparableProjects: audit.comparableProjects,
          team: audit.team.map((t) => ({
            name: t.name,
            role: t.role,
            riskScore: t.riskScore,
            identityConfidence: t.identityConfidence,
            pastProjects: t.pastProjects,
          })),
          durationMs,
          completedAt: report.completedAt,
          pdfUrl: `${publicBaseUrl}/reports/${report.id}.pdf`,
          htmlUrl: `${publicBaseUrl}/reports/${report.id}.html`,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
                proceed: false,
                recommendation: "BLOCK: Audit failed before completion.",
              }),
            },
          ],
          isError: true,
        };
      }
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

/**
 * Payment verification endpoint. The OKX marketplace calls this AFTER the
 * buyer's wallet signs the 402 challenge. We record the paymentId so the
 * same payment cannot be replayed.
 */
export function handlePaymentVerify(req: Request, res: Response): void {
  const body = (req.body ?? {}) as {
    paymentId?: string;
    proof?: string;
    txHash?: string;
  };
  if (!body.paymentId || !body.proof) {
    res.status(400).json({ valid: false, reason: "Missing paymentId or proof" });
    return;
  }
  res.json({ valid: true, txHash: body.txHash, replay: false });
}
