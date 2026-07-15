// scripts/run-demo.ts
// Run a demo audit on a well-known project. Used for the X thread + OKX
// submission. Requires OPENAI_API_KEY in env to be set.
//
// Usage: pnpm audit:demo
//   or:  OPENAI_API_KEY=... npx tsx scripts/run-demo.ts [project_name]

import { runAudit } from "../src/synthesis/orchestrator.js";
import { renderReportPdf } from "../src/pdf/render.js";
import { config } from "../src/config/secrets.js";
import { writeFileSync, mkdirSync } from "node:fs";

const DEMO_TARGETS = [
  // A well-known, long-running legit project
  { name: "Uniswap", expected: "should score 85+ (long history, known team)" },
  // A well-known mid-tier project
  { name: "Hyperliquid", expected: "should score 60-80 (newer, less doxxed team)" },
  // A clearly suspicious project pattern (no real project here, used to demo "AVOID" outcome)
  { name: "MoonRetreat", expected: "may score low — likely no real on-chain footprint" },
];

async function main() {
  const args = process.argv.slice(2);
  const targets = args.length > 0 ? args.map((n) => ({ name: n, expected: "ad-hoc" })) : DEMO_TARGETS;

  mkdirSync(config.outputDir, { recursive: true });

  console.log(`Running ${targets.length} demo audits...`);
  const results = [];
  for (const t of targets) {
    console.log(`\n--- Auditing: ${t.name} (${t.expected}) ---`);
    try {
      const t0 = Date.now();
      const { report, durationMs } = await runAudit({ query: t.name });
      const pdf = await renderReportPdf(report);
      console.log(`  ✓ Score: ${report.audit.riskScore}/100 · ${report.audit.recommendation}`);
      console.log(`  ✓ Reasoning: ${report.audit.reasoning.slice(0, 120)}...`);
      console.log(`  ✓ PDF: ${pdf.pdfPath} (${pdf.pageCount} pages, ${durationMs}ms)`);
      results.push({ name: t.name, score: report.audit.riskScore, recommendation: report.audit.recommendation, pdfPath: pdf.pdfPath });
    } catch (e) {
      console.error(`  ✗ Failed: ${e}`);
      results.push({ name: t.name, error: String(e) });
    }
  }

  writeFileSync(`${config.outputDir}/demo-summary.json`, JSON.stringify(results, null, 2));
  console.log(`\n✓ Summary written to ${config.outputDir}/demo-summary.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
