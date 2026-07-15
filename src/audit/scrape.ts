// src/audit/scrape.ts
// Lightweight web scraper — pulls team page, whitepaper, social links.
// We don't need to fully parse; we extract the key signal blocks.

import { request } from "undici";
import type { TeamMember } from "../types/index.js";

const TEAM_KEYWORDS = [
  "team",
  "about",
  "founders",
  "leadership",
  "people",
  "crew",
  "advisors",
];

const USELESS_HEADERS = ["script", "style", "noscript", "svg"];

export interface ScrapeResult {
  /** Raw text blobs from each scraped page */
  pages: { url: string; text: string }[];
  /** Candidate team member names found */
  candidateNames: string[];
  /** Twitter handles found */
  twitterHandles: string[];
  /** GitHub orgs/repos found */
  githubRefs: string[];
}

/** Find team/about page URLs by walking links on the homepage */
export async function findTeamPageUrls(homepage: string): Promise<string[]> {
  try {
    const res = await request(homepage, {
      method: "GET",
      headers: { "user-agent": "VEY1-Research-Bot/0.1" },
      headersTimeout: 8000,
      bodyTimeout: 8000,
    });
    if (res.statusCode >= 400) return [];
    const html = await res.body.text();
    const base = new URL(homepage);

    // Find <a href="..."> tags
    const linkRe = /<a[^>]+href=["']([^"']+)["']/gi;
    const matches = [...html.matchAll(linkRe)].map((m) => m[1]);
    const candidates: string[] = [];
    for (const href of matches) {
      try {
        const url = new URL(href, base);
        const path = url.pathname.toLowerCase();
        if (TEAM_KEYWORDS.some((kw) => path.includes(kw))) {
          candidates.push(url.toString());
        }
      } catch {
        // ignore
      }
    }
    // Dedupe + cap
    return Array.from(new Set(candidates)).slice(0, 5);
  } catch {
    return [];
  }
}

/** Strip HTML, drop script/style, normalize whitespace */
export function htmlToText(html: string): string {
  let text = html;
  for (const tag of USELESS_HEADERS) {
    text = text.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, "gi"), " ");
  }
  text = text.replace(/<[^>]+>/g, " ");
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

/** Pull text + candidate names from a URL */
export async function scrapePage(url: string): Promise<{ text: string; names: string[]; twitters: string[]; githubs: string[] }> {
  const empty = { text: "", names: [], twitters: [], githubs: [] };
  try {
    const res = await request(url, {
      method: "GET",
      headers: { "user-agent": "VEY1-Research-Bot/0.1" },
      headersTimeout: 8000,
      bodyTimeout: 8000,
    });
    if (res.statusCode >= 400) return empty;
    const html = await res.body.text();
    const text = htmlToText(html);

    const twitters = Array.from(
      new Set(
        [...html.matchAll(/twitter\.com\/([A-Za-z0-9_]{1,15})/gi)].map((m) => m[1]),
      ),
    );
    const githubs = Array.from(
      new Set(
        [...html.matchAll(/github\.com\/([A-Za-z0-9_-]+)/gi)].map((m) => m[1]),
      ),
    );

    // Heuristic: look for "Name — Role" or "Name: Role" patterns near team keywords
    const names: string[] = [];
    const nameRe = /([A-Z][a-z]{1,15}(?:\s[A-Z][a-z]{1,15}){0,2})\s*[\-—,:|]\s*([A-Z][a-zA-Z\s]{2,30}?)(?=[,.;\n]|$)/g;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = nameRe.exec(text)) !== null && guard++ < 50) {
      const name = m[1].trim();
      const role = m[2].trim();
      const lower = role.toLowerCase();
      if (
        name.length > 4 &&
        (lower.includes("founder") ||
          lower.includes("ceo") ||
          lower.includes("cto") ||
          lower.includes("coo") ||
          lower.includes("lead") ||
          lower.includes("advisor") ||
          lower.includes("head") ||
          lower.includes("developer") ||
          lower.includes("researcher"))
      ) {
        names.push(name);
      }
    }

    return { text, names, twitters, githubs };
  } catch {
    return empty;
  }
}

/** High-level: scrape the project site and return a list of candidate team members */
export async function scrapeProjectSite(
  homepage: string,
): Promise<{ pages: { url: string; text: string }[]; candidates: Partial<TeamMember>[]; twitters: string[]; githubs: string[] }> {
  const teamUrls = await findTeamPageUrls(homepage);
  const allUrls = Array.from(new Set([homepage, ...teamUrls])).slice(0, 4);

  const pages: { url: string; text: string }[] = [];
  const allTwitters = new Set<string>();
  const allGithubs = new Set<string>();
  const allNames = new Set<string>();

  for (const url of allUrls) {
    const r = await scrapePage(url);
    pages.push({ url, text: r.text });
    r.twitters.forEach((t) => allTwitters.add(t));
    r.githubs.forEach((g) => allGithubs.add(g));
    r.names.forEach((n) => allNames.add(n));
  }

  const candidates: Partial<TeamMember>[] = [...allNames].map((name) => ({
    name,
    role: "Unknown",
    identityConfidence: "PSEUDONYMOUS",
  }));

  return {
    pages,
    candidates,
    twitters: [...allTwitters],
    githubs: [...allGithubs],
  };
}
