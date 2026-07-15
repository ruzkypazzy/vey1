// src/synthesis/prompt.ts
// LLM synthesis — the secret sauce. Given a ProjectAudit, ask the LLM
// to produce: a 0-100 risk score, red/yellow/green flags, comparable
// projects, and a 1-paragraph recommendation.
//
// We use gpt-4o-mini via the OpenAI-compatible API (FreeModel.dev by
// default; swap OPENAI_BASE_URL to use OpenAI directly).

import { request } from "undici";
import { config } from "../config/secrets.js";
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

You receive a structured JSON payload with:
- Project identity (name, contract, social links)
- Audited on-chain wallets (deployer, treasury, team personal wallets)
- Audited team members (with personal wallet audit results)
- Past project references and scam database hits

Your job: produce a strict JSON response matching the requested schema. No prose outside the JSON.

Rules:
- riskScore: 0-100, where 100 is safest. Be conservative. New projects with anonymous teams start at 60.
- recommendation: "PROCEED" | "PROCEED_WITH_MONITORING" | "CAUTION" | "AVOID"
- reasoning: 3-6 sentences. Cite specific evidence (tx hash, address, person name). Distinguish facts from inferences.
- comparableProjects: 3-5 similar projects with status. Use your knowledge of crypto history. If you don't know, return fewer.
- flags: only material flags. Don't pad. RED = serious, YELLOW = monitor, GREEN = positive signal.
- teamEnrichment: for each team member, return inferred role (if you can guess), and any past projects you recognize.
- topRisks: the 3-5 most material risks, ordered by severity.

Output ONLY the JSON. No markdown fences, no commentary.`;

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
  // Build a compact evidence payload (don't blow the context window)
  const payload = {
    identity,
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
    extraSignals,
  };

  const body = {
    model: config.openai.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Analyze this project:\n\n${JSON.stringify(payload, null, 2)}\n\nReturn JSON with this exact shape:\n{\n  "riskScore": <0-100>,\n  "recommendation": "PROCEED" | "PROCEED_WITH_MONITORING" | "CAUTION" | "AVOID",\n  "reasoning": "<3-6 sentence narrative citing specific evidence>",\n  "topRisks": ["<risk 1>", "<risk 2>", "<risk 3>"],\n  "flags": [{"color": "RED|YELLOW|GREEN", "category": "<str>", "message": "<str>", "evidence": "<optional>"}],\n  "comparableProjects": [{"name": "<str>", "role": "<str or 'n/a'>", "year": <number or null>, "status": "ACTIVE|RUGGED|ABANDONED|ACQUIRED|UNKNOWN", "outcome": "<str>"}],\n  "teamEnrichment": [{"name": "<str>", "role": "<str>", "pastProjects": [{"name": "<str>", "role": "<str>", "year": <number|null>, "status": "ACTIVE|RUGGED|ABANDONED|ACQUIRED|UNKNOWN", "outcome": "<str>"}]}]\n}`,
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
): AuditReport {
  return {
    id: `TL-${startedAt.getUTCFullYear()}-${String(startedAt.getUTCMonth() + 1).padStart(2, "0")}-${String(startedAt.getUTCDate()).padStart(2, "0")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    identity,
    audit,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    evidence,
    dataConfidence,
  };
}
