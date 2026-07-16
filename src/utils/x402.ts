// src/utils/x402.ts
// x402 v2 payment-required response builder using the OFFICIAL OKX Payment
// SDK (@okxweb3/x402-express + @okxweb3/x402-core + @okxweb3/x402-evm).
//
// IMPORTANT: The 402 challenge shape MUST match the OKX schema exactly:
//   {
//     x402Version: 2,
//     error: "Payment required" | undefined,
//     resource: { url, description, mimeType },
//     accepts: [  // ARRAY, not single object
//       { scheme, network, amount (not maxAmountRequired!), asset, payTo, maxTimeoutSeconds, extra }
//     ]
//   }
//
// Reference: https://web3.okx.com/onchainos/dev-docs/payments/service-seller-sdk

import { config } from "../config/secrets.js";
import {
  x402ResourceServer,
  paymentMiddlewareFromConfig,
} from "@okxweb3/x402-express";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";

// Route configuration shape expected by the official OKX SDK
// Note: the SDK's `accepts` is a single object (not an array) inside a route config
type RouteConfigEntry = {
  accepts: {
    scheme: string;
    network: string;
    payTo: string;
    price: string; // "$1.50" format — SDK parses to amount in base units
    maxTimeoutSeconds?: number;
    extra?: Record<string, unknown>;
  };
  description?: string;
  mimeType?: string;
};
type RoutesConfig = Record<string, RouteConfigEntry> | any;

/**
 * Build the canonical OKX x402 402 challenge in the exact shape expected by
 * the OKX validator. Uses the same field names as the OKX SDK:
 *   - "amount" (not "maxAmountRequired")
 *   - "accepts" is an array (not a single object)
 *   - "error" field included with "Payment required"
 *
 * This function is the SINGLE SOURCE OF TRUTH for the 402 challenge shape.
 * Both the unpaid handler and the paid-audit page render this same shape.
 */
export function buildPaymentChallenge(resourceUrl: string, description: string) {
  return {
    x402Version: 2 as const,
    error: "Payment required",
    resource: {
      url: resourceUrl,
      description,
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: config.x402.network, // "eip155:196"
        amount: String(Math.round(config.x402.auditPrice * 1_000_000)), // "1500000" for 1.5 USDT0 (6 decimals)
        asset: config.x402.asset, // USDT0 contract on X Layer
        payTo: config.x402.receivingWallet, // VEY1 receiving wallet
        maxTimeoutSeconds: 300,
        extra: {
          name: "USD₮0",
          version: "1",
        },
      },
    ],
  };
}

export function paymentRequiredResponse(resourceUrl: string, description: string) {
  return {
    statusCode: 402,
    body: buildPaymentChallenge(resourceUrl, description),
  };
}

/** Lightweight verification: presence + base64-shape check.
 *  Real signature verification requires the OKX facilitator. */
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
 * Uses the official @okxweb3/x402-express middleware.
 *
 * Requires env vars (for full facilitator integration):
 *   OKX_FACILITATOR_API_KEY      — OKX exchange API key (Read-only permission)
 *   OKX_FACILITATOR_SECRET_KEY   — API secret
 *   OKX_FACILITATOR_PASSPHRASE   — API passphrase
 *
 * Without these, returns null. The server falls back to manually emitting
 * the proper 402 challenge (same shape as the SDK would emit).
 */
export function buildX402Middleware(): ((req: any, res: any, next?: any) => Promise<any>) | null {
  if (!process.env.OKX_FACILITATOR_API_KEY || !process.env.OKX_FACILITATOR_SECRET_KEY || !process.env.OKX_FACILITATOR_PASSPHRASE) {
    return null;
  }
  try {
    const facilitator = new OKXFacilitatorClient({
      apiKey: process.env.OKX_FACILITATOR_API_KEY,
      secretKey: process.env.OKX_FACILITATOR_SECRET_KEY,
      passphrase: process.env.OKX_FACILITATOR_PASSPHRASE,
    });
    const routes: RoutesConfig = {
      "POST /v1/audit": {
        accepts: {
          scheme: "exact",
          network: config.x402.network,
          payTo: config.x402.receivingWallet,
          price: `$${config.x402.auditPrice.toFixed(2)}`, // "$1.50" — SDK parses
          maxTimeoutSeconds: 300,
        },
        description: "VEY1 forensic project audit — returns a 12-18 page PDF",
        mimeType: "application/json",
      },
    };
    return paymentMiddlewareFromConfig(
      routes,
      facilitator,
      [],
      { appName: "VEY1", testnet: false },
      undefined,
      false, // syncFacilitatorOnStart: false — don't block server startup
    );
  } catch (e) {
    console.error("[x402] failed to build middleware:", e);
    return null;
  }
}
