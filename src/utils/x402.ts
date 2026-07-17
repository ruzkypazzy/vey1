// x402 payment layer for VEY1, using the OKX Payment SDK.
//
// Pattern matches the working aura-card-asp project:
//   1. Create an OKXFacilitatorClient with the user's API key.
//   2. Create a resourceServer and register the EIP-3009 exact scheme for
//      eip155:196 (X Layer).
//   3. Pre-populate the supported-kinds cache with the eip155:196 exact
//      kind — so the SDK can verify/settle without needing to call
//      `getSupported()` on the OKX facilitator (which is IP-blocked from
//      Railway's egress).
//   4. Configure routes with `price: { asset, amount, extra: { name, version, decimals } }`.
//   5. Use `syncFacilitatorOnStart: false` so the Express middleware does
//      NOT try to re-initialize on each request.
//   6. DON'T call payments.initialize() ourselves either — the cache is
//      already populated.
//
// Reference: https://web3.okx.com/onchainos/dev-docs/okxai/howtomcp

import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import {
  paymentMiddlewareFromHTTPServer,
  setSettlementOverrides,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@okxweb3/x402-express";
import type { RequestHandler, Response } from "express";
import { config } from "../config/secrets.js";

const NETWORK = (process.env.X402_NETWORK ?? "eip155:196") as `eip155:${string}`;
const USDT0_ADDRESS = process.env.X402_ASSET ?? "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const AGENT_NAME = "VEY1";

let resourceServer: x402ResourceServer | undefined;

export interface PaymentLayer {
  middleware: RequestHandler;
  /** No-op: cache is pre-populated, no facilitator call needed. */
  initialize: () => Promise<void>;
}

/**
 * Pre-populate the supportedResponsesMap with the eip155:196 / exact kind
 * so the SDK can serve 402 challenges and verify/settle payments without
 * ever calling `getSupported()` on the OKX facilitator.
 *
 * The OKX web3 facilitator is IP-whitelisted and blocks Cloudflare 1010
 * from Railway's egress IP, so `getSupported()` hangs. We hardcode the
 * known-supported kind here.
 *
 * The supportedResponsesMap structure is:
 *   supportedResponsesMap[x402Version][network][scheme] = SupportedResponse
 * IMPORTANT: the outer key MUST be the number 2 (matches the constant
 * x402Version in the SDK), not the string "2" — Map.get() is type-strict.
 */
function prePopulateSupportedKinds(rs: x402ResourceServer): void {
  const fakeSupportedResponse = {
    kinds: [
      {
        x402Version: 2,
        scheme: "exact",
        network: NETWORK,
        extra: { name: "USD\u20ae0", version: "1" },
      },
    ],
  };
  const networkMap = new Map<string, Map<string, unknown>>();
  const schemeMap = new Map<string, unknown>();
  schemeMap.set("exact", fakeSupportedResponse);
  networkMap.set(NETWORK, schemeMap);
  const versionMap = new Map<number, Map<string, Map<string, unknown>>>();
  versionMap.set(2, networkMap);
  (rs as unknown as { supportedResponsesMap: typeof versionMap }).supportedResponsesMap = versionMap;
  const facilitatorClient = (rs as unknown as { facilitatorClients: unknown[] }).facilitatorClients[0];
  (rs as unknown as { facilitatorClientsMap: Map<number, Map<string, Map<string, unknown>>> }).facilitatorClientsMap = new Map([
    [2, new Map([[NETWORK, new Map([["exact", facilitatorClient]])]])],
  ]);
}

/**
 * Build the x402 payment layer. Returns `null` if facilitator credentials
 * aren't configured (so the server can still run for local dev).
 */
export function buildPaymentLayer(): PaymentLayer | null {
  const apiKey = process.env.OKX_FACILITATOR_API_KEY;
  const secretKey = process.env.OKX_FACILITATOR_SECRET_KEY;
  const passphrase = process.env.OKX_FACILITATOR_PASSPHRASE;
  if (!apiKey || !secretKey || !passphrase) {
    console.warn("⚠️  Missing OKX_FACILITATOR_* env vars. x402 payments disabled.");
    return null;
  }
  const facilitator = new OKXFacilitatorClient({
    apiKey,
    secretKey,
    passphrase,
    baseUrl: process.env.OKX_FACILITATOR_BASE_URL ?? "https://web3.okx.com",
    // Wait for on-chain settlement confirmation. A forensic report is cheap to
    // produce but impossible to claw back, so we take the latency.
    syncSettle: true,
  });

  resourceServer = new x402ResourceServer(facilitator).register(
    NETWORK,
    new ExactEvmScheme(),
  );

  // Pre-populate the supported kinds so the SDK never needs to call
  // `getSupported()` on the IP-blocked OKX facilitator.
  prePopulateSupportedKinds(resourceServer);

  // Price as an explicit asset+amount (not a "$1.50" string) so the OKX
  // validator can resolve USDT0's decimals from the `extra.decimals` field.
  // name/version reproduce the EIP-712 domain the SDK injects for a string
  // price, so EIP-3009 signing is byte-for-byte unchanged — this only adds
  // decimals.
  const feeAtomic = String(Math.round(config.x402.auditPrice * 1_000_000));
  const accepts = {
    scheme: "exact" as const,
    network: NETWORK,
    payTo: config.x402.receivingWallet,
    price: {
      asset: USDT0_ADDRESS,
      amount: feeAtomic,
      extra: { name: "USD\u20ae0", version: "1", decimals: 6 },
    },
    maxTimeoutSeconds: 300,
  };

  const httpServer = new x402HTTPResourceServer(resourceServer, {
    "POST /v1/audit": {
      accepts,
      description: `${AGENT_NAME}: forensic crypto project audit (12-18 page PDF)`,
      mimeType: "application/json",
    },
    "GET /v1/audit": {
      accepts,
      description: `${AGENT_NAME}: forensic crypto project audit (12-18 page PDF)`,
      mimeType: "application/json",
    },
  });

  // syncFacilitatorOnStart: false → the Express middleware does NOT call
  // httpServer.initialize() on each request. We've already populated the
  // supported-kinds cache, so we don't need initialize() to do anything.
  const middleware = paymentMiddlewareFromHTTPServer(
    httpServer,
    {
      appName: AGENT_NAME,
      currentUrl: config.publicBaseUrl,
    },
    undefined,
    false, // ← critical
  );

  return {
    middleware,
    initialize: async () => {
      // No-op: the supported-kinds cache is already populated. We intentionally
      // skip httpServer.initialize() because it would call getSupported() on
      // the IP-blocked OKX facilitator and crash the server.
    },
  };
}

/**
 * Cancel settlement for this request — used when the audit failed after
 * payment was verified but before it settled. An amount of "0" short-circuits
 * the on-chain transfer so the caller is never charged for an audit they
 * didn't get.
 */
export function refundSettlement(res: Response): void {
  try {
    setSettlementOverrides(res, { amount: "0" });
  } catch {
    // Non-fatal: worst case the payment settles and we've served an error.
  }
}

/**
 * Backwards-compat shim. The SDK now handles the 402 challenge; this returns
 * null so legacy code that imported it still compiles.
 */
export function buildPaymentChallenge(_url: string, _desc: string): null {
  return null;
}

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
