// src/services/onchainos.ts
// Wraps the onchainos CLI to make real x402-paywalled calls to OKX OnchainOS.
// This is what makes VEY1's audit "real" — every data point comes from OKX's
// own infrastructure, not LLM hallucination.
//
// Authentication: API Key via env vars (no OTP needed in headless containers).
//   OKX_API_KEY
//   OKX_SECRET_KEY
//   OKX_PASSPHRASE
// Set these in Railway env vars and the CLI auto-logs-in on first call.
//
// Payment: x402 calls draw from the Agentic Wallet (0x72233b...) — must have
// USDT0 balance. We pre-flight check the balance before any paid call to
// avoid wasting calls when the wallet is empty.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const exec = promisify(execFile);

const ONCHAINOS_BIN = process.env.ONCHAINOS_BIN || "onchainos";
const ONCHAINOS_HOME = process.env.ONCHAINOS_HOME || "/app/.onchainos";
const SESSION_FILE = resolve(ONCHAINOS_HOME, "session.json");

// Minimum USDT0 balance to attempt any paid call. Below this, skip onchainos
// entirely to avoid x402 payment failures that confuse the user.
// 0.005 USDT0 ≈ 2-3 audits. Set low so the demo can run on small balances.
const MIN_BALANCE_USDT0 = 0.005;

// Cache wallet balance to avoid hammering the API
let cachedBalance: { balance: number; ts: number } | null = null;
const BALANCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export type Chain = "ethereum" | "bsc" | "base" | "arbitrum" | "polygon" | "solana" | "xlayer";

export interface TokenInfo {
  symbol: string;
  name: string;
  address: string;
  chain: Chain;
  decimals: number;
  totalSupply?: string;
  deployerAddress?: string;
  deployTime?: number;
  source: "okx-dex-token" | "okx-dex-trenches" | "okx-dex-signal" | "okx-dex-social" | "okx-dex-market" | "okx-security" | "manual";
  raw?: unknown;
}

export interface DevReputation {
  deployerAddress: string;
  otherTokens: TokenInfo[];
  ruggedCount: number;
  totalTokensLaunched: number;
  avgTokenLifetimeDays?: number;
  source: "okx-dex-trenches";
  raw?: unknown;
}

export interface SmartMoneySignal {
  address: string;
  tag: "smart_money" | "kol" | "whale" | "sniper" | "bundler" | "regular";
  recentBuysUsd?: number;
  recentSellsUsd?: number;
  netPosition?: string;
  source: "okx-dex-signal";
  raw?: unknown;
}

export interface SentimentSignal {
  symbol: string;
  sentimentScore: number; // 0-100, 0=extreme fear, 100=extreme greed
  vibeRank?: number;
  topKOLs?: { handle: string; influence: number }[];
  newsCount24h?: number;
  topNews?: { title: string; url: string; source: string; publishedAt: number }[];
  source: "okx-dex-social";
  raw?: unknown;
}

export interface SecurityScan {
  address: string;
  riskLevel: "safe" | "low" | "medium" | "high" | "critical";
  riskScore: number; // 0-100, 100=safest
  isHoneypot: boolean;
  canSell: boolean;
  cannotBuy: boolean;
  cannotSell: boolean;
  hasRenounced: boolean;
  hasMintFunction: boolean;
  holderConcentration?: number; // % held by top 10
  suspiciousFlags: string[];
  source: "okx-security";
  raw?: unknown;
}

export interface HolderCluster {
  address: string;
  topHolders: { address: string; percent: number; tag?: string }[];
  clusterCount: number;
  newWalletPercent: number;
  rugPullPercent: number;
  source: "okx-dex-token" | "okx-dex-market";
  raw?: unknown;
}

/**
 * Run an onchainos command and return parsed JSON.
 * Throws if the command fails (including x402 payment failures, which are
 * surfaced as raw stderr).
 */
async function runCli<T = unknown>(
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const { stdout, stderr } = await exec(
    ONCHAINOS_BIN,
    args,
    {
      timeout: opts.timeoutMs ?? 30_000,
      env: {
        ...process.env,
        ONCHAINOS_HOME,
        PATH: `${process.env.PATH}:/root/.local/bin`,
      },
      maxBuffer: 10 * 1024 * 1024, // 10MB — advanced-info can be big
    },
  );
  // onchainos returns JSON; sometimes with leading warnings/non-JSON
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch (e) {
    // Some commands print human output, try to find JSON substring
    const jsonStart = trimmed.indexOf("{");
    if (jsonStart >= 0) {
      return JSON.parse(trimmed.slice(jsonStart)) as T;
    }
    throw new Error(`onchainos returned non-JSON: ${trimmed.slice(0, 200)} | stderr: ${stderr.slice(0, 200)}`);
  }
}

/**
 * Make a single x402-paid call to onchainos.
 * Cost is ~0.0001 USDT0 for basic, ~0.0005 USDT0 for premium.
 *
 * For demo/dev use, this can be skipped with ONCHAINOS_MOCK=1 to return
 * placeholder data so the rest of the pipeline still works.
 */
async function paidCall<T>(
  args: string[],
  mockValue: T,
  label: string,
): Promise<T> {
  if (process.env.ONCHAINOS_MOCK === "1") {
    return mockValue;
  }
  try {
    const result = await runCli<T>(args, { timeoutMs: 60_000 });
    console.log(`[onchainos:${label}] result preview: ${JSON.stringify(result).slice(0, 300)}`);
    return result;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[onchainos:${label}] paid call failed: ${msg.slice(0, 500)}`);
    if (process.env.ONCHAINOS_FAIL_OPEN === "1") {
      return mockValue;
    }
    throw e;
  }
}

// ─── 1. Token search & info ─────────────────────────────────────────────────

export async function searchToken(query: string, chain?: Chain): Promise<TokenInfo[]> {
  console.log(`[onchainos:search] query="${query}" chain=${chain ?? "(none)"}`);
  const result = await paidCall<unknown>(
    ["token", "search", "--query", query, ...(chain ? ["--chain", chain] : [])],
    [],
    "search",
  );
  // The CLI returns { ok: true, data: [{...}, ...] } — unwrap and normalize
  let rawList: any[] = [];
  if (result && typeof result === "object" && "data" in (result as any)) {
    rawList = ((result as any).data as any[]) ?? [];
  } else if (Array.isArray(result)) {
    rawList = result;
  }
  // Map to our TokenInfo shape
  return rawList.slice(0, 5).map((t): TokenInfo => ({
    symbol: t.symbol ?? t.tokenSymbol ?? "UNKNOWN",
    name: t.name ?? t.tokenName ?? "Unknown",
    address: t.address ?? t.tokenContractAddress ?? "",
    chain: chainIndexToChain(t.chainIndex ?? t.chain) ?? (chain ?? "ethereum"),
    decimals: parseInt(t.decimal ?? t.decimals ?? "18", 10),
    deployerAddress: t.deployerAddress ?? t.creator ?? undefined,
    source: "okx-dex-token",
  }));
}

/** Map OKX chainIndex (string number) or chain name to our Chain type */
function chainIndexToChain(idx: string | number | undefined): Chain | null {
  if (idx == null) return null;
  const s = String(idx).toLowerCase();
  if (s === "1" || s === "ethereum" || s === "eth") return "ethereum";
  if (s === "56" || s === "bsc" || s === "bnb") return "bsc";
  if (s === "8453" || s === "base") return "base";
  if (s === "42161" || s === "arbitrum" || s === "arb_eth") return "arbitrum";
  if (s === "137" || s === "polygon" || s === "matic") return "polygon";
  if (s === "196" || s === "okb" || s === "xlayer" || s === "x-layer") return "xlayer";
  if (s === "501" || s === "solana" || s === "sol") return "solana";
  return null;
}

export async function getTokenInfo(address: string, chain: Chain): Promise<TokenInfo> {
  return paidCall<TokenInfo>(
    ["token", "info", "--address", address, "--chain", chain],
    {
      symbol: "UNKNOWN",
      name: "Unknown",
      address,
      chain,
      decimals: 18,
      source: "okx-dex-token",
    },
    "info",
  );
}

export async function getAdvancedInfo(address: string, chain: Chain): Promise<{
  token: TokenInfo;
  holders: HolderCluster;
}> {
  const result = await paidCall<unknown>(
    ["token", "advanced-info", "--address", address, "--chain", chain],
    {
      token: { symbol: "UNKNOWN", name: "Unknown", address, chain, decimals: 18, source: "okx-dex-token" as const },
      holders: { address, topHolders: [], clusterCount: 0, newWalletPercent: 0, rugPullPercent: 0, source: "okx-dex-token" as const },
    },
    "advanced-info",
  );
  return result as { token: TokenInfo; holders: HolderCluster };
}

// ─── 2. Dev reputation (trenches — "has this dev rugged before?") ───────────

export async function getDeployerReputation(deployerAddress: string, chain: Chain): Promise<DevReputation> {
  return paidCall<DevReputation>(
    ["memepump", "token-dev-info", "--address", deployerAddress, "--chain", chain],
    {
      deployerAddress,
      otherTokens: [],
      ruggedCount: 0,
      totalTokensLaunched: 0,
      source: "okx-dex-trenches",
    },
    "dev-reputation",
  );
}

export async function getTokensByDeployer(deployerAddress: string, chain: Chain): Promise<TokenInfo[]> {
  return paidCall<TokenInfo[]>(
    ["memepump", "similar-tokens", "--address", deployerAddress, "--chain", chain],
    [],
    "dev-tokens",
  );
}

// ─── 3. Smart money / KOL signals ──────────────────────────────────────────

export async function getSmartMoneySignals(tokenAddress: string, chain: Chain): Promise<SmartMoneySignal[]> {
  return paidCall<SmartMoneySignal[]>(
    ["signal", "list", "--chain", chain, "--token-address", tokenAddress, "--limit", "10"],
    [],
    "signal",
  );
}

export async function getTokenSentiment(symbol: string, tokenAddress?: string, chain: Chain = "ethereum"): Promise<SentimentSignal> {
  // vibe-timeline needs --token-address and --chain (not --symbol)
  return paidCall<SentimentSignal>(
    tokenAddress
      ? ["social", "vibe-timeline", "--chain", chain, "--token-address", tokenAddress]
      : ["social", "sentiment-symbol", "--token-symbols", symbol, "--chain", chain],
    {
      symbol,
      sentimentScore: 50,
      source: "okx-dex-social",
    },
    "social",
  );
}

export async function getTokenNews(symbol: string, limit = 10): Promise<SentimentSignal["topNews"]> {
  return paidCall<SentimentSignal["topNews"]>(
    ["social", "news-by-symbol", "--token-symbols", symbol, "--limit", String(limit)],
    [],
    "news",
  );
}

// ─── 4. Security scan (honeypot, risk score, mint authority) ───────────────

export async function getSecurityScan(address: string, chain: Chain): Promise<SecurityScan> {
  return paidCall<SecurityScan>(
    ["security", "token-scan", "--address", address, "--chain", chain],
    {
      address,
      riskLevel: "low" as const,
      riskScore: 50,
      isHoneypot: false,
      canSell: true,
      cannotBuy: false,
      cannotSell: false,
      hasRenounced: false,
      hasMintFunction: false,
      suspiciousFlags: [],
      source: "okx-security" as const,
    },
    "security",
  );
}

// ─── 5. Wallet analysis (deployer wallet PnL, win rate, history) ───────────

export async function getWalletAnalysis(address: string, chain: Chain): Promise<{
  pnlOverview: { realizedPnlUsd: number; unrealizedPnlUsd: number; winRate: number; totalTrades: number };
  recentActivity: { signature: string; timestamp: number; type: "buy" | "sell"; token: string; amountUsd: number }[];
}> {
  return paidCall(
    ["market", "portfolio-overview", "--address", address, "--chain", chain],
    {
      pnlOverview: { realizedPnlUsd: 0, unrealizedPnlUsd: 0, winRate: 0, totalTrades: 0 },
      recentActivity: [],
    },
    "wallet-analysis",
  );
}

// ─── 6. Composite: full on-chain dossier for a single project ───────────────

export interface OnchainDossier {
  query: string;
  resolvedToken: TokenInfo | null;
  security: SecurityScan | null;
  holders: HolderCluster | null;
  deployerReputation: DevReputation | null;
  smartMoney: SmartMoneySignal[];
  sentiment: SentimentSignal | null;
  recentNews: SentimentSignal["topNews"];
  walletPnl: { realizedPnlUsd: number; unrealizedPnlUsd: number; winRate: number; totalTrades: number } | null;
  errors: string[];
  generatedAt: number;
  costUsdt0: number; // estimated x402 cost for this dossier
}

const COST_PER_BASIC = 0.0001;
const COST_PER_PREMIUM = 0.0005;

/**
 * Run all on-chain data gathering in parallel for a given project query.
 * Returns a structured dossier with citations to OKX OnchainOS skills.
 */
export async function buildDossier(query: string, chain?: Chain): Promise<OnchainDossier> {
  const errors: string[] = [];
  let costUsdt0 = 0;

  // Step 1: resolve the token (basic call, $0.0001)
  let resolvedToken: TokenInfo | null = null;
  try {
    const candidates = await searchToken(query, chain);
    costUsdt0 += COST_PER_BASIC;
    resolvedToken = candidates?.[0] ?? null;
  } catch (e) {
    errors.push(`search: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!resolvedToken) {
    return {
      query,
      resolvedToken: null,
      security: null,
      holders: null,
      deployerReputation: null,
      smartMoney: [],
      sentiment: null,
      recentNews: [],
      walletPnl: null,
      errors: [...errors, "Could not resolve token"],
      generatedAt: Date.now(),
      costUsdt0,
    };
  }

  const tokenChain = (resolvedToken.chain || chain || "ethereum") as Chain;
  const deployer = resolvedToken.deployerAddress;

  // Step 2: parallel calls for everything else
  const tasks: Array<Promise<void>> = [];

  // Security scan — premium ($0.0005)
  let security: SecurityScan | null = null;
  tasks.push(
    (async () => {
      try {
        security = await getSecurityScan(resolvedToken!.address, tokenChain);
        costUsdt0 += COST_PER_PREMIUM;
      } catch (e) {
        errors.push(`security: ${e instanceof Error ? e.message : String(e)}`);
      }
    })(),
  );

  // Advanced info (holders + cluster) — premium ($0.0005)
  let holders: HolderCluster | null = null;
  tasks.push(
    (async () => {
      try {
        const adv = await getAdvancedInfo(resolvedToken!.address, tokenChain);
        holders = adv.holders;
        costUsdt0 += COST_PER_PREMIUM;
      } catch (e) {
        errors.push(`holders: ${e instanceof Error ? e.message : String(e)}`);
      }
    })(),
  );

  // Deployer reputation — premium ($0.0005)
  let deployerReputation: DevReputation | null = null;
  if (deployer) {
    tasks.push(
      (async () => {
        try {
          deployerReputation = await getDeployerReputation(deployer, tokenChain);
          costUsdt0 += COST_PER_PREMIUM;
        } catch (e) {
          errors.push(`deployer: ${e instanceof Error ? e.message : String(e)}`);
        }
      })(),
    );
  }

  // Smart money signals — basic ($0.0001)
  let smartMoney: SmartMoneySignal[] = [];
  tasks.push(
    (async () => {
      try {
        smartMoney = await getSmartMoneySignals(resolvedToken!.address, tokenChain);
        costUsdt0 += COST_PER_BASIC;
      } catch (e) {
        errors.push(`smart-money: ${e instanceof Error ? e.message : String(e)}`);
      }
    })(),
  );

  // Sentiment — basic ($0.0001)
  let sentiment: SentimentSignal | null = null;
  tasks.push(
    (async () => {
      try {
        sentiment = await getTokenSentiment(resolvedToken!.symbol, resolvedToken!.address, tokenChain);
        costUsdt0 += COST_PER_BASIC;
      } catch (e) {
        errors.push(`sentiment: ${e instanceof Error ? e.message : String(e)}`);
      }
    })(),
  );

  // News — basic ($0.0001)
  let recentNews: SentimentSignal["topNews"] = [];
  tasks.push(
    (async () => {
      try {
        recentNews = (await getTokenNews(resolvedToken!.symbol, 10)) ?? [];
        costUsdt0 += COST_PER_BASIC;
      } catch (e) {
        errors.push(`news: ${e instanceof Error ? e.message : String(e)}`);
      }
    })(),
  );

  // Deployer wallet PnL — premium ($0.0005)
  let walletPnl: OnchainDossier["walletPnl"] = null;
  if (deployer) {
    tasks.push(
      (async () => {
        try {
          const wa = await getWalletAnalysis(deployer, tokenChain);
          walletPnl = wa.pnlOverview;
          costUsdt0 += COST_PER_PREMIUM;
        } catch (e) {
          errors.push(`wallet-pnl: ${e instanceof Error ? e.message : String(e)}`);
        }
      })(),
    );
  }

  await Promise.allSettled(tasks);

  return {
    query,
    resolvedToken,
    security,
    holders,
    deployerReputation,
    smartMoney,
    sentiment,
    recentNews: recentNews ?? [],
    walletPnl,
    errors,
    generatedAt: Date.now(),
    costUsdt0,
  };
}

// ─── Health check ───────────────────────────────────────────────────────────

export async function checkOnchainosAvailable(): Promise<{ ok: boolean; version?: string; error?: string; loggedIn?: boolean; balance?: number }> {
  try {
    const { stdout } = await exec(ONCHAINOS_BIN, ["--version"], { timeout: 5_000 });
    const match = stdout.match(/onchainos\s+([\d.]+)/);
    const version = match?.[1];

    // Check login state
    const loggedIn = await isLoggedIn();

    // Log wallet status for debugging
    try {
      const { stdout: statusOut } = await exec(ONCHAINOS_BIN, ["wallet", "status"], { timeout: 5_000, env: { ...process.env, ONCHAINOS_HOME, PATH: `${process.env.PATH}:/root/.local/bin` } });
      console.log(`[onchainos:status] ${statusOut.slice(0, 500)}`);
    } catch (e) {
      console.warn(`[onchainos:status] failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Check balance (best effort)
    let balance: number | undefined;
    if (loggedIn) {
      balance = await getAgenticWalletBalance();
    }

    return { ok: true, version, loggedIn, balance };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── Wallet session ─────────────────────────────────────────────────────────

/**
 * Persist the Agentic Wallet session. The onchainos CLI manages its own
 * session files in $ONCHAINOS_HOME. We just need to ensure that home
 * directory exists and that the user can do `onchainos wallet login <email>`
 * once via OTP.
 */
export async function ensureSessionHome(): Promise<void> {
  if (!existsSync(ONCHAINOS_HOME)) {
    await mkdir(ONCHAINOS_HOME, { recursive: true });
  }
}

/**
 * Check if the onchainos CLI is already logged in (session file or cached).
 * Returns true if a prior login session exists.
 */
export async function isLoggedIn(): Promise<boolean> {
  try {
    const { stdout } = await exec(
      ONCHAINOS_BIN,
      ["wallet", "status"],
      {
        timeout: 10_000,
        env: {
          ...process.env,
          ONCHAINOS_HOME,
          PATH: `${process.env.PATH}:/root/.local/bin`,
        },
      },
    );
    const json = JSON.parse(stdout.trim());
    return json?.data?.loggedIn === true;
  } catch {
    return false;
  }
}

/**
 * Bootstrap the session: if env has API key credentials and we're not
 * already logged in, attempt a non-interactive login. Returns whether the
 * session is ready for paid calls.
 */
export async function bootstrapSession(): Promise<{ ok: boolean; reason: string }> {
  if (process.env.ONCHAINOS_DISABLED === "1") {
    return { ok: false, reason: "disabled by env" };
  }
  if (!process.env.OKX_API_KEY || !process.env.OKX_SECRET_KEY || !process.env.OKX_PASSPHRASE) {
    return { ok: false, reason: "missing OKX_API_KEY/SECRET/PASSPHRASE env vars" };
  }
  if (await isLoggedIn()) {
    return { ok: true, reason: "already logged in" };
  }
  try {
    await ensureSessionHome();
    const { stdout, stderr } = await exec(
      ONCHAINOS_BIN,
      ["wallet", "login"],
      {
        timeout: 30_000,
        env: {
          ...process.env,
          ONCHAINOS_HOME,
          PATH: `${process.env.PATH}:/root/.local/bin`,
        },
      },
    );
    if (stdout.includes("ok") || stdout.includes("success")) {
      return { ok: true, reason: "API key login succeeded" };
    }
    return { ok: false, reason: `login response: ${stdout.slice(0, 200)} | ${stderr.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Get the current Agentic Wallet balance in USDT0 (X Layer).
 * Returns 0 if not logged in or balance unavailable.
 * Cached for 5 minutes to avoid hammering the API.
 */
export async function getAgenticWalletBalance(): Promise<number> {
  if (cachedBalance && Date.now() - cachedBalance.ts < BALANCE_TTL_MS) {
    return cachedBalance.balance;
  }
  try {
    const { stdout, stderr } = await exec(
      ONCHAINOS_BIN,
      ["wallet", "balance", "--chain", "xlayer"],
      {
        timeout: 10_000,
        env: {
          ...process.env,
          ONCHAINOS_HOME,
          PATH: `${process.env.PATH}:/root/.local/bin`,
        },
      },
    );
    console.log(`[onchainos:balance] stdout=${stdout.slice(0, 500)} stderr=${stderr.slice(0, 200)}`);
    const json = JSON.parse(stdout.trim());
    // Try multiple response shapes — the CLI's response format has changed
    // between versions. The current (v4.2.4) response is:
    //   { data: { details: [{ tokenAssets: [{ symbol: "USD₮0", balance: "0.06", ... }] }], totalValueUsd: "0.06" } }
    let balance = 0;
    const data = json?.data;

    // Helper: find USDT0 in any list
    const findUsdt0 = (list: any[]) => {
      if (!Array.isArray(list)) return null;
      return list.find(
        (t: any) =>
          t?.symbol === "USDT0" ||
          t?.symbol === "USD₮0" ||
          t?.tokenSymbol === "USDT0" ||
          t?.tokenSymbol === "USD₮0",
      );
    };

    if (typeof data === "number" || typeof data === "string") {
      balance = parseFloat(String(data));
    } else if (data?.totalAssets) {
      balance = parseFloat(data.totalAssets);
    } else if (data?.balance) {
      balance = parseFloat(data.balance);
    } else if (data?.totalValueUsd) {
      // Newest shape: walk through details[].tokenAssets[]
      if (Array.isArray(data.details)) {
        for (const detail of data.details) {
          const usdt0 = findUsdt0(detail?.tokenAssets ?? []);
          if (usdt0) {
            balance = parseFloat(usdt0.balance ?? "0");
            break;
          }
        }
      }
      if (balance === 0) balance = parseFloat(data.totalValueUsd);
    } else if (Array.isArray(data)) {
      const usdt0 = findUsdt0(data);
      balance = parseFloat(usdt0?.balance ?? usdt0?.totalAssets ?? "0");
    } else if (data?.tokens && Array.isArray(data.tokens)) {
      const usdt0 = findUsdt0(data.tokens);
      balance = parseFloat(usdt0?.balance ?? usdt0?.totalAssets ?? "0");
    } else if (data?.assets && Array.isArray(data.assets)) {
      const usdt0 = findUsdt0(data.assets);
      balance = parseFloat(usdt0?.balance ?? usdt0?.totalAssets ?? "0");
    } else if (data?.details && Array.isArray(data.details)) {
      for (const detail of data.details) {
        const usdt0 = findUsdt0(detail?.tokenAssets ?? []);
        if (usdt0) {
          balance = parseFloat(usdt0.balance ?? "0");
          break;
        }
      }
    }
    console.log(`[onchainos:balance] parsed=${balance} from ${JSON.stringify(data).slice(0, 300)}`);
    cachedBalance = { balance, ts: Date.now() };
    return balance;
  } catch (e) {
    console.warn(`[onchainos:balance] failed: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}

/**
 * Pre-flight: is the session ready + does the wallet have enough balance?
 * Returns true only if we should attempt paid calls.
 */
export async function canMakePaidCalls(): Promise<{ ok: boolean; reason: string; balance?: number }> {
  const session = await bootstrapSession();
  if (!session.ok) {
    return { ok: false, reason: session.reason };
  }
  const balance = await getAgenticWalletBalance();
  if (balance < MIN_BALANCE_USDT0) {
    return { ok: false, reason: `balance too low: ${balance.toFixed(4)} USDT0 < ${MIN_BALANCE_USDT0}`, balance };
  }
  return { ok: true, reason: "ready", balance };
}

/**
 * Reset the balance cache. Call this after a paid call to force a refresh.
 */
export function invalidateBalanceCache(): void {
  cachedBalance = null;
}
