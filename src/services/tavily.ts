// src/services/tavily.ts
// Tavily search — AI-agent-friendly web search with cited results.
// Used as Tier 2 fallback when OKX OnchainOS can't find the project, or
// to gather off-chain context (Twitter handles, team bios, controversies).
//
// Free tier: 1000 searches/month. Get a key at https://tavily.com
// Set TAVILY_API_KEY in env to enable; otherwise this module is a no-op.

import { request } from "undici";

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number; // 0-1, Tavily's relevance score
  publishedDate?: string;
}

export interface TavilyResponse {
  query: string;
  results: TavilyResult[];
  answer?: string; // Tavily's LLM-generated summary if asked
}

const TAVILY_URL = "https://api.tavily.com/search";

export async function tavilySearch(
  query: string,
  opts: {
    maxResults?: number;
    searchDepth?: "basic" | "advanced";
    includeAnswer?: boolean;
    topic?: "general" | "news" | "finance";
    includeDomains?: string[];
  } = {},
): Promise<TavilyResponse> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return { query, results: [] };
  }
  const body = {
    api_key: apiKey,
    query,
    max_results: opts.maxResults ?? 5,
    search_depth: opts.searchDepth ?? "basic",
    include_answer: opts.includeAnswer ?? false,
    topic: opts.topic ?? "general",
    include_domains: opts.includeDomains,
  };
  try {
    const res = await request(TAVILY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      headersTimeout: 15_000,
      bodyTimeout: 30_000,
    });
    if (res.statusCode >= 400) {
      const text = await res.body.text();
      throw new Error(`Tavily ${res.statusCode}: ${text.slice(0, 200)}`);
    }
    const json = (await res.body.json()) as {
      results: TavilyResult[];
      answer?: string;
    };
    return { query, results: json.results ?? [], answer: json.answer };
  } catch (e) {
    console.warn(`[tavily] search failed: ${e instanceof Error ? e.message : String(e)}`);
    return { query, results: [] };
  }
}

// ─── Convenience queries for due-diligence context ─────────────────────────

/** Search for Twitter handles, team bios, and "founder" mentions. */
export async function findTeamContext(projectName: string): Promise<TavilyResult[]> {
  const r = await tavilySearch(
    `"${projectName}" crypto founder team twitter bios`,
    { maxResults: 5, searchDepth: "advanced", includeAnswer: false },
  );
  return r.results;
}

/** Search for controversies, scams, red flags, past failures. */
export async function findControversies(projectName: string): Promise<TavilyResult[]> {
  const r = await tavilySearch(
    `"${projectName}" crypto scam rugged hack exploit controversy`,
    { maxResults: 5, searchDepth: "advanced", includeAnswer: false },
  );
  return r.results;
}

/** Search for funding rounds, investors, partnerships. */
export async function findFundingContext(projectName: string): Promise<TavilyResult[]> {
  const r = await tavilySearch(
    `"${projectName}" crypto funding round investors raised`,
    { maxResults: 5, searchDepth: "advanced", includeAnswer: false },
  );
  return r.results;
}

/** Search for recent news (last 30 days). */
export async function findRecentNews(projectName: string): Promise<TavilyResult[]> {
  const r = await tavilySearch(
    `"${projectName}" crypto news 2026`,
    { maxResults: 5, searchDepth: "advanced", topic: "news" },
  );
  return r.results;
}
