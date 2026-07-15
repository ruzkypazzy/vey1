// src/audit/onchain.ts
// On-chain audit module.
//
// Strategy: we shell out to the `onchainos` CLI on the host. This keeps the
// app keyless (no OKX API keys in the .env) and matches the A2A/Onchain OS
// pattern OKX.AI rewards. If the CLI isn't available, we fall back to a
// direct ethers.js RPC read so the app still works for testing.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { JsonRpcProvider, formatEther, isAddress } from "ethers";
import type { WalletAudit, AuditFlag } from "../types/index.js";

const exec = promisify(execFile);

const CHAIN_RPCS: Record<string, string> = {
  ethereum: process.env.RPC_ETHEREUM ?? "https://eth.llamarpc.com",
  xlayer: process.env.RPC_XLAYER ?? "https://rpc.xlayer.tech",
  bsc: process.env.RPC_BSC ?? "https://bsc-dataseed.binance.org",
  base: process.env.RPC_BASE ?? "https://mainnet.base.org",
  arbitrum: process.env.RPC_ARBITRUM ?? "https://arb1.arbitrum.io/rpc",
  polygon: process.env.RPC_POLYGON ?? "https://polygon-rpc.com",
};

const OFAC_SANCTIONED = new Set<string>([
  // Placeholder; real list comes from public OFAC SDN list. Keep this set
  // short and rely on the onchainos risk-scanner skill for full coverage.
  "0x8576acc5c05d6ce88f4e49bf65bdf0c62f05153c",
  "0xd882cfc20f52f2599d84b8a8d9b3c2fa5b9b4b2f",
]);

const KNOWN_MIXERS = new Set<string>([
  "0x12d66f87a04ad9d72d22f813a9e8a7b6f2a4b3c1", // Tornado proxy placeholder
  "0x47ce0c6ed5b0ce3d3a51fdb1c52cc66b7c0cba3d", // Tornado proxy placeholder
]);

/** Try to call the onchainos CLI. Returns null if not available. */
async function tryOnchainos(
  args: string[],
  timeoutMs = 12000,
): Promise<unknown | null> {
  try {
    const { stdout } = await exec("onchainos", args, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

export interface OnchainAuditInput {
  address: string;
  label: string;
  chain?: string;
}

export interface OnchainAuditResult {
  wallet: WalletAudit;
  raw: unknown;
}

export async function auditWallet(
  input: OnchainAuditInput,
): Promise<OnchainAuditResult> {
  const chain = input.chain ?? "ethereum";
  const flags: AuditFlag[] = [];

  // Path 1: try OnchainOS skill (preferred — gives risk scoring for free)
  const onchainData = await tryOnchainos([
    "wallet",
    "history",
    "--address",
    input.address,
    "--chain",
    chain,
    "--limit",
    "20",
  ]);

  // Path 2: direct ethers read for first-seen + balance (fallback / supplement)
  const rpc = CHAIN_RPCS[chain];
  let firstSeenBlock: number | undefined;
  let currentBalanceWei: bigint | undefined;
  if (rpc && isAddress(input.address)) {
    try {
      const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
      const [balance, txCount] = await Promise.all([
        provider.getBalance(input.address),
        provider.getTransactionCount(input.address),
      ]);
      currentBalanceWei = balance;
      if (txCount > 0) {
        // Get the earliest tx we can find via a binary-ish block search would be ideal,
        // but a simple proxy: scan first few thousand blocks after deployment is overkill.
        // We use txCount as a proxy for activity and leave firstSeen to OnchainOS.
      }
    } catch {
      // ignore
    }
  }

  // Construct wallet record
  const wallet: WalletAudit = {
    address: input.address,
    label: input.label,
    chain,
    currentBalanceUsd: currentBalanceWei
      ? Number(formatEther(currentBalanceWei)) * 3000 // assume ~$3k ETH for demo
      : undefined,
    flags,
  };

  // Apply risk heuristics
  const lower = input.address.toLowerCase();
  if (OFAC_SANCTIONED.has(lower)) {
    flags.push({
      color: "RED",
      category: "Funding",
      message: "Address is on OFAC sanctions list.",
      evidence: `OFAC SDN match: ${input.address}`,
    });
  }
  if (KNOWN_MIXERS.has(lower)) {
    flags.push({
      color: "RED",
      category: "Funding",
      message: "Address is a known mixer contract (Tornado Cash / similar).",
      evidence: input.address,
    });
  }

  // If onchainos returned a result, surface high-risk flags from it
  if (onchainData && typeof onchainData === "object") {
    const obj = onchainData as Record<string, unknown>;
    if (Array.isArray(obj["flags"])) {
      for (const f of obj["flags"] as { severity?: string; message?: string }[]) {
        if (f.severity === "high" || f.severity === "critical") {
          flags.push({
            color: "RED",
            category: "OnchainOS",
            message: f.message ?? "OnchainOS risk flag",
          });
        }
      }
    }
    if (typeof obj["first_seen"] === "string") {
      wallet.firstSeenDate = obj["first_seen"];
    }
    if (typeof obj["tx_count"] === "number") {
      wallet.totalTxs = obj["tx_count"];
    }
    if (Array.isArray(obj["funding_source"])) {
      const src = (obj["funding_source"] as unknown[])[0] as
        | { type?: string; address?: string }
        | undefined;
      if (src) {
        wallet.fundingSource = {
          type: (src.type as "CEX" | "DEX" | "MIXER" | "BRIDGE" | "MINING" | "UNKNOWN") ?? "UNKNOWN",
          sourceAddress: src.address,
        };
        if (src.type === "MIXER") {
          flags.push({
            color: "RED",
            category: "Funding",
            message: `Wallet was funded via mixer (${src.address ?? "unknown"}).`,
            evidence: src.address,
          });
        }
      }
    }
  }

  return { wallet, raw: onchainData ?? null };
}

/** Quick check if an address is an EOA or contract */
export async function isContractAddress(
  address: string,
  chain = "ethereum",
): Promise<boolean> {
  const rpc = CHAIN_RPCS[chain];
  if (!rpc || !isAddress(address)) return false;
  try {
    const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
    const code = await provider.getCode(address);
    return code !== "0x" && code.length > 2;
  } catch {
    return false;
  }
}
