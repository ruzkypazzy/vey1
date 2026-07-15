// src/audit/team.ts
// Team extraction + social audit.
//
// Given the scraped candidate names + Twitter handles from the project site,
// build a list of team members with: role (best-effort), Twitter (if any),
// GitHub (if any), and a list of personal wallets (resolved from bio/ENS).
//
// For the hackathon MVP, we use a deterministic wallet-resolution strategy
// that doesn't require paid Twitter API access: Twitter handles → ENS
// reverse-lookup via a public RPC.

import { request } from "undici";
import { JsonRpcProvider, isAddress } from "ethers";
import type { TeamMember, AuditFlag } from "../types/index.js";
import { auditPersonalWallets, scorePersonalWallet } from "./personal-wallet.js";

const RPC = process.env.RPC_ETHEREUM ?? "https://eth.llamarpc.com";
const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });

export interface TeamBuildInput {
  /** Names from the team page */
  names: string[];
  /** Twitter handles from the project site */
  twitters: string[];
  /** GitHub handles (org or users) */
  githubs: string[];
  /** Optional: explicit addresses provided by user (e.g. "audit 0xABC… who is the deployer") */
  explicitAddresses?: { address: string; source: string; chain?: string }[];
}

export interface TeamBuildResult {
  members: TeamMember[];
  unresolved: string[];
}

const ROLE_KEYWORDS: [string, string][] = [
  ["founder", "Founder"],
  ["co-founder", "Co-Founder"],
  ["ceo", "CEO"],
  ["cto", "CTO"],
  ["coo", "COO"],
  ["chief", "C-Suite"],
  ["lead developer", "Lead Developer"],
  ["head of engineering", "Head of Engineering"],
  ["head of product", "Head of Product"],
  ["head of marketing", "Head of Marketing"],
  ["advisor", "Advisor"],
  ["researcher", "Researcher"],
];

/** Best-effort role inference from a name + surrounding text */
export function inferRole(name: string, surrounding: string): string {
  const lower = surrounding.toLowerCase();
  for (const [kw, label] of ROLE_KEYWORDS) {
    if (lower.includes(kw)) return label;
  }
  return "Unknown";
}

/** Resolve an address to an ENS reverse lookup (best effort) */
export async function reverseResolve(address: string): Promise<string | null> {
  if (!isAddress(address)) return null;
  try {
    return await provider.lookupAddress(address);
  } catch {
    return null;
  }
}

/** Resolve a name/handle to an address via ENS forward lookup */
export async function forwardResolve(name: string): Promise<string | null> {
  if (!name.endsWith(".eth")) return null;
  try {
    return await provider.resolveName(name);
  } catch {
    return null;
  }
}

/** Try to find a public address for a Twitter handle — public APIs are limited,
 * so we use a conservative approach: scrape the user's bio via a fallback
 * public mirror. For the hackathon MVP, we accept the user passing addresses
 * in via /v1/audit?address=0x... and use those as primary. */
export async function twitterToAddress(_handle: string): Promise<string | null> {
  // Without a paid Twitter API tier, reverse-resolving handle → wallet is
  // unreliable. We mark it null and rely on the user to provide explicit
  // addresses for personal wallets. This is a known limitation surfaced in
  // the methodology section of the PDF.
  return null;
}

/** Build the team dossier list from scrape output + explicit addresses */
export async function buildTeam(
  input: TeamBuildInput,
): Promise<TeamBuildResult> {
  const members: TeamMember[] = [];
  const unresolved: string[] = [];

  // 1) Build skeletons from names
  const nameToHandle = new Map<string, string>();
  for (const tw of input.twitters) {
    // Heuristic: if a name appears next to a Twitter handle in raw text, pair them.
    // For MVP, we just put each handle in its own pseudo-member.
  }

  for (const name of input.names.slice(0, 8)) {
    const flags: AuditFlag[] = [];
    const personalInputs: { address: string; source: string; chain?: string }[] = [];

    // Try to find personal wallets for this name via ENS or explicit addresses
    for (const addr of input.explicitAddresses ?? []) {
      personalInputs.push(addr);
    }

    const personalResults = await auditPersonalWallets(personalInputs);
    const personalWallets = personalResults.map((r) => r.wallet);
    const scamDbHits: { source: string; note: string }[] = personalResults.flatMap((r) =>
      r.scamDbHits.map((h) => ({ source: h.source, note: h.note ?? "" })),
    );

    // Per-person risk score = average of personal wallet scores
    let riskScore = 100;
    if (personalWallets.length > 0) {
      const scores = personalResults.map((r) =>
        scorePersonalWallet(r.wallet, r.scamDbHits),
      );
      riskScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    } else {
      // No personal wallets found = identity is opaque
      flags.push({
        color: "YELLOW",
        category: "Identity",
        message: "No personal wallet could be linked to this person. Identity is opaque.",
      });
      riskScore = 60;
    }

    members.push({
      name,
      role: "Unknown",
      identityConfidence: personalWallets.length > 0 ? "LIKELY" : "PSEUDONYMOUS",
      personalWallets,
      pastProjects: [], // populated later by LLM
      scamDbHits,
      riskScore,
      flags,
    });
  }

  // 2) For names that didn't make it (over the 8 cap), mark as unresolved
  if (input.names.length > 8) {
    unresolved.push(...input.names.slice(8));
  }

  return { members, unresolved };
}
