// src/services/research.ts
// Web research using Tavily (free 1000/month) — this is the PRIMARY evidence
// source. OnchainOS is secondary and only used for rugpull detection.
//
// Tavily gives us:
// - Project's official website + social media
// - Recent news articles (with citations)
// - Twitter mentions
// - Reddit discussions
// - General "what is this project" knowledge
//
// Plus we add:
// - GitHub API (free, no key) for code-level project evidence
// - CoinGecko free tier for market data

import { safeFetch } from "../utils/undici.js";

const TAVILY_URL = "https://api.tavily.com/search";
const TAVILY_KEY = process.env.TAVILY_API_KEY ?? "";

export interface ResearchFinding {
  source: string;            // "tavily-search", "github", "coingecko"
  category: string;          // "official", "news", "social", "docs", "market", "code"
  title: string;
  url?: string;
  content: string;           // quote or summary
  date?: string;             // ISO date if available
  author?: string;           // Twitter handle, news author
  score?: number;            // 0-1 confidence
}

export interface ResearchReport {
  query: string;             // what we asked
  resolvedProjectName?: string;
  officialWebsite?: string;
  officialTwitter?: string;
  whitepaperUrl?: string;
  githubRepo?: string;
  teamMembers: Array<{ name: string; role: string; background?: string }>;
  findings: ResearchFinding[];
  marketContext?: {
    coinGeckoId?: string;
    rank?: number;
    marketCapUsd?: number;
    volume24hUsd?: number;
    tvlUsd?: number;
    circulatingSupply?: number;
    priceUsd?: number;
    categories?: string[];
  };
  searchQueries: string[];   // what we searched for
  totalCost: number;         // tavily cost estimate
  completedAt: string;
}

// ─── 1. Tavily web search ─────────────────────────────────────────────────

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  raw_content?: string;
  score?: number;
  published_date?: string;
}

interface TavilyResponse {
  query: string;
  results: TavilyResult[];
  answer?: string;
  response_time?: number;
}

async function tavilySearch(
  query: string,
  options: { maxResults?: number; topic?: "general" | "news" | "finance" } = {},
): Promise<TavilyResult[]> {
  if (!TAVILY_KEY) {
    throw new Error("TAVILY_API_KEY not set");
  }
  const body = {
    api_key: TAVILY_KEY,
    query,
    search_depth: "advanced",
    max_results: options.maxResults ?? 8,
    topic: options.topic ?? "general",
    include_answer: true,
    include_raw_content: false,
  };
  const r = await safeFetch(TAVILY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Tavily ${r.status}: ${text.slice(0, 200)}`);
  }
  const data = (await r.json()) as TavilyResponse;
  return data.results ?? [];
}

// ─── 2. GitHub repo discovery ─────────────────────────────────────────────

interface GitHubRepo {
  full_name: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  updated_at: string;
  created_at: string;
  language: string | null;
  license: { spdx_id: string } | null;
  topics: string[];
  html_url: string;
}

async function githubSearchRepos(query: string, maxResults = 5): Promise<GitHubRepo[]> {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}+crypto&sort=stars&per_page=${maxResults}`;
  const r = await safeFetch(url, {
    headers: {
      "Accept": "application/vnd.github+json",
      "User-Agent": "VEY1-forensic-audit/1.0",
    },
  });
  if (!r.ok) return [];
  const data = (await r.json()) as { items?: GitHubRepo[] };
  return data.items ?? [];
}

interface GitHubCommit {
  sha: string;
  commit: { author: { date: string; name: string }; message: string };
}

async function githubRecentCommits(owner: string, repo: string, count = 5): Promise<GitHubCommit[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits?per_page=${count}`;
  const r = await safeFetch(url, {
    headers: {
      "Accept": "application/vnd.github+json",
      "User-Agent": "VEY1-forensic-audit/1.0",
    },
  });
  if (!r.ok) return [];
  const data = (await r.json()) as GitHubCommit[];
  return Array.isArray(data) ? data : [];
}

// ─── 3. CoinGecko free tier ───────────────────────────────────────────────

interface CoinGeckoCoin {
  id: string;
  symbol: string;
  name: string;
  market_cap_rank: number | null;
  categories: string[];
  description?: { en?: string };
  links?: {
    homepage?: string[];
    twitter_screen_name?: string;
    repos_url?: { github?: string[] };
    chat_url?: string[];
    announcement_url?: string[];
  };
}

interface CoinGeckoMarket {
  id: string;
  symbol: string;
  name: string;
  current_price: number | null;
  market_cap: number | null;
  total_volume: number | null;
  circulating_supply: number | null;
  total_supply: number | null;
  market_cap_rank: number | null;
  ath: number | null;
  atl: number | null;
  price_change_percentage_30d_in_currency?: number | null;
}

async function coingeckoSearch(query: string): Promise<CoinGeckoCoin[]> {
  const url = `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`;
  const r = await safeFetch(url, {
    headers: { "User-Agent": "VEY1-forensic-audit/1.0", "Accept": "application/json" },
  });
  if (!r.ok) return [];
  const data = (await r.json()) as { coins?: CoinGeckoCoin[] };
  return data.coins ?? [];
}

async function coingeckoMarket(ids: string[]): Promise<CoinGeckoMarket[]> {
  if (ids.length === 0) return [];
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids.join(",")}&order=market_cap_desc&sparkline=false&price_change_percentage=30d`;
  const r = await safeFetch(url, {
    headers: { "User-Agent": "VEY1-forensic-audit/1.0", "Accept": "application/json" },
  });
  if (!r.ok) return [];
  const data = (await r.json()) as CoinGeckoMarket[];
  return Array.isArray(data) ? data : [];
}

async function coingeckoDefiTVL(id: string): Promise<number | null> {
  const url = `https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`;
  const r = await safeFetch(url, {
    headers: { "User-Agent": "VEY1-forensic-audit/1.0", "Accept": "application/json" },
  });
  if (!r.ok) return null;
  const data = (await r.json()) as { market_data?: { total_value_locked?: { usd?: number } } };
  return data.market_data?.total_value_locked?.usd ?? null;
}

// ─── 4. Main research orchestrator ────────────────────────────────────────

export interface ResearchOptions {
  includeGithub?: boolean;
  includeCoinGecko?: boolean;
  tavilyTopics?: Array<"general" | "news" | "finance">;
  onProgress?: (stage: string, info?: string) => void;
}

export async function researchProject(
  query: string,
  options: ResearchOptions = {},
): Promise<ResearchReport> {
  const findings: ResearchFinding[] = [];
  const searchQueries: string[] = [];
  let resolvedProjectName: string | undefined;
  let officialWebsite: string | undefined;
  let officialTwitter: string | undefined;
  let whitepaperUrl: string | undefined;
  let githubRepo: string | undefined;
  let teamMembers: Array<{ name: string; role: string; background?: string }> = [];
  let marketContext: ResearchReport["marketContext"] = undefined;
  let totalCost = 0;

  // 1. Identify the project — ask Tavily "what is X" first
  if (TAVILY_KEY) {
    options.onProgress?.("identifying", "Tavily: project identification");
    try {
      const identQueries = [
        `${query} cryptocurrency protocol official website`,
        `${query} crypto project team founders`,
        `${query} whitepaper audit report`,
        `${query} token contract address blockchain`,
        `${query} crypto scam OR hack OR exploit 2024 OR 2025 OR 2026`,
      ];
      for (const identQ of identQueries) {
        searchQueries.push(identQ);
        try {
          const results = await tavilySearch(identQ, { maxResults: 5 });
          totalCost += 1;
          for (const r of results) {
            const finding: ResearchFinding = {
              source: "tavily-search",
              category: "general",
              title: r.title,
              url: r.url,
              content: r.content,
              date: r.published_date,
              score: r.score,
            };
            // Try to extract canonical name from first result
            if (!resolvedProjectName && r.title.includes(query)) {
              // Use the project name from the title if query is a substring
              resolvedProjectName = query;
            }
            // Detect official website from URL patterns
            if (!officialWebsite) {
              const url = new URL(r.url);
              const host = url.hostname.replace(/^www\./, "");
              const knownNonOfficial = [
                "twitter.com", "x.com", "reddit.com", "github.com",
                "youtube.com", "medium.com", "t.me", "discord.gg",
                "coingecko.com", "coinmarketcap.com", "cryptorank.io",
                "messari.io", "defillama.com", "decrypt.co",
                "theblock.co", "cointelegraph.com", "coindesk.com",
                "binance.com", "coinbase.com", "okx.com", "kucoin.com",
                "reuters.com", "bloomberg.com", "cnbc.com", "forbes.com",
                "facebook.com", "linkedin.com", "instagram.com",
              ];
              if (!knownNonOfficial.some((d) => host.includes(d))) {
                officialWebsite = r.url;
              }
            }
            findings.push(finding);
          }
        } catch (e) {
          // Continue with next query even if one fails
        }
      }
    } catch (e) {
      findings.push({
        source: "tavily-search",
        category: "general",
        title: "Tavily search error",
        content: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 2. News search specifically (last 90 days)
  if (TAVILY_KEY) {
    options.onProgress?.("news", "Tavily: recent news");
    try {
      const newsQueries = [
        `${query} news 2026 announcement`,
        `${query} crypto partnership OR launch OR integration`,
      ];
      for (const q of newsQueries) {
        searchQueries.push(q);
        const results = await tavilySearch(q, { maxResults: 6, topic: "news" });
        totalCost += 1;
        for (const r of results) {
          findings.push({
            source: "tavily-search",
            category: "news",
            title: r.title,
            url: r.url,
            content: r.content,
            date: r.published_date,
            score: r.score,
          });
        }
      }
    } catch (e) {
      // continue
    }
  }

  // 3. Risk search — explicit red flag check
  if (TAVILY_KEY) {
    options.onProgress?.("risks", "Tavily: risk pattern check");
    try {
      const riskQueries = [
        `${query} scam review complaints`,
        `${query} hack exploit vulnerability report`,
        `${query} team anonymous doxxed founders`,
      ];
      for (const q of riskQueries) {
        searchQueries.push(q);
        const results = await tavilySearch(q, { maxResults: 5 });
        totalCost += 1;
        for (const r of results) {
          findings.push({
            source: "tavily-search",
            category: "risks",
            title: r.title,
            url: r.url,
            content: r.content,
            date: r.published_date,
            score: r.score,
          });
        }
      }
    } catch (e) {
      // continue
    }
  }

  // 4. GitHub repo discovery
  if (options.includeGithub !== false) {
    options.onProgress?.("github", "GitHub: project repo search");
    try {
      const repos = await githubSearchRepos(query, 5);
      for (const repo of repos.slice(0, 3)) {
        const isLikelyOfficial =
          repo.full_name.toLowerCase().includes(query.toLowerCase().split(" ")[0]) ||
          (repo.description ?? "").toLowerCase().includes(query.toLowerCase());
        if (isLikelyOfficial || repos.length <= 2) {
          if (!githubRepo) {
            githubRepo = repo.html_url;
          }
          const [owner, repoName] = repo.full_name.split("/");
          const recentCommits = await githubRecentCommits(owner, repoName, 3);
          findings.push({
            source: "github",
            category: "code",
            title: `${repo.full_name} — ${repo.description ?? "(no description)"}`,
            url: repo.html_url,
            content: `Stars: ${repo.stargazers_count}, Forks: ${repo.forks_count}, Last updated: ${repo.updated_at}, Language: ${repo.language ?? "unknown"}, License: ${repo.license?.spdx_id ?? "none"}. Recent commits: ${recentCommits.map((c) => `${c.commit.author.date.split("T")[0]}: "${c.commit.message.split("\n")[0].slice(0, 80)}"`).join("; ")}`,
            date: repo.updated_at,
          });
        }
      }
    } catch (e) {
      // continue
    }
  }

  // 5. CoinGecko market context
  if (options.includeCoinGecko !== false) {
    options.onProgress?.("market", "CoinGecko: market data");
    try {
      const coins = await coingeckoSearch(query);
      const bestMatch = coins.find(
        (c) => c.symbol.toLowerCase() === query.toLowerCase().split(" ")[0] || c.name.toLowerCase() === query.toLowerCase(),
      ) ?? coins[0];
      if (bestMatch) {
        if (!officialWebsite && bestMatch.links?.homepage?.[0]) {
          officialWebsite = bestMatch.links.homepage[0];
        }
        if (!officialTwitter && bestMatch.links?.twitter_screen_name) {
          officialTwitter = `https://twitter.com/${bestMatch.links.twitter_screen_name}`;
        }
        if (!githubRepo && bestMatch.links?.repos_url?.github?.[0]) {
          githubRepo = bestMatch.links.repos_url.github[0];
        }
        const markets = await coingeckoMarket([bestMatch.id]);
        const m = markets[0];
        if (m) {
          const tvl = await coingeckoDefiTVL(bestMatch.id);
          marketContext = {
            coinGeckoId: m.id,
            rank: m.market_cap_rank ?? undefined,
            marketCapUsd: m.market_cap ?? undefined,
            volume24hUsd: m.total_volume ?? undefined,
            circulatingSupply: m.circulating_supply ?? undefined,
            priceUsd: m.current_price ?? undefined,
            tvlUsd: tvl ?? undefined,
            categories: bestMatch.categories,
          };
          findings.push({
            source: "coingecko",
            category: "market",
            title: `${m.name} (${m.symbol.toUpperCase()}) — market data`,
            url: `https://www.coingecko.com/en/coins/${m.id}`,
            content: `Rank: #${m.market_cap_rank ?? "unranked"}, Price: $${m.current_price?.toFixed(4) ?? "n/a"}, Market cap: $${m.market_cap?.toLocaleString() ?? "n/a"}, 24h volume: $${m.total_volume?.toLocaleString() ?? "n/a"}, Circulating supply: ${m.circulating_supply?.toLocaleString() ?? "n/a"}, ATH: $${m.ath?.toFixed(4) ?? "n/a"}, ATL: $${m.atl?.toFixed(6) ?? "n/a"}, 30d change: ${m.price_change_percentage_30d_in_currency?.toFixed(2) ?? "n/a"}%, Categories: ${bestMatch.categories.join(", ")}`,
          });
        }
      }
    } catch (e) {
      // continue
    }
  }

  return {
    query,
    resolvedProjectName: resolvedProjectName ?? query,
    officialWebsite,
    officialTwitter,
    whitepaperUrl,
    githubRepo,
    teamMembers,
    findings,
    marketContext,
    searchQueries,
    totalCost,
    completedAt: new Date().toISOString(),
  };
}

// ─── 5. Helpers to extract specific info from findings ────────────────────

export function getNewsForProject(research: ResearchReport, limit = 5): ResearchFinding[] {
  return research.findings
    .filter((f) => f.category === "news")
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
    .slice(0, limit);
}

export function getRiskEvidence(research: ResearchReport): ResearchFinding[] {
  return research.findings.filter(
    (f) => f.category === "risks" || f.content.toLowerCase().includes("scam") || f.content.toLowerCase().includes("exploit") || f.content.toLowerCase().includes("hack"),
  );
}

export function getOfficialLinks(research: ResearchReport): { website?: string; twitter?: string; github?: string; whitepaper?: string } {
  return {
    website: research.officialWebsite,
    twitter: research.officialTwitter,
    github: research.githubRepo,
    whitepaper: research.whitepaperUrl,
  };
}
