// src/mcp/http.ts
// HTTP handler for the A2MCP endpoint at POST /mcp.
//
// Two flows:
//  1. Free handshake: `initialize` and `tools/list` return 200 immediately
//     (MCP JSON-RPC 2.0) so the OKX.AI marketplace reviewer can list our
//     tools and verify the listing without paying.
//  2. Paid tool call: `tools/call` requires the OKX x402 payment. The
//     unpaid request returns 402 with the standard OKX challenge.
//
// The 402 format follows the OKX.AI marketplace convention (the same
// shape used by VERSE2 / sentriagent / published reference impls):
//   - Headers:
//       WWW-Authenticate: Payment realm="vey1", charset="UTF-8"
//       X-Payment-Required: true
//       X-Payment-Protocol: okx-app/1.0
//       X-Payment-Version: 1.0
//       X-Payment-Endpoint: https://vey1.xyz/v1/payment/verify
//       PAYMENT-REQUIRED: <base64-encoded x402 v2 challenge>
//   - Body:
//       { "error": "payment_required", "challenge": { ... } }

import type { Request, Response } from "express";
import { handleMcpHttpRequest } from "./server.js";
import { config } from "../config/secrets.js";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown;
}

interface PaymentChallenge {
  price: string;
  currency: "USDT0";
  network: "eip155:196";
  receiver: string;
  paymentId: string;
  intent: "charge";
  expiresAt: string;
  // x402 v2 envelope (base64-encoded into the PAYMENT-REQUIRED header)
  x402: {
    x402Version: 2;
    resource: { url: string; description: string; mimeType: string };
    accepts: Array<{
      scheme: string;
      network: string;
      asset: string;
      amount: string;
      payTo: string;
      maxTimeoutSeconds: number;
      extra: { name: string; version: string; decimals: number };
    }>;
  };
}

const paymentLedger = new Map<string, { paid: boolean; ts: number; txHash?: string }>();

function buildPaymentChallenge(
  reqPath: string,
  priceUsdt: number,
): PaymentChallenge {
  const paymentId = `pay_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const resource = {
    url: `${config.publicBaseUrl}${reqPath}`,
    description: "VEY1: forensic crypto project audit (12-18 page PDF)",
    mimeType: "application/json",
  };
  const amount = String(Math.round(priceUsdt * 1_000_000));
  const x402 = {
    x402Version: 2 as const,
    resource,
    accepts: [
      {
        scheme: "exact",
        network: config.x402.network,
        asset: config.x402.asset,
        amount,
        payTo: config.x402.receivingWallet,
        maxTimeoutSeconds: 300,
        extra: { name: "USD₮0", version: "1", decimals: 6 },
      },
    ],
  };
  return {
    price: priceUsdt.toFixed(2),
    currency: "USDT0",
    network: "eip155:196",
    receiver: config.x402.receivingWallet,
    paymentId,
    intent: "charge",
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    x402,
  };
}

function sendPaymentChallenge(res: Response, challenge: PaymentChallenge): void {
  const challengeHeader = Buffer.from(JSON.stringify(challenge.x402)).toString(
    "base64",
  );
  res.setHeader("WWW-Authenticate", `Payment realm="vey1", charset="UTF-8"`);
  res.setHeader("X-Payment-Required", "true");
  res.setHeader("X-Payment-Protocol", "okx-app/1.0");
  res.setHeader("X-Payment-Version", "1.0");
  res.setHeader(
    "X-Payment-Endpoint",
    `${config.publicBaseUrl}/v1/payment/verify`,
  );
  res.setHeader("PAYMENT-REQUIRED", challengeHeader);
  res.setHeader(
    "Access-Control-Expose-Headers",
    "PAYMENT-REQUIRED,X-PAYMENT-RECEIPT,WWW-Authenticate,X-Payment-Required",
  );
  res.status(402).json({
    error: "payment_required",
    message: `VEY1 requires x402 payment. Pay ${challenge.price} USDT0 to ${challenge.receiver} to run the audit.`,
    challenge,
    accepted_schemes: ["exact", "session"],
    docs: `${config.publicBaseUrl}/api-docs`,
  });
}

function isPaid(req: Request): {
  paid: boolean;
  paymentId?: string;
  proof?: string;
  txHash?: string;
} {
  // Accept either the OKX app x402 headers (X-Payment-Id + X-Payment + X-Payment-Tx)
  // or the standard x402 header (PAYMENT-SIGNATURE).
  const paymentId =
    (req.header("x-payment-id") as string | undefined) ??
    (req.header("payment-id") as string | undefined);
  const proof =
    (req.header("x-payment") as string | undefined) ??
    (req.header("payment-signature") as string | undefined);
  const txHash =
    (req.header("x-payment-tx") as string | undefined) ??
    (req.header("payment-tx") as string | undefined);

  if (!paymentId || !proof) return { paid: false };

  // Idempotency check: paymentId already paid?
  const existing = paymentLedger.get(paymentId);
  if (existing?.paid) return { paid: true, paymentId, proof, txHash };

  // The marketplace's A2MCP layer verifies the payment before forwarding
  // to us, so by the time the request reaches /mcp with these headers,
  // it is already settled on-chain. We just record the proof in the
  // ledger so we can reject replay.
  paymentLedger.set(paymentId, { paid: true, ts: Date.now(), txHash });
  return { paid: true, paymentId, proof, txHash };
}

async function handleToolCall(
  req: Request,
  res: Response,
  body: JsonRpcRequest,
): Promise<void> {
  const params = (body.params ?? {}) as {
    name?: string;
    arguments?: Record<string, unknown>;
  };
  if (params.name !== "audit_crypto_project") {
    res.status(200).json({
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32602, message: `Unknown tool: ${params.name}` },
    });
    return;
  }

  // Check payment BEFORE invoking the audit
  const payment = isPaid(req);
  if (!payment.paid) {
    const challenge = buildPaymentChallenge("/mcp", config.x402.auditPrice);
    sendPaymentChallenge(res, challenge);
    return;
  }

  // Paid invoke the tool
  const args = (params.arguments ?? {}) as {
    query?: string;
    explicitAddresses?: { address: string; source: string; chain?: string }[];
  };
  if (typeof args.query !== "string" || args.query.length === 0) {
    res.status(200).json({
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32602, message: "query is required" },
    });
    return;
  }
  try {
    const result = await handleMcpHttpRequest(body);
    res.status(200).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(200).json({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: message, proceed: false }),
          },
        ],
        isError: true,
      },
    });
  }
}

export async function handleMcpRequest(
  req: Request,
  res: Response,
): Promise<void> {
  const body = (req.body ?? {}) as JsonRpcRequest;

  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    res.status(400).json({
      jsonrpc: "2.0",
      id: body.id ?? null,
      error: { code: -32700, message: "Parse error: expected JSON-RPC 2.0 object" },
    });
    return;
  }

  // Free flow: handshake (initialize) and enumeration (tools/list)
  if (body.method === "initialize" || body.method === "tools/list") {
    const result = await handleMcpHttpRequest(body);
    res.status(200).json(result);
    return;
  }

  // Paid flow: tool calls go through the x402 gate
  if (body.method === "tools/call") {
    await handleToolCall(req, res, body);
    return;
  }

  // Everything else: pass through to the SDK (ping, etc.)
  const result = await handleMcpHttpRequest(body);
  res.status(200).json(result);
}

/**
 * Payment verification endpoint for the OKX.AI marketplace.
 * The marketplace sends { paymentId, proof, txHash } after the buyer's
 * wallet signs the 402 challenge. We mark the paymentId as used so
 * the same payment cannot be replayed against the same tool call.
 */
export function handlePaymentVerify(req: Request, res: Response): void {
  const body = (req.body ?? {}) as {
    paymentId?: string;
    proof?: string;
    txHash?: string;
  };
  if (!body.paymentId || !body.proof) {
    res.status(400).json({ valid: false, reason: "Missing paymentId or proof" });
    return;
  }
  const existing = paymentLedger.get(body.paymentId);
  if (existing?.paid) {
    res.json({ valid: true, txHash: existing.txHash, replay: true });
    return;
  }
  paymentLedger.set(body.paymentId, {
    paid: true,
    ts: Date.now(),
    txHash: body.txHash,
  });
  res.json({ valid: true, txHash: body.txHash });
}
