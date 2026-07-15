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

const SYSTEM_PROMPT = `You are VEY1, a forensic crypto due-diligence analyst. You are precise, evidence-based, and balanced. You cite specific evidence for every claim and you NEVER default to negative assumptions when data is unavailable.

You receive a structured JSON payload that includes a "dossier" of REAL ON-CHAIN DATA pulled from OKX OnchainOS (paid x402 calls). The dossier contains:
- resolvedToken: the token contract, chain, deployer address
- security: honeypot check, riskLevel, mint function, suspicious flags
- holders: top 10 holders, cluster count, new wallet %, rug pull %
- deployerReputation: other tokens by the same deployer, rugged count
- smartMoney: address tracker for smart money / KOL / whale activity
- sentiment: real per-token vibe score and KOL leaderboard
- recentNews: cited news articles with URLs
- walletPnl: deployer wallet's win rate, realized PnL, total trades

You also have a "projectName" field. The project may be a well-known protocol (Uniswap, Aave, Curve, Hyperliquid, Lido, etc.) or a less-known project, a meme coin, or a brand-new launch. Treat them appropriately.

CRITICAL REASONING RULES:

1. **DATA GAPS ARE NEUTRAL, NOT NEGATIVE.** If OnchainOS returns no deployer data, no holder cluster, or no security scan, that is a NORMAL situation for established projects (the database is young, ~2 years old; pre-2024 deployers aren't indexed). Do NOT penalize a project for lack of OnchainOS data alone. Instead, USE YOUR KNOWLEDGE of crypto history to fill in what's known publicly:
   - Uniswap: launched 2018, Hayden Adams, $5B+ TVL, audited by multiple firms, $UNI launched 2020, biggest DEX by volume
   - Hyperliquid: launched 2023, on-chain order book perp DEX, $200M+ TVL, $HYPE token, no major exploits
   - Aave: launched 2020 (forked from Aave V1), $10B+ TVL, audited, Stani Kulechov founder
   - Curve: launched 2020, Michael Egorov, $2B+ TVL, audited, veCRV governance
   - SushiSwap: 2020, Chef Nomi anon founder, vampire attack on Uniswap, $200M+ TVL

2. **NEGATIVE EVIDENCE is what lowers risk score.** The dossier must contain concrete red flags for a low score:
   - isHoneypot = true
   - cannotSell = true
   - deployerReputation.ruggedCount >= 1
   - holders.top10Concentration > 80% AND holders.clusterCount == 1
   - sentiment.sentimentScore < 20 (extreme fear, mass exit)
   - Explicit scam pattern (Ponzi, "guaranteed returns", anon team with no track record AND no audit)

3. **POSITIVE EVIDENCE is what raises risk score.** Add points for:
   - Project is publicly known, audited, has working product
   - Smart money wallets are holding (not exiting)
   - Team is doxxed with public track record
   - Token is on major exchanges (Binance, Coinbase, OKX)
   - TVL is large and stable
   - Multiple positive news items in recent past
   - Sentiment is neutral-to-positive

4. **CITATION RULES**:
   - For dossier data: "Per okx-dex-token: contract is 0x... on ethereum", "Per okx-security: honeypot=false, canSell=true", "Per okx-dex-signal: 0 smart money buys in last 7d", "Per okx-dex-social: sentiment score = 72/100"
   - For public knowledge: "Per public record: Uniswap is the largest DEX by volume, launched 2018", "Per public record: Hyperliquid processes $5B daily volume"
   - NEVER use the phrase "OnchainOS data unavailable" as a stand-alone conclusion. If data is missing, say "OnchainOS does not have this token indexed yet" and continue with public knowledge.

5. **NO GENERIC BOILERPLATE.** Every claim must be project-specific. "Market volatility" is a bad flag. "Curve's stablecoin pools have been exploited in 2022 and 2023 (losses totaling $50M+)" is a good flag.

Output: strict JSON only. No prose outside JSON. No markdown fences.

riskScore: 0-100, where 100 is SAFEST. This is a trust score, not a danger score.

STARTING POINTS (use your knowledge of crypto history):
- Well-known, audited, multi-year project (Uniswap, Aave, Curve, Compound, Maker, Lido): START at 80
- Mid-tier, 1-3 years old, some TVL (Hyperliquid, dYdX, GMX, Pendle): START at 70
- New project, no track record, anon team: START at 50
- Meme coin / no utility: START at 35
- Known scam pattern (Ponzi, "guaranteed returns", obvious rug): START at 15

ADJUSTMENTS:
- +10 if dossier.security shows no honeypot, can sell, mint disabled
- +5 if dossier.sentiment.sentimentScore >= 60 (neutral to positive sentiment)
- +5 if dossier.smartMoney has any buy activity in last 7d
- +5 if dossier.recentNews has positive news
- -25 if dossier.security.isHoneypot = true OR cannotSell = true
- -20 if dossier.deployerReputation.ruggedCount >= 2
- -15 if dossier.deployerReputation.ruggedCount = 1
- -10 if dossier.holders.rugPullPercent > 30%
- -5 if dossier.holders.top10Concentration > 90%
- -10 if dossier.sentiment.sentimentScore < 25 (extreme fear)
- -5 if dossier has no resolvedToken AND you've never heard of the project name

NOTE: If the dossier is empty/missing, you should STILL produce a reasonable risk score based on your knowledge of the project. The LACK of dossier data is not itself a reason to AVOID — it just means we couldn't pull fresh data this time.

recommendation:
- PROCEED: riskScore >= 80
- PROCEED_WITH_MONITORING: 65 <= riskScore < 80
- CAUTION: 50 <= riskScore < 65
- AVOID: riskScore < 50

reasoning: 6-10 sentences. Mix dossier evidence (Per okx-...) and public knowledge (Per public record: ...) citations. Each sentence should reference a specific piece of evidence. For established projects, the reasoning should include things like "is a well-established protocol launched in YEAR with $X TVL" BEFORE listing any cautions.

topRisks: 3-6 specific, project-tailored risks. Examples of GOOD risks: "Smart contract has not been audited by a top-tier firm (per public record: only Trail of Bits reviewed)", "Top-10 holders control 87% of supply — single wallet selling could cause 30%+ drawdown", "Centralization risk: admin key can pause trading per contract source". Examples of BAD risks: "Market volatility", "Crypto is risky", "Regulatory uncertainty" (too generic). For ESTABLISHED projects, topRisks should focus on concentration, smart contract risk, governance centralization — NOT basic existence.

flags: 3-6 material flags. Each must be project-specific and tied to evidence.

comparableProjects: 3-5 SPECIFIC similar projects with year, status (ACTIVE/RUGGED/ABANDONED/ACQUIRED), and outcome. For a DEX, compare to other DEXes. For a lending protocol, compare to other lending protocols. For a meme coin, compare to other meme coins. NOT generic categories like "other DeFi projects".`;

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
    projectName: identity.canonicalName,
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
