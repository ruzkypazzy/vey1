// src/audit/resolver.ts
// Input resolver — turn "Hyperliquid" / "@hyperliquidX" / "0x..." / URL
// into a canonical ProjectIdentity.
//
// Strategy: lightweight heuristics, no external API required to *start*.
// The web scraper + on-chain audit will *enrich* the identity downstream.

import { request } from "undici";
import { ProjectIdentity } from "../types/index.js";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HANDLE_RE = /^@?([A-Za-z0-9_]{1,15})$/;
const URL_RE = /^(https?:\/\/)?([a-z0-9-]+(\.[a-z0-9-]+)+)/i;
const ENS_RE = /^[a-z0-9-]+\.eth$/i;

export interface ResolveResult {
  identity: ProjectIdentity;
  /** Resolved URLs to scrape in the next stage */
  scrapeUrls: string[];
  /** Detected chain if it's a contract address */
  detectedChain?: string;
}

const KNOWN_CHAIN_PREFIXES: Record<string, string> = {
  // rough first-byte detection is not reliable, so default to ethereum
  // and let on-chain audit confirm.
  eth: "ethereum",
  arb: "arbitrum",
  base: "base",
  bnb: "bsc",
  op: "optimism",
  polygon: "polygon",
  xlayer: "xlayer",
  sol: "solana",
};

export async function resolveInput(raw: string): Promise<ResolveResult> {
  const input = raw.trim();
  if (!input) throw new Error("Empty input");

  // Case 1: EVM contract address
  if (ADDRESS_RE.test(input)) {
    return {
      identity: {
        rawInput: raw,
        canonicalName: shortenAddress(input),
        contractAddress: input.toLowerCase(),
        chain: "ethereum",
        confidence: 0.7,
      },
      scrapeUrls: [],
      detectedChain: "ethereum",
    };
  }

  // Case 2: Solana address
  if (SOLANA_ADDRESS_RE.test(input) && !input.includes(".")) {
    return {
      identity: {
        rawInput: raw,
        canonicalName: shortenAddress(input),
        contractAddress: input,
        chain: "solana",
        confidence: 0.6,
      },
      scrapeUrls: [],
      detectedChain: "solana",
    };
  }

  // Case 3: ENS / SNS handle
  if (ENS_RE.test(input)) {
    return {
      identity: {
        rawInput: raw,
        canonicalName: input.replace(".eth", ""),
        chain: "ethereum",
        confidence: 0.5,
      },
      scrapeUrls: [`https://${input}`],
    };
  }

  // Case 4: Twitter handle
  if (input.startsWith("@") || (HANDLE_RE.test(input) && !input.includes("."))) {
    const handle = input.replace(/^@/, "");
    return {
      identity: {
        rawInput: raw,
        canonicalName: capitalizeWords(handle),
        twitter: handle,
        confidence: 0.4,
      },
      scrapeUrls: [`https://x.com/${handle}`],
    };
  }

  // Case 5: URL
  const urlMatch = input.match(URL_RE);
  if (urlMatch) {
    const fullUrl = input.startsWith("http") ? input : `https://${input}`;
    const domain = urlMatch[2];
    const name = domain.split(".").slice(-2, -1)[0];
    return {
      identity: {
        rawInput: raw,
        canonicalName: capitalizeWords(name),
        website: fullUrl,
        confidence: 0.6,
      },
      scrapeUrls: [fullUrl],
    };
  }

  // Case 6: bare project name — will be enriched by web search downstream
  return {
    identity: {
      rawInput: raw,
      canonicalName: input,
      confidence: 0.3,
    },
    scrapeUrls: [],
  };
}

function shortenAddress(addr: string): string {
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function capitalizeWords(s: string): string {
  return s
    .replace(/[-_]+/g, " ")
    .split(" ")
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Try to enrich identity by hitting project website /about page (lightweight) */
export async function enrichFromWeb(
  identity: ProjectIdentity,
  scrapeUrls: string[],
): Promise<ProjectIdentity> {
  const out: ProjectIdentity = { ...identity };
  for (const url of scrapeUrls.slice(0, 3)) {
    try {
      const res = await request(url, {
        method: "GET",
        headers: { "user-agent": "VEY1-Research-Bot/0.1 (+contact: support@vey1.xyz)" },
        headersTimeout: 8000,
        bodyTimeout: 8000,
      });
      if (res.statusCode >= 400) continue;
      const html = await res.body.text();

      // Try to extract a Twitter handle
      const tw = html.match(/twitter\.com\/([A-Za-z0-9_]{1,15})/i);
      if (tw && !out.twitter) out.twitter = tw[1];

      // GitHub
      const gh = html.match(/github\.com\/([A-Za-z0-9_-]+)/i);
      if (gh && !out.github) out.github = gh[1];

      // Contract address in page source
      const addr = html.match(/0x[a-fA-F0-9]{40}/);
      if (addr && !out.contractAddress) {
        out.contractAddress = addr[0].toLowerCase();
        out.confidence = Math.min(1, out.confidence + 0.2);
      }

      // Ticker in title or schema.org
      const ticker = html.match(/"ticker"\s*:\s*"([A-Z0-9]{2,10})"/i);
      if (ticker && !out.ticker) out.ticker = ticker[1];
    } catch {
      // best-effort, ignore
    }
  }
  return out;
}
