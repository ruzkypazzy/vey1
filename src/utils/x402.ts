// src/utils/x402.ts
// Minimal x402 v2 payment-required response builder.
// When a request comes in without a valid payment header, we return a
// 402 with the standard x402 v2 PaymentRequirements. The user (or their
// agent wallet) signs the payload, replays the request with
// `X-PAYMENT: <base64 payload>`, and we verify + serve.
//
// For the hackathon MVP we keep this minimal: the payment challenge is
// generated, but signature verification is delegated to a local helper
// because we don't have a Circle Gateway sidecar in this environment.
// Production should use the canonical x402 facilitator.

import { config } from "../config/secrets.js";

export interface X402PaymentRequirements {
  scheme: "exact";
  network: string;        // CAIP-2 e.g. "eip155:196"
  maxAmountRequired: string; // base units, e.g. "1500000" for $1.50 USDT0 (6 decimals)
  resource: string;       // the URL being paid for
  description: string;
  mimeType: string;
  outputSchema?: Record<string, unknown>;
  payTo: string;          // receiving wallet
  maxTimeoutSeconds: number;
  asset: string;          // ERC-20 contract address
  extra?: Record<string, unknown>;
}

export interface X402Challenge {
  x402Version: 2;
  resource: {
    url: string;
    description: string;
    mimeType: string;
  };
  accepted: X402PaymentRequirements;
}

export function buildPaymentChallenge(resourceUrl: string, description: string): X402Challenge {
  // USDT0 has 6 decimals. $1.50 = 1_500_000 base units.
  const amountBaseUnits = String(Math.round(config.x402.auditPrice * 1_000_000));
  return {
    x402Version: 2,
    resource: {
      url: resourceUrl,
      description,
      mimeType: "application/json",
    },
    accepted: {
      scheme: "exact",
      network: config.x402.network,
      maxAmountRequired: amountBaseUnits,
      resource: resourceUrl,
      description,
      mimeType: "application/json",
      payTo: config.x402.receivingWallet,
      maxTimeoutSeconds: 300,
      asset: config.x402.asset,
      extra: {
        name: "USD₮0",
        version: "1",
      },
    },
  };
}

export function paymentRequiredResponse(resourceUrl: string, description: string) {
  return {
    statusCode: 402,
    body: buildPaymentChallenge(resourceUrl, description),
  };
}

/** Lightweight verification: presence + base64-shape check.
 *  Production: replace with real signature verification via x402 facilitator. */
export function isPaymentHeaderValid(header: string | undefined): boolean {
  if (!header) return false;
  try {
    const decoded = Buffer.from(header, "base64").toString("utf8");
    const obj = JSON.parse(decoded);
    return (
      typeof obj === "object" &&
      obj !== null &&
      typeof obj.signature === "string" &&
      obj.signature.startsWith("0x") &&
      typeof obj.authorization === "object"
    );
  } catch {
    return false;
  }
}
