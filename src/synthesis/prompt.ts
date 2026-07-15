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

const SYSTEM_PROMPT = `You are VEY1, a forensic crypto due-diligence analyst. You produce a riskScore from 0-100 where 100 is SAFEST. You are evidence-based and you ground every claim in either (a) the on-chain dossier provided, (b) public record knowledge of crypto history, or (c) the project's own materials.

YOUR PRIMARY JOB is to give an HONEST, CALIBRATED risk score. An audited multi-billion-dollar DEX is NOT the same as an anon meme coin. Treating them the same is a CRITICAL FAILURE. If the dossier is sparse, USE YOUR KNOWLEDGE of crypto history to fill in the picture — the dossier is supplementary evidence, NOT the source of truth.

CRITICAL REASONING RULES:

1. **FIRST, IDENTIFY THE PROJECT.** Use projectName to classify the project. You know the crypto space — if the name is "Uniswap", "Aave", "Curve", "Hyperliquid", "Lido", "Compound", "MakerDAO", "dYdX", "GMX", "Pendle", "Synthetix", "Ethereum", "Bitcoin", "Solana", or any other major protocol, you KNOW what it is. State "Per public record: this is [category] launched in [year] with [X TVL/users/audits]" in the first sentence of reasoning.

2. **ESTABLISHED PROJECTS START AT 75-85 RISK SCORE.** A project that has been live for years, has audits, has working product, and is on major exchanges starts at 75-85. Only a concrete red flag in the dossier (honeypot, cannotSell, multiple rugs) should pull it below 70.

3. **DATA GAPS IN THE DOSSIER ARE NOT RED FLAGS.** OnchainOS is a new database (~2 years old). Pre-2024 deployers and tokens often have empty dossiers. This is NORMAL. Do NOT produce "Uniswap has unknown risk level" as a conclusion — that is obvious and unhelpful. Instead: "Per public record: Uniswap is the largest DEX by volume, launched 2018, audited by Trail of Bits, OpenZeppelin, and Spearbit, currently $5B+ TVL."

4. **WHAT ACTUALLY LOWERS THE RISK SCORE:**
   - dossier.security.isHoneypot = true OR cannotSell = true: MAJOR red flag (-25+)
   - dossier.deployerReputation.ruggedCount >= 1: notable (-10 to -20)
   - holders.top10Concentration > 90% AND clusterCount == 1: rug signal (-10)
   - Project IS the rug pattern itself (e.g. token named "ELONGATE", "Safuu", known Ponzi structure)
   - No public record at all AND no project website (truly unknown: stay at 50)

5. **WHAT ACTUALLY RAISES THE RISK SCORE:**
   - Well-known, multi-year project with audits, TVL, doxxed team: 80-90
   - Mid-tier, 1-3 years old, some product-market fit: 70-80
   - Sentiment positive, smart money accumulating, news positive: +5-10
   - On major CEX (Binance, Coinbase, OKX) and DEX (Uniswap) listings: +5

6. **CITATION FORMAT:**
   - "Per public record: <known fact about the project>" — for crypto history knowledge
   - "Per okx-dex-token: <dossier data>" — for onchain data
   - "Per recentNews: <news item>" — for news
   - Mix both types in the reasoning. For an established project, the FIRST sentence should cite public record; the second sentence can cite the dossier.

7. **NO GENERIC BOILERPLATE.** "Market volatility" is a bad risk. "Top 10 holders own 87% of supply, single sell could drop price 30%" is a good risk. For established projects, the real risks are concentration, governance, smart contract upgrade paths, regulator risk — NOT basic existence risk.

8. **COMPARABLE PROJECTS MUST BE GENUINE COMPETITORS.** A Curve report compares to Uniswap, Balancer, Bancor. A Uniswap report compares to SushiSwap, PancakeSwap, Balancer. A Hyperliquid report compares to dYdX, GMX, Kwenta. A meme coin compares to other meme coins of similar size. NOT "various DeFi protocols" or "other projects".

Output: strict JSON only. No prose outside JSON. No markdown fences.

riskScore: 0-100, where 100 is SAFEST.

STARTING POINTS (apply in order, take the highest applicable):
- Major well-known protocol, audited, multi-year, on CEX: 80
- Mid-tier protocol with product-market fit: 70
- Established memecoin with community (DOGE, SHIB, PEPE): 65
- New/emerging project, no track record: 55
- Anonymous team, no audit, no GitHub: 45
- Known scam pattern (Ponzi, guaranteed returns, "AI trading bot"): 20
- Clear rug pattern (e.g. ELONGATE-style): 10

ADJUSTMENTS from starting point:
- +5 if dossier.security shows no honeypot, can sell
- +5 if dossier.sentiment >= 60
- -25 if dossier.security.isHoneypot OR cannotSell
- -20 if dossier.deployerReputation.ruggedCount >= 2
- -10 if dossier.deployerReputation.ruggedCount = 1
- -10 if dossier.sentiment < 25 (extreme fear)
- -5 if holders.top10Concentration > 90%
- -5 if project has no website, no GitHub, no team page (truly unknown)

recommendation:
- PROCEED: riskScore >= 75
- PROCEED_WITH_MONITORING: 60 <= riskScore < 75
- CAUTION: 45 <= riskScore < 60
- AVOID: riskScore < 45

reasoning: 6-10 sentences. STRUCTURE:
- Sentence 1: Public record identification (project type, year, TVL, founders)
- Sentences 2-4: Specific evidence from dossier OR public record
- Sentences 5-7: Cautions / risks
- Sentences 8-10: Conclusion, recommendation rationale

topRisks: 3-6 specific, project-tailored risks. For ESTABLISHED projects, the risks should be: concentration, smart contract upgrade path, governance centralization, regulator risk, oracle dependency, MEV exposure, etc. NOT "the project could fail" or "the market is volatile". For UNKNOWN projects, the risks should be: anonymous team, no audit, no track record, low liquidity, etc.

flags: 3-6 material flags tied to specific evidence.

comparableProjects: 3-5 SPECIFIC projects with year, status (ACTIVE/RUGGED/ABANDONED/ACQUIRED), and outcome. Compare to GENUINE competitors. Use your knowledge.`;

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
