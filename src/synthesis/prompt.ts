// src/synthesis/prompt.ts
// LLM synthesis - the secret sauce. Given a ProjectAudit + real on-chain
// dossier from OKX OnchainOS, ask the LLM to produce: a 0-100 risk score,
// red/yellow/green flags, comparable projects, and a 1-paragraph
// recommendation. The dossier is EVIDENCE - every claim in the final
// report should cite it.
//
// We use gpt-4o-mini via the OpenAI-compatible API (FreeModel.dev by
// default; swap OPENAI_BASE_URL to use OpenAI directly).

import { request } from "undici";
import { config } from "../config/secrets.js";
import type { OnchainDossier } from "../services/onchainos.js";
import type {
  ProjectAudit,
  ProjectIdentity,
  WalletAudit,
  TeamMember,
  PastProjectRef,
  AuditReport,
  AuditFlag,
} from "../types/index.js";

const SYSTEM_PROMPT = `You are VEY1, a forensic crypto due-diligence analyst. You are precise, evidence-based, and adversarial toward unverified claims. You never invent facts; if you don't have evidence, you say so explicitly with a confidence downgrade.

You receive a structured JSON payload that includes a "dossier" of REAL ON-CHAIN DATA pulled from OKX OnchainOS (paid x402 calls). The dossier contains:
- resolvedToken: the token contract, chain, deployer address
- security: honeypot check, riskLevel, mint function, suspicious flags
- holders: top 10 holders, cluster count, new wallet %, rug pull %
- deployerReputation: other tokens by the same deployer, rugged count
- smartMoney: address tracker for smart money / KOL / whale activity
- sentiment: real per-token vibe score and KOL leaderboard
- recentNews: cited news articles with URLs
- walletPnl: deployer wallet's win rate, realized PnL, total trades

CITATION RULES - CRITICAL:
- Every material claim in the report must reference the source: "Per okx-dex-trenches: deployer has launched 3 prior tokens, 2 of which rugged", "Per okx-security: honeypot risk = low, mint function = disabled", "Per okx-dex-signal: 12 smart money wallets added this position in the last 7 days", "Per okx-dex-social: sentiment score = 72/100 (greedy), top KOLs: @alice, @bob".
- If the dossier is null or empty, treat that as a data gap and say "OnchainOS data unavailable - relying on LLM knowledge + scraper". Downgrade the riskScore by 10 points for missing dossier.
- Do NOT fabricate token addresses, deployer addresses, wallet PnL, or holder counts. Only use what's in the dossier.
- For "comparableProjects" and historical context (e.g. "this is similar to BitConnect"), you may use your knowledge of crypto history, but distinguish clearly: "Historical context (LLM knowledge, not in dossier):" prefix.

Output: strict JSON only. No prose outside JSON. No markdown fences.

riskScore: 0-100, where 100 is safest. Be conservative.
- Start at 50 (neutral).
- Add +20 if dossier.security.riskLevel = "safe" and honeypot=false.
- Add +15 if dossier.deployerReputation.ruggedCount = 0 AND totalTokensLaunched >= 1.
- Add +10 if dossier.smartMoney has >= 3 smart_money buys in last 7d.
- Subtract -40 if dossier.security.isHoneypot = true OR cannotSell = true.
- Subtract -30 if dossier.deployerReputation.ruggedCount >= 2.
- Subtract -20 if dossier.holders.top10Concentration > 80%.
- Subtract -10 if dossier.sentiment.sentimentScore < 30 (extreme fear / exit).
- Subtract -15 if dossier has no resolvedToken (data gap).

recommendation: "PROCEED" | "PROCEED_WITH_MONITORING" | "CAUTION" | "AVOID"
- PROCEED: riskScore >= 80
- PROCEED_WITH_MONITORING: 60 <= riskScore < 80
- CAUTION: 40 <= riskScore < 60
- AVOID: riskScore < 40

reasoning: 6-10 sentences. Cite dossier sources explicitly. Distinguish on-chain facts from inferences. Each sentence should ideally reference a specific piece of evidence. NEVER produce generic boilerplate - every claim must be project-specific and grounded in either the dossier or your cited knowledge of crypto history.

topRisks: 5-8 specific, project-tailored risks. Examples of GOOD risks: Deployer's only other token rugged within 90 days of launch, Top-10 holders own 87% of supply, No audit report found and contract not verified, Founder's previous project charged with fraud. Examples of BAD risks: Market volatility, General crypto risks, Regulatory uncertainty (too generic).

flags: 4-8 material flags. Each must be project-specific and tied to a specific piece of evidence (cite the source). Avoid vague flags like "operational risk".

comparableProjects: 3-5 SPECIFIC similar projects with year, status (ACTIVE/RUGGED/ABANDONED/ACQUIRED), and outcome. For example, a Curve Finance audit should compare to Uniswap, Balancer, Bancor, etc. - NOT to "various DeFi protocols". For a meme coin, compare to other meme coins of similar size. Use your knowledge of crypto history.`;

interface LlmResponseShape {
  riskScore: number;
  recommendation: ProjectAudit["recommendation"];
  reasoning: string;
  topRisks: string[];
  flags: AuditFlag[];
  comparableProjects: PastProjectRef[];
  teamEnrichment: { name: string; role: string; pastProjects: PastProjectRef[] }[];
}

export async function synthesizeAudit(
  identity: ProjectIdentity,
  projectWallets: WalletAudit[],
  team: TeamMember[],
  extraSignals: Record<string, unknown> = {},
): Promise<{
  riskScore: number;
  recommendation: ProjectAudit["recommendation"];
  reasoning: string;
  topRisks: string[];
  flags: AuditFlag[];
  comparableProjects: PastProjectRef[];
  enrichedTeam: TeamMember[];
}> {
  const dossier = extraSignals.dossier as OnchainDossier | undefined;

  // Build a compact evidence payload
  const payload = {
    identity,
    dossier: dossier ?? null, // ← real on-chain evidence, not LLM memory
    projectWallets: projectWallets.map((w) => ({
      address: w.address,
      label: w.label,
      chain: w.chain,
      firstSeenDate: w.firstSeenDate,
      fundingSource: w.fundingSource,
      flags: w.flags,
    })),
    team: team.map((t) => ({
      name: t.name,
      role: t.role,
      identityConfidence: t.identityConfidence,
      riskScore: t.riskScore,
      personalWallets: t.personalWallets.map((w) => ({
        address: w.address,
        label: w.label,
        fundingSource: w.fundingSource,
        flags: w.flags,
      })),
      scamDbHits: t.scamDbHits,
      flags: t.flags,
    })),
    extraSignals: Object.fromEntries(
      Object.entries(extraSignals).filter(([k]) => k !== "dossier"),
    ),
  };

  const dossierNote = dossier
    ? `Real OnchainOS dossier attached (cost: ${dossier.costUsdt0.toFixed(4)} USDT0 from Agentic Wallet). CITE IT in your reasoning with explicit "Per okx-<skill>:" prefixes.`
    : `⚠️ OnchainOS dossier is NULL or empty. Treat this as a DATA GAP - every claim is LLM-knowledge only, not real on-chain data. Downgrade riskScore by 10 points and note "OnchainOS data unavailable" in reasoning.`;

  const body = {
    model: config.openai.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `⚠️ CRITICAL: The project being audited is "${identity.canonicalName}"${identity.ticker ? ` (ticker: $${identity.ticker})` : ""}${identity.contractAddress ? `, contract: ${identity.contractAddress}` : ""}${identity.chain ? ` on ${identity.chain}` : ""}.

Do NOT confuse this with any other project. All your analysis MUST be about "${identity.canonicalName}" specifically.

${dossierNote}

Project data (JSON):
${JSON.stringify(payload, null, 2)}

Return JSON with this exact shape:
{
  "riskScore": <0-100>,
  "recommendation": "PROCEED" | "PROCEED_WITH_MONITORING" | "CAUTION" | "AVOID",
  "reasoning": "<3-6 sentence narrative about ${identity.canonicalName} with 'Per okx-<skill>:' citations to dossier data>",
  "topRisks": ["<risk 1>", "<risk 2>", "<risk 3>"],
  "flags": [{"color": "RED|YELLOW|GREEN", "category": "<str>", "message": "<str>", "evidence": "<okx-skill or url>"}],
  "comparableProjects": [{"name": "<str>", "role": "<str or 'n/a'>", "year": <number or null>, "status": "ACTIVE|RUGGED|ABANDONED|ACQUIRED|UNKNOWN", "outcome": "<str>"}],
  "teamEnrichment": [{"name": "<str>", "role": "<str>", "pastProjects": [{"name": "<str>", "role": "<str>", "year": <number|null>, "status": "ACTIVE|RUGGED|ABANDONED|ACQUIRED|UNKNOWN", "outcome": "<str>"}]}]
}`,
      },
    ],
    temperature: 0.2,
    max_tokens: 2000,
  };

  const res = await request(`${config.openai.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.openai.apiKey}`,
    },
    body: JSON.stringify(body),
    headersTimeout: 30_000,
    bodyTimeout: 60_000,
  });

  if (res.statusCode >= 400) {
    const text = await res.body.text();
    throw new Error(`LLM API error ${res.statusCode}: ${text.slice(0, 300)}`);
  }

  const json = (await res.body.json()) as {
    choices: { message: { content: string } }[];
  };
  const raw = json.choices[0]?.message?.content ?? "{}";
  let parsed: LlmResponseShape;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    // Try to extract a JSON block from prose
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("LLM returned non-JSON response");
    parsed = JSON.parse(m[0]);
  }

  // Merge enrichment back into team
  const enrichByName = new Map(
    (parsed.teamEnrichment ?? []).map((e) => [e.name.toLowerCase(), e]),
  );
  const enrichedTeam: TeamMember[] = team.map((t) => {
    const e = enrichByName.get(t.name.toLowerCase());
    if (!e) return t;
    return {
      ...t,
      role: e.role || t.role,
      pastProjects: e.pastProjects ?? [],
    };
  });

  return {
    riskScore: clamp(parsed.riskScore, 0, 100),
    recommendation: parsed.recommendation,
    reasoning: parsed.reasoning,
    topRisks: parsed.topRisks ?? [],
    flags: parsed.flags ?? [],
    comparableProjects: parsed.comparableProjects ?? [],
    enrichedTeam,
  };
}

function stripFences(s: string): string {
  return s
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function buildReport(
  identity: ProjectIdentity,
  audit: ProjectAudit,
  evidence: { type: string; ref: string; note?: string }[],
  startedAt: Date,
  dataConfidence: number,
  dossier?: OnchainDossier | null,
): AuditReport {
  return {
    id: `TL-${startedAt.getUTCFullYear()}-${String(startedAt.getUTCMonth() + 1).padStart(2, "0")}-${String(startedAt.getUTCDate()).padStart(2, "0")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    identity,
    audit,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    evidence,
    dataConfidence,
    onchainDossier: dossier
      ? {
          query: dossier.query,
          resolvedToken: dossier.resolvedToken
            ? {
                symbol: dossier.resolvedToken.symbol,
                name: dossier.resolvedToken.name,
                address: dossier.resolvedToken.address,
                chain: String(dossier.resolvedToken.chain),
                deployerAddress: dossier.resolvedToken.deployerAddress,
              }
            : undefined,
          security: dossier.security
            ? {
                riskLevel: dossier.security.riskLevel,
                riskScore: dossier.security.riskScore,
                isHoneypot: dossier.security.isHoneypot,
                canSell: dossier.security.canSell,
                hasRenounced: dossier.security.hasRenounced,
                hasMintFunction: dossier.security.hasMintFunction,
                holderConcentration: dossier.security.holderConcentration,
                suspiciousFlags: dossier.security.suspiciousFlags ?? [],
              }
            : undefined,
          holders: dossier.holders
            ? {
                clusterCount: dossier.holders.clusterCount,
                newWalletPercent: dossier.holders.newWalletPercent,
                rugPullPercent: dossier.holders.rugPullPercent,
                topHolders: dossier.holders.topHolders,
              }
            : undefined,
          deployerReputation: dossier.deployerReputation
            ? {
                deployerAddress: dossier.deployerReputation.deployerAddress,
                otherTokens: (dossier.deployerReputation.otherTokens ?? []).map((t) => ({
                  symbol: t.symbol,
                  name: t.name,
                  chain: String(t.chain),
                })),
                ruggedCount: dossier.deployerReputation.ruggedCount,
                totalTokensLaunched: dossier.deployerReputation.totalTokensLaunched,
                avgTokenLifetimeDays: dossier.deployerReputation.avgTokenLifetimeDays,
              }
            : undefined,
          smartMoney: dossier.smartMoney?.map((s) => ({
            address: s.address,
            tag: s.tag,
            recentBuysUsd: s.recentBuysUsd,
            recentSellsUsd: s.recentSellsUsd,
          })),
          sentiment: dossier.sentiment
            ? {
                sentimentScore: dossier.sentiment.sentimentScore,
                newsCount24h: dossier.sentiment.newsCount24h,
                vibeRank: dossier.sentiment.vibeRank,
                topKOLs: dossier.sentiment.topKOLs,
              }
            : undefined,
          recentNews: dossier.recentNews?.map((n) => ({
            title: n.title,
            url: n.url,
            source: n.source,
            publishedAt: n.publishedAt,
          })),
          walletPnl: dossier.walletPnl ?? undefined,
          errors: dossier.errors,
          costUsdt0: dossier.costUsdt0,
        }
      : undefined,
  };
}
