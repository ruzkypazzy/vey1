// src/synthesis/orchestrator.ts
// Orchestrates the full audit pipeline:
//   1. resolve input → ProjectIdentity
//   2. scrape project site → candidate team
//   3. audit on-chain wallets (project + personal)
//   3b. (NEW) gather real on-chain evidence via OKX OnchainOS
//   4. synthesize via LLM (with source citations)
//   5. build the ProjectAudit record

import { resolveInput, enrichFromWeb } from "../audit/resolver.js";
import { scrapeProjectSite } from "../audit/scrape.js";
import { auditWallet } from "../audit/onchain.js";
import { buildTeam } from "../audit/team.js";
import { synthesizeAudit, buildReport } from "./prompt.js";
import { buildDossier, checkOnchainosAvailable, canMakePaidCalls, type OnchainDossier } from "../services/onchainos.js";
import type {
  ProjectAudit,
  ProjectIdentity,
  AuditReport,
  WalletAudit,
  TeamMember,
  AuditFlag,
} from "../types/index.js";

export interface OrchestratorInput {
  /** Project name, handle, contract, or URL */
  query: string;
  /** Optional: explicit addresses to treat as personal wallets */
  explicitAddresses?: { address: string; source: string; chain?: string }[];
}

export interface OrchestratorResult {
  report: AuditReport;
  durationMs: number;
  onchainDossier?: OnchainDossier | null;
}

export async function runAudit(
  input: OrchestratorInput,
): Promise<OrchestratorResult> {
  const t0 = Date.now();

  // Stage 1: resolve
  const { identity: initialIdentity, scrapeUrls } = await resolveInput(input.query);
  let identity = initialIdentity;
  if (scrapeUrls.length > 0) {
    identity = await enrichFromWeb(identity, scrapeUrls);
  }

  // Stage 2: scrape project site (if we have one)
  let candidates: Partial<TeamMember>[] = [];
  let twitters: string[] = identity.twitter ? [identity.twitter] : [];
  let githubs: string[] = identity.github ? [identity.github] : [];
  let evidence: { type: string; ref: string; note?: string }[] = [];

  if (identity.website) {
    try {
      const scraped = await scrapeProjectSite(identity.website);
      candidates = scraped.candidates;
      twitters = Array.from(new Set([...twitters, ...scraped.twitters]));
      githubs = Array.from(new Set([...githubs, ...scraped.githubs]));
      for (const p of scraped.pages) {
        evidence.push({ type: "web", ref: p.url });
      }
    } catch (e) {
      // best effort
      evidence.push({ type: "error", ref: "scrape", note: String(e) });
    }
  }

  // Stage 3: audit project on-chain wallet(s) — start with the contract deployer
  const projectWallets: WalletAudit[] = [];
  if (identity.contractAddress) {
    try {
      const r = await auditWallet({
        address: identity.contractAddress,
        label: "Contract / Deployer candidate",
        chain: identity.chain,
      });
      projectWallets.push(r.wallet);
      evidence.push({ type: "onchain", ref: r.wallet.address });
    } catch (e) {
      evidence.push({ type: "error", ref: "onchain", note: String(e) });
    }
  }

  // Stage 3b (NEW): real on-chain dossier via OKX OnchainOS — this is the
  // "no LLM hallucination" upgrade. Builds a structured dossier of:
  //   - resolved token (contract + chain + deployer)
  //   - security scan (honeypot, risk level, mint authority)
  //   - holder cluster analysis (rug pull %, top 10 concentration)
  //   - deployer reputation (other tokens, rugged count)
  //   - smart money signals
  //   - real social sentiment (KOLs, vibe score)
  //   - recent news (cited URLs)
  //   - deployer wallet PnL (win rate, realized PnL)
  let dossier: OnchainDossier | null = null;
  const onchainosHealth = await checkOnchainosAvailable();
  if (onchainosHealth.ok && process.env.ONCHAINOS_DISABLED !== "1") {
    // Pre-flight: try to bootstrap the session and check the balance.
    // Skip the dossier entirely if we can't pay for it.
    const preflight = await canMakePaidCalls();
    if (preflight.ok) {
      evidence.push({
        type: "onchainos",
        ref: "session",
        note: `logged in, balance ${preflight.balance?.toFixed(4)} USDT0`,
      });
      try {
        dossier = await buildDossier(input.query, identity.chain as any);
        evidence.push({ type: "onchainos", ref: "dossier", note: `cost=${dossier.costUsdt0.toFixed(4)} USDT0` });
      } catch (e) {
        console.error(`[orchestrator] buildDossier failed: ${e instanceof Error ? e.message : String(e)}`);
        evidence.push({ type: "error", ref: "onchainos-dossier", note: String(e) });
      }
    } else {
      evidence.push({
        type: "info",
        ref: "onchainos",
        note: `preflight skipped: ${preflight.reason}`,
      });
    }
  } else {
    evidence.push({
      type: "info",
      ref: "onchainos",
      note: onchainosHealth.ok ? "disabled by env" : `unavailable: ${onchainosHealth.error ?? "see logs"}`,
    });
  }

  // Stage 4: build team (now informed by the dossier's deployer + other tokens)
  const candidateNames = candidates.map((c) => c.name ?? "").filter(Boolean);
  const teamResult = await buildTeam({
    names: candidateNames,
    twitters,
    githubs,
    explicitAddresses: input.explicitAddresses,
  });

  // Stage 5: synthesize via LLM — pass the dossier as EVIDENCE (not just LLM memory)
  let synth;
  try {
    synth = await synthesizeAudit(identity, projectWallets, teamResult.members, {
      twitters,
      githubs,
      dossier: dossier ?? undefined,
    });
  } catch (e) {
    console.error(`[orchestrator] synth FAILED: ${e instanceof Error ? e.stack : String(e)}`);
    throw e;
  }

  // Stage 6: assemble ProjectAudit
  const allFlags: AuditFlag[] = [
    ...projectWallets.flatMap((w) => w.flags),
    ...synth.flags,
  ];
  // Sort flags: RED first, then YELLOW, then GREEN
  const order: Record<string, number> = { RED: 0, YELLOW: 1, GREEN: 2 };
  allFlags.sort((a, b) => (order[a.color] ?? 9) - (order[b.color] ?? 9));

  const audit: ProjectAudit = {
    identity,
    projectWallets,
    team: synth.enrichedTeam,
    flags: allFlags,
    riskScore: synth.riskScore,
    recommendation: synth.recommendation,
    reasoning: synth.reasoning,
    comparableProjects: synth.comparableProjects,
  };

  const dataConfidence =
    Math.min(1, 0.3 + (projectWallets?.length ?? 0) * 0.1 + (teamResult.members?.length ?? 0) * 0.1) *
    (identity.confidence || 0.5) *
    (dossier?.resolvedToken ? 1.3 : 1.0); // boost confidence if we have real OnchainOS data

  let report;
  try {
    report = buildReport(identity, audit, evidence, new Date(t0), Math.min(1, dataConfidence), dossier);
  } catch (e) {
    console.error(`[orchestrator] buildReport FAILED: ${e instanceof Error ? e.stack : String(e)}`);
    throw e;
  }

  return { report, durationMs: Date.now() - t0, onchainDossier: dossier };
}
