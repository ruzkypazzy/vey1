// src/server.ts
// Fastify server — landing page + /v1/audit endpoint with x402 paywall.

import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config } from "./config/secrets.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { runAudit } from "./synthesis/orchestrator.js";
import { renderReportPdf } from "./pdf/render.js";
import { buildPaymentChallenge, isPaymentHeaderValid } from "./utils/x402.js";
import { checkOnchainosAvailable, bootstrapSession } from "./services/onchainos.js";

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
    reply.code(402).send(challenge);
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
  app.post("/v1/audit", async (req, reply) => {
    const paymentHeader = req.headers["x-payment"];
    const paymentHeaderStr = Array.isArray(paymentHeader) ? paymentHeader[0] : paymentHeader;
    if (!isPaymentHeaderValid(paymentHeaderStr)) {
      const challenge = buildPaymentChallenge(
        `${config.publicBaseUrl}/v1/audit`,
        "VEY1 forensic project audit — returns a 12-18 page PDF",
      );
      reply.code(402).send(challenge);
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
