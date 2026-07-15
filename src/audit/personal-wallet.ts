// src/audit/personal-wallet.ts
// Personal wallet audit — given a list of addresses, audit each one's
// funding source, holdings, counterparties, and cross-reference against
// known scam databases. This is VEY1's "doxx" core.

import { auditWallet, OnchainAuditInput } from "./onchain.js";
import type { WalletAudit, AuditFlag } from "../types/index.js";

const SCAM_DBS: { name: string; check: (addr: string) => Promise<{ hit: boolean; note?: string }> }[] = [
  {
    name: "Chainabuse (mock)",
    check: async (addr) => {
      // Real impl: fetch chainabuse.com API or scrape reports
      // Mock: only flag a sentinel test address
      return { hit: addr.toLowerCase() === "0xdead000000000000000000000000000000000001" };
    },
  },
  {
    name: "Etherscan labels (mock)",
    check: async (addr) => {
      // Real impl: query etherscan labels API
      // Mock: only flag specific sentinels
      return {
        hit: addr.toLowerCase() === "0xbadbadbadbadbadbadbadbadbadbadbadbad0001",
        note: "Labeled as 'Phishing' on Etherscan",
      };
    },
  },
];

export interface PersonalWalletAuditInput {
  address: string;
  /** Where did we find this wallet? ("twitter bio", "ens", "donation page") */
  source: string;
  chain?: string;
}

export interface PersonalWalletAuditResult {
  wallet: WalletAudit;
  scamDbHits: { source: string; note?: string }[];
}

/** Audit a single personal wallet end-to-end */
export async function auditPersonalWallet(
  input: PersonalWalletAuditInput,
): Promise<PersonalWalletAuditResult> {
  const flags: AuditFlag[] = [];
  const { wallet: baseWallet } = await auditWallet({
    address: input.address,
    label: `Personal (${input.source})`,
    chain: input.chain,
  });

  // Add the source as context, not a flag
  baseWallet.label = `Personal — ${input.source}`;

  // Run scam DB cross-reference
  const scamDbHits: { source: string; note?: string }[] = [];
  for (const db of SCAM_DBS) {
    const result = await db.check(input.address);
    if (result.hit) {
      scamDbHits.push({ source: db.name, note: result.note });
      flags.push({
        color: "RED",
        category: "Scam Database",
        message: `${db.name} flag: ${result.note ?? "match"}`,
        evidence: input.address,
      });
    }
  }

  baseWallet.flags = [...baseWallet.flags, ...flags];
  return { wallet: baseWallet, scamDbHits };
}

/** Audit many personal wallets in parallel (with light concurrency cap) */
export async function auditPersonalWallets(
  inputs: PersonalWalletAuditInput[],
): Promise<PersonalWalletAuditResult[]> {
  const out: PersonalWalletAuditResult[] = [];
  const cap = 4;
  for (let i = 0; i < inputs.length; i += cap) {
    const batch = inputs.slice(i, i + cap);
    const results = await Promise.all(batch.map((b) => auditPersonalWallet(b)));
    out.push(...results);
  }
  return out;
}

/** Score a personal wallet 0-100 (100 = safest) */
export function scorePersonalWallet(wallet: WalletAudit, scamDbHits: { source: string }[]): number {
  let score = 100;
  for (const f of wallet.flags) {
    if (f.color === "RED") score -= 30;
    else if (f.color === "YELLOW") score -= 10;
  }
  if (scamDbHits.length > 0) score -= 25;
  // New wallets (no first-seen or recent) lose trust
  if (!wallet.firstSeenDate) score -= 5;
  else {
    const age = Date.now() - new Date(wallet.firstSeenDate).getTime();
    if (age < 1000 * 60 * 60 * 24 * 30) score -= 15; // < 30 days
  }
  return Math.max(0, Math.min(100, score));
}
