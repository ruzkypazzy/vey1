// src/pdf/template.ts
// HTML template for the VEY1 PDF report. Pure string-building so the
// output is reproducible and easy to test.

import type { AuditReport, ProjectAudit, TeamMember, WalletAudit, RiskLevel, FlagColor } from "../types/index.js";

// Subset of the OnchainDossier that we actually render in the PDF.
// Matches the structure stored in `AuditReport.onchainDossier` (see types/index.ts).
type ReportDossier = NonNullable<AuditReport["onchainDossier"]>;

// Helper to format percentage with safety
function pct(n: number | undefined | null): string {
  if (n == null || isNaN(n)) return "—";
  return `${n.toFixed(1)}%`;
}

// Helper to format USD value
function usd(n: number | undefined | null): string {
  if (n == null || isNaN(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function renderOnchainosDossier(dossier: ReportDossier | null | undefined): string {
  if (!dossier) {
    return `
    <section>
      <h2>3.5 OnchainOS Real-Time Evidence</h2>
      <p class="muted">OnchainOS dossier unavailable for this audit. The risk score above is based on LLM knowledge and web scraping only — treat as provisional. Re-run with a funded Agentic Wallet to unlock real on-chain evidence.</p>
    </section>`;
  }
  if (!dossier.resolvedToken) {
    return `
    <section>
      <h2>3.5 OnchainOS Real-Time Evidence</h2>
      <p class="muted">OnchainOS could not resolve a token matching "${escapeHtml(dossier.query)}" across its 20+ supported chains. The audit relies on LLM knowledge + web scraping for this project. Cost of search: ${dossier.costUsdt0.toFixed(4)} USDT0.</p>
    </section>`;
  }

  const t = dossier.resolvedToken;
  const sec = dossier.security;
  const h = dossier.holders;
  const dev = dossier.deployerReputation;
  const sm = dossier.smartMoney;
  const sent = dossier.sentiment;
  const news = dossier.recentNews ?? [];
  const pnl = dossier.walletPnl;

  // Security panel
  const secPanel = sec ? `
    <h3>Security scan <span class="muted small">(okx-security)</span></h3>
    <table class="table compact">
      <tr><th>Risk level</th><td><strong style="color:${sec.riskLevel === "safe" || sec.riskLevel === "low" ? "#059669" : sec.riskLevel === "medium" ? "#d97706" : "#dc2626"}">${(sec.riskLevel || "unknown").toUpperCase()}</strong> (score ${sec.riskScore ?? 0}/100)</td></tr>
      <tr><th>Honeypot?</th><td>${sec.isHoneypot ? "<strong style=\"color:#dc2626\">YES</strong>" : "No"}</td></tr>
      <tr><th>Can sell?</th><td>${sec.canSell ? "Yes" : "<strong style=\"color:#dc2626\">NO</strong>"}</td></tr>
      <tr><th>Ownership renounced</th><td>${sec.hasRenounced ? "Yes" : "No"}</td></tr>
      <tr><th>Mint function</th><td>${sec.hasMintFunction ? "<strong style=\"color:#d97706\">Present (can inflate supply)</strong>" : "Disabled"}</td></tr>
      ${sec.holderConcentration != null ? `<tr><th>Top-10 concentration</th><td>${pct(sec.holderConcentration)}</td></tr>` : ""}
      ${(sec.suspiciousFlags?.length ?? 0) > 0 ? `<tr><th>Suspicious flags</th><td>${sec.suspiciousFlags.map((f) => `<span class="mini-flag" style="background:#dc2626">!</span> ${escapeHtml(f)}`).join("; ")}</td></tr>` : ""}
    </table>` : `<h3>Security scan <span class="muted small">(okx-security)</span></h3><p class="muted">Security scan unavailable (x402 call failed — see evidence log).</p>`;

  // Holders panel
  const hPanel = h ? `
    <h3>Holder cluster analysis <span class="muted small">(okx-dex-token)</span></h3>
    <table class="table compact">
      <tr><th>Cluster count</th><td>${h.clusterCount} ${h.clusterCount <= 1 ? "(suspicious — single cluster often indicates sybil)" : ""}</td></tr>
      <tr><th>New wallet %</th><td>${pct(h.newWalletPercent)}</td></tr>
      <tr><th>Rug pull probability</th><td><strong style="color:${h.rugPullPercent > 30 ? "#dc2626" : h.rugPullPercent > 10 ? "#d97706" : "#059669"}">${pct(h.rugPullPercent)}</strong></td></tr>
    </table>
    ${(h.topHolders?.length ?? 0) > 0 ? `
      <h4>Top holders</h4>
      <table class="table compact">
        <thead><tr><th>Address</th><th>% held</th><th>Tag</th></tr></thead>
        <tbody>
          ${h.topHolders.slice(0, 8).map((hh) => `<tr><td><code>${shortAddr(hh.address)}</code></td><td>${pct(hh.percent)}</td><td>${hh.tag ? escapeHtml(hh.tag) : "—"}</td></tr>`).join("")}
        </tbody>
      </table>` : ""}` : `<h3>Holder cluster analysis</h3><p class="muted">Holder data unavailable.</p>`;

  // Deployer panel
  const devPanel = dev ? `
    <h3>Deployer reputation <span class="muted small">(okx-dex-trenches)</span></h3>
    <table class="table compact">
      <tr><th>Deployer</th><td><code>${shortAddr(dev.deployerAddress)}</code></td></tr>
      <tr><th>Other tokens launched</th><td>${dev.totalTokensLaunched}</td></tr>
      <tr><th>Of which rugged</th><td><strong style="color:${dev.ruggedCount >= 2 ? "#dc2626" : dev.ruggedCount === 1 ? "#d97706" : "#059669"}">${dev.ruggedCount}</strong></td></tr>
      ${dev.avgTokenLifetimeDays != null ? `<tr><th>Avg token lifetime</th><td>${dev.avgTokenLifetimeDays.toFixed(0)} days</td></tr>` : ""}
    </table>
    ${(dev.otherTokens?.length ?? 0) > 0 ? `
      <h4>Deployer's other tokens</h4>
      <table class="table compact">
        <thead><tr><th>Symbol</th><th>Name</th><th>Chain</th></tr></thead>
        <tbody>
          ${dev.otherTokens.slice(0, 10).map((ot) => `<tr><td>${escapeHtml(ot.symbol)}</td><td>${escapeHtml(ot.name)}</td><td>${escapeHtml(ot.chain)}</td></tr>`).join("")}
        </tbody>
      </table>` : ""}` : `<h3>Deployer reputation</h3><p class="muted">Deployer data unavailable or address not found.</p>`;

  // Smart money panel
  const smPanel = sm && sm.length > 0 ? `
    <h3>Smart money / KOL signal <span class="muted small">(okx-dex-signal)</span></h3>
    <table class="table compact">
      <thead><tr><th>Address</th><th>Tag</th><th>Recent buys (USD)</th><th>Recent sells (USD)</th></tr></thead>
      <tbody>
        ${sm.slice(0, 10).map((s) => `<tr><td><code>${shortAddr(s.address)}</code></td><td>${escapeHtml(s.tag)}</td><td>${usd(s.recentBuysUsd)}</td><td>${usd(s.recentSellsUsd)}</td></tr>`).join("")}
      </tbody>
    </table>` : `<h3>Smart money signal</h3><p class="muted">No smart money / KOL activity in the past 7 days.</p>`;

  // Sentiment panel
  const sentPanel = sent ? `
    <h3>Social sentiment <span class="muted small">(okx-dex-social)</span></h3>
    <table class="table compact">
      <tr><th>Vibe score</th><td><strong>${sent.sentimentScore}/100</strong> ${sent.sentimentScore < 30 ? "(extreme fear)" : sent.sentimentScore < 50 ? "(bearish)" : sent.sentimentScore < 70 ? "(neutral)" : "(greedy)"}</td></tr>
      ${sent.vibeRank != null ? `<tr><th>Vibe rank</th><td>#${sent.vibeRank}</td></tr>` : ""}
      ${sent.newsCount24h != null ? `<tr><th>News in 24h</th><td>${sent.newsCount24h}</td></tr>` : ""}
      ${sent.topKOLs && sent.topKOLs.length > 0 ? `<tr><th>Top KOLs</th><td>${sent.topKOLs.slice(0, 5).map((k) => `@${escapeHtml(String((k as any).handle ?? (k as any).twitterHandle ?? "anonymous"))} (influence: ${(k as any).influence ?? "n/a"})`).join(", ")}</td></tr>` : ""}
    </table>` : "";

  // News panel
  const newsPanel = (news?.length ?? 0) > 0 ? `
    <h3>Recent news <span class="muted small">(okx-dex-social, cited)</span></h3>
    <ol class="news-list">
      ${news.slice(0, 8).map((n) => `<li><strong>${escapeHtml(String(n.title ?? "Untitled"))}</strong> — <a href="${escapeHtml(String(n.url ?? "#"))}">${escapeHtml(String(n.source ?? "Unknown"))}</a> <span class="muted">${n.publishedAt ? new Date(n.publishedAt).toISOString().slice(0, 10) : ""}</span></li>`).join("")}
    </ol>` : "";

  // Wallet PnL panel
  const pnlPanel = pnl ? `
    <h3>Deployer wallet trading history <span class="muted small">(okx-dex-market)</span></h3>
    <table class="table compact">
      <tr><th>Total trades</th><td>${pnl.totalTrades}</td></tr>
      <tr><th>Win rate</th><td>${pct(pnl.winRate)}</td></tr>
      <tr><th>Realized PnL</th><td><strong style="color:${pnl.realizedPnlUsd >= 0 ? "#059669" : "#dc2626"}">${usd(pnl.realizedPnlUsd)}</strong></td></tr>
      <tr><th>Unrealized PnL</th><td><strong style="color:${pnl.unrealizedPnlUsd >= 0 ? "#059669" : "#dc2626"}">${usd(pnl.unrealizedPnlUsd)}</strong></td></tr>
    </table>` : "";

  return `
    <section>
      <h2>3.5 OnchainOS Real-Time Evidence</h2>
      <p class="muted small">All data in this section is REAL ON-CHAIN EVIDENCE pulled from OKX OnchainOS via x402 paywall. The audit cost <strong>${dossier.costUsdt0.toFixed(4)} USDT0</strong> from VEY1's Agentic Wallet. Sources cited inline: <code>okx-dex-token</code>, <code>okx-dex-trenches</code>, <code>okx-dex-signal</code>, <code>okx-dex-social</code>, <code>okx-dex-market</code>, <code>okx-security</code>.</p>
      <h3>Resolved token</h3>
      <table class="table compact">
        <tr><th>Symbol</th><td><strong>${escapeHtml(t.symbol)}</strong></td></tr>
        <tr><th>Name</th><td>${escapeHtml(t.name)}</td></tr>
        <tr><th>Contract</th><td><code>${shortAddr(t.address)}</code></td></tr>
        <tr><th>Chain</th><td>${escapeHtml(t.chain)}</td></tr>
        <tr><th>Deployer</th><td>${t.deployerAddress ? `<code>${shortAddr(t.deployerAddress)}</code>` : "—"}</td></tr>
      </table>
      ${secPanel}
      ${hPanel}
      ${devPanel}
      ${smPanel}
      ${sentPanel}
      ${pnlPanel}
      ${newsPanel}
      ${dossier.errors.length > 0 ? `<p class="muted small">OnchainOS call errors: ${dossier.errors.map((e) => escapeHtml(e)).join("; ")}</p>` : ""}
    </section>`;
}

const COLORS: Record<FlagColor, string> = {
  RED: "#dc2626",
  YELLOW: "#d97706",
  GREEN: "#059669",
};

const RISK_BG: Record<RiskLevel, string> = {
  LOW: "#d1fae5",
  MEDIUM: "#fef3c7",
  HIGH: "#fee2e2",
  CRITICAL: "#7f1d1d",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shortAddr(addr: string): string {
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function riskLevel(score: number): RiskLevel {
  if (score >= 80) return "LOW";
  if (score >= 60) return "MEDIUM";
  if (score >= 30) return "HIGH";
  return "CRITICAL";
}

function recommendationText(rec: ProjectAudit["recommendation"]): string {
  switch (rec) {
    case "PROCEED":
      return "PROCEED — Standard due diligence satisfied. Invest as planned.";
    case "PROCEED_WITH_MONITORING":
      return "PROCEED WITH MONITORING — Acceptable risk, but monitor key signals monthly.";
    case "CAUTION":
      return "CAUTION — Material concerns identified. Reduce exposure or require resolution before adding.";
    case "AVOID":
      return "AVOID — Significant red flags. We recommend not exposing capital.";
  }
}

function riskScoreBar(score: number): string {
  const color =
    score >= 80 ? "#059669" : score >= 60 ? "#d97706" : score >= 30 ? "#dc2626" : "#7f1d1d";
  const width = Math.max(2, score);
  return `
    <div class="risk-bar">
      <div class="risk-bar-fill" style="width:${width}%;background:${color}"></div>
    </div>
    <div class="risk-bar-label">${score}/100</div>
  `;
}

function renderFlags(flags: { color: FlagColor; category: string; message: string; evidence?: string }[]): string {
  if (flags.length === 0) return "<p class=\"muted\">No material flags identified.</p>";
  return `<ul class="flag-list">
    ${flags
      .map(
        (f) => `
      <li class="flag flag-${f.color.toLowerCase()}">
        <span class="flag-color" style="background:${COLORS[f.color]}">${f.color}</span>
        <strong>${escapeHtml(f.category)}:</strong>
        <span>${escapeHtml(f.message)}</span>
        ${f.evidence ? `<div class="flag-evidence">${escapeHtml(f.evidence)}</div>` : ""}
      </li>`,
      )
      .join("")}
  </ul>`;
}

function renderWalletTable(wallets: WalletAudit[]): string {
  if (wallets.length === 0) return "<p class=\"muted\">No wallets identified.</p>";
  return `<table class="table">
    <thead>
      <tr>
        <th>Label</th>
        <th>Address</th>
        <th>Chain</th>
        <th>First seen</th>
        <th>Funding source</th>
        <th>Flags</th>
      </tr>
    </thead>
    <tbody>
      ${wallets
        .map(
          (w) => `
        <tr>
          <td>${escapeHtml(w.label)}</td>
          <td><code>${shortAddr(w.address)}</code></td>
          <td>${escapeHtml(w.chain)}</td>
          <td>${w.firstSeenDate ? escapeHtml(w.firstSeenDate) : "—"}</td>
          <td>${w.fundingSource ? escapeHtml(w.fundingSource.type) : "—"}</td>
          <td>${w.flags.length === 0 ? "—" : w.flags.map((f) => `<span class="mini-flag" style="background:${COLORS[f.color]}">${f.color[0]}</span>`).join("")}</td>
        </tr>`,
        )
        .join("")}
    </tbody>
  </table>`;
}

function renderTeamSection(team: TeamMember[]): string {
  if (team.length === 0) return "<p class=\"muted\">No team members identified.</p>";
  return team
    .map((t) => {
      const past = t.pastProjects
        .map(
          (p) =>
            `<tr><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.role)}</td><td>${p.year ?? "—"}</td><td>${escapeHtml(p.status)}</td><td>${escapeHtml(p.outcome ?? "—")}</td></tr>`,
        )
        .join("");
      const wallets = t.personalWallets
        .map(
          (w) => `
        <div class="wallet-card">
          <div><code>${shortAddr(w.address)}</code> <span class="muted">(${escapeHtml(w.label)})</span></div>
          <div class="muted">Funding: ${w.fundingSource ? escapeHtml(w.fundingSource.type) : "—"} · First seen: ${w.firstSeenDate ?? "—"}</div>
          ${w.flags.length > 0 ? `<div class="wallet-flags">${w.flags.map((f) => `<span class="mini-flag" style="background:${COLORS[f.color]}">${f.color}</span> ${escapeHtml(f.message)}`).join("; ")}</div>` : ""}
        </div>`,
        )
        .join("");
      return `
        <div class="team-member">
          <div class="team-header">
            <h3>${escapeHtml(t.name)}</h3>
            <div class="team-meta">
              <span>Role: ${escapeHtml(t.role)}</span> ·
              <span>Identity: ${escapeHtml(t.identityConfidence)}</span> ·
              <span>Risk: ${t.riskScore}/100</span>
            </div>
          </div>
          ${renderFlags(t.flags)}
          ${
            t.personalWallets.length > 0
              ? `<h4>Personal wallets</h4>${wallets}`
              : `<p class="muted">No personal wallets linked to this person.</p>`
          }
          ${
            t.pastProjects.length > 0
              ? `<h4>Past projects</h4>
                <table class="table compact">
                  <thead><tr><th>Project</th><th>Role</th><th>Year</th><th>Status</th><th>Outcome</th></tr></thead>
                  <tbody>${past}</tbody>
                </table>`
              : `<p class="muted">No prior public projects identified.</p>`
          }
          ${
            t.scamDbHits.length > 0
              ? `<h4>Scam database hits</h4>
                <ul>${t.scamDbHits.map((h) => `<li><strong>${escapeHtml(h.source)}</strong>: ${escapeHtml(h.note ?? "match")}</li>`).join("")}</ul>`
              : ""
          }
        </div>`;
    })
    .join("");
}

function renderCover(report: AuditReport): string {
  const score = report.audit.riskScore;
  const rl = riskLevel(score);
  return `
    <div class="cover">
      <div class="cover-brand">VEY1</div>
      <h1>Project Due Diligence Report</h1>
      <h2 class="cover-name">${escapeHtml(report.identity.canonicalName)}</h2>
      ${report.identity.ticker ? `<div class="cover-ticker">$${escapeHtml(report.identity.ticker)}</div>` : ""}
      <div class="cover-score risk-${rl.toLowerCase()}">
        <div class="cover-score-num">${score}<span>/100</span></div>
        <div class="cover-score-label">${rl} RISK</div>
      </div>
      <div class="cover-meta">
        <div>Report ID: <code>${escapeHtml(report.id)}</code></div>
        <div>Generated: ${escapeHtml(report.completedAt)}</div>
      </div>
      <div class="cover-confidential">CONFIDENTIAL</div>
    </div>`;
}

function renderToc(): string {
  return `
    <div class="toc">
      <h2>Table of Contents</h2>
      <ol>
        <li>Executive Summary</li>
        <li>Project Profile</li>
        <li>On-Chain Audit</li>
        <li>Team Dossiers</li>
        <li>Risk Synthesis</li>
        <li>Comparable Projects</li>
        <li>Final Recommendation</li>
        <li>Methodology &amp; Data Sources</li>
        <li>Annexures</li>
      </ol>
    </div>`;
}

function renderExecSummary(report: AuditReport, audit: ProjectAudit): string {
  return `
    <section>
      <h2>1. Executive Summary</h2>
      <div class="callout">
        <div><strong>Risk score:</strong> ${audit.riskScore}/100 (${riskLevel(audit.riskScore)})</div>
        ${riskScoreBar(audit.riskScore)}
        <div><strong>Recommendation:</strong> ${recommendationText(audit.recommendation)}</div>
      </div>
      <h3>Reasoning</h3>
      <p>${escapeHtml(audit.reasoning)}</p>
      <h3>Top material flags</h3>
      ${renderFlags(audit.flags.slice(0, 8))}
    </section>`;
}

function renderProjectProfile(report: AuditReport): string {
  const i = report.identity;
  return `
    <section>
      <h2>2. Project Profile</h2>
      <table class="table">
        <tbody>
          <tr><th>Canonical name</th><td>${escapeHtml(i.canonicalName)}</td></tr>
          ${i.ticker ? `<tr><th>Ticker</th><td>${escapeHtml(i.ticker)}</td></tr>` : ""}
          ${i.contractAddress ? `<tr><th>Contract</th><td><code>${escapeHtml(i.contractAddress)}</code></td></tr>` : ""}
          ${i.chain ? `<tr><th>Chain</th><td>${escapeHtml(i.chain)}</td></tr>` : ""}
          ${i.website ? `<tr><th>Website</th><td>${escapeHtml(i.website)}</td></tr>` : ""}
          ${i.twitter ? `<tr><th>Twitter</th><td>@${escapeHtml(i.twitter)}</td></tr>` : ""}
          ${i.github ? `<tr><th>GitHub</th><td>${escapeHtml(i.github)}</td></tr>` : ""}
          <tr><th>Input given</th><td><code>${escapeHtml(i.rawInput)}</code></td></tr>
          <tr><th>Identity confidence</th><td>${(i.confidence * 100).toFixed(0)}%</td></tr>
        </tbody>
      </table>
    </section>`;
}

function renderOnchainSection(audit: ProjectAudit): string {
  return `
    <section>
      <h2>3. On-Chain Audit</h2>
      <p>For every project-controlled wallet (deployer, treasury, fee collector, multisig), VEY1 audits the funding source, transaction history, and counterparty graph. ${audit.projectWallets.length === 0 ? "No project-controlled wallets were identified in this audit." : ""}</p>
      ${renderWalletTable(audit.projectWallets)}
    </section>`;
}

function renderTeamSection2(team: TeamMember[]): string {
  return `
    <section>
      <h2>4. Team Dossiers</h2>
      <p>For every identified team member, VEY1 audits: (a) identity verification status, (b) public social footprint, (c) past project associations, (d) personal on-chain wallets, (e) scam database cross-reference. The dossier below contains evidence and per-person risk scoring.</p>
      ${renderTeamSection(team)}
    </section>`;
}

function renderRiskSynthesis(audit: ProjectAudit): string {
  return `
    <section>
      <h2>5. Risk Synthesis</h2>
      <p>${escapeHtml(audit.reasoning)}</p>
      ${audit.flags.length > 0 ? renderFlags(audit.flags) : ""}
    </section>`;
}

function renderComparables(audit: ProjectAudit): string {
  if (audit.comparableProjects.length === 0) return "<section><h2>6. Comparable Projects</h2><p class=\"muted\">No comparable projects returned by analysis.</p></section>";
  return `
    <section>
      <h2>6. Comparable Projects</h2>
      <p>${audit.comparableProjects.length} comparable projects in the same category:</p>
      <table class="table">
        <thead>
          <tr><th>Project</th><th>Year</th><th>Status</th><th>Outcome</th></tr>
        </thead>
        <tbody>
          ${audit.comparableProjects
            .map(
              (p) =>
                `<tr><td>${escapeHtml(p.name)}</td><td>${p.year ?? "—"}</td><td>${escapeHtml(p.status)}</td><td>${escapeHtml(p.outcome ?? "—")}</td></tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </section>`;
}

function renderRecommendation(audit: ProjectAudit): string {
  return `
    <section>
      <h2>7. Final Recommendation</h2>
      <div class="callout">
        <h3>${recommendationText(audit.recommendation)}</h3>
      </div>
      <h3>Suggested next steps</h3>
      <ul>
        ${
          audit.recommendation === "AVOID"
            ? "<li>Do not allocate capital. Document this audit for compliance records.</li><li>Alert your team / community if this project is being promoted internally.</li>"
            : audit.recommendation === "CAUTION"
            ? "<li>Reduce exposure by 50% pending resolution of flagged issues.</li><li>Set a stop-loss at -20% and review weekly.</li><li>Require team doxx + treasury lock before adding.</li>"
            : audit.recommendation === "PROCEED_WITH_MONITORING"
            ? "<li>Proceed with planned exposure. Re-run this audit in 30 days.</li><li>Subscribe to wallet-activity alerts for the deployer and treasury.</li>"
            : "<li>Standard investment process applies. Re-audit quarterly.</li>"
        }
      </ul>
      <p class="muted">Revalidation recommended: 30 days.</p>
    </section>`;
}

function renderMethodology(report: AuditReport): string {
  return `
    <section>
      <h2>8. Methodology &amp; Data Sources</h2>
      <p>VEY1 performs five sequential stages: (1) input resolution to canonical project identity, (2) web scraping of project site for team and social links, (3) on-chain audit of project-controlled and personal wallets, (4) team dossier assembly with scam database cross-reference, (5) LLM synthesis with adversarial prompt design.</p>
      <h3>Data sources used</h3>
      <ul>
        <li>Project website, whitepaper, team page (best-effort scrape)</li>
        <li>OnchainOS wallet history, risk scanner, and token holder queries (when CLI is available)</li>
        <li>Direct EVM RPC read for first-seen block and balance (fallback path)</li>
        <li>Public scam databases: Chainabuse, Etherscan labels (mock cross-reference in MVP)</li>
        <li>LLM synthesis via OpenAI-compatible API (gpt-4o-mini by default)</li>
      </ul>
      <h3>Limitations</h3>
      <ul>
        <li>Twitter handle → wallet resolution requires paid API access; we accept explicit user-provided addresses for personal wallets.</li>
        <li>LinkedIn is not queried (no public API).</li>
        <li>Scam database coverage in MVP is mock-level; production should integrate Chainabuse API.</li>
        <li>${report.evidence.length} evidence references captured for this audit.</li>
      </ul>
      <h3>Data confidence</h3>
      <p>${(report.dataConfidence * 100).toFixed(0)}% — ${
    report.dataConfidence > 0.7
      ? "high"
      : report.dataConfidence > 0.4
      ? "medium"
      : "low"
  }. Lower confidence means fewer data sources could be cross-referenced; treat the score as provisional.</p>
    </section>`;
}

function renderAnnexures(report: AuditReport): string {
  return `
    <section>
      <h2>9. Annexures</h2>
      <h3>Evidence index</h3>
      <table class="table compact">
        <thead><tr><th>Type</th><th>Reference</th><th>Note</th></tr></thead>
        <tbody>
          ${report.evidence
            .map(
              (e) =>
                `<tr><td>${escapeHtml(e.type)}</td><td><code>${escapeHtml(e.ref)}</code></td><td>${escapeHtml(e.note ?? "—")}</td></tr>`,
            )
            .join("")}
        </tbody>
      </table>
      <h3>Glossary</h3>
      <dl class="glossary">
        <dt>CEX</dt><dd>Centralized exchange (Binance, Coinbase, etc.)</dd>
        <dt>DEX</dt><dd>Decentralized exchange (Uniswap, etc.)</dd>
        <dt>EOA</dt><dd>Externally owned account (regular wallet)</dd>
        <dt>Multisig</dt><dd>Multi-signature wallet requiring M-of-N signers</dd>
        <dt>OFAC</dt><dd>Office of Foreign Assets Control — US sanctions list</dd>
        <dt>Tornado Cash</dt><dd>Privacy mixer sanctioned by US Treasury in 2022</dd>
      </dl>
    </section>`;
}

export function reportToHtml(report: AuditReport): string {
  const a = report.audit;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>VEY1 Report — ${escapeHtml(report.identity.canonicalName)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
      font-size: 11pt;
      line-height: 1.5;
      color: #111;
      margin: 0;
      padding: 0;
    }
    h1 { font-size: 24pt; margin: 0 0 8mm 0; }
    h2 { font-size: 16pt; margin: 8mm 0 4mm 0; padding-bottom: 2mm; border-bottom: 2px solid #111; page-break-before: always; }
    h3 { font-size: 13pt; margin: 6mm 0 3mm 0; }
    h4 { font-size: 11pt; margin: 4mm 0 2mm 0; color: #444; text-transform: uppercase; letter-spacing: 0.05em; }
    code { font-family: "SF Mono", "Consolas", monospace; font-size: 9pt; background: #f3f4f6; padding: 1px 4px; border-radius: 2px; }
    .muted { color: #6b7280; }
    section { padding: 0; }
    .cover { padding: 30mm 20mm; text-align: center; page-break-after: always; }
    .cover-brand { font-size: 14pt; letter-spacing: 0.3em; color: #6b7280; margin-bottom: 12mm; }
    .cover h1 { font-size: 20pt; font-weight: 400; color: #6b7280; }
    .cover-name { font-size: 36pt; margin: 8mm 0 4mm 0; }
    .cover-ticker { font-size: 14pt; color: #6b7280; margin-bottom: 12mm; }
    .cover-score { margin: 20mm auto; max-width: 60mm; padding: 12mm; border-radius: 6px; }
    .cover-score-num { font-size: 48pt; font-weight: 700; }
    .cover-score-num span { font-size: 16pt; color: #6b7280; }
    .cover-score-label { font-size: 11pt; letter-spacing: 0.2em; margin-top: 4mm; }
    .risk-low { background: ${RISK_BG.LOW}; }
    .risk-medium { background: ${RISK_BG.MEDIUM}; }
    .risk-high { background: ${RISK_BG.HIGH}; }
    .risk-critical { background: ${RISK_BG.CRITICAL}; color: white; }
    .cover-meta { font-size: 9pt; color: #6b7280; margin-top: 12mm; }
    .cover-confidential { font-size: 10pt; letter-spacing: 0.3em; color: #dc2626; margin-top: 20mm; }
    .toc { padding: 20mm; page-break-after: always; }
    .toc ol { font-size: 13pt; line-height: 2; }
    .callout { background: #f3f4f6; border-left: 4px solid #111; padding: 6mm 8mm; margin: 4mm 0; }
    .callout h3 { margin: 0; font-size: 13pt; }
    .risk-bar { background: #e5e7eb; height: 4mm; border-radius: 2mm; overflow: hidden; margin: 3mm 0 1mm 0; }
    .risk-bar-fill { height: 100%; }
    .risk-bar-label { font-size: 9pt; color: #6b7280; }
    .table { width: 100%; border-collapse: collapse; margin: 3mm 0; font-size: 9pt; }
    .table th, .table td { border: 1px solid #e5e7eb; padding: 2mm 3mm; text-align: left; vertical-align: top; }
    .table th { background: #f9fafb; font-weight: 600; }
    .table.compact th, .table.compact td { padding: 1.5mm 2mm; font-size: 8.5pt; }
    .flag-list { list-style: none; padding: 0; margin: 3mm 0; }
    .flag { display: flex; gap: 2mm; padding: 2mm 3mm; margin-bottom: 1mm; background: #fafafa; border-radius: 2mm; font-size: 10pt; }
    .flag-color { display: inline-block; width: 12mm; padding: 0.5mm 1mm; text-align: center; color: white; font-size: 8pt; font-weight: 700; border-radius: 1mm; flex-shrink: 0; }
    .flag-evidence { color: #6b7280; font-size: 8.5pt; margin-top: 1mm; font-family: monospace; }
    .mini-flag { display: inline-block; width: 4mm; height: 4mm; line-height: 4mm; text-align: center; color: white; font-size: 7pt; font-weight: 700; border-radius: 1mm; margin-right: 1mm; }
    .team-member { padding: 4mm 0; border-bottom: 1px solid #e5e7eb; page-break-inside: avoid; }
    .team-header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 2mm; }
    .team-header h3 { margin: 0; }
    .team-meta { font-size: 9pt; color: #6b7280; }
    .wallet-card { background: #f9fafb; border-radius: 2mm; padding: 2mm 3mm; margin: 1mm 0; font-size: 9pt; }
    .wallet-flags { margin-top: 1mm; }
    .glossary dt { font-weight: 600; margin-top: 1mm; }
    .glossary dd { margin: 0 0 1mm 4mm; color: #4b5563; font-size: 9.5pt; }
  </style>
</head>
<body>
  ${renderCover(report)}
  ${renderToc()}
  ${renderExecSummary(report, a)}
  ${renderProjectProfile(report)}
  ${renderOnchainSection(a)}
  ${renderOnchainosDossier(report.onchainDossier)}
  ${renderTeamSection2(a.team)}
  ${renderRiskSynthesis(a)}
  ${renderComparables(a)}
  ${renderRecommendation(a)}
  ${renderMethodology(report)}
  ${renderAnnexures(report)}
  <footer style="text-align:center;padding:6mm;font-size:8pt;color:#9ca3af;border-top:1px solid #e5e7eb;">
    Generated by VEY1 · ${escapeHtml(report.id)} · ${escapeHtml(report.completedAt)}
  </footer>
</body>
</html>`;
}
