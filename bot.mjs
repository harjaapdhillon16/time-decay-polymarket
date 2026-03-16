// ═══════════════════════════════════════════════════════════════════════════════
//  Polymarket Multi-Asset 5-Minute Up/Down Bot  —  Single-file Edition
//  Node.js ≥ 18 required  |  ES Modules ("type":"module" in package.json)
// ═══════════════════════════════════════════════════════════════════════════════
//
//  STRATEGY
//  ─────────
//  • Monitors BTC, XRP, and SOL "Up/Down 5-minute" markets on Polymarket
//  • Priority order: BTC → XRP → SOL  (first qualifying asset wins)
//  • Only ONE bet is placed per 5-minute window across all assets
//
//  Every POLL_INTERVAL_MS milliseconds:
//    1. Calculates current 5-min interval + seconds-to-expiry
//    2. Ignores polls until < EXPIRY_THRESHOLD_SECS (90s) remain
//    3. Scans BTC first, then XRP, then SOL:
//         – Fetches token IDs (Gamma API, cached per slug)
//         – Resolves live UP/DOWN prices via WebSocket (REST fallback)
//         – If PROB_MIN < price < PROB_MAX (80–90%): signal found → bet placed
//         – Once a signal is found, remaining assets are NOT checked
//    4. Schedules a P&L snapshot exactly 1 second before market expiry
//  • Never bets twice on the same 5-minute window
//
//  POSITION CLOSE (T – 5 s)
//  ────────────────────────
//  • Sells the position BEFORE market expiry while the orderbook is active
//  • Uses aggressive pricing (best bid or slightly below) for fast fill
//  • Retries once at T – 3 s if the first attempt fails
//  • If all sell attempts fail, Polymarket auto-redeems winning positions
//
//  P&L SNAPSHOT (T – 1 s)
//  ──────────────────────
//  • Reads the current mid-price from the WS cache (or REST fallback)
//  • Calculates: unrealised P&L = (currentPrice – fillPrice) × shares
//  • Estimates outcome:
//      – If current price ≥ 0.90  →  likely WIN   (+$payout − cost)
//      – If current price ≤ 0.10  →  likely LOSS  (−$cost)
//      – Otherwise               →  uncertain
//  • Prints a clear P&L card to the console
//
// ═══════════════════════════════════════════════════════════════════════════════

import 'dotenv/config';
import { ClobClient, Side, OrderType, AssetType } from '@polymarket/clob-client';
import { Wallet }    from 'ethers';
import axios         from 'axios';
import chalk         from 'chalk';
import { WebSocket } from 'ws';
import { EventEmitter } from 'events';

// ──────────────────────────────────────────────────────────────────────────────
//  SECTION 1 — CONFIGURATION
// ──────────────────────────────────────────────────────────────────────────────

function _envFloat(key, def) {
  const v = process.env[key]; if (!v) return def;
  const n = parseFloat(v);    if (isNaN(n)) throw new Error(`${key} must be a number`);
  return n;
}
function _envInt(key, def) {
  const v = process.env[key]; if (!v) return def;
  const n = parseInt(v, 10);  if (isNaN(n)) throw new Error(`${key} must be an integer`);
  return n;
}

const CFG = {
  privateKey:          process.env.PRIVATE_KEY    || null,
  funderAddress:       process.env.FUNDER_ADDRESS || null,
  // signatureType:
  //   0 = Plain MetaMask / EOA wallet (PRIVATE_KEY is the wallet key directly)
  //   1 = Google / email / Magic Link account (PRIVATE_KEY = Magic EOA key,
  //       FUNDER_ADDRESS = your Polymarket proxy/profile address)
  //   2 = Gnosis Safe proxy wallet
  signatureType:       _envInt('SIGNATURE_TYPE',           0),

  // Optional: paste pre-generated CLOB credentials here to skip derivation.
  // Run `node get-creds.js` once to generate them, then set in .env.
  // This is required for Magic/Google accounts if auto-derivation fails.
  clobApiKey:          process.env.CLOB_API_KEY    || null,
  clobSecret:          process.env.CLOB_SECRET     || null,
  clobPassphrase:      process.env.CLOB_PASSPHRASE || null,

  betSizeUsdc:         _envFloat('BET_SIZE_USDC',         5),
  probMin:             _envFloat('PROB_MIN',               0.80),
  probMax:             _envFloat('PROB_MAX',               0.90),
  expiryThresholdSecs: _envInt('EXPIRY_THRESHOLD_SECS',    90),
  pollIntervalMs:      _envInt('POLL_INTERVAL_MS',         5_000),
  dryRun:              (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false',
  gammaApiUrl:         process.env.GAMMA_API_URL  || 'https://gamma-api.polymarket.com',
  clobApiUrl:          process.env.CLOB_API_URL   || 'https://clob.polymarket.com',
  chainId:             _envInt('CHAIN_ID',                 137),

  // Seconds before expiry to attempt the sell close.
  // Must be > 0 (orderbook shuts down at T=0). Default 5s gives a safe margin.
  sellBeforeExpirySecs: _envInt('SELL_BEFORE_EXPIRY_SECS', 3),

  // Assets scanned in priority order — first match wins each interval.
  // Slug prefixes must match Polymarket's naming: btc-updown-5m-*, xrp-updown-5m-*, sol-updown-5m-*
  assets: [
    { id: 'btc', label: 'BTC', slugPrefix: 'btc-updown-5m', emoji: '₿' },
    { id: 'xrp', label: 'XRP', slugPrefix: 'xrp-updown-5m', emoji: '✕' },
    { id: 'sol', label: 'SOL', slugPrefix: 'sol-updown-5m', emoji: '◎' },
  ],
};

if (CFG.probMin >= CFG.probMax)
  throw new Error(`PROB_MIN (${CFG.probMin}) must be < PROB_MAX (${CFG.probMax})`);

// ──────────────────────────────────────────────────────────────────────────────
//  SECTION 2 — LOGGER
// ──────────────────────────────────────────────────────────────────────────────

const ts   = () => chalk.gray(new Date().toISOString());
const log  = {
  info:    (...a) => console.log(ts(), chalk.cyan('[INFO]'),         ...a),
  ok:      (...a) => console.log(ts(), chalk.green('[OK]'),          ...a),
  warn:    (...a) => console.log(ts(), chalk.yellow('[WARN]'),        ...a),
  error:   (...a) => console.error(ts(), chalk.red('[ERROR]'),       ...a),
  trade:   (...a) => console.log(ts(), chalk.magentaBright('[TRADE]'),...a),
  scan:    (...a) => console.log(ts(), chalk.blue('[SCAN]'),         ...a),
  pnl:     (...a) => console.log(ts(), chalk.bgGreen.black('[P&L]'), ...a),
  dry:     (...a) => console.log(ts(), chalk.bgYellow.black('[DRY]'),...a),
  divider: ()     => console.log(chalk.gray('─'.repeat(72))),
};
const pct = (v) => v != null ? `${(v * 100).toFixed(2)}%` : 'n/a';

// ──────────────────────────────────────────────────────────────────────────────
//  SECTION 3 — MARKET TIMING
// ──────────────────────────────────────────────────────────────────────────────

const INTERVAL_SECS = 300; // 5 minutes

/** Unix seconds of the START of the current 5-min interval. */
function intervalStart() {
  const now = Math.floor(Date.now() / 1000);
  return now - (now % INTERVAL_SECS);
}

/** Unix seconds of the END (expiry) of the current 5-min interval. */
function intervalEnd() { return intervalStart() + INTERVAL_SECS; }

/** Seconds remaining until the current 5-min interval expires. */
function secsToExpiry() { return intervalEnd() - Math.floor(Date.now() / 1000); }

/**
 * Builds the Polymarket event slug for a given asset and the current interval.
 * e.g. buildSlug('btc-updown-5m') → 'btc-updown-5m-1742120400'
 */
function buildSlug(slugPrefix) { return `${slugPrefix}-${intervalStart()}`; }

/**
 * A unique key representing the current 5-min interval window.
 * Used to ensure we place at most ONE bet across ALL assets per window.
 */
function currentIntervalKey() { return `interval-${intervalStart()}`; }

// ──────────────────────────────────────────────────────────────────────────────
//  SECTION 4 — GAMMA API  (market discovery)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Fetches 5-min market metadata for a given slug (any asset).
 * Returns null when the market isn't indexed yet (Gamma can lag ~10–20 s).
 *
 * Shape returned:
 * {
 *   slug, endTimestamp,
 *   upTokenId, downTokenId, question,
 *   conditionId   ← needed for GET /data/trades filter
 * }
 */
async function fetchMarketMeta(slug) {
  try {
    const { data } = await axios.get(`${CFG.gammaApiUrl}/events`, {
      params: { slug }, timeout: 8_000,
    });
    if (!Array.isArray(data) || !data.length) return null;

    const event   = data[0];
    const market  = event.markets?.[0];
    if (!market) return null;

    const tokenIds = (() => {
      try { return JSON.parse(market.clobTokenIds); }
      catch { return market.clobTokenIds || []; }
    })();

    const outcomes = (() => {
      try { return JSON.parse(market.outcomes); }
      catch { return market.outcomes || []; }
    })();

    const upIdx   = outcomes.findIndex(o => /up/i.test(o));
    const downIdx = outcomes.findIndex(o => /down/i.test(o));

    const endTimestamp = event.endDate
      ? Math.floor(new Date(event.endDate).getTime() / 1000)
      : intervalEnd();

    return {
      slug,
      endTimestamp,
      question:    market.question || '',
      conditionId: market.conditionId || market.condition_id || '',
      upTokenId:   upIdx   >= 0 ? tokenIds[upIdx]   : tokenIds[0],
      downTokenId: downIdx >= 0 ? tokenIds[downIdx] : tokenIds[1],
    };
  } catch (err) {
    log.error(`Gamma API error: ${err.message}`);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//  SECTION 5 — CLOB REST  (price fallback)
// ──────────────────────────────────────────────────────────────────────────────

async function restMidpoint(tokenId) {
  if (!tokenId) return null;
  try {
    const { data } = await axios.get(`${CFG.clobApiUrl}/midpoint`,
      { params: { token_id: tokenId }, timeout: 6_000 });
    if (data?.mid != null) return parseFloat(data.mid);
  } catch { /* fall through */ }
  try {
    const { data } = await axios.get(`${CFG.clobApiUrl}/price`,
      { params: { token_id: tokenId, side: 'BUY' }, timeout: 6_000 });
    if (data?.price != null) return parseFloat(data.price);
  } catch (err) {
    log.warn(`REST price fetch failed for ${tokenId.slice(0,10)}…: ${err.message}`);
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
//  SECTION 6 — WEBSOCKET MONITOR  (real-time prices)
// ──────────────────────────────────────────────────────────────────────────────

const WS_URL      = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const WS_HB_MS    = 20_000;
const WS_RETRY_MS = 3_000;

class WsMonitor extends EventEmitter {
  constructor() {
    super();
    this._prices    = new Map();   // tokenId → mid-price (0–1)
    this._bestBid   = new Map();
    this._bestAsk   = new Map();
    this._subscribed = new Set();
    this._ws        = null;
    this._alive     = false;
    this._hbTimer   = null;
    this._retryTimer = null;
  }

  subscribe(tokenIds) {
    tokenIds.forEach(id => this._subscribed.add(id));
    if (!this._ws || this._ws.readyState > WebSocket.OPEN) {
      this._connect();
    } else if (this._ws.readyState === WebSocket.OPEN) {
      this._send(tokenIds);
    }
  }

  getPrice(id)   { return this._prices.get(id)  ?? null; }
  getBestBid(id) { return this._bestBid.get(id) ?? null; }
  getBestAsk(id) { return this._bestAsk.get(id) ?? null; }
  get connected(){ return this._ws?.readyState === WebSocket.OPEN; }

  close() {
    this._alive = false;
    clearInterval(this._hbTimer);
    clearTimeout(this._retryTimer);
    this._ws?.terminate();
    this._ws = null;
  }

  _connect() {
    if (this._ws && this._ws.readyState <= WebSocket.OPEN) return;
    this._alive = true;
    log.info('WS → connecting…');
    this._ws = new WebSocket(WS_URL);

    this._ws.on('open', () => {
      log.ok('WS connected to Polymarket CLOB.');
      this._startHb();
      if (this._subscribed.size) this._send([...this._subscribed]);
    });

    this._ws.on('message', raw => {
      try {
        const msgs = JSON.parse(raw.toString());
        (Array.isArray(msgs) ? msgs : [msgs]).forEach(m => this._handle(m));
      } catch { /* ignore malformed */ }
    });

    this._ws.on('close', code => {
      log.warn(`WS closed (${code})`);
      this._stopHb();
      if (this._alive) this._scheduleRetry();
    });

    this._ws.on('error', err => log.error(`WS error: ${err.message}`));
  }

  _send(ids) {
    if (!ids.length) return;
    this._ws.send(JSON.stringify({ type: 'market', assets_ids: ids }));
    log.info(`WS subscribed: ${ids.length} token(s)`);
  }

  _handle({ event_type, asset_id, price, bids, asks }) {
    switch (event_type) {
      case 'price_change':
      case 'last_trade_price': {
        const p = parseFloat(price);
        if (asset_id && !isNaN(p)) {
          this._prices.set(asset_id, p);
          this.emit('price', { id: asset_id, price: p });
        }
        break;
      }
      case 'book': {
        if (!asset_id) break;
        const bid = bids?.length  ? parseFloat(bids[bids.length - 1].price) : null;
        const ask = asks?.length  ? parseFloat(asks[0].price)               : null;
        if (bid != null) this._bestBid.set(asset_id, bid);
        if (ask != null) this._bestAsk.set(asset_id, ask);
        const mid = bid != null && ask != null ? (bid + ask) / 2 : (ask ?? bid);
        if (mid != null) {
          this._prices.set(asset_id, mid);
          this.emit('price', { id: asset_id, price: mid });
        }
        break;
      }
      default: break;
    }
  }

  _startHb() {
    this._stopHb();
    this._hbTimer = setInterval(() => {
      if (this._ws?.readyState === WebSocket.OPEN)
        this._ws.send(JSON.stringify({ type: 'ping' }));
    }, WS_HB_MS);
  }
  _stopHb() { clearInterval(this._hbTimer); this._hbTimer = null; }

  _scheduleRetry() {
    if (this._retryTimer) return;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._ws = null;
      this._connect();
    }, WS_RETRY_MS);
  }
}

const wsMonitor = new WsMonitor();

/** Resolve price: WS first, REST fallback. */
async function livePrice(tokenId) {
  const ws = wsMonitor.getPrice(tokenId);
  if (ws != null) return ws;
  return restMidpoint(tokenId);
}

// ──────────────────────────────────────────────────────────────────────────────
//  SECTION 7 — TRADER  (CLOB client + order placement)
// ──────────────────────────────────────────────────────────────────────────────

let _clobClient = null;
let _traderReady = false;

/**
 * Initialises the authenticated ClobClient.
 *
 * API credential resolution order:
 *  1. If CLOB_API_KEY + CLOB_SECRET + CLOB_PASSPHRASE are all set in .env
 *     → use them directly (most reliable, recommended for Magic/Google accounts)
 *  2. Otherwise → derive credentials on-the-fly from the wallet private key.
 *     For signatureType=1 (Magic/Google), the derivation client must include
 *     signatureType and funderAddress — per the official Polymarket Python SDK.
 */
async function initTrader() {
  if (_traderReady) return _clobClient;

  const signer = new Wallet(CFG.privateKey);

  let creds;

  // ── Path A: credentials supplied directly in .env ─────────────────────────
  if (CFG.clobApiKey && CFG.clobSecret && CFG.clobPassphrase) {
    log.ok('Using API credentials from .env (CLOB_API_KEY / CLOB_SECRET / CLOB_PASSPHRASE)');
    creds = {
      apiKey:     CFG.clobApiKey,
      secret:     CFG.clobSecret,
      passphrase: CFG.clobPassphrase,
    };

  // ── Path B: derive credentials from wallet signature ──────────────────────
  } else {
    log.info('Deriving API credentials from wallet signature…');
    log.info('(Tip: paste CLOB_API_KEY / CLOB_SECRET / CLOB_PASSPHRASE into .env to skip this step)');

    const derivationClient = CFG.signatureType === 0
      ? new ClobClient(CFG.clobApiUrl, CFG.chainId, signer)
      : new ClobClient(
          CFG.clobApiUrl,
          CFG.chainId,
          signer,
          undefined,           // no creds yet
          CFG.signatureType,   // 1 = Magic/Google, 2 = Gnosis Safe
          CFG.funderAddress,   // proxy wallet address
        );

    try {
      creds = await derivationClient.deriveApiKey();
      if (creds?.error || !creds?.apiKey) throw new Error(creds?.error || 'empty');
      log.ok('API key derived successfully.');
    } catch (deriveErr) {
      log.warn(`deriveApiKey failed (${deriveErr.message}) — trying createApiKey…`);
      try {
        creds = await derivationClient.createApiKey();
        if (creds?.error || !creds?.apiKey) {
          throw new Error(creds?.error || 'empty response from createApiKey');
        }
        log.ok('API key created successfully.');
      } catch (createErr) {
        throw new Error(
          `Could not derive or create API key.\n` +
          `  deriveApiKey error : ${deriveErr.message}\n` +
          `  createApiKey error : ${createErr.message}\n\n` +
          `  ► Fix: run the helper script to get your credentials:\n` +
          `      node get-creds.js\n` +
          `    Then paste CLOB_API_KEY, CLOB_SECRET, CLOB_PASSPHRASE into your .env`
        );
      }
    }

    log.ok(`Your API credentials (save these in .env to skip derivation):`);
    console.log(`    CLOB_API_KEY=${creds.apiKey}`);
    console.log(`    CLOB_SECRET=${creds.secret}`);
    console.log(`    CLOB_PASSPHRASE=${creds.passphrase}`);
  }

  log.ok(`Auth type: ${CFG.signatureType} (${CFG.signatureType === 0 ? 'EOA/MetaMask' : CFG.signatureType === 1 ? 'Google/Magic proxy' : 'Gnosis Safe'})`);
  log.ok(`API key: ${creds.apiKey.slice(0, 10)}…`);

  _clobClient = new ClobClient(
    CFG.clobApiUrl,
    CFG.chainId,
    signer,
    { key: creds.apiKey, secret: creds.secret, passphrase: creds.passphrase },
    CFG.signatureType,
    CFG.funderAddress,
  );

  _traderReady = true;
  log.ok('CLOB client ready.');
  return _clobClient;
}

/** Fetches minimum tick size for a token (BTC markets = "0.01"). */
async function getTickSize(tokenId) {
  if (_clobClient) {
    try {
      const r = await _clobClient.getTickSize(tokenId);
      if (r?.minimum_tick_size) return String(r.minimum_tick_size);
    } catch { /* fall back */ }
  }
  return '0.01';
}

/**
 * Place a FOK market BUY order.
 * Returns { success, orderId, fillPrice, sharesFilled, costUsdc }
 */
async function placeOrder({ tokenId, price, sizeUsdc, label }) {
  const client = await initTrader();

  log.trade(`FOK BUY  ${label}  $${sizeUsdc} USDC  @~${pct(price)}`);

  try {
    const resp = await client.createAndPostMarketOrder(
      { tokenID: tokenId, amount: sizeUsdc, side: Side.BUY, feeRateBps: 1000 },
      { negRisk: false, tickSize: await getTickSize(tokenId) },
      OrderType.FOK,
    );

    if (resp?.orderID && resp.success !== false) {
      const sharesFilled = resp.takingAmount ? parseFloat(resp.takingAmount) : sizeUsdc / price;
      const costUsdc     = resp.makingAmount ? parseFloat(resp.makingAmount) : sizeUsdc;
      const fillPrice    = costUsdc / sharesFilled;

      log.ok(`Order filled ✓  ID: ${resp.orderID}  shares: ${sharesFilled.toFixed(4)}  fill: ${pct(fillPrice)}`);
      return { success: true, orderId: resp.orderID, fillPrice, sharesFilled, costUsdc };
    }

    const msg = resp?.errorMsg || JSON.stringify(resp);
    log.warn(`Order not confirmed: ${msg}`);
    return { success: false, detail: msg };

  } catch (err) {
    log.error(`Order error: ${err.message}`);
    return { success: false, detail: err.message };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//  SECTION 8 — TRADE HISTORY  (for P&L: fetch actual fill from /data/trades)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Fetches the most recent trade for a given tokenId from GET /data/trades.
 * Returns { price, size, side } or null.
 *
 * Requires authenticated client (L2 header).
 */
async function fetchFillFromTrades(tokenId) {
  if (!_traderReady || !_clobClient) return null;
  try {
    const resp = await _clobClient.getTrades({
      asset_id:     tokenId,
      maker_address: CFG.funderAddress,
    });
    const trades = Array.isArray(resp) ? resp : (resp?.data ?? []);
    if (!trades.length) return null;

    const latest = trades.sort((a, b) =>
      new Date(b.created_at || 0) - new Date(a.created_at || 0)
    )[0];

    return {
      price: parseFloat(latest.price),
      size:  parseFloat(latest.size),
      side:  latest.side,
    };
  } catch (err) {
    log.warn(`fetchFillFromTrades: ${err.message}`);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//  SECTION 9 — BET TRACKER
// ──────────────────────────────────────────────────────────────────────────────

/**
 * In-memory ledger.  Each entry:
 * {
 *   slug, side, betSizeUsdc,
 *   orderId,
 *   fillPrice,   ← actual execution price (or entry price in dry-run)
 *   sharesFilled,
 *   tokenId,
 *   placedAt,
 *   sellResult:  null | { success, orderId, sellPrice, proceeds, pnl }
 *   pnlSnapshot: null | { secsLeft, currentPrice, unrealisedPnl, outlook, snappedAt }
 * }
 */
const _ledger = new Map();

function recordBet(slug, data) { _ledger.set(slug, { ...data, sellResult: null, pnlSnapshot: null }); }
function hasBet(slug)          { return _ledger.has(slug); }
function getBet(slug)          { return _ledger.get(slug); }

function allBets() {
  return [..._ledger.entries()].map(([slug, d]) => ({ slug, ...d }));
}

// ──────────────────────────────────────────────────────────────────────────────
//  SECTION 10 — P&L SNAPSHOT  (runs at T − 1 s, LOGGING ONLY — no sell)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Derive the market end timestamp directly from its slug.
 * e.g. "sol-updown-5m-1773662700" → 1773662700 + 300 = 1773663000
 * This avoids relying on secsToExpiry() which rolls over to the next interval.
 */
function slugEndTimestamp(slug) {
  const ts = parseInt(slug.split('-').pop(), 10);
  return isNaN(ts) ? intervalEnd() : ts + INTERVAL_SECS;
}

function slugSecsLeft(slug) {
  return slugEndTimestamp(slug) - Math.floor(Date.now() / 1000);
}

/**
 * Called exactly 1 second before market expiry for a slug we bet on.
 * PURE LOGGING — does NOT attempt to sell (sell happens at T − 5 s).
 *
 *  1. Fetch actual fill from /data/trades (if live)
 *  2. Read current market price (WS / REST)
 *  3. Calculate unrealised P&L
 *  4. Print P&L card
 */
async function takePnlSnapshot(slug) {
  const bet = getBet(slug);
  if (!bet) return;

  const secsLeft = slugSecsLeft(slug);
  log.divider();
  log.pnl(`P&L SNAPSHOT  —  ${slug}  (${secsLeft}s to expiry)`);

  // ── 1. Fill price ─────────────────────────────────────────────────────────
  let fillPrice    = bet.fillPrice;
  let sharesFilled = bet.sharesFilled;

  if (!CFG.dryRun) {
    const fill = await fetchFillFromTrades(bet.tokenId);
    if (fill) {
      fillPrice    = fill.price;
      sharesFilled = fill.size;
      log.pnl(`Fill (from /data/trades):  ${pct(fillPrice)}  ×  ${sharesFilled.toFixed(4)} shares`);
    } else {
      log.pnl(`Fill (recorded):           ${pct(fillPrice)}  ×  ${sharesFilled.toFixed(4)} shares`);
    }
  } else {
    log.pnl(`Fill (dry-run estimate):   ${pct(fillPrice)}  ×  ${sharesFilled.toFixed(4)} shares`);
  }

  // ── 2. Current price ──────────────────────────────────────────────────────
  const currentPrice = await livePrice(bet.tokenId);
  log.pnl(`Current price:             ${pct(currentPrice)}`);

  if (currentPrice == null) {
    log.warn('Could not read current price for P&L calculation.');
    return;
  }

  // ── 3. P&L ───────────────────────────────────────────────────────────────
  const costUsdc        = bet.betSizeUsdc;
  const potentialPayout = sharesFilled * 1.00;
  const unrealisedPnl   = (currentPrice - fillPrice) * sharesFilled;
  const estimatedValue  = currentPrice * sharesFilled;

  // ── 4. Outlook ────────────────────────────────────────────────────────────
  let outlook, outlookColour;
  if (currentPrice >= 0.90) {
    outlook       = '✅  LIKELY WIN   (price ≥ 90%)';
    outlookColour = chalk.greenBright;
  } else if (currentPrice <= 0.10) {
    outlook       = '❌  LIKELY LOSS  (price ≤ 10%)';
    outlookColour = chalk.redBright;
  } else {
    outlook       = '⚠️   UNCERTAIN   (outcome unclear)';
    outlookColour = chalk.yellow;
  }

  // ── 5. Sell status ────────────────────────────────────────────────────────
  const sellStatus = bet.sellResult
    ? (bet.sellResult.success ? `✅ SOLD @ ${pct(bet.sellResult.sellPrice)}` : `❌ Sell failed`)
    : '⏳ Pending (auto-redeem at expiry)';

  // ── 6. Print card ─────────────────────────────────────────────────────────
  log.divider();
  console.log(chalk.bgMagenta.white.bold('  ┌─────────────────────────────────────────┐  '));
  console.log(chalk.bgMagenta.white.bold('  │         P&L SNAPSHOT (T − 1s)           │  '));
  console.log(chalk.bgMagenta.white.bold('  └─────────────────────────────────────────┘  '));
  console.log(chalk.white(`  Market    : ${slug}`));
  console.log(chalk.white(`  Side      : ${bet.side}`));
  console.log(chalk.white(`  Asset     : ${bet.asset}`));
  console.log(chalk.white(`  Order ID  : ${bet.orderId}`));
  console.log(chalk.white(`  Cost      : $${costUsdc.toFixed(2)} USDC`));
  console.log(chalk.white(`  Fill @    : ${pct(fillPrice)}`));
  console.log(chalk.white(`  Shares    : ${sharesFilled.toFixed(4)}`));
  console.log(chalk.white(`  Current P : ${pct(currentPrice)}`));
  console.log(chalk.white(`  Mkt Value : $${estimatedValue.toFixed(4)} USDC`));
  console.log(chalk.white(`  Unr. P&L  : ${unrealisedPnl >= 0 ? chalk.green('+') : chalk.red('')}$${unrealisedPnl.toFixed(4)} USDC`));
  console.log(chalk.white(`  Max Win   : +$${(potentialPayout - costUsdc).toFixed(2)} USDC`));
  console.log(chalk.white(`  Max Loss  : -$${costUsdc.toFixed(2)} USDC`));
  console.log(outlookColour(`  Outlook   : ${outlook}`));
  console.log(chalk.white(`  Close     : ${sellStatus}`));
  log.divider();

  // ── 7. Persist snapshot to ledger ────────────────────────────────────────
  _ledger.get(slug).pnlSnapshot = {
    secsLeft,
    fillPrice,
    sharesFilled,
    currentPrice,
    unrealisedPnl,
    estimatedValue,
    outlook,
    snappedAt: new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
//  SECTION 10b — PRE-EXPIRY SELL  (fires at T − 5 s, BEFORE market closes)
// ──────────────────────────────────────────────────────────────────────────────
//
//  WHY PRE-EXPIRY:
//  After a 5-minute market expires and resolves, the CLOB orderbook is closed.
//  No new orders (BUY or SELL) are accepted. The old approach of selling at
//  T + 30 s always fails because there is no orderbook to match against.
//
//  By selling at T − 5 s the orderbook is still active, counterparties exist,
//  and the GTC limit sell can match immediately.
//
//  If the pre-expiry sell fails, Polymarket automatically redeems winning
//  conditional tokens into USDC during settlement (typically within minutes).
//
//  SELL MECHANICS:
//  - Uses `createAndPostOrder` (GTC limit) — NOT `createAndPostMarketOrder`
//  - Price: best bid from WS, minus one tick for aggressive fill
//  - Size: number of shares (not dollars)
//  - Retries once at T − 3 s if first attempt fails

/**
 * Attempt to sell the position for `slug` while the orderbook is still live.
 *
 * @param {string} slug   — market slug (lookup in _ledger)
 * @param {number} attempt — 0 = first try (T−5s), 1 = retry (T−3s)
 */
async function preExpirySell(slug, attempt = 0) {
  const bet = getBet(slug);
  if (!bet) return;

  // Already sold successfully — skip
  if (bet.sellResult?.success) return;

  const secsLeft = slugSecsLeft(slug);
  log.divider();
  log.trade(`🔄  PRE-EXPIRY SELL  ${slug}  attempt ${attempt + 1}/2  (${secsLeft}s left)`);

  if (CFG.dryRun) {
    const simPrice = await livePrice(bet.tokenId) ?? bet.fillPrice;
    const proceeds = simPrice * bet.sharesFilled;
    const pnl      = proceeds - bet.betSizeUsdc;
    log.dry(`[SIMULATED SELL] ${bet.sharesFilled?.toFixed(4)} shares @ ${pct(simPrice)}  P&L: $${pnl.toFixed(4)}`);
    _ledger.get(slug).sellResult = {
      success: true, orderId: `DRY-SELL-${Date.now()}`,
      sellPrice: simPrice, proceeds, pnl,
    };
    return;
  }

  // ── Guard: if market already expired, don't bother ────────────────────────
  if (secsLeft <= 0) {
    log.warn(`  Market already expired (${secsLeft}s ago) — orderbook is closed.`);
    log.warn('  Winning positions will auto-redeem via Polymarket settlement.');
    _ledger.get(slug).sellResult = { success: false, reason: 'expired' };
    return;
  }

  const client = await initTrader();

  // ── Refresh CLOB balance so it sees the shares from our BUY ───────────────
  try {
    await client.updateBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id:   bet.tokenId,
    });
  } catch (err) {
    log.warn(`  updateBalanceAllowance: ${err.message} (continuing anyway)`);
  }

  // ── Determine sell price: best bid → midpoint → fillPrice ─────────────────
  let sellPrice = wsMonitor.getBestBid(bet.tokenId);
  if (sellPrice == null) sellPrice = wsMonitor.getPrice(bet.tokenId);
  if (sellPrice == null) sellPrice = await restMidpoint(bet.tokenId);
  if (sellPrice == null) sellPrice = bet.fillPrice;

  // Sanity: don't sell far below our entry for a likely-winning position
  if (sellPrice < bet.fillPrice * 0.5 && bet.fillPrice > 0.5) {
    log.warn(`  Sell price ${pct(sellPrice)} looks too low vs fill ${pct(bet.fillPrice)} — using fill price`);
    sellPrice = bet.fillPrice;
  }

  // ── Align price to tick grid, cap at 0.99 ────────────────────────────────
  const tickSize = await getTickSize(bet.tokenId);
  const tick     = parseFloat(tickSize);
  // Subtract one tick from best bid for aggressive fill (taker-like)
  const aggressive = Math.floor((sellPrice - tick) / tick) * tick;
  const capped     = Math.min(Math.max(aggressive, tick), 0.99);
  const decimals   = Math.ceil(-Math.log10(tick));
  const priceStr   = capped.toFixed(decimals);

  // ── Floor shares to 4 decimal places ──────────────────────────────────────
  const sharesRounded = Math.floor(bet.sharesFilled * 10000) / 10000;
  if (sharesRounded <= 0) {
    log.warn(`  No sellable shares (rounded to 0) — skipping`);
    return;
  }

  log.trade(`  GTC limit SELL  ${sharesRounded} shares @ ${priceStr}  (tick: ${tickSize})`);
  log.trade(`  Token: ${bet.tokenId.slice(0, 20)}…`);

  try {
    const resp = await client.createAndPostOrder(
      {
        tokenID:    bet.tokenId,
        price:      parseFloat(priceStr),
        size:       sharesRounded,
        side:       Side.SELL,
        feeRateBps: 1000,
        expiration: 0,
        taker:      '0x0000000000000000000000000000000000000000',
      },
      { negRisk: false, tickSize },
      OrderType.GTC,
    );

    if (resp?.orderID && resp.success !== false) {
      const proceeds = parseFloat(priceStr) * sharesRounded;
      const pnl      = proceeds - bet.betSizeUsdc;
      const c        = pnl >= 0 ? chalk.greenBright : chalk.redBright;

      log.ok(`✅  Sell order placed!  ID: ${resp.orderID}  status: ${resp.status}`);
      log.ok(`    Est. proceeds : $${proceeds.toFixed(4)} USDC`);
      log.ok(`    Est. P&L      : ${c(`${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)} USDC`)}`);

      _ledger.get(slug).sellResult = {
        success: true, orderId: resp.orderID,
        sellPrice: parseFloat(priceStr), proceeds, pnl,
      };
      return;
    }

    const msg = resp?.errorMsg || JSON.stringify(resp);
    log.warn(`  Sell order not accepted: ${msg}`);

  } catch (err) {
    log.error(`  Sell error: ${err.message}`);
  }

  // ── Retry once more (attempt 0 → retry at T−3s, attempt 1 → give up) ────
  if (attempt === 0) {
    const retryInMs = Math.max((secsLeft - 3) * 1000, 1000);
    log.info(`  Retrying in ${(retryInMs / 1000).toFixed(1)}s…`);
    setTimeout(() => preExpirySell(slug, 1), retryInMs);
  } else {
    log.warn('  All sell attempts failed. Winning positions auto-redeem at settlement.');
    _ledger.get(slug).sellResult = { success: false, reason: 'sell_failed' };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//  SECTION 11 — MARKET META CACHE + WS SUBSCRIPTIONS
// ──────────────────────────────────────────────────────────────────────────────

// Cache keyed by slug — holds metadata for all three assets simultaneously
const _metaCacheMap = new Map();   // slug → meta
let _wsSubscribed = new Set();

async function resolvedMeta(slug) {
  if (_metaCacheMap.has(slug)) return _metaCacheMap.get(slug);
  const meta = await fetchMarketMeta(slug);
  if (!meta) return null;
  _metaCacheMap.set(slug, meta);
  log.info(`  [${slug}] Market: "${meta.question}"`);
  log.info(`    UP   token: …${meta.upTokenId?.slice(-10)}`);
  log.info(`    DOWN token: …${meta.downTokenId?.slice(-10)}`);
  return meta;
}

function ensureWsSubscription(meta) {
  const tokens = [meta.upTokenId, meta.downTokenId].filter(Boolean);
  const fresh  = tokens.filter(t => !_wsSubscribed.has(t));
  if (fresh.length) {
    wsMonitor.subscribe(fresh);
    fresh.forEach(t => _wsSubscribed.add(t));
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//  SECTION 12 — POLL LOOP  (runs every POLL_INTERVAL_MS)
// ──────────────────────────────────────────────────────────────────────────────

// Tracks which slugs have a P&L snapshot already scheduled
const _pnlScheduled  = new Set();

// Tracks which slugs have a pre-expiry sell already scheduled
const _sellScheduled = new Set();

// Tracks which 5-min interval windows we have already placed a bet in.
const _bettedIntervals = new Set();

/**
 * Schedule both the pre-expiry sell and P&L snapshot for a given slug.
 * Safe to call multiple times — idempotent via _sellScheduled / _pnlScheduled.
 */
function scheduleCloseAndSnapshot(slug, asset) {
  const secsLeft = slugSecsLeft(slug);

  // ── Schedule pre-expiry SELL at T − sellBeforeExpirySecs ──────────────────
  if (!_sellScheduled.has(slug)) {
    _sellScheduled.add(slug);
    const sellDelay = Math.max((secsLeft - CFG.sellBeforeExpirySecs) * 1000, 500);
    log.info(`${asset.label}: SELL scheduled in ${(sellDelay / 1000).toFixed(1)}s (T−${CFG.sellBeforeExpirySecs}s)`);
    setTimeout(() => preExpirySell(slug, 0), sellDelay);
  }

  // ── Schedule P&L snapshot at T − 1 s ─────────────────────────────────────
  if (!_pnlScheduled.has(slug)) {
    _pnlScheduled.add(slug);
    const snapDelay = Math.max((secsLeft - 1) * 1000, 500);
    log.info(`${asset.label}: P&L snapshot in ${(snapDelay / 1000).toFixed(1)}s`);
    setTimeout(() => takePnlSnapshot(slug), snapDelay);
  }
}

/**
 * Evaluate a single asset: fetch its meta, subscribe WS, resolve prices,
 * and check whether either UP or DOWN satisfies the probability window.
 *
 * Returns a signal object if a bet should be placed, or null.
 * { asset, slug, meta, side, price, tokenId }
 */
async function evaluateAsset(asset, timeLeft) {
  const slug = buildSlug(asset.slugPrefix);

  // Fetch / cache market metadata
  const meta = await resolvedMeta(slug);
  if (!meta || !meta.upTokenId || !meta.downTokenId) {
    log.warn(`  ${asset.label}: market not indexed yet — skipping`);
    return null;
  }

  // Ensure WS is streaming this asset's tokens
  ensureWsSubscription(meta);

  // Resolve live prices (WS → REST fallback)
  const [upP, downP] = await Promise.all([
    livePrice(meta.upTokenId),
    livePrice(meta.downTokenId),
  ]);

  const src = wsMonitor.getPrice(meta.upTokenId) != null ? 'WS' : 'REST';
  log.scan(
    `  ${asset.emoji} ${asset.label.padEnd(3)}  UP: ${pct(upP).padStart(7)}  ` +
    `DOWN: ${pct(downP).padStart(7)}  (${src})`
  );

  // Check probability window
  const upFit   = upP   != null && upP   > CFG.probMin && upP   < CFG.probMax;
  const downFit = downP != null && downP > CFG.probMin && downP < CFG.probMax;

  if (!upFit && !downFit) return null;

  // Pick the side with higher conviction (usually only one qualifies)
  let side, price, tokenId;
  if (upFit && downFit) {
    if ((upP ?? 0) >= (downP ?? 0)) { side = 'UP';   price = upP;   tokenId = meta.upTokenId; }
    else                             { side = 'DOWN'; price = downP; tokenId = meta.downTokenId; }
  } else if (upFit) {
    side = 'UP';   price = upP;   tokenId = meta.upTokenId;
  } else {
    side = 'DOWN'; price = downP; tokenId = meta.downTokenId;
  }

  return { asset, slug, meta, side, price, tokenId };
}

async function poll() {
  const timeLeft    = secsToExpiry();
  const intervalKey = currentIntervalKey();

  log.divider();
  log.scan(`⏱  ${timeLeft}s to expiry  |  interval: ${intervalStart()}`);

  // ── 1. Schedule sell + P&L for any existing bot-placed bets this interval ─
  for (const asset of CFG.assets) {
    const slug = buildSlug(asset.slugPrefix);
    if (hasBet(slug)) {
      scheduleCloseAndSnapshot(slug, asset);
    }
  }

  // ── 2. Skip if outside trigger window ─────────────────────────────────────
  if (timeLeft >= CFG.expiryThresholdSecs) return;

  // ── 3. Only one bet per 5-min interval across ALL assets ──────────────────
  if (_bettedIntervals.has(intervalKey)) {
    const bettedSlug = CFG.assets
      .map(a => buildSlug(a.slugPrefix))
      .find(s => hasBet(s));
    const b = bettedSlug ? getBet(bettedSlug) : null;
    if (b) log.scan(`Already bet this interval on ${bettedSlug} (${b.side} @ ${pct(b.fillPrice)}) — idle`);
    return;
  }

  // ── 4. Scan all assets in priority order ──────────────────────────────────
  log.scan(`Scanning ${CFG.assets.map(a => a.label).join(' → ')} (priority order)…`);

  let signal = null;

  for (const asset of CFG.assets) {
    const result = await evaluateAsset(asset, timeLeft);
    if (result) {
      signal = result;
      log.ok(`  ✓ Signal found on ${asset.label} — stopping scan`);
      break;
    }
  }

  if (!signal) {
    log.scan('No signal on any asset this poll.');
    return;
  }

  const { asset, slug, side, price, tokenId } = signal;

  // ── 5. Print signal card ──────────────────────────────────────────────────
  log.divider();
  log.trade(`🎯  SIGNAL  —  ${asset.emoji} ${asset.label}`);
  log.trade(`    Slug    : ${slug}`);
  log.trade(`    Side    : ${side}`);
  log.trade(`    Prob    : ${pct(price)}`);
  log.trade(`    Bet     : $${CFG.betSizeUsdc} USDC`);
  log.trade(`    Expiry  : ${timeLeft}s`);
  log.divider();

  // ── 6. Place bet or simulate ──────────────────────────────────────────────
  let orderId, fillPrice, sharesFilled;

  if (CFG.dryRun) {
    orderId      = `DRY-${Date.now()}`;
    fillPrice    = price;
    sharesFilled = CFG.betSizeUsdc / price;
    log.dry(`[SIMULATED] FOK BUY  ${asset.label} ${side}  $${CFG.betSizeUsdc}  @${pct(price)}`);
  } else {
    const result = await placeOrder({ tokenId, price, sizeUsdc: CFG.betSizeUsdc, label: `${asset.label}-${side}` });
    if (!result.success) {
      log.error(`Bet failed: ${result.detail}`);
      return;
    }
    orderId      = result.orderId;
    fillPrice    = result.fillPrice   ?? price;
    sharesFilled = result.sharesFilled ?? CFG.betSizeUsdc / price;
  }

  // ── 7. Record bet and mark interval as done ───────────────────────────────
  recordBet(slug, {
    side,
    asset:       asset.label,
    betSizeUsdc: CFG.betSizeUsdc,
    orderId,
    fillPrice,
    sharesFilled,
    tokenId,
    conditionId: signal.meta.conditionId || null,
    placedAt: new Date().toISOString(),
  });

  _bettedIntervals.add(intervalKey);
  log.ok(`Bet recorded ✓  ${asset.label} ${side}  orderId=${orderId}`);

  // ── 8. Schedule pre-expiry sell + P&L snapshot ────────────────────────────
  scheduleCloseAndSnapshot(slug, asset);
}

// ──────────────────────────────────────────────────────────────────────────────
//  SECTION 13 — SESSION SUMMARY  (printed on exit)
// ──────────────────────────────────────────────────────────────────────────────

function printSessionSummary() {
  const bets = allBets();
  log.divider();
  console.log(chalk.bold.white(`  SESSION SUMMARY  —  ${bets.length} bet(s)`));
  log.divider();

  if (!bets.length) {
    console.log(chalk.gray('  No bets were placed this session.'));
    log.divider();
    return;
  }

  let totalCost = 0, totalPnl = 0;

  for (const b of bets) {
    totalCost += b.betSizeUsdc;
    const snap = b.pnlSnapshot;
    const sell = b.sellResult;

    console.log(chalk.cyan(`  ${b.slug}`));
    console.log(`    Asset    : ${b.asset || 'unknown'}`);
    console.log(`    Side     : ${b.side}`);
    console.log(`    Order    : ${b.orderId}`);
    console.log(`    Fill     : ${pct(b.fillPrice)}  × ${b.sharesFilled?.toFixed(4)} shares`);
    console.log(`    Cost     : $${b.betSizeUsdc}`);

    if (sell?.success) {
      totalPnl += sell.pnl;
      const plColour = sell.pnl >= 0 ? chalk.green : chalk.red;
      console.log(`    Sell     : ✅ @ ${pct(sell.sellPrice)}  orderId=${sell.orderId}`);
      console.log(`    Proceeds : $${sell.proceeds?.toFixed(4)}`);
      console.log(`    P&L      : ${plColour(`${sell.pnl >= 0 ? '+' : ''}$${sell.pnl.toFixed(4)}`)}`);
    } else if (sell) {
      console.log(chalk.yellow(`    Sell     : ❌ failed (${sell.reason || 'unknown'}) — auto-redeem expected`));
    }

    if (snap) {
      const pl = snap.unrealisedPnl;
      if (!sell?.success) totalPnl += pl; // use unrealised if no sell
      const plColour = pl >= 0 ? chalk.green : chalk.red;
      console.log(`    Unr. P&L : ${plColour(`${pl >= 0 ? '+' : ''}$${pl.toFixed(4)}`)}`);
      console.log(`    Outlook  : ${snap.outlook}`);
      console.log(`    Snapshot : ${snap.snappedAt}`);
    } else {
      console.log(chalk.gray('    P&L snapshot not yet taken'));
    }
    console.log('');
  }

  const plColour = totalPnl >= 0 ? chalk.greenBright : chalk.redBright;
  console.log(chalk.bold(`  Total cost  : $${totalCost.toFixed(2)} USDC`));
  console.log(chalk.bold(`  Total P&L   : ${plColour(`${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(4)} USDC`)}`));
  log.divider();
}

// ──────────────────────────────────────────────────────────────────────────────
//  SECTION 14 — STARTUP  (pre-flight + banner)
// ──────────────────────────────────────────────────────────────────────────────

log.divider();
console.log('');
console.log('   🤖  Polymarket Multi-Asset 5-Minute Up/Down Bot  (single-file)');
console.log('');
console.log(`   Assets     :  BTC (1st) → XRP (2nd) → SOL (3rd)  [priority order]`);
console.log(`   Strategy   :  ${pct(CFG.probMin)} < P < ${pct(CFG.probMax)}  — first qualifying asset wins`);
console.log(`   Trigger    :  last ${CFG.expiryThresholdSecs}s before expiry`);
console.log(`   Bet size   :  $${CFG.betSizeUsdc} USDC  (one bet per 5-min window)`);
console.log(`   Sell close :  T − ${CFG.sellBeforeExpirySecs}s (pre-expiry, while orderbook is live)`);
console.log(`   P&L snap   :  T − 1s before market close`);
console.log(`   Auth type  :  ${CFG.signatureType === 0 ? '0 — EOA / MetaMask' : CFG.signatureType === 1 ? '1 — Google / Magic Link proxy' : '2 — Gnosis Safe'}`);
console.log(`   Mode       :  ${CFG.dryRun ? '✅  DRY-RUN (no real orders)' : '🔴  LIVE TRADING'}`);
console.log(`   Poll       :  every ${CFG.pollIntervalMs}ms`);
console.log('');
log.divider();

// Validate credentials for live mode
if (!CFG.dryRun) {
  if (!CFG.privateKey   || CFG.privateKey   === '0xYOUR_PRIVATE_KEY_HERE')
    { log.error('PRIVATE_KEY missing/placeholder in .env'); process.exit(1); }
  if (!CFG.funderAddress || CFG.funderAddress === '0xYOUR_WALLET_ADDRESS_HERE')
    { log.error('FUNDER_ADDRESS missing/placeholder in .env'); process.exit(1); }

  log.info('Initialising CLOB trader…');
  try {
    await initTrader();
    log.ok('Trader ready.');
  } catch (err) {
    log.error(`Trader init failed: ${err.message}`);
    process.exit(1);
  }
} else {
  log.dry('Trader init skipped (dry-run).');
}

// Global error resilience — keep the process alive on transient errors
process.on('uncaughtException',  err => log.error(`Uncaught: ${err.message}`));
process.on('unhandledRejection', err => log.error(`Unhandled rejection: ${err}`));

// Graceful shutdown
process.on('SIGINT',  () => { printSessionSummary(); wsMonitor.close(); process.exit(0); });
process.on('SIGTERM', () => { printSessionSummary(); wsMonitor.close(); process.exit(0); });

// ── Start ──────────────────────────────────────────────────────────────────
log.info(`Polling every ${CFG.pollIntervalMs}ms — press Ctrl+C to stop`);

await poll();
setInterval(poll, CFG.pollIntervalMs);
