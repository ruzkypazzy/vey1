// src/mcp/server.ts
// MCP-over-HTTP server for VEY1.
//
// Exposes 1 MCP tool: `audit_crypto_project`
//   - Input:  { query, explicitAddresses? }
//   - Output: { reportId, project, riskScore, recommendation, reasoning, flags, ... }
//
// The /mcp endpoint is the entry point for the OKX.AI marketplace
// (A2MCP transport). Per OKX.AI requirement, each POST /mcp is
// independent: no session state is kept between requests. We build
// a fresh server + WebStandardStreamableHTTPServerTransport per
// request with `sessionIdGenerator: undefined` (stateless mode)
// and `enableJsonResponse: true` (so the marketplace reviewer gets
// plain JSON, not SSE).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAudit } from "../synthesis/orchestrator.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "vey1",
    version: "0.1.0",
  });

  // Tool: audit_crypto_project
  // Runs a full forensic audit on a crypto project. Returns risk
  // score (0-100), team dossiers, on-chain audit, scam DB
  // cross-reference, comparable projects, and recommendation.
  // Pay-per-call in USDT0 on X Layer via x402.
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
            source: z.string().describe("Where this address came from (e.g. docs, team-tweet)"),
            chain: z.string().optional().describe("Chain name or ID (e.g. eip155:1, ethereum)"),
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
        // ProjectAudit is the canonical output of runAudit
        const audit = report.audit;
        const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? "https://vey1.xyz";
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
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
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

/**
 * Handle a single HTTP request as a stateless MCP-over-HTTP call.
 * Returns the parsed JSON-RPC response (or a wrapper with `raw` if
 * the transport returns non-JSON).
 */
export async function handleMcpHttpRequest(body: unknown): Promise<unknown> {
  const server = createMcpServer();
  const { WebStandardStreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true, // marketplace wants plain JSON
  });

  await server.connect(
    transport as unknown as Parameters<typeof server.connect>[0],
  );

  // The transport needs a Web Request with the right Accept header.
  const request = new Request("https://vey1.xyz/mcp", {
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
