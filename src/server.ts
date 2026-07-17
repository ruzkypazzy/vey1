// src/server.ts
// Fastify server — landing page + /v1/audit endpoint with x402 paywall.

import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config } from "./config/secrets.js";
import { existsSync, readFileSync, readFile, statSync } from "node:fs";
import { runAudit } from "./synthesis/orchestrator.js";
import { renderReportPdf } from "./pdf/render.js";
import { buildPaymentChallenge, buildX402Middleware, isPaymentHeaderValid } from "./utils/x402.js";
import { checkOnchainosAvailable, bootstrapSession } from "./services/onchainos.js";

// Adapter: wrap an Express-style (req, res, next) handler as a Fastify
// preHandler. The x402 SDK middleware is Express-style; Fastify needs a
// preHandler with (req, reply) signature.
function expressToFastify(expressHandler: (req: any, res: any, next: any) => any) {
  return async (req: any, reply: any) => {
    let responseSent = false;
    const res: any = {
      setHeader(name: string, value: any) {
        reply.header(name, value);
        return res;
      },
      writeHead(code: number, headers?: any) {
        reply.code(code);
        if (headers) {
          for (const [k, v] of Object.entries(headers)) {
            reply.header(k, v as any);
          }
        }
        return res;
      },
      write(_chunk: any) {
        return true;
      },
      end(chunk?: any) {
        responseSent = true;
        if (!reply.sent) {
          if (chunk) reply.send(chunk);
          else reply.send();
        }
        return res;
      },
      json(body: any) {
        responseSent = true;
        if (!reply.sent) reply.send(body);
      },
      send(body: any) {
        responseSent = true;
        if (!reply.sent) reply.send(body);
      },
      status(code: number) {
        reply.code(code);
        return res;
      },
      flushHeaders() {
        // no-op
      },
      headersSent: false,
    };
    const expressReq: any = {
      method: req.method,
      path: req.url.split("?")[0],
      originalUrl: req.url,
      url: `${req.protocol}://${req.headers.host}${req.url}`,
      protocol: req.protocol,
      headers: { ...req.headers },
      header(name: string) {
        const v = req.headers[name.toLowerCase()];
        return Array.isArray(v) ? v[0] : v;
      },
      query: req.query,
      body: req.body,
      ip: req.ip,
    };
    let nextCalled = false;
    const next = (err?: any) => {
      if (err) throw err;
      nextCalled = true;
    };
    try {
      const result = expressHandler(expressReq, res, next);
      if (result && typeof result.then === "function") {
        await result;
      }
    } catch (e) {
      // SDK errored — let it propagate so Fastify handles it
      throw e;
    }
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, "..", "public");

async function main() {
  const app = Fastify({
    logger: { level: config.env === "production" ? "info" : "debug" },
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: true });
  await app.register(fastifyStatic, { root: publicDir, prefix: "/" });

  // Startup: check onchainos availability + bootstrap session
  const onchainosHealth = await checkOnchainosAvailable();
  if (onchainosHealth.ok) {
    app.log.info(`onchainos CLI v${onchainosHealth.version} available`);
    const session = await bootstrapSession();
    app.log.info(`onchainos session: ${session.ok ? "ready" : "skipped"} (${session.reason})`);
  } else {
    app.log.warn(`onchainos CLI unavailable: ${onchainosHealth.error ?? "see logs"}`);
  }

  // Health
  app.get("/ready", async () => ({ ok: true, ts: Date.now() }));
  app.get("/health", async () => ({ ok: true, ts: Date.now() }));

  // Admin: Tavily status (for monitoring credit usage)
  app.get("/admin/tavily", async () => {
    const { getTavilyStatus } = await import("./services/research.js");
    const status = getTavilyStatus();
    return {
      ...status,
      keyConfigured: !!process.env.TAVILY_API_KEY,
      hint: !status.disabled && !status.available
        ? "Tavily has had 3+ consecutive failures (likely 429 rate-limited). Set TAVILY_DISABLED=1 to disable."
        : status.disabled
          ? "Tavily is disabled (TAVILY_DISABLED=1 or no key)"
          : "OK",
    };
  });

  // API docs (proper HTML page, not raw JSON)
  app.get("/api-docs", async (_req, reply) => {
    const path = resolve(publicDir, "api-docs.html");
    const content = readFileSync(path, "utf8");
    reply.type("text/html; charset=utf-8").send(content);
  });

  // Paid audit landing page (x402 flow)
  app.get("/paid-audit", async (_req, reply) => {
    const path = resolve(publicDir, "paid-audit.html");
    const content = readFileSync(path, "utf8");
    reply.type("text/html; charset=utf-8").send(content);
  });

  // Discovery: what VEY1 is, what it costs, how to call it
  app.get("/v1/info", async () => ({
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
  }));

  // x402 challenge endpoint — clients GET this to learn the price
  app.get("/v1/audit", async (_req, reply) => {
    const challenge = buildPaymentChallenge(
      `${config.publicBaseUrl}/v1/audit`,
      "VEY1 forensic project audit — returns a 12-18 page PDF",
    );
    const encoded = Buffer.from(JSON.stringify(challenge), "utf8").toString("base64");
    reply
      .code(402)
      .header("PAYMENT-REQUIRED", encoded)
      .header("X-PAYMENT-REQUIRED", encoded)
      .send(challenge);
  });

  // Free demo endpoint — runs an audit on any project (no x402, no payment)
  // Rate-limited per IP to prevent abuse (1 call per 30 seconds)
  const demoLastCall = new Map<string, number>();
  app.post("/v1/demo", async (req, reply) => {
    const body = (req.body ?? {}) as { target?: string; query?: string };
    let query: string;
    if (body.query) {
      // Custom input from the "Any project" tab
      query = body.query;
    } else {
      // Preset targets
      const demoTargets: Record<string, string> = {
        uniswap: "https://uniswap.org",
        hyperliquid: "Hyperliquid",
        safereum: "SafeMoon",
        __custom: "Uniswap",
      };
      query = demoTargets[body.target ?? "uniswap"] ?? "Uniswap";
    }
    // Rate limit: 1 call per 30s per IP
    const ip = req.ip;
    const last = demoLastCall.get(ip) ?? 0;
    if (Date.now() - last < 30_000) {
      const wait = Math.ceil((30_000 - (Date.now() - last)) / 1000);
      reply.code(429).send({ error: `Rate limited. Try again in ${wait}s.` });
      return;
    }
    demoLastCall.set(ip, Date.now());
    try {
      const { report, durationMs } = await runAudit({ query });
      const pdf = await renderReportPdf(report);
      reply.send({
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
      app.log.error(e);
      reply.code(500).send({ error: String(e) });
    }
  });

  // The actual audit endpoint — paywalled
  // Use the official OKX x402 SDK middleware if facilitator credentials are set.
  // The SDK middleware pre-populates supportedResponsesMap so it doesn't need to
  // call the broken getSupported() endpoint, and it self-recovers from 5xx errors
  // by serving the spec-compliant 402 challenge.
  const x402Middleware = buildX402Middleware();
  const x402FastifyHandler = expressToFastify(x402Middleware);
  app.post("/v1/audit", { preHandler: x402FastifyHandler }, async (req, reply) => {
    const paymentHeader = req.headers["payment-signature"] ?? req.headers["x-payment"];
    const paymentHeaderStr = Array.isArray(paymentHeader) ? paymentHeader[0] : paymentHeader;
    if (!isPaymentHeaderValid(paymentHeaderStr)) {
      // Fallback: manual 402 challenge (used when no facilitator credentials are set)
      const challenge = buildPaymentChallenge(
        `${config.publicBaseUrl}/v1/audit`,
        "VEY1 forensic project audit — returns a 12-18 page PDF",
      );
      const encoded = Buffer.from(JSON.stringify(challenge), "utf8").toString("base64");
      reply
        .code(402)
        .header("PAYMENT-REQUIRED", encoded)
        .header("X-PAYMENT-REQUIRED", encoded)
        .send(challenge);
      return;
    }

    const body = (req.body ?? {}) as {
      query?: string;
      explicitAddresses?: { address: string; source: string; chain?: string }[];
    };

    if (!body.query) {
      reply.code(400).send({ error: "Missing 'query' in request body" });
      return;
    }

    try {
      const { report, durationMs } = await runAudit({
        query: body.query,
        explicitAddresses: body.explicitAddresses,
      });
      const pdf = await renderReportPdf(report);

      reply.send({
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
      app.log.error(e);
      reply.code(500).send({ error: String(e) });
    }
  });

  // Serve generated reports (PDFs and HTMLs)
  app.get("/reports/:filename", async (req, reply) => {
    const { filename } = req.params as { filename: string };
    // path-traversal guard
    if (filename.includes("/") || filename.includes("..")) {
      reply.code(400).send({ error: "Bad filename" });
      return;
    }
    const fullPath = resolve(config.outputDir, filename);
    if (!existsSync(fullPath)) {
      reply.code(404).send({ error: "Not found" });
      return;
    }
    const stat = statSync(fullPath);
    if (!stat.isFile() || stat.size === 0) {
      reply.code(404).send({ error: "File empty or invalid" });
      return;
    }
    const buf = readFileSync(fullPath);
    const contentType = filename.endsWith(".pdf")
      ? "application/pdf"
      : "text/html; charset=utf-8";
    reply.header("content-type", contentType).header("content-length", String(buf.length)).send(buf);
  });

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`VEY1 listening on http://${config.host}:${config.port}`);
  app.log.info(`CWD: ${process.cwd()}`);
  app.log.info(`outputDir resolved: ${resolve(config.outputDir)}`);
  app.log.info(`publicBaseUrl: ${config.publicBaseUrl}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
// Force rebuild Wed Jul 15 16:29:58 UTC 2026
