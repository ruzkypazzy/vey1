// src/types/index.ts
// Type definitions for VEY1 audit pipeline.

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type FlagColor = "RED" | "YELLOW" | "GREEN";

export interface ProjectIdentity {
  /** The raw input the user gave us */
  rawInput: string;
  /** Best-guess canonical name (e.g. "Hyperliquid") */
  canonicalName: string;
  /** Detected ticker, if any */
  ticker?: string;
  /** Primary contract address (0x...), if resolvable */
  contractAddress?: string;
  /** Detected chain (ethereum, bsc, base, arbitrum, xlayer, solana) */
  chain?: string;
  /** Official website, if found */
  website?: string;
  /** Twitter handle (no @), if found */
  twitter?: string;
  /** GitHub org, if found */
  github?: string;
  /** Confidence the identity resolution is correct (0-1) */
  confidence: number;
}

export interface WalletAudit {
  address: string;
  label: string;            // e.g. "Deployer", "Treasury", "Multisig"
  chain: string;
  firstSeenDate?: string;
  totalTxs?: number;
  currentBalanceUsd?: number;
  fundingSource?: {
    type: "CEX" | "DEX" | "MIXER" | "BRIDGE" | "MINING" | "UNKNOWN";
    sourceAddress?: string;
    details?: string;
  };
  flags: AuditFlag[];
  topCounterparties?: { address: string; txCount: number }[];
}

export interface AuditFlag {
  color: FlagColor;
  category: string;         // e.g. "Funding", "Team", "Contract", "Social"
  message: string;
  evidence?: string;        // tx hash, tweet URL, etc.
}

export interface TeamMember {
  /** Best public name */
  name: string;
  /** Claimed role in the project */
  role: string;
  /** Twitter handle, if found */
  twitter?: string;
  /** GitHub username, if found */
  github?: string;
  /** Real-name confidence (verified / likely / pseudonymous / anonymous) */
  identityConfidence: "VERIFIED" | "LIKELY" | "PSEUDONYMOUS" | "ANONYMOUS";
  /** Personal wallets found, audited below */
  personalWallets: WalletAudit[];
  /** Past projects this person was associated with */
  pastProjects: PastProjectRef[];
  /** Scam database hits (if any) */
  scamDbHits: { source: string; note: string }[];
  /** Per-person risk score (0-100, 100 = safest) */
  riskScore: number;
  flags: AuditFlag[];
}

export interface PastProjectRef {
  name: string;
  role: string;
  year?: number;
  status: "ACTIVE" | "RUGGED" | "ABANDONED" | "ACQUIRED" | "UNKNOWN";
  outcome?: string;
  source?: string;          // URL or on-chain evidence
}

export interface ProjectAudit {
  identity: ProjectIdentity;
  /** Project-level on-chain wallets (deployer, treasury, multisig, fee) */
  projectWallets: WalletAudit[];
  /** All identified team members */
  team: TeamMember[];
  /** Twitter account analysis */
  twitterAnalysis?: {
    handle: string;
    accountAgeDays?: number;
    followerCount?: number;
    botScore?: number;        // 0-1
    notes?: string;
  };
  /** GitHub analysis */
  githubAnalysis?: {
    org: string;
    lastCommitDate?: string;
    contributorCount?: number;
    notes?: string;
  };
  /** Domain registration info */
  domainWhois?: {
    domain: string;
    createdDate?: string;
    registrar?: string;
    privacyProtected?: boolean;
  };
  /** Web archive reincarnation check */
  reincarnationCheck?: {
    priorNameAppearances: string[];
    priorDeployerUsage: PastProjectRef[];
    priorTeamUsage: PastProjectRef[];
  };
  /** All flags surfaced (deduplicated, sorted by severity) */
  flags: AuditFlag[];
  /** Final overall risk score 0-100 (100 = safest) */
  riskScore: number;
  /** Plain-English recommendation */
  recommendation: "PROCEED" | "PROCEED_WITH_MONITORING" | "CAUTION" | "AVOID";
  /** Reasoning paragraphs (LLM-generated) */
  reasoning: string;
  /** Comparable projects table */
  comparableProjects: PastProjectRef[];
}

export interface AuditReport {
  /** Unique report ID */
  id: string;
  /** Project audited */
  identity: ProjectIdentity;
  /** Full audit */
  audit: ProjectAudit;
  /** When audit started */
  startedAt: string;
  /** When audit completed */
  completedAt: string;
  /** Source URLs / tx hashes used as evidence (annexure) */
  evidence: { type: string; ref: string; note?: string }[];
  /** Confidence in the audit's completeness (0-1) */
  dataConfidence: number;
  /** Real web research evidence (Tavily + GitHub + CoinGecko) */
  research?: {
    query: string;
    resolvedProjectName?: string;
    officialWebsite?: string;
    officialTwitter?: string;
    githubRepo?: string;
    whitepaperUrl?: string;
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
    findings: Array<{
      source: string;
      category: string;
      title: string;
      url?: string;
      content: string;
      date?: string;
    }>;
    searchQueries: string[];
    totalCost: number;
  };
  /** Real on-chain evidence from OKX OnchainOS (if available) */
  onchainDossier?: {
    query: string;
    resolvedToken?: {
      symbol: string;
      name: string;
      address: string;
      chain: string;
      deployerAddress?: string;
    };
    security?: {
      riskLevel: string;
      riskScore: number;
      isHoneypot: boolean;
      canSell: boolean;
      hasRenounced: boolean;
      hasMintFunction: boolean;
      holderConcentration?: number;
      suspiciousFlags: string[];
    };
    holders?: {
      clusterCount: number;
      newWalletPercent: number;
      rugPullPercent: number;
      topHolders: { address: string; percent: number; tag?: string }[];
    };
    deployerReputation?: {
      deployerAddress: string;
      otherTokens: { symbol: string; name: string; chain: string }[];
      ruggedCount: number;
      totalTokensLaunched: number;
      avgTokenLifetimeDays?: number;
    };
    smartMoney?: { address: string; tag: string; recentBuysUsd?: number; recentSellsUsd?: number }[];
    sentiment?: { sentimentScore: number; newsCount24h?: number; vibeRank?: number; topKOLs?: { handle: string; influence: number }[] };
    recentNews?: { title: string; url: string; source: string; publishedAt?: number }[];
    walletPnl?: { realizedPnlUsd: number; unrealizedPnlUsd: number; winRate: number; totalTrades: number };
    errors: string[];
    costUsdt0: number;
  };
}
