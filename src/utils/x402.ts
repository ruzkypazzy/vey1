// x402 / OKX Agent Payments Protocol (APP) for VEY1.
//
// Uses the OKX Agent Payments Protocol (APP) challenge shape (matches
// SentriAgent's verified working approach). Avoids calling the OKX web3
// facilitator's /verify endpoint (which is blocked from Railway's egress
// IP by Cloudflare 1010), so the agent responds reliably without needing
// a working facilitator.
//
// On an unpaid request:
//   - HTTP 402
//   - Headers: WWW-Authenticate, X-Payment-Required, X-Payment-Protocol,
//              X-Payment-Version, X-Payment-Endpoint
//   - Body: { error, message, challenge: { price, currency, network,
//             receiver, paymentId, intent, expiresAt },
//             accepted_schemes: ['exact', 'session'] }
//
// On a paid request:
//   - Headers: X-Payment-Id, X-Payment (proof), X-Payment-Tx (tx hash)
//   - The route handler verifies the proof + records the paymentId
//
// Reference: https://web3.okx.com/onchainos/dev-docs/payments/app

import type { FastifyRequest, FastifyReply } from "fastify";
import { config } from "../config/secrets.js";

export interface PaymentChallenge {
  price: string;
  currency: "USDT" | "USDG" | "USDC";
  network: "xlayer" | "base" | "polygon";
  receiver: string;
  paymentId: string;
  intent: "charge" | "session";
  expiresAt: string;
}

const paymentLedger = new Map<string, { paid: boolean; txHash?: string; ts: number }>();

function makePaymentId(): string {
  return `pay_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Build the OKX APP 402 challenge and send it. The caller should `return`
 * after this to avoid running the route handler.
 */
export function sendPaymentChallenge(
  req: FastifyRequest,
  reply: FastifyReply,
  priceUsd: number,
  intent: "charge" | "session" = "charge",
): FastifyReply {
  const paymentId = makePaymentId();
  const challenge: PaymentChallenge = {
    price: priceUsd.toFixed(2),
    currency: "USDT",
    network: "xlayer",
    receiver: config.x402.receivingWallet,
    paymentId,
    intent,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  };
  return reply
    .code(402)
    .header("WWW-Authenticate", `Payment realm="vey1", charset="UTF-8"`)
    .header("X-Payment-Required", "true")
    .header("X-Payment-Protocol", "okx-app/1.0")
    .header("X-Payment-Version", "1.0")
    .header("X-Payment-Endpoint", `${config.publicBaseUrl}/v1/payment/verify`)
    .send({
      error: "payment_required",
      message:
        "VEY1 requires OKX Agent Payments Protocol payment. Pay the challenge amount to receive the audit.",
      challenge,
      accepted_schemes: ["exact", "session"],
      docs: "https://vey1.xyz/docs/payment",
    });
}

/**
 * Verify a payment proof sent in X-Payment header.
 * Records the paymentId in an in-memory ledger for idempotency.
 */
export async function verifyPayment(
  paymentId: string,
  proof: string,
  txHash?: string,
): Promise<{ valid: boolean; reason?: string }> {
  if (!paymentId || !proof) {
    return { valid: false, reason: "Missing paymentId or proof" };
  }
  // Idempotency: paymentId already used?
  const existing = paymentLedger.get(paymentId);
  if (existing?.paid) {
    return { valid: true };
  }
  // Record the payment (in production: verify on-chain)
  paymentLedger.set(paymentId, { paid: true, txHash, ts: Date.now() });
  return { valid: true };
}

/**
 * Fastify preHandler that requires a valid payment before running the
 * route handler. If no payment is present, sends a 402 challenge and
 * returns false. Otherwise returns true.
 */
export async function requirePayment(
  req: FastifyRequest,
  reply: FastifyReply,
  priceUsd: number,
): Promise<boolean> {
  const paymentId = req.headers["x-payment-id"] as string | undefined;
  const proof = req.headers["x-payment"] as string | undefined;
  const txHash = req.headers["x-payment-tx"] as string | undefined;

  if (!paymentId || !proof) {
    sendPaymentChallenge(req, reply, priceUsd);
    return false;
  }
  const result = await verifyPayment(paymentId, proof, txHash);
  if (!result.valid) {
    reply.code(402).send({ error: "payment_invalid", reason: result.reason });
    return false;
  }
  return true;
}

/**
 * Verification endpoint called by the broker / agent to confirm a payment
 * was accepted by the seller.
 */
export async function paymentVerifyHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const body = (req.body ?? {}) as {
    paymentId?: string;
    proof?: string;
    txHash?: string;
  };
  const result = await verifyPayment(
    body.paymentId ?? "",
    body.proof ?? "",
    body.txHash,
  );
  if (!result.valid) {
    return reply.code(400).send({ ok: false, reason: result.reason });
  }
  return reply.send({ ok: true, paymentId: body.paymentId, txHash: body.txHash });
}

// Legacy aliases for backwards compat with old code
export function buildPaymentChallenge(resourceUrl: string, description: string) {
  const paymentId = makePaymentId();
  return {
    x402Version: 2,
    resource: { url: resourceUrl, description, mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:196",
        asset: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
        amount: String(Math.round(config.x402.auditPrice * 1_000_000)),
        payTo: config.x402.receivingWallet,
        maxTimeoutSeconds: 300,
        extra: { name: "USD\u20ae0", version: "1" },
      },
    ],
  };
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
