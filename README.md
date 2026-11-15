# LUMEN SCREEN — zkVerify Agent Games

CoinGecko-powered token research & risk-screening agent (Wildcard) + proof-gatekeeper
decision endpoint (arena), in one Cloudflare Worker. Built by @stellarlumens29.
No API keys. Free tiers only.

## Live

- **Worker:** https://lumen-screen.shocking-axolotl.workers.dev
- **KV namespace:** SEEN_PROOFS, id `bdef612af92e42028a22297e27284a5d` (same temp account)

## Endpoints

| Route | What it does |
|---|---|
| `GET /health` | health check, incl. `mode` (hmac / unsigned-test) |
| `GET /` | live demo page with curl examples |
| `POST /screen {chain, contract}` | CoinGecko market + GoPlus safety battery + DexScreener pairs → risk score 0–100, PASS/FAIL per check, brief, sources with timestamps + SHA-256 of raw payloads |
| `POST /brief {query}` | research brief from CoinGecko (or `"trending"`) + 7d chart; DexScreener fallback when CoinGecko is throttled |
| `GET /gatekeeper` | gatekeeper health |
| `POST /gatekeeper` | 7 deterministic trap checks → `{decision, reason_code, proof_tx}`; HMAC-verifies raw body when `AGENT_HMAC_SECRET` is set, signs responses with `x-agent-games-signature` |

Chains for /screen: ethereum, base, arbitrum, polygon, bsc, optimism, avalanche, robinhood (4663), solana.

## Verified live (15 Nov 02:34–02:41 UTC)

- /health, demo page: OK.
- /screen POOLS (robinhood): score 0 LOW, price $0.0001969, mcap $196,918, liquidity $78,474, 24h +12.53% — live DexScreener data.
- /brief trending: OK via CoinGecko (BTC #1, SOL #7, ETH #2, NEAR, HYPE, PUMP, LIT).
- /brief bitcoin: CoinGecko /coins/* 429 → DexScreener fallback answered (BTC $63,662).
- /gatekeeper: all 7 traps + VALID + INVALID_PAYLOAD verified; PROOF_REUSED verified KV-backed across requests.
- HMAC mode verified locally (`wrangler dev` + test secret): correct sig → 200 APPROVE + response signature header; wrong/no sig → 401.

## Known limits (honest)

- **CoinGecko /coins/* 429s from Worker egress** — the free tier shares the egress IP quota, so /coins/* is often throttled. Mitigations in place: 60s cache, retry with backoff, DexScreener fallback for /brief and /screen market data. /search/trending still works directly.
- **GoPlus 4029 from Worker egress** — same shared-IP issue; the Worker retries once, then marks the battery UNKNOWN and says the score is a lower bound. From this VM GoPlus works fine (honeypot 0, mintable 0, owner none, 6,885 holders for POOLS).
- **Gatekeeper phase 1 = decision-only** — no Groth16 proving in the Worker (zkey too large, no fs). Circuits are downloaded in `circuits/` (gatekeeper.wasm 1,755,820 B, gatekeeper_final.zkey 309,750 B, vfy-policy pair too) + snarkjs 0.7.6 installed for phase 2. vkHash from circuit-info matches the design (0x6b79c6…d77b0); independent keccak256 reproduction of the vkey hash did NOT match in the forms tried — provenance is the platform's own circuit-info endpoint, not the hash.
- **HMAC secret not yet set on the live Worker** — it runs in `unsigned-test` mode until the real platform secret is stored via `wrangler secret put AGENT_HMAC_SECRET` (after agent registration + the gist capture flow).

## Deploy

```sh
cd ~/workspace/zkverify/worker
npx wrangler deploy --temporary   # temp account, claim URL printed
# after claim:
npx wrangler deploy
npx wrangler secret put AGENT_HMAC_SECRET
```

## Files

- `src/index.js` — the whole Worker (no dependencies).
- `wrangler.toml` — name lumen-screen + SEEN_PROOFS KV binding.
- `circuits/` — gatekeeper + vfy-policy wasm/zkey, circuit-info.json.
- `package.json` — snarkjs 0.7.6 (phase-2 tooling only, not bundled).
