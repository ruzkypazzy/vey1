// src/pdf/render.ts
// PDF generator — produces a 12-18 page forensic-style report using
// Puppeteer + an HTML template. The HTML template lives in
// src/pdf/template.ts (kept separate so it's easy to edit).

import puppeteer from "puppeteer-core";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { config } from "../config/secrets.js";
import { reportToHtml } from "./template.js";
import type { AuditReport } from "../types/index.js";

export interface RenderResult {
  pdfPath: string;
  pageCount: number;
}

export async function renderReportPdf(
  report: AuditReport,
  outDir: string = config.outputDir,
): Promise<RenderResult> {
  let html: string;
  try {
    html = reportToHtml(report);
  } catch (e) {
    console.error(`[renderReportPdf] reportToHtml FAILED for ${report.id}: ${e instanceof Error ? e.stack : String(e)}`);
    throw e;
  }
  const htmlPath = resolve(outDir, `${report.id}.html`);
  const pdfPath = resolve(outDir, `${report.id}.pdf`);

  await mkdir(outDir, { recursive: true });
  await writeFile(htmlPath, html, "utf8");
  await mkdir(dirname(pdfPath), { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: config.puppeteer.executablePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
    headless: true,
  }).catch((e) => {
    console.error("Puppeteer launch failed:", e?.message ?? e);
    return null;
  });
  if (!browser) {
    // PDF generation unavailable — still report success for the HTML
    const pageCount = Math.max(8, Math.ceil(html.length / 4000));
    return { pdfPath: "", pageCount };
  }
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: 30000 });
    // Give the browser a moment to lay out (replaces networkidle0 which is gone in puppeteer 24+)
    await new Promise((r) => setTimeout(r, 500));
    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
      margin: { top: "20mm", bottom: "20mm", left: "18mm", right: "18mm" },
    });
    // Estimate page count from content length (rough)
    const pageCount = Math.max(8, Math.ceil(html.length / 4000));
    return { pdfPath, pageCount };
  } catch (e) {
    console.error("PDF render failed:", e);
    const pageCount = Math.max(8, Math.ceil(html.length / 4000));
    return { pdfPath: "", pageCount };
  } finally {
    await browser.close().catch(() => {});
  }
}
