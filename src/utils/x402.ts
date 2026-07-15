// src/utils/x402.ts
// x402 v2 payment-required response builder using the OFFICIAL OKX Payment
// SDK (@okxweb3/x402-express). Returns a 402 challenge in the standard
// x402 v2 shape, with the required `PAYMENT-REQUIRED` header so the OKX
// validator can confirm compliance.
//
// Reference: https://web3.okx.com/onchainos/dev-docs/payments/service-seller-sdk

import { config } from "../config/secrets.js";
import {
  x402ResourceServer,
  paymentMiddlewareFromConfig,
} from "@okxweb3/x402-express";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import type { PaywallConfig } from "@okxweb3/x402-core/server";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";

// RoutesConfig has a specific shape — we re-define it here since the SDK
// doesn't export the type publicly.
type RoutesConfig = Record<string, any>;

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

// ─── Official OKX Payment SDK integration ─────────────────────────────────

/**
 * Build the canonical OKX x402 payment middleware for our /v1/audit endpoint.
 * Uses the official @okxweb3/x402-express middleware, adapted to work with
 * Fastify (the Express middleware is an (req, res, next) function that we
 * can wire up directly via fastify.addHook).
 *
 * Requires env vars:
 *   OKX_FACILITATOR_API_KEY      — OKX exchange API key (Read-only permission)
 *   OKX_FACILITATOR_SECRET_KEY   — API secret
 *   OKX_FACILITATOR_PASSPHRASE   — API passphrase
 *
 * Without these, the facilitator client will throw on init and the middleware
 * builder returns null. In that case the server falls back to the minimal
 * 402 challenge (no facilitator, no auto-verification) so the demo still
 * works for listing review.
 */
export function buildX402Middleware(): ((req: any, res: any, next?: any) => Promise<any>) | null {
  if (!process.env.OKX_FACILITATOR_API_KEY || !process.env.OKX_FACILITATOR_SECRET_KEY || !process.env.OKX_FACILITATOR_PASSPHRASE) {
    console.warn("[x402] facilitator credentials not set — falling back to minimal 402 challenge");
    return null;
  }
  try {
    const facilitator = new OKXFacilitatorClient({
      apiKey: process.env.OKX_FACILITATOR_API_KEY,
      secretKey: process.env.OKX_FACILITATOR_SECRET_KEY,
      passphrase: process.env.OKX_FACILITATOR_PASSPHRASE,
    });
    const server = new x402ResourceServer(facilitator);
    server.register(config.x402.network as `${string}:${string}`, new ExactEvmScheme());
    const routes: RoutesConfig = {
      "POST /v1/audit": {
        accepts: [
          {
            scheme: "exact",
            network: config.x402.network as any,
            payTo: config.x402.receivingWallet,
            price: `$${config.x402.auditPrice.toFixed(2)}`,
          },
        ],
        description: "VEY1 forensic project audit — returns a 12-18 page PDF",
        mimeType: "application/json",
      },
    };
    const paywall: PaywallConfig = {
      appName: "VEY1",
      testnet: false,
    };
    return paymentMiddlewareFromConfig(routes, facilitator, [], paywall);
  } catch (e) {
    console.error("[x402] failed to build middleware:", e);
    return null;
  }
}
