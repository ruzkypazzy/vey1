// src/utils/x402.ts
// x402 v2 integration using the OFFICIAL OKX Payment SDK
// (@okxweb3/x402-express + @okxweb3/x402-core + @okxweb3/x402-evm).
//
// This file exports:
//   - buildPaymentChallenge(): the canonical 402 challenge shape
//   - buildX402Middleware(): the official SDK middleware, adapted to Fastify
//   - paymentRequiredResponse(): helper for emitting 402
//
// Reference: https://web3.okx.com/onchainos/dev-docs/okxai/howtomcp

import { config } from "../config/secrets.js";
import {
  x402ResourceServer,
  paymentMiddlewareFromConfig,
} from "@okxweb3/x402-express";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";

/**
 * Build the canonical OKX x402 402 challenge in the exact shape the
 * OKX validator expects (per https://web3.okx.com/onchainos/dev-docs/okxai/howtomcp).
 *
 * Shape:
 *   {
 *     x402Version: 2,
 *     resource: { url, description, mimeType },
 *     accepts: [{
 *       scheme: "exact",
 *       network: "eip155:196",
 *       asset: "0x779ded0c9e1022225f8e0630b35a9b54be713736",  // USDT0
 *       amount: "1500000",     // 6 decimals
 *       payTo: "0x<receiving-wallet>",
 *       maxTimeoutSeconds: 300,
 *       extra: { name: "USD₮0", version: "1", decimals: 6 }
 *     }]
 *   }
 */
export function buildPaymentChallenge(resourceUrl: string, description: string) {
  return {
    x402Version: 2 as const,
    resource: {
      url: resourceUrl,
      description,
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: config.x402.network, // "eip155:196"
        asset: config.x402.asset, // USDT0 on X Layer
        amount: String(Math.round(config.x402.auditPrice * 1_000_000)), // 1.5 USDT0 = 1500000 base units
        payTo: config.x402.receivingWallet, // VEY1 receiving wallet
        maxTimeoutSeconds: 300,
        extra: {
          name: "USD₮0",
          version: "1",
          decimals: 6, // USDT0 has 6 decimals
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

/**
 * Build the canonical OKX x402 payment middleware adapted to Fastify.
 *
 * Uses the official @okxweb3/x402-express middleware wrapped in a Fastify
 * preHandler hook. The adapter translates between Fastify's req/reply and
 * the Express-style (req, res, next) signature the SDK expects.
 *
 * Requires env vars:
 *   OKX_FACILITATOR_API_KEY      — OKX Web3 facilitator API key (from dev portal)
 *   OKX_FACILITATOR_SECRET_KEY   — API secret
 *   OKX_FACILITATOR_PASSPHRASE   — API passphrase
 *
 * Without these, returns null. The server falls back to manually emitting
 * the proper 402 challenge (same shape as the SDK).
 */
export function buildX402Middleware(): ((req: any, reply: any) => Promise<any>) | null {
  if (!process.env.OKX_FACILITATOR_API_KEY || !process.env.OKX_FACILITATOR_SECRET_KEY || !process.env.OKX_FACILITATOR_PASSPHRASE) {
    console.warn("[x402] facilitator credentials not set — falling back to manual 402");
    return null;
  }
  try {
    const facilitator = new OKXFacilitatorClient({
      apiKey: process.env.OKX_FACILITATOR_API_KEY!,
      secretKey: process.env.OKX_FACILITATOR_SECRET_KEY!,
      passphrase: process.env.OKX_FACILITATOR_PASSPHRASE!,
      baseUrl: "https://web3.okx.com",
      syncSettle: true,
    });
    const routes = {
      "POST /v1/audit": {
        accepts: {
          scheme: "exact",
          price: `$${config.x402.auditPrice.toFixed(2)}`,
          network: config.x402.network as `${string}:${string}`,
          payTo: config.x402.receivingWallet,
          maxTimeoutSeconds: 300,
        },
        description: "VEY1 forensic project audit — returns a 12-18 page PDF",
        mimeType: "application/json",
      },
    };
    const expressMiddleware = paymentMiddlewareFromConfig(
      routes,
      facilitator,
      [{ network: config.x402.network as `${string}:${string}`, server: new ExactEvmScheme() }],
      { appName: "VEY1", testnet: false },
      undefined,
      false, // syncFacilitatorOnStart: false — never block boot
    );

    // Wrap the Express (req, res, next) middleware into a Fastify preHandler.
    return async (req: any, reply: any) => {
      // Build an Express-style res object from Fastify's reply
      let statusCode = 200;
      const res: any = {
        setHeader(name: string, value: any) {
          reply.header(name, value);
          return res;
        },
        writeHead(code: number, headers?: any) {
          statusCode = code;
          if (headers) {
            for (const [k, v] of Object.entries(headers)) {
              reply.header(k, v as any);
            }
          }
          return res;
        },
        write(_chunk: any) {
          return true;
        },
        end(chunk?: any) {
          reply.code(statusCode);
          if (chunk) reply.send(chunk);
          return res;
        },
        json(body: any) {
          reply.code(statusCode).send(body);
        },
        send(body: any) {
          reply.code(statusCode).send(body);
        },
        flushHeaders() {
          // no-op for Fastify
        },
      };

      // Express-style req: needs .path, .method, .headers, .header(name), .protocol
      const expressReq: any = {
        method: req.method,
        path: req.url.split("?")[0],
        originalUrl: req.url,
        url: `${req.protocol}://${req.headers.host}${req.url}`,
        protocol: req.protocol,
        headers: { ...req.headers },
        header(name: string) {
          const v = req.headers[name.toLowerCase()];
          return Array.isArray(v) ? v[0] : v;
        },
      };

      let nextCalled = false;
      const next = (err?: any) => {
        if (err) throw err;
        nextCalled = true;
      };

      try {
        await expressMiddleware(expressReq, res, next);
        // If middleware called next() (payment verified), continue
        if (nextCalled) {
          // continue — preHandler resolved, route handler runs
          return;
        }
        // If middleware set headers/body, the response was sent via res.json/send
        // Fastify's reply.send has been called; nothing more to do
      } catch (e) {
        console.error("[x402] middleware error:", e);
        throw e;
      }
    };
  } catch (e) {
    console.error("[x402] failed to build middleware:", e);
    return null;
  }
}
// Inline validator: the OKX SDK middleware (in the preHandler) now handles
// real signature verification. This stub is a fallback used when the SDK
// is not configured (no facilitator credentials).
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

export const _isPaymentHeaderValid = isPaymentHeaderValid;
