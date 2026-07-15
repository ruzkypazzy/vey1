# VEY1

**Forensic crypto project due diligence, on demand.**

VEY1 takes a project name, Twitter handle, contract address, or URL — and produces a 12-18 page PDF report covering: project identity, on-chain wallet audit, team dossiers with personal wallet history, scam database cross-reference, risk scoring, comparable projects, and a final recommendation.

Built for the [OKX.AI Genesis Hackathon](https://web3.okx.com/xlayer/build-x-series). Submitted as an A2A Agent Service Provider on the OKX.AI marketplace.

## Why VEY1

Most "is this project legit?" tools stop at the smart contract. VEY1 goes further:

- **Team dossiers** — for each identified team member: identity verification, public social footprint, **personal wallet audit** (source of funds, scam DB cross-reference), past project associations.
- **Forensic PDF** — every claim is cited (tx hash, address, tweet URL). Not a number on a webpage, a 12-18 page report you can read on a flight.
- **A2A-native** — single input, agent does everything autonomously. No follow-up questions.

## Architecture

```
User → "audit Hyperliquid"
  ↓
Input resolver (name/handle/contract/URL → canonical identity)
  ↓
Web scraper (site, team page, social links)
  ↓
On-chain audit (project wallets + personal wallets via OnchainOS / ethers)
  ↓
LLM synthesis (gpt-4o-mini, adversarial due-diligence prompt)
  ↓
PDF generator (Puppeteer + branded template)
  ↓
Served via x402 v2 (USDT0 on X Layer, 1.5 USDT per audit)
```

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/` | Landing page |
| GET | `/ready` | Health check |
| GET | `/v1/info` | Service metadata, price, payment config |
| GET | `/v1/audit` | Returns x402 402 challenge with payment requirements |
| POST | `/v1/audit` | Run audit (requires `X-PAYMENT` header) |
| GET | `/reports/:filename` | Download generated PDF |

## Quick start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Edit .env: set OPENAI_API_KEY, X402_RECEIVING_WALLET, X402_AUDIT_PRICE

# 3. Dev
npm run dev

# 4. Demo audits (generates 3 PDFs)
npm run audit:demo

# 5. Deploy to Railway
railway up
```

## x402 payment

VEY1 is paywalled via x402 v2 on X Layer mainnet:

- Network: `eip155:196` (X Layer)
- Asset: USDT0 (`0x779ded0c9e1022225f8e0630b35a9b54be713736`)
- Price: 1.5 USDT0 per audit (configurable via `X402_AUDIT_PRICE`)
- Payment header: `X-PAYMENT: <base64 JSON of { signature, authorization }>`

Production should integrate with a Circle Gateway sidecar for signature verification. The MVP validates the header shape and trusts the payment header presence.

## Hackathon submission checklist

- [x] A2A ASP listing on OKX.AI (run `onchainos agent register` + `activate`)
- [x] Custom domain + live health endpoint
- [x] x402 paywall integrated
- [x] 3 demo reports (legit / mid / obvious rug)
- [x] 90-second X demo video
- [x] Google form submission
- [ ] Vote on 5+ other projects (required for prize eligibility)

## License

MIT
