// src/utils/undici.ts
// Centralized HTTP client.
// Uses Node 20+'s global fetch (which is undici under the hood) with a timeout.

const FETCH_TIMEOUT_MS = 20_000;

export async function safeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
