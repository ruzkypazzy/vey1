// src/server.ts
// Express server — landing page + /v1/audit endpoint with x402 paywall.
//
// Uses the OKX Payment SDK (Express-native) with the x402 v2 spec.
// Pattern matches working ASPs on the OKX.AI marketplace.

import express from "express";
import type { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config } from "./config/secrets.js";
import { existsSync, readFileSync, readFile, statSync } from "node:fs";
import { runAudit } from "./synthesis/orchestrator.js";
import { renderReportPdf } from "./pdf/render.js";
import { buildPaymentLayer, refundSettlement } from "./utils/x402.js";
import { handleMcpRequest } from "./mcp/http.js";
import { checkOnchainosAvailable, bootstrapSession } from "./services/onchainos.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, "..", "public");

async function main() {
  const app = express();
  app.set("trust proxy", 1); // behind Railway's proxy
  app.use(express.json({ limit: "10mb" }));
  app.use(cors({
    origin: true,
    exposedHeaders: [
      "PAYMENT-REQUIRED",
      "X-PAYMENT-RECEIPT",
    ],
  }));
  app.use(helmet({ contentSecurityPolicy: false }));


  app.use(express.static(publicDir, { maxAge: "1h" }));

  // Startup: check onchainos availability + bootstrap session
  const onchainosHealth = await checkOnchainosAvailable();
  if (onchainosHealth.ok) {
    console.log(`[vey1] onchainos CLI v${onchainosHealth.version} available`);
    const session = await bootstrapSession();
    console.log(`[vey1] onchainos session: ${session.ok ? "ready" : "skipped"} (${session.reason})`);
  } else {
    console.warn(`[vey1] onchainos CLI unavailable: ${onchainosHealth.error ?? "see logs"}`);
  }

  // x402 payment layer - MUST be available. buildPaymentLayer() THROWS
  // if required env vars are missing; the process exits. The application
  // must never start with payments disabled.
  const payments = buildPaymentLayer();

  /** Payment middleware - there is no "no payments" path. */
  const pay: express.RequestHandler = (req, res, next) =>
    payments.middleware(req, res, next);

  // A2A / Agent Card discovery endpoint.
  // Per the latest A2A spec, served at /.well-known/agent.json.
  app.get("/.well-known/agent.json", (_req, res) => {
    res.json({
      name: "VEY1",
      description: "Forensic crypto project due diligence agent.",
      url: config.publicBaseUrl,
      version: "1.0.0",
      provider: { organization: "ruzkypazzy", url: "https://github.com/ruzkypazzy/vey1" },
      capabilities: { streaming: false, pushNotifications: false, stateTransition: false },
      authentication: { schemes: ["x402"], x402Version: 2, network: config.x402.network, asset: config.x402.asset, payTo: config.x402.receivingWallet, facilitator: "https://web3.okx.com" },
      defaultInputModes: ["application/json"],
      defaultOutputModes: ["application/json", "application/pdf", "text/html"],
      skills: [
        {
          id: "audit_crypto_project",
          name: "audit_crypto_project",
          description: "Run a forensic audit on a crypto project.",
          tags: ["crypto", "audit", "due-diligence", "security", "forensic", "risk"],
          inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" }, explicitAddresses: { type: "array" } } },
          pricing: { amount: String(Math.round(config.x402.auditPrice * 1_000_000)), asset: config.x402.asset, network: config.x402.network, decimals: 6 }
        }
      ]
    });
  });
  app.get("/agent-card", (_req, res) => res.redirect(301, "/.well-known/agent.json"));

  // A2MCP endpoint (OKX.AI marketplace integration)
  // The marketplace reviewer calls this to:
  //   1. initialize (handshake)  - free
  //   2. tools/list (enumerate)  - free
  //   3. tools/call (execute)    - requires x402 payment
  app.post("/mcp", pay, handleMcpRequest);


  // Health endpoints
  app.get("/ready", (_req, res) => res.json({ ok: true, ts: Date.now() }));
  app.get("/health", (_req, res) =>
    res.json({
      status: "ok",
      agent: "VEY1",
      payments: "live",
      network: config.x402.network,
      facilitator: "OKX Payment SDK",
      x402Version: 2,
    }),
  );

  // Admin: Tavily status
  app.get("/admin/tavily", async (_req, res) => {
    const { getTavilyStatus } = await import("./services/research.js");
    const status = getTavilyStatus();
    res.json({
      ...status,
      keyConfigured: !!process.env.TAVILY_API_KEY,
      hint: !status.disabled && !status.available
        ? "Tavily has had 3+ consecutive failures (likely 429 rate-limited). Set TAVILY_DISABLED=1 to disable."
        : status.disabled
          ? "Tavily is disabled (TAVILY_DISABLED=1 or no key)"
          : "OK",
    });
  });

  // Static pages
  app.get("/api-docs", (_req, res) => {
    res.type("text/html; charset=utf-8").send(readFileSync(resolve(publicDir, "api-docs.html"), "utf8"));
  });
  app.get("/paid-audit", (_req, res) => {
    res.type("text/html; charset=utf-8").send(readFileSync(resolve(publicDir, "paid-audit.html"), "utf8"));
  });

  // Discovery
  app.get("/v1/info", (_req, res) =>
    res.json({
      name: "VEY1",
      description: "Forensic crypto project due diligence. Pass a project name, get a 12-18 page PDF.",
      price: `${config.x402.auditPrice} USDT0 per audit`,
      paymentNetwork: config.x402.network,
      paymentAsset: config.x402.asset,
      payTo: config.x402.receivingWallet,
      x402Version: 2,
      input: {
        query: "string — project name, @handle, contract address, or URL",
        explicitAddresses: "optional — array of { address, source, chain? } to include as personal wallets",
      },
    }),
  );

  // Free demo endpoint — runs an audit on any project (no x402, no payment)
  // Rate-limited per IP to prevent abuse (1 call per 30 seconds)
  const demoLastCall = new Map<string, number>();
  app.post("/v1/demo", async (req, res) => {
    const body = (req.body ?? {}) as { target?: string; query?: string };
    let query: string;
    if (body.query) {
      query = body.query;
    } else {
      const demoTargets: Record<string, string> = {
        uniswap: "https://uniswap.org",
        hyperliquid: "Hyperliquid",
        safereum: "SafeMoon",
      };
      query = demoTargets[body.target ?? "uniswap"] ?? "Uniswap";
    }
    const ip = req.ip ?? "unknown";
    const last = demoLastCall.get(ip) ?? 0;
    if (Date.now() - last < 30_000) {
      const wait = Math.ceil((30_000 - (Date.now() - last)) / 1000);
      res.status(429).json({ error: `Rate limited. Try again in ${wait}s.` });
      return;
    }
    demoLastCall.set(ip, Date.now());
    try {
      const { report, durationMs } = await runAudit({ query });
      const pdf = await renderReportPdf(report);
      res.json({
        reportId: report.id,
        project: report.identity.canonicalName,
        riskScore: report.audit.riskScore,
        recommendation: report.audit.recommendation,
        reasoning: report.audit.reasoning,
        flags: report.audit.flags,
        comparableProjects: report.audit.comparableProjects,
        team: report.audit.team.map((t) => ({
          name: t.name,
          role: t.role,
          riskScore: t.riskScore,
          identityConfidence: t.identityConfidence,
          pastProjects: t.pastProjects,
        })),
        pdf: pdf.pdfPath
          ? {
              path: pdf.pdfPath,
              url: `${config.publicBaseUrl}/reports/${report.id}.pdf`,
              pageCount: pdf.pageCount,
            }
          : null,
        html: {
          url: `${config.publicBaseUrl}/reports/${report.id}.html`,
          pageCount: pdf.pageCount,
        },
        durationMs,
        completedAt: report.completedAt,
      });
    } catch (e) {
      console.error("[demo error]", e);
      res.status(500).json({ error: String(e) });
    }
  });

  // The audit endpoint — paywalled via x402.
  // Both GET and POST are gated so the OKX platform validator can probe
  // the endpoint with either method.
  // GET /v1/audit — returns the 402 challenge with the PAYMENT-REQUIRED
  // header (no body work).
  app.get("/v1/audit", pay, (_req, res) => {
    // The SDK middleware already wrote the 402 response. We just end here.
    // If somehow we get past it (e.g. with a valid payment), return a
    // 405 since GET is only for discovery.
    if (!res.headersSent) {
      res.status(405).json({ error: "Method Not Allowed. Use POST to submit an audit query." });
    }
  });

  // POST /v1/audit — runs the audit, gated by the SDK middleware.
  app.post("/v1/audit", pay, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = (req.body ?? {}) as {
        query?: string;
        explicitAddresses?: { address: string; source: string; chain?: string }[];
      };
      // Body is optional. Marketplace QA probes may POST with empty body
      // to verify the paid path. Default to a generic project query.
      const query = (body?.query && typeof body.query === "string" && body.query.length > 0)
        ? body.query
        : "Provide a general risk analysis of an unspecified crypto project";
      const { report, durationMs } = await runAudit({
        query,
        explicitAddresses: body?.explicitAddresses,
      });
      const pdf = await renderReportPdf(report);
      res.json({
        reportId: report.id,
        project: report.identity.canonicalName,
        riskScore: report.audit.riskScore,
        recommendation: report.audit.recommendation,
        reasoning: report.audit.reasoning,
        flags: report.audit.flags,
        comparableProjects: report.audit.comparableProjects,
        team: report.audit.team.map((t) => ({
          name: t.name,
          role: t.role,
          riskScore: t.riskScore,
          identityConfidence: t.identityConfidence,
          pastProjects: t.pastProjects,
        })),
        pdf: pdf.pdfPath
          ? {
              path: pdf.pdfPath,
              url: `${config.publicBaseUrl}/reports/${report.id}.pdf`,
              pageCount: pdf.pageCount,
            }
          : null,
        html: {
          url: `${config.publicBaseUrl}/reports/${report.id}.html`,
          pageCount: pdf.pageCount,
        },
        durationMs,
        completedAt: report.completedAt,
      });
    } catch (err) {
      // Payment was verified but we failed to deliver — cancel the on-chain
      // transfer so the caller isn't charged for an audit they never got.
      refundSettlement(res);
      next(err);
    }
  });

  // Serve generated reports (PDFs and HTMLs)
  app.get("/reports/:filename", (req, res) => {
    const filename = (req.params as { filename: string }).filename;
    if (filename.includes("/") || filename.includes("..")) {
      res.status(400).json({ error: "Bad filename" });
      return;
    }
    const fullPath = resolve(config.outputDir, filename);
    if (!existsSync(fullPath)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const stat = statSync(fullPath);
    if (!stat.isFile() || stat.size === 0) {
      res.status(404).json({ error: "File empty or invalid" });
      return;
    }
    const buf = readFileSync(fullPath);
    const contentType = filename.endsWith(".pdf")
      ? "application/pdf"
      : "text/html; charset=utf-8";
    res.setHeader("content-type", contentType);
    res.setHeader("content-length", String(buf.length));
    res.send(buf);
  });

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[error]", err.message);
    res.status(500).json({ error: "Internal error", message: err.message });
  });

  // Listen
  const server = app.listen(config.port, config.host, async () => {
    // The OKX SDK requires initialize() AFTER the server is listening
    // and BEFORE any request is handled. Skipping it is the most common
    // way to break the payment layer.
    try {
      await payments.initialize();
      console.log(
        `💸 payments live - ${config.x402.auditPrice} USDT0 per call on ${config.x402.network}`,
      );
    } catch (err) {
      console.error("payment layer failed to initialize:", err);
      process.exit(1);
    }
    console.log(`✨ VEY1 listening on http://${config.host}:${config.port}`);
    console.log(`   CWD: ${process.cwd()}`);
    console.log(`   outputDir: ${resolve(config.outputDir)}`);
    console.log(`   publicBaseUrl: ${config.publicBaseUrl}`);
  });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log(`\n[vey1] ${sig} received, closing...`);
      server.close(() => process.exit(0));
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
