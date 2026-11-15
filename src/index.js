// LUMEN SCREEN — zkVerify Agent Games
// Wildcard agent: CoinGecko-powered token research & risk screening
// Gatekeeper agent: proof-gatekeeper decision endpoint (phase 1, decision-only)
// One Worker, routes: /health / /screen /brief /gatekeeper
// No API keys. Free tiers only. Built by @stellarlumens29.

const VERSION = '1.0.0';

// ---------- chain map: slug -> { goplus chain id, coingecko platform, label } ----------
const CHAINS = {
  ethereum: { goplus: '1', cg: 'ethereum', label: 'Ethereum' },
  base: { goplus: '8453', cg: 'base', label: 'Base' },
  arbitrum: { goplus: '42161', cg: 'arbitrum-one', label: 'Arbitrum' },
  polygon: { goplus: '137', cg: 'polygon-pos', label: 'Polygon' },
  bsc: { goplus: '56', cg: 'binance-smart-chain', label: 'BNB Chain' },
  optimism: { goplus: '10', cg: 'optimistic-ethereum', label: 'Optimism' },
  avalanche: { goplus: '43114', cg: 'avalanche', label: 'Avalanche' },
  robinhood: { goplus: '4663', cg: 'robinhood-chain', label: 'Robinhood Chain' },
  solana: { goplus: 'solana', cg: 'solana', label: 'Solana' },
};

// ---------- small utils ----------
const enc = new TextEncoder();
function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return hex(d);
}
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      ...extraHeaders,
    },
  });
}
function corsHeaders() {
  return { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,x-agent-games-signature,x-signature' };
}

// 60s in-memory cache (per isolate) for upstream GETs — keeps CoinGecko free tier happy.
const cache = new Map(); // url -> { at, body }
async function cachedGet(url, ttlMs = 60000) {
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && now - hit.at < ttlMs) return { body: hit.body, cached: true, fetchedAt: new Date(hit.at).toISOString() };
  // CoinGecko free tier shares the egress IP quota — retry 429s with backoff.
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt === 1 ? 1000 : 3000));
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'lumen-screen/1.0 (+https://agentgames.zkverify.io)' },
      signal: AbortSignal.timeout(9000),
    });
    const text = await res.text();
    const fetchedAt = new Date().toISOString();
    if (res.status === 429) { lastErr = new Error(`upstream 429 on ${url}`); continue; }
    if (!res.ok) throw new Error(`upstream ${res.status} on ${url}`);
    cache.set(url, { at: now, body: text });
    return { body: text, cached: false, fetchedAt };
  }
  throw lastErr || new Error(`upstream failed on ${url}`);
}

// GoPlus returns HTTP 200 with {"code":4029,"message":"too many requests"} when its
// per-IP quota is hit (Cloudflare egress IPs are heavily shared) — and no result.
// Treat any non-1 code / missing result as failure, retry 4029 once after 2s.
async function fetchGoPlus(url) {
  for (let a = 0; a < 2; a++) {
    if (a > 0) await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'lumen-screen/1.0 (+https://agentgames.zkverify.io)' },
      signal: AbortSignal.timeout(9000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`upstream ${res.status} on ${url}`);
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('goplus non-JSON response'); }
    if (parsed.code === 4029) continue;
    if (parsed.code !== 1 || !parsed.result) throw new Error(`goplus: ${parsed.message || 'no result'}`);
    return { parsed, text, fetchedAt: new Date().toISOString() };
  }
  throw new Error('goplus rate-limited (4029) after retry');
}

// ---------- /screen ----------
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function handleScreen(body) {
  const chainSlug = String(body.chain || 'ethereum').toLowerCase();
  const contract = String(body.contract || '').trim();
  const chain = CHAINS[chainSlug];
  if (!chain) return json({ error: `unknown chain '${chainSlug}'`, supported: Object.keys(CHAINS) }, 400);
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract) && chainSlug !== 'solana')
    return json({ error: 'contract must be a 0x EVM address (40 hex chars)' }, 400);
  if (chainSlug === 'solana' && contract.length < 32)
    return json({ error: 'contract must be a Solana mint address' }, 400);

  const sources = [];
  const errors = [];
  let goplus = null, dex = null, cg = null;

  // GoPlus safety battery
  try {
    const { parsed, text, fetchedAt } = await fetchGoPlus(
      `https://api.gopluslabs.io/api/v1/token_security/${chain.goplus}?contract_addresses=${contract}`
    );
    const resMap = parsed.result || {};
    const key = Object.keys(resMap).find((k) => k.toLowerCase() === contract.toLowerCase());
    goplus = key ? resMap[key] : null;
    if (!goplus) throw new Error('goplus: token not in result');
    sources.push({ name: 'goplus', url: `https://api.gopluslabs.io/api/v1/token_security/${chain.goplus}`, fetched_at: fetchedAt, cached: false, sha256: await sha256Hex(text) });
  } catch (e) { errors.push(`goplus: ${e.message}`); }

  // DexScreener pair data
  try {
    const r = await cachedGet(`https://api.dexscreener.com/latest/dex/tokens/${contract}`);
    const parsed = JSON.parse(r.body);
    const pairs = (parsed.pairs || []).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    dex = pairs[0] || null;
    sources.push({ name: 'dexscreener', url: 'https://api.dexscreener.com/latest/dex/tokens', fetched_at: r.fetchedAt, cached: r.cached, sha256: await sha256Hex(r.body) });
  } catch (e) { errors.push(`dexscreener: ${e.message}`); }

  // CoinGecko market data (platform contract lookup; may 404 for new chains — graceful)
  if (chain.cg) {
    try {
      const r = await cachedGet(`https://api.coingecko.com/api/v3/coins/${chain.cg}/contract/${contract}`);
      cg = JSON.parse(r.body);
      sources.push({ name: 'coingecko', url: `https://api.coingecko.com/api/v3/coins/${chain.cg}/contract`, fetched_at: r.fetchedAt, cached: r.cached, sha256: await sha256Hex(r.body) });
    } catch (e) { errors.push(`coingecko: ${e.message}`); }
  }

  if (!goplus && !dex && !cg)
    return json({ error: 'all upstream sources failed', details: errors }, 502);

  // ---- checks -> weighted risk score ----
  const checks = [];
  const add = (id, label, status, weight, detail) => checks.push({ id, label, status, weight, detail });
  const is1 = (v) => v === '1' || v === 1 || v === true;

  if (goplus) {
    add('honeypot', 'Not a honeypot', is1(goplus.is_honeypot) ? 'FAIL' : 'PASS', 40, is1(goplus.is_honeypot) ? 'GoPlus flags honeypot' : 'GoPlus: not a honeypot');
    add('mintable', 'Supply not mintable', is1(goplus.is_mintable) ? 'FAIL' : 'PASS', 15, is1(goplus.is_mintable) ? 'owner can mint more' : 'no mint function');
    add('owner', 'Ownership renounced', goplus.owner_address ? 'FAIL' : 'PASS', 10, goplus.owner_address ? `owner ${goplus.owner_address}` : 'no owner');
    add('blacklist', 'No blacklist function', is1(goplus.is_blacklisted) ? 'FAIL' : 'PASS', 15, is1(goplus.is_blacklisted) ? 'blacklist present' : 'no blacklist');
    add('proxy', 'Not a proxy contract', is1(goplus.is_proxy) ? 'FAIL' : 'PASS', 5, is1(goplus.is_proxy) ? 'upgradeable proxy' : 'not a proxy');
    add('pausable', 'Transfers not pausable', is1(goplus.transfer_pausable) ? 'FAIL' : 'PASS', 5, is1(goplus.transfer_pausable) ? 'transfers can be paused' : 'not pausable');
    add('hidden_owner', 'No hidden owner', is1(goplus.hidden_owner) ? 'FAIL' : 'PASS', 10, is1(goplus.hidden_owner) ? 'hidden owner detected' : 'no hidden owner');
    add('selfdestruct', 'No selfdestruct', is1(goplus.selfdestruct) ? 'FAIL' : 'PASS', 20, is1(goplus.selfdestruct) ? 'selfdestruct present' : 'no selfdestruct');
    const buyTax = num(goplus.buy_tax), sellTax = num(goplus.sell_tax);
    add('buy_tax', 'Buy tax <= 10%', buyTax !== null && buyTax > 0.10 ? 'FAIL' : 'PASS', 5, buyTax === null ? 'tax unknown' : `buy tax ${(buyTax * 100).toFixed(1)}%`);
    add('sell_tax', 'Sell tax <= 10%', sellTax !== null && sellTax > 0.10 ? 'FAIL' : 'PASS', 10, sellTax === null ? 'tax unknown' : `sell tax ${(sellTax * 100).toFixed(1)}%`);
    // top wallet excluding pool/burn/lock contracts
    const wallets = (goplus.holders || []).filter((h) => !h.is_contract || h.is_locked === 1);
    const top = wallets.sort((a, b) => num(b.percent) - num(a.percent))[0];
    const topPct = top ? num(top.percent) * 100 : null;
    add('top_holder', 'Top wallet <= 10%', topPct !== null && topPct > 20 ? 'FAIL' : topPct !== null && topPct > 10 ? 'WARN' : 'PASS', topPct !== null && topPct > 20 ? 10 : topPct !== null && topPct > 10 ? 5 : 0, topPct === null ? 'holder data unavailable' : `top wallet ${topPct.toFixed(2)}%`);
    add('holders', 'Holder count', (goplus.holder_count || 0) >= 100 ? 'PASS' : 'WARN', 0, `${goplus.holder_count ?? 'unknown'} holders`);
  } else {
    add('goplus', 'GoPlus safety battery', 'UNKNOWN', 0, 'GoPlus unreachable — battery skipped, score is a lower bound');
  }

  if (dex) {
    const liq = num(dex.liquidity?.usd);
    add('liquidity', 'Liquidity >= $50k', liq !== null && liq < 10000 ? 'FAIL' : liq !== null && liq < 50000 ? 'WARN' : 'PASS', liq !== null && liq < 10000 ? 15 : liq !== null && liq < 50000 ? 8 : 0, liq === null ? 'liquidity unknown' : `liquidity $${liq.toLocaleString()}`);
    const ageMs = Date.now() - (dex.pairCreatedAt || 0);
    add('pair_age', 'Pair older than 24h', dex.pairCreatedAt && ageMs < 86400000 ? 'WARN' : 'PASS', dex.pairCreatedAt && ageMs < 86400000 ? 5 : 0, dex.pairCreatedAt ? `pair age ${(ageMs / 3600000).toFixed(1)}h` : 'pair age unknown');
    const chg24 = num(dex.priceChange?.h24);
    add('price_24h', 'No 24h crash', chg24 !== null && chg24 < -30 ? 'WARN' : 'PASS', chg24 !== null && chg24 < -30 ? 5 : 0, chg24 === null ? '24h change unknown' : `24h ${chg24.toFixed(2)}%`);
  } else {
    add('dexscreener', 'DexScreener pair data', 'UNKNOWN', 0, 'DexScreener unreachable — liquidity checks skipped');
  }

  let score = 0;
  for (const c of checks) if (c.status === 'FAIL' || c.status === 'WARN') score += c.weight;
  score = Math.min(100, score);
  const verdict = score <= 24 ? 'LOW' : score <= 49 ? 'MEDIUM' : score <= 74 ? 'HIGH' : 'CRITICAL';
  const fails = checks.filter((c) => c.status === 'FAIL').length;
  const warns = checks.filter((c) => c.status === 'WARN').length;

  const price = dex ? num(dex.priceUsd) : cg ? num(cg.market_data?.current_price?.usd) : null;
  const mcap = cg ? num(cg.market_data?.market_cap?.usd) : dex ? num(dex.marketCap) : null;
  const brief = [
    `${dex?.baseToken?.symbol || cg?.symbol?.toUpperCase() || contract.slice(0, 10)} on ${chain.label}:`,
    `risk ${verdict} (${score}/100), ${fails} failed checks, ${warns} warnings.`,
    price !== null ? `Price $${price}, ` : '',
    mcap !== null ? `mcap $${Math.round(mcap).toLocaleString()}, ` : '',
    dex?.liquidity?.usd ? `liquidity $${Math.round(dex.liquidity.usd).toLocaleString()}. ` : '',
    fails ? `Hard flags: ${checks.filter((c) => c.status === 'FAIL').map((c) => c.label).join('; ')}. ` : 'No hard safety flags. ',
    goplus && !is1(goplus.is_honeypot) && !goplus.owner_address ? 'Contract looks clean on GoPlus. ' : '',
    'Verify the sources below before buying — this screen is data, not advice.',
  ].join(' ');

  return json({
    service: 'lumen-screen', version: VERSION, chain: chainSlug, contract,
    risk_score: score, verdict, checks, brief,
    market: {
      price_usd: price,
      market_cap_usd: mcap,
      fdv_usd: cg ? num(cg.market_data?.fully_diluted_valuation?.usd) : dex ? num(dex.fdv) : null,
      volume_24h_usd: cg ? num(cg.market_data?.total_volume?.usd) : dex ? num(dex.volume?.h24) : null,
      change_24h_pct: cg ? num(cg.market_data?.price_change_percentage_24h) : dex ? num(dex.priceChange?.h24) : null,
      liquidity_usd: dex ? num(dex.liquidity?.usd) : null,
      pair: dex ? dex.pairAddress : null,
      holders: goplus ? goplus.holder_count : null,
    },
    sources, upstream_errors: errors,
    fetched_at: new Date().toISOString(),
  });
}

// ---------- /brief ----------
async function handleBrief(body) {
  const query = String(body.query || '').trim();
  if (!query) return json({ error: 'query is required, e.g. {"query":"bitcoin"} or {"query":"trending"}' }, 400);
  const sources = [];
  const errors = [];

  if (query.toLowerCase() === 'trending') {
    try {
      const r = await cachedGet('https://api.coingecko.com/api/v3/search/trending');
      const data = JSON.parse(r.body);
      sources.push({ name: 'coingecko', url: 'https://api.coingecko.com/api/v3/search/trending', fetched_at: r.fetchedAt, cached: r.cached, sha256: await sha256Hex(r.body) });
      const coins = (data.coins || []).slice(0, 7).map((c) => ({
        id: c.item.id, symbol: c.item.symbol, name: c.item.name,
        rank: c.item.market_cap_rank,
        price_btc: c.item.price_btc,
        score: c.item.score,
      }));
      return json({
        service: 'lumen-screen', version: VERSION, query: 'trending',
        brief: `Top trending on CoinGecko right now: ${coins.map((c) => `${c.name} (${c.symbol}, rank #${c.rank ?? 'n/a'})`).join(', ')}. Trending is attention, not quality — screen any of these with /screen before buying.`,
        trending: coins, sources, fetched_at: new Date().toISOString(),
      });
    } catch (e) { return json({ error: `coingecko trending failed: ${e.message}` }, 502); }
  }

  // Direct coin-id first (skips the search call for known ids), then search fallback.
  // If CoinGecko stays throttled, fall back to DexScreener pair data so the endpoint
  // still answers instead of erroring.
  let coinId = query.toLowerCase().replace(/\s+/g, '-');
  let coin = null;
  let coinErr = null;
  try {
    const r = await cachedGet(`https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&community_data=true&developer_data=true`);
    coin = JSON.parse(r.body);
    sources.push({ name: 'coingecko', url: `https://api.coingecko.com/api/v3/coins/${coinId}`, fetched_at: r.fetchedAt, cached: r.cached, sha256: await sha256Hex(r.body) });
  } catch (e) { coinErr = e; }
  if (!coin) {
    try {
      const r = await cachedGet(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`);
      const data = JSON.parse(r.body);
      sources.push({ name: 'coingecko', url: 'https://api.coingecko.com/api/v3/search', fetched_at: r.fetchedAt, cached: r.cached, sha256: await sha256Hex(r.body) });
      if (data.coins?.length && data.coins[0].id !== coinId) {
        coinId = data.coins[0].id;
        try {
          const r2 = await cachedGet(`https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&community_data=true&developer_data=true`);
          coin = JSON.parse(r2.body);
          sources.push({ name: 'coingecko', url: `https://api.coingecko.com/api/v3/coins/${coinId}`, fetched_at: r2.fetchedAt, cached: r2.cached, sha256: await sha256Hex(r2.body) });
        } catch (e2) { coinErr = e2; }
      }
    } catch (e) { errors.push(`search: ${e.message}`); }
  }
  if (!coin) {
    // DexScreener fallback (CoinGecko throttled or coin unknown there).
    try {
      const r = await cachedGet(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`);
      const data = JSON.parse(r.body);
      sources.push({ name: 'dexscreener', url: 'https://api.dexscreener.com/latest/dex/search', fetched_at: r.fetchedAt, cached: r.cached, sha256: await sha256Hex(r.body) });
      const pairs = (data.pairs || []).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)).slice(0, 5);
      if (!pairs.length) return json({ error: `no CoinGecko coin and no DexScreener pair found for '${query}'`, upstream_errors: errors, coingecko_error: String(coinErr?.message || coinErr) }, 404);
      const top = pairs[0];
      return json({
        service: 'lumen-screen', version: VERSION, query, fallback: 'dexscreener (coingecko throttled)',
        brief: `${top.baseToken?.name || query} (${top.baseToken?.symbol || ''}) on ${top.chainId}: price $${top.priceUsd}${top.priceChange?.h24 !== undefined ? `, 24h ${top.priceChange.h24}%` : ''}, liquidity $${Math.round(top.liquidity?.usd || 0).toLocaleString()}, top pair ${top.pairAddress}. CoinGecko was throttled (free tier shares the egress IP) — this brief is built from DexScreener pair data instead; re-check CoinGecko directly to verify.`,
        pairs: pairs.map((p) => ({ chain: p.chainId, dex: p.dexId, pair: p.pairAddress, symbol: `${p.baseToken?.symbol}/${p.quoteToken?.symbol}`, price_usd: p.priceUsd, change_24h_pct: p.priceChange?.h24, liquidity_usd: p.liquidity?.usd, volume_24h_usd: p.volume?.h24 })),
        sources, upstream_errors: errors,
        fetched_at: new Date().toISOString(),
      });
    } catch (e) { return json({ error: `coin '${coinId}' not found on CoinGecko: ${String(coinErr?.message || coinErr)}`, upstream_errors: errors }, 404); }
  }

  let chart = null;
  try {
    const r = await cachedGet(`https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=7`);
    chart = JSON.parse(r.body);
    sources.push({ name: 'coingecko', url: `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart`, fetched_at: r.fetchedAt, cached: r.cached, sha256: await sha256Hex(r.body) });
  } catch (e) { errors.push(`chart: ${e.message}`); }

  const md = coin.market_data || {};
  const prices = chart?.prices?.map((p) => p[1]) || [];
  const low7 = prices.length ? Math.min(...prices) : null;
  const high7 = prices.length ? Math.max(...prices) : null;
  const chg7 = md.price_change_percentage_7d_in_currency?.usd ?? null;
  const brief = [
    `${coin.name} (${(coin.symbol || '').toUpperCase()}), rank #${coin.market_cap_rank ?? 'n/a'}:`,
    md.current_price?.usd ? `price $${md.current_price.usd}, ` : '',
    chg7 !== null ? `7d ${chg7 >= 0 ? '+' : ''}${chg7.toFixed(2)}% (range $${low7?.toFixed(4)}–$${high7?.toFixed(4)}), ` : '',
    md.market_cap?.usd ? `mcap $${Math.round(md.market_cap.usd).toLocaleString()}, ` : '',
    md.total_volume?.usd ? `24h volume $${Math.round(md.total_volume.usd).toLocaleString()}. ` : '',
    (coin.categories || []).length ? `Categories: ${coin.categories.slice(0, 4).join(', ')}. ` : '',
    coin.links?.homepage?.[0] ? `Homepage: ${coin.links.homepage[0]} ` : '',
    'Sources below — re-fetch to verify.',
  ].join(' ');

  return json({
    service: 'lumen-screen', version: VERSION, query, coin_id: coinId,
    brief,
    market: {
      price_usd: md.current_price?.usd ?? null,
      change_24h_pct: md.price_change_percentage_24h ?? null,
      change_7d_pct: chg7,
      low_7d_usd: low7, high_7d_usd: high7,
      market_cap_usd: md.market_cap?.usd ?? null,
      volume_24h_usd: md.total_volume?.usd ?? null,
      ath_usd: md.ath?.usd ?? null, atl_usd: md.atl?.usd ?? null,
      rank: coin.market_cap_rank ?? null,
      categories: coin.categories || [],
      homepage: coin.links?.homepage?.filter(Boolean) || [],
    },
    sources, upstream_errors: errors,
    fetched_at: new Date().toISOString(),
  });
}

// ---------- /gatekeeper (phase 1: decision-only) ----------
// Seen-proof store: in-memory Set (fast path, per isolate) + Cloudflare KV
// (source of truth across isolates — a replay hitting a different isolate
// must still be caught). KV is eventually consistent; the in-memory set
// covers same-isolate replays instantly.
const seenProofs = new Set();
async function proofSeen(proofTx, env) {
  if (!proofTx) return false;
  if (seenProofs.has(proofTx)) return true;
  if (env.SEEN_PROOFS) {
    try {
      const v = await env.SEEN_PROOFS.get(`seen:${proofTx}`);
      if (v) { seenProofs.add(proofTx); return true; }
    } catch { /* KV read failure: fall through, fail closed below via other checks */ }
  }
  return false;
}
async function markProofSeen(proofTx, env) {
  if (!proofTx) return;
  seenProofs.add(proofTx);
  if (env.SEEN_PROOFS) {
    try { await env.SEEN_PROOFS.put(`seen:${proofTx}`, '1'); } catch { /* best effort */ }
  }
}
async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}
async function hmacVerify(secret, text, sigHex) {
  try {
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sig = new Uint8Array(sigHex.match(/../g).map((b) => parseInt(b, 16)));
    return await crypto.subtle.verify('HMAC', key, sig, enc.encode(text));
  } catch { return false; }
}

async function handleGatekeeper(request, env) {
  const raw = await request.text();
  const secret = env.AGENT_HMAC_SECRET || '';
  const headers = { ...corsHeaders() };
  let mode = 'unsigned-test';

  if (secret) {
    mode = 'hmac';
    const sig = request.headers.get('x-agent-games-signature') || request.headers.get('x-signature') || '';
    if (!sig || !(await hmacVerify(secret, raw, sig.replace(/^0x/, '')))) {
      return json({ error: 'invalid or missing HMAC signature' }, 401, headers);
    }
  } else {
    headers['x-gatekeeper-mode'] = 'unsigned-test';
  }

  let task;
  try { task = JSON.parse(raw); } catch { return json({ decision: 'REJECT', reason_code: 'INVALID_PAYLOAD', proof_tx: null }, 200, headers); }
  const input = task.input || task;
  const proofTx = input.proof_tx || task.proof_tx || null;

  const decide = (decision, reason_code) => ({ decision, reason_code, proof_tx: proofTx });

  // Fail closed on missing fields.
  const required = ['registered_vk', 'proof_vk', 'minimum', 'public_balance', 'expiry_block', 'current_block', 'recipient', 'condition_recipient', 'amount', 'max_transfer'];
  for (const f of required) {
    if (input[f] === undefined || input[f] === null) return respond(decide('REJECT', 'INVALID_PAYLOAD'));
  }

  let result;
  const reused = proofTx ? await proofSeen(proofTx, env) : false;
  if (String(input.proof_vk) !== String(input.registered_vk)) result = decide('REJECT', 'VK_SUBSTITUTION');
  else if (Number(input.public_balance) < Number(input.minimum)) result = decide('REJECT', 'THRESHOLD_MISMATCH');
  else if (reused) result = decide('REJECT', 'PROOF_REUSED');
  else if (Number(input.current_block) > Number(input.expiry_block)) result = decide('REJECT', 'EXPIRED_CONDITION');
  else if (String(input.recipient).toLowerCase() !== String(input.condition_recipient).toLowerCase()) result = decide('REJECT', 'RECIPIENT_MISMATCH');
  else if (Number(input.amount) > Number(input.max_transfer)) result = decide('REJECT', 'AMOUNT_OVERFLOW');
  else {
    result = decide('APPROVE', 'VALID');
    await markProofSeen(proofTx, env);
  }

  return respond(result);

  function respond(resultObj) {
    const body = JSON.stringify(resultObj);
    const h = { ...headers, 'content-type': 'application/json' };
    return new Response(body, { status: 200, headers: h });
  }
}

async function signResponse(response, env) {
  // Attach x-agent-games-signature over the raw response body when the secret is set.
  const secret = env.AGENT_HMAC_SECRET || '';
  if (!secret) return response;
  const body = await response.text();
  const sig = await hmacHex(secret, body);
  const headers = new Headers(response.headers);
  headers.set('x-agent-games-signature', sig);
  return new Response(body, { status: response.status, headers });
}

// ---------- demo page ----------
const DEMO_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LUMEN SCREEN — zkVerify Agent Games</title><style>body{font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.6;color:#111}code{background:#f1f1f1;padding:2px 6px;border-radius:4px}pre{background:#111;color:#0f0;padding:14px;border-radius:8px;overflow:auto}h1{font-size:28px}small{color:#666}</style></head><body>
<h1>LUMEN SCREEN</h1><p>CoinGecko-powered token research &amp; risk-screening agent — Wildcard entry for <b>zkVerify Agent Games</b> by <b>@stellarlumens29</b>.</p>
<p>One endpoint screens a token the way a careful researcher does by hand: CoinGecko market data + GoPlus safety battery + DexScreener pair data, into a 0–100 risk score with a PASS/FAIL check per rule, a one-paragraph brief, and sources with timestamps + SHA-256 of the raw payloads so anyone can re-fetch and reproduce the numbers.</p>
<h2>Try it</h2><pre>curl -s -X POST $ORIGIN/screen -H 'content-type: application/json' \\
  -d '{"chain":"robinhood","contract":"0x385b36Ff682Ab4C76E7c37A66b96aABC466471d5"}'</pre>
<pre>curl -s -X POST $ORIGIN/brief -H 'content-type: application/json' \\
  -d '{"query":"bitcoin"}'</pre>
<pre>curl -s $ORIGIN/health</pre>
<h2>Gatekeeper</h2><p><code>POST /gatekeeper</code> — proof-gatekeeper decisions (phase 1, decision-only). HMAC-verifies the raw body when <code>AGENT_HMAC_SECRET</code> is set, runs the 7 deterministic trap checks, signs the response with <code>x-agent-games-signature</code>. Decision in &lt;60s, fail closed.</p>
<h2>Endpoints</h2><ul><li><code>GET /health</code> — health check</li><li><code>POST /screen {chain, contract}</code> — token risk screen</li><li><code>POST /brief {query}</code> — research brief (or <code>{"query":"trending"}</code>)</li><li><code>POST /gatekeeper</code> — gatekeeper task</li></ul>
<p><small>Data: CoinGecko (free) · GoPlus (free) · DexScreener (free). This screen is data, not advice. Built for zkVerify Agent Games, 15 Nov 2026.</small></p>
</body></html>`;

// ---------- router ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
      if (path === '/health' && request.method === 'GET')
        return json({ ok: true, service: 'lumen-screen', version: VERSION, mode: env.AGENT_HMAC_SECRET ? 'hmac' : 'unsigned-test', time: new Date().toISOString() });
      if (path === '/' && request.method === 'GET')
        return new Response(DEMO_HTML.replaceAll('$ORIGIN', url.origin), { headers: { 'content-type': 'text/html', ...corsHeaders() } });
      if (path === '/screen' && request.method === 'POST')
        return await handleScreen(await request.json().catch(() => ({})));
      if (path === '/brief' && request.method === 'POST')
        return await handleBrief(await request.json().catch(() => ({})));
      if (path === '/gatekeeper' && request.method === 'GET')
        return json({ ok: true, service: 'gatekeeper', mode: env.AGENT_HMAC_SECRET ? 'hmac' : 'unsigned-test', phase: 'decision-only' });
      if (path === '/gatekeeper' && request.method === 'POST') {
        const res = await handleGatekeeper(request, env);
        return await signResponse(res, env);
      }
      return json({ error: 'not found', routes: ['GET /health', 'GET /', 'POST /screen', 'POST /brief', 'GET|POST /gatekeeper'] }, 404);
    } catch (e) {
      return json({ error: 'internal error', detail: String(e?.message || e) }, 500);
    }
  },
};
