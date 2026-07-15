// src/config/secrets.ts
// Environment configuration. Reads from process.env with safe fallbacks.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../..");

// Load .env if present (no dotenv dep — keep deps minimal)
const envPath = resolve(root, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

// Optional: base64-obfuscate OPENAI_API_KEY for public repos.
// If you commit a base64 blob instead of the raw key, decode it here.
function getOpenaiKey(): string {
  const raw = process.env.OPENAI_API_KEY ?? "";
  if (raw.startsWith("fe_oa_") || raw.startsWith("sk-")) return raw;
  // Treat as base64 of the real key (safe for public repos)
  try {
    return Buffer.from(raw, "base64").toString("utf8").trim();
  } catch {
    return raw;
  }
}

export const config = {
  env: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? "0.0.0.0",
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "http://localhost:8080",
  dataDir: process.env.DATA_DIR ?? "./data",
  outputDir: process.env.OUTPUT_DIR ?? "./data/outputs",
  openai: {
    apiKey: getOpenaiKey(),
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.freemodel.dev/v1",
    model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  },
  x402: {
    network: process.env.X402_NETWORK ?? "eip155:196",
    asset: process.env.X402_ASSET ?? "0x779ded0c9e1022225f8e0630b35a9b54be713736",
    receivingWallet: process.env.X402_RECEIVING_WALLET ?? "",
    auditPrice: Number(process.env.X402_AUDIT_PRICE ?? 1.5),
  },
  puppeteer: {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH ?? "/usr/bin/chromium",
  },
} as const;

export type Config = typeof config;
