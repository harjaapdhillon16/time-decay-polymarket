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
//  POST-RESOLUTION REDEMPTION  (via Builder Relayer Client)
//  ──────────────────────────────────────────────────────────
//  • After market expiry, polls Gamma API to detect resolution
//  • Verifies on-chain that the oracle has reported (payoutDenominator > 0)
//  • Uses @polymarket/builder-relayer-client to relay CTF redeemPositions()
//    through the user's Safe or Proxy wallet — NO direct ethers contract calls
//  • Supports both standard CTF redeem and NegRisk adapter redeem
//  • Winning tokens redeem at $1.00 each; losing tokens yield $0
//  • Retries resolution checks every 15s for up to 10 minutes
//  • No deadline — winning tokens are always redeemable
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
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import ethers from 'ethers';
import axios from 'axios';
import chalk from 'chalk';
import { WebSocket } from 'ws';
import { EventEmitter } from 'events';

// ── viem + builder-relayer-client imports (for gasless redemption) ───────────
import {
  createWalletClient,
  createPublicClient,
  http,
  encodeFunctionData,
  zeroHash,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { RelayClient, RelayerTxType } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';

const { Wallet } = ethers;

// ──────────────────────────────────────────────────────────────────────────────
//  SECTION 1 — CONFIGURATION
// ──────────────────────────────────────────────────────────────────────────────

function _envFloat(key, def) {
  const v = process.env[key]; if (!v) return def;
  const n = parseFloat(v); if (isNaN(n)) throw new Error(`${key} must be a number`);
  return n;
}
function _envInt(key, def) {
  const v = process.env[key]; if (!v) return def;
  const n = parseInt(v, 10); if (isNaN(n)) throw new Error(`${key} must be an integer`);
  return n;
}

const CFG = {
  privateKey: process.env.PRIVATE_KEY || null,
  funderAddress: process.env.FUNDER_ADDRESS || null,
  // signatureType:
  //   0 = Plain MetaMask / EOA wallet (PRIVATE_KEY is the wallet key directly)
  //   1 = Google / email / Magic Link account (PRIVATE_KEY = Magic EOA key,
  //       FUNDER_ADDRESS = your Polymarket proxy/profile address)
  //   2 = Gnosis Safe proxy wallet
  signatureType: _envInt('SIGNATURE_TYPE', 0),

  // Optional: paste pre-generated CLOB credentials here to skip derivation.
  // Run `node get-creds.js` once to generate them, then set in .env.
  // This is required for Magic/Google accounts if auto-derivation fails.
  clobApiKey: process.env.CLOB_API_KEY || null,
  clobSecret: process.env.CLOB_SECRET || null,
  clobPassphrase: process.env.CLOB_PASSPHRASE || null,

  // ── Builder Relayer credentials (required for on-chain redemption) ─────────
  // Apply for Builder access at: https://docs.polymarket.com/developers/builders/builder-intro
  builderApiKey: process.env.BUILDER_API_KEY || null,
  builderSecret: process.env.BUILDER_SECRET || null,
  builderPassphrase: process.env.BUILDER_PASSPHRASE || null,
  relayerUrl: process.env.POLYMARKET_RELAYER_URL || 'https://relayer.polymarket.com',

  // Polygon RPC for read-only on-chain checks (payoutDenominator)
  polygonRpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',

  betSizeUsdc: _envFloat('BET_SIZE_USDC', 5),
  probMin: _envFloat('PROB_MIN', 0.80),
  probMax: _envFloat('PROB_MAX', 0.90),
  expiryThresholdSecs: _envInt('EXPIRY_THRESHOLD_SECS', 90),
  pollIntervalMs: _envInt('POLL_INTERVAL_MS', 5_000),
  dryRun: (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false',
  gammaApiUrl: process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com',
  clobApiUrl: process.env.CLOB_API_URL || 'https://clob.polymarket.com',
  chainId: _envInt('CHAIN_ID', 137),

  // Assets scanned in priority order — first match wins each interval.
  assets: [
    { id: 'btc', label: 'BTC', slugPrefix: 'btc-updown-5m', emoji: '₿' },
    { id: 'xrp', label: 'XRP', slugPrefix: 'xrp-updown-5m', emoji: '✕' },
    { id: 'sol', label: 'SOL', slugPrefix: 'sol-updown-5m', emoji: '◎' },
  ],
};

if (CFG.probMin >= CFG.probMax)
  throw new Error(`PROB_MIN (${CFG.probMin}) must be < PROB_MAX (${CFG.probMax})`);

// ── Redemption constants ────────────────────────────────────────────────────
const REDEEM = {
  pollIntervalMs: 15_000,   // check resolution every 15s
  maxAttempts: 40,           // 40 × 15s = ~10 minutes
};

// ──────────────────────────────────────────────────────────────────────────────
//  SECTION 2 — LOGGER
// ──────────────────────────────────────────────────────────────────────────────

const ts = () => chalk.gray(new Date().toISOString());
const log = {
  info: (...a) => console.log(ts(), chalk.cyan('[INFO]'), ...a),
  ok: (...a) => console.log(ts(), chalk.green('[OK]'), ...a),
  warn: (...a) => console.log(ts(), chalk.yellow('[WARN]'), ...a),
  error: (...a) => console.error(ts(), chalk.red('[ERROR]'), ...a),
  trade: (...a) => console.log(ts(), chalk.magentaBright('[TRADE]'), ...a),
  scan: (...a) => console.log(ts(), chalk.blue('[SCAN]'), ...a),
  pnl: (...a) => console.log(ts(), chalk.bgGreen.black('[P&L]'), ...a),
  redeem: (...a) => console.log(ts(), chalk.bgCyan.black('[REDEEM]'), ...a),
  dry: (...a) => console.log(ts(), chalk.bgYellow.black('[DRY]'), ...a),
  divider: () => console.log(chalk.gray('─'.repeat(72))),
};
const pct = (v) => v != null ? `${(v * 100).toFixed(2)}%` : 'n/a';

// ──────────────────────────────────────────────────────────────────────────────
//  SECTION 3 — MARKET TIMING
// ──────────────────────────────────────────────────────────────────────────────

const INTERVAL_SECS = 300; // 5 minutes

function intervalStart() {
  const now = Math.floor(Date.now() / 1000);
  return now - (now % INTERVAL_SECS);
}

function intervalEnd() { return intervalStart() + INTERVAL_SECS; }
function secsToExpiry() { return intervalEnd() - Math.floor(Date.now() / 1000); }
function buildSlug(slugPrefix) { return `${slugPrefix}-${intervalStart()}`; }
function currentIntervalKey() { return `interval-${intervalStart()}`; }

// ──────────────────────────────────────────────────────────────────────────────
//  SECTION 4 — GAMMA API  (market discovery + resolution check)
// ──────────────────────────────────────────────────────────────────────────────

async function fetchMarketMeta(slug) {
  try {
    const { data } = await axios.get(`${CFG.gammaApiUrl}/events`, {
      params: { slug }, timeout: 8_000,
    });
    if (!Array.isArray(data) || !data.length) return null;

    const event = data[0];
    const market = event.markets?.[0];
    if (!market) return null;

    const tokenIds = (() => {
      try { return JSON.parse(market.clobTokenIds); }
      catch { return market.clobTokenIds || []; }
    })();

    const outcomes = (() => {
      try { return JSON.parse(market.outcomes); }
      catch { return market.outcomes || []; }
    })();

    const upIdx = outcomes.findIndex(o => /up/i.test(o));
    const downIdx = outcomes.findIndex(o => /down/i.test(o));

    const endTimestamp = event.endDate
      ? Math.floor(new Date(event.endDate).getTime() / 1000)
      : intervalEnd();

    // Detect neg_risk for proper redeem routing
    const negRisk = market.neg_risk === true || market.neg_risk === 'true';
    const negRiskMarketId = market.neg_risk_market_id || '';

    return {
      slug,
      endTimestamp,
      question: market.question || '',
      conditionId: market.conditionId || market.condition_id || '',
      upTokenId: upIdx >= 0 ? tokenIds[upIdx] : tokenIds[0],
      downTokenId: downIdx >= 0 ? tokenIds[downIdx] : tokenIds[1],
      negRisk,
      negRiskMarketId,
    };
  } catch (err) {
    log.error(`Gamma API error: ${err.message}`);
    return null;
  }
}

/**
 * Check whether a market has resolved via Gamma API.
 * Returns { resolved, outcome } or null on error.
 */
async function checkMarketResolved(slug) {
  try {
    const { data } = await axios.get(`${CFG.gammaApiUrl}/events`, {
      params: { slug }, timeout: 8_000,
    });
    if (!Array.isArray(data) || !data.length) return null;

    const market = data[0].markets?.[0];
    if (!market) return null;

    const resolved = market.resolved === true || market.resolved === 'true';
    return {
      resolved,
      outcome: market.outcome || market.winning_outcome || null,
    };
  } catch (err) {
    log.warn(`Resolution check failed: ${err.message}`);
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
    log.warn(`REST price fetch failed for ${tokenId.slice(0, 10)}…: ${err.message}`);
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
//  SECTION 6 — WEBSOCKET MONITOR  (real-time prices)
// ──────────────────────────────────────────────────────────────────────────────

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const WS_HB_MS = 20_000;
const WS_RETRY_MS = 3_000;

class WsMonitor extends EventEmitter {
  constructor() {
    super();
    this._prices = new Map();
    this._bestBid = new Map();
    this._bestAsk = new Map();
    this._subscribed = new Set();
    this._ws = null;
    this._alive = false;
    this._hbTimer = null;
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

  getPrice(id) { return this._prices.get(id) ?? null; }
  getBestBid(id) { return this._bestBid.get(id) ?? null; }
  getBestAsk(id) { return this._bestAsk.get(id) ?? null; }
  get connected() { return this._ws?.readyState === WebSocket.OPEN; }

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
        const bid = bids?.length ? parseFloat(bids[bids.length - 1].price) : null;
        const ask = asks?.length ? parseFloat(asks[0].price) : null;
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

async function initTrader() {
  if (_traderReady) return _clobClient;

  const signer = new Wallet(CFG.privateKey);
  let creds;

  if (CFG.clobApiKey && CFG.clobSecret && CFG.clobPassphrase) {
    log.ok('Using API credentials from .env (CLOB_API_KEY / CLOB_SECRET / CLOB_PASSPHRASE)');
    creds = {
      apiKey: CFG.clobApiKey,
      secret: CFG.clobSecret,
      passphrase: CFG.clobPassphrase,
    };
  } else {
    log.info('Deriving API credentials from wallet signature…');
    log.info('(Tip: paste CLOB_API_KEY / CLOB_SECRET / CLOB_PASSPHRASE into .env to skip this step)');

    const derivationClient = CFG.signatureType === 0
      ? new ClobClient(CFG.clobApiUrl, CFG.chainId, signer)
      : new ClobClient(
        CFG.clobApiUrl, CFG.chainId, signer,
        undefined, CFG.signatureType, CFG.funderAddress,
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
    CFG.clobApiUrl, CFG.chainId, signer,
    { key: creds.apiKey, secret: creds.secret, passphrase: creds.passphrase },
    CFG.signatureType, CFG.funderAddress,
  );

  _traderReady = true;
  log.ok('CLOB client ready.');
  return _clobClient;
}

async function getTickSize(tokenId) {
  if (_clobClient) {
    try {
      const r = await _clobClient.getTickSize(tokenId);
      if (r?.minimum_tick_size) return String(r.minimum_tick_size);
    } catch { /* fall back */ }
  }
  return '0.01';
}

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
      const costUsdc = resp.makingAmount ? parseFloat(resp.makingAmount) : sizeUsdc;
      const fillPrice = costUsdc / sharesFilled;

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

async function fetchFillFromTrades(tokenId) {
  if (!_traderReady || !_clobClient) return null;
  try {
    const resp = await _clobClient.getTrades({
      asset_id: tokenId,
      maker_address: CFG.funderAddress,
    });
    const trades = Array.isArray(resp) ? resp : (resp?.data ?? []);
    if (!trades.length) return null;

    const latest = trades.sort((a, b) =>
      new Date(b.created_at || 0) - new Date(a.created_at || 0)
    )[0];

    return {
      price: parseFloat(latest.price),
      size: parseFloat(latest.size),
      side: latest.side,
    };
  } catch (err) {
    log.warn(`fetchFillFromTrades: ${err.message}`);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//  SECTION 9 — BET TRACKER
// ──────────────────────────────────────────────────────────────────────────────

const _ledger = new Map();

function recordBet(slug, data) { _ledger.set(slug, { ...data, redeemResult: null, pnlSnapshot: null }); }
function hasBet(slug) { return _ledger.has(slug); }
function getBet(slug) { return _ledger.get(slug); }
function allBets() { return [..._ledger.entries()].map(([slug, d]) => ({ slug, ...d })); }

// ──────────────────────────────────────────────────────────────────────────────
//  SECTION 10 — P&L SNAPSHOT  (runs at T − 1 s, LOGGING ONLY)
// ──────────────────────────────────────────────────────────────────────────────

function slugEndTimestamp(slug) {
  const ts = parseInt(slug.split('-').pop(), 10);
  return isNaN(ts) ? intervalEnd() : ts + INTERVAL_SECS;
}

function slugSecsLeft(slug) {
  return slugEndTimestamp(slug) - Math.floor(Date.now() / 1000);
}

async function takePnlSnapshot(slug) {
  const bet = getBet(slug);
  if (!bet) return;

  const secsLeft = slugSecsLeft(slug);
  log.divider();
  log.pnl(`P&L SNAPSHOT  —  ${slug}  (${secsLeft}s to expiry)`);

  let fillPrice = bet.fillPrice;
  let sharesFilled = bet.sharesFilled;

  if (!CFG.dryRun) {
    const fill = await fetchFillFromTrades(bet.tokenId);
    if (fill) {
      fillPrice = fill.price;
      sharesFilled = fill.size;
      log.pnl(`Fill (from /data/trades):  ${pct(fillPrice)}  ×  ${sharesFilled.toFixed(4)} shares`);
    } else {
      log.pnl(`Fill (recorded):           ${pct(fillPrice)}  ×  ${sharesFilled.toFixed(4)} shares`);
    }
  } else {
    log.pnl(`Fill (dry-run estimate):   ${pct(fillPrice)}  ×  ${sharesFilled.toFixed(4)} shares`);
  }

  const currentPrice = await livePrice(bet.tokenId);
  log.pnl(`Current price:             ${pct(currentPrice)}`);

  if (currentPrice == null) {
    log.warn('Could not read current price for P&L calculation.');
    return;
  }

  const costUsdc = bet.betSizeUsdc;
  const potentialPayout = sharesFilled * 1.00;
  const unrealisedPnl = (currentPrice - fillPrice) * sharesFilled;
  const estimatedValue = currentPrice * sharesFilled;

  let outlook, outlookColour;
  if (currentPrice >= 0.90) {
    outlook = '✅  LIKELY WIN   (price ≥ 90%)';
    outlookColour = chalk.greenBright;
  } else if (currentPrice <= 0.10) {
    outlook = '❌  LIKELY LOSS  (price ≤ 10%)';
    outlookColour = chalk.redBright;
  } else {
    outlook = '⚠️   UNCERTAIN   (outcome unclear)';
    outlookColour = chalk.yellow;
  }

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
  log.divider();

  _ledger.get(slug).pnlSnapshot = {
    secsLeft, fillPrice, sharesFilled, currentPrice,
    unrealisedPnl, estimatedValue, outlook,
    snappedAt: new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
//  SECTION 10b — POST-RESOLUTION TOKEN REDEMPTION
//               (via Builder Relayer Client — gasless, Safe/Proxy compatible)
// ──────────────────────────────────────────────────────────────────────────────
//
//  Uses @polymarket/builder-relayer-client to relay CTF redeemPositions()
//  through Polymarket's relayer infrastructure. This handles both Safe and
//  Proxy wallet types transparently — no direct on-chain signing required.
//
//  The relayer encodes your transaction, wraps it for the correct wallet type,
//  signs via Builder credentials, and submits to Polygon. Gas is covered by
//  the relayer (gasless for the user).
//
//  Two redeem paths:
//    1. Standard CTF redeem  — for normal (non-neg-risk) binary markets
//    2. NegRisk Adapter redeem — for neg-risk event markets
//
//  Addresses (Polygon mainnet):
//    CTF:             0x4D97DCd97eC945f40cF65F87097ACe5EA0476045
//    USDC.e:          0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
//    NegRisk Adapter: 0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296

const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDCE_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

// ── ABI fragments for viem encodeFunctionData ───────────────────────────────

const CTF_REDEEM_ABI = [
  {
    constant: false,
    inputs: [
      { name: 'collateralToken', type: 'address' },
      { name: 'parentCollectionId', type: 'bytes32' },
      { name: 'conditionId', type: 'bytes32' },
      { name: 'indexSets', type: 'uint256[]' },
    ],
    name: 'redeemPositions',
    outputs: [],
    payable: false,
    stateMutability: 'nonpayable',
    type: 'function',
  },
];

const NR_ADAPTER_REDEEM_ABI = [
  {
    inputs: [
      { internalType: 'bytes32', name: '_conditionId', type: 'bytes32' },
      { internalType: 'uint256[]', name: '_amounts', type: 'uint256[]' },
    ],
    name: 'redeemPositions',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
];

const PAYOUT_DENOMINATOR_ABI = [
  {
    inputs: [{ name: 'conditionId', type: 'bytes32' }],
    name: 'payoutDenominator',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
];

// ── Lazy-initialised viem clients + relayer ─────────────────────────────────

let _viemWallet = null;
let _viemPublic = null;
let _relayClient = null;

function getViemPublicClient() {
  if (!_viemPublic) {
    _viemPublic = createPublicClient({
      chain: polygon,
      transport: http(CFG.polygonRpcUrl),
    });
  }
  return _viemPublic;
}

function getViemWalletClient() {
  if (!_viemWallet) {
    const account = privateKeyToAccount(CFG.privateKey);
    _viemWallet = createWalletClient({
      account,
      chain: polygon,
      transport: http(CFG.polygonRpcUrl),
    });
  }
  return _viemWallet;
}

function getRelayClient() {
  if (_relayClient) return _relayClient;

  const wallet = getViemWalletClient();

  // Determine transaction type from signatureType config
  const txType = CFG.signatureType === 1
    ? RelayerTxType.PROXY
    : RelayerTxType.SAFE;

  if (CFG.builderApiKey && CFG.builderSecret && CFG.builderPassphrase) {
    // Authenticated relay with Builder credentials
    const builderConfig = new BuilderConfig({
      localBuilderCreds: {
        key: CFG.builderApiKey,
        secret: CFG.builderSecret,
        passphrase: CFG.builderPassphrase,
      },
    });
    _relayClient = new RelayClient(
      CFG.relayerUrl,
      CFG.chainId,
      wallet,
      builderConfig,
      txType,
    );
    log.ok(`Relayer client ready (${txType === RelayerTxType.PROXY ? 'PROXY' : 'SAFE'} mode, Builder auth)`);
  } else {
    // Unauthenticated relay (may have limited functionality)
    _relayClient = new RelayClient(
      CFG.relayerUrl,
      CFG.chainId,
      wallet,
      undefined,
      txType,
    );
    log.warn('Relayer client ready WITHOUT Builder auth — redemption may fail.');
    log.warn('Set BUILDER_API_KEY, BUILDER_SECRET, BUILDER_PASSPHRASE in .env');
  }

  return _relayClient;
}

// ── Build redeem transactions using viem ────────────────────────────────────

function buildCtfRedeemTx(conditionId) {
  const calldata = encodeFunctionData({
    abi: CTF_REDEEM_ABI,
    functionName: 'redeemPositions',
    args: [USDCE_ADDRESS, zeroHash, conditionId, [1n, 2n]],
  });
  return { to: CTF_ADDRESS, data: calldata, value: '0' };
}

function buildNegRiskRedeemTx(conditionId, amounts) {
  const calldata = encodeFunctionData({
    abi: NR_ADAPTER_REDEEM_ABI,
    functionName: 'redeemPositions',
    args: [conditionId, amounts],
  });
  return { to: NEG_RISK_ADAPTER, data: calldata, value: '0' };
}

// ── On-chain oracle check (read-only via viem public client) ────────────────

async function checkPayoutDenominator(conditionId) {
  try {
    const client = getViemPublicClient();
    const result = await client.readContract({
      address: CTF_ADDRESS,
      abi: PAYOUT_DENOMINATOR_ABI,
      functionName: 'payoutDenominator',
      args: [conditionId],
    });
    return result;
  } catch (err) {
    log.warn(`payoutDenominator check failed: ${err.message}`);
    return null;
  }
}

/**
 * Polls for market resolution then redeems tokens via Relayer Client.
 */
async function pollAndRedeem(slug, attempt = 0) {
  const bet = getBet(slug);
  if (!bet) return;

  if (bet.redeemResult?.success) return;

  if (attempt >= REDEEM.maxAttempts) {
    log.warn(`${slug}: Gave up waiting for resolution after ${attempt} attempts.`);
    log.warn('  Tokens remain in wallet — redeem manually at any time (no deadline).');
    _ledger.get(slug).redeemResult = { success: false, reason: 'timeout' };
    return;
  }

  log.redeem(`${slug}: Checking resolution… (attempt ${attempt + 1}/${REDEEM.maxAttempts})`);

  // ── 1. Check Gamma API for resolution ─────────────────────────────────────
  const status = await checkMarketResolved(slug);

  if (!status || !status.resolved) {
    log.redeem(`  Not resolved yet — retrying in ${REDEEM.pollIntervalMs / 1000}s`);
    setTimeout(() => pollAndRedeem(slug, attempt + 1), REDEEM.pollIntervalMs);
    return;
  }

  log.divider();
  log.redeem(`✅ Market RESOLVED  —  ${slug}`);
  log.redeem(`   Outcome: ${status.outcome || 'unknown'}`);

  // ── 2. Determine win/loss ─────────────────────────────────────────────────
  const ourSide = bet.side.toUpperCase();
  const resolvedOutcome = (status.outcome || '').toUpperCase();
  const won = resolvedOutcome === ourSide;

  if (won) {
    log.redeem(`   🎉 We bet ${ourSide} — WE WON!`);
  } else {
    log.redeem(`   😞 We bet ${ourSide}, resolved ${resolvedOutcome} — loss.`);
  }

  // ── 3. Dry-run simulation ─────────────────────────────────────────────────
  if (CFG.dryRun) {
    const payout = won ? bet.sharesFilled * 1.00 : 0;
    const pnl = payout - bet.betSizeUsdc;
    const c = pnl >= 0 ? chalk.greenBright : chalk.redBright;

    log.dry(`[SIMULATED REDEEM] conditionId: ${bet.conditionId?.slice(0, 20)}…`);
    log.dry(`  Shares    : ${bet.sharesFilled.toFixed(4)}`);
    log.dry(`  Payout    : $${payout.toFixed(4)} USDC.e  (winning = $1.00/token, losing = $0.00)`);
    log.dry(`  P&L       : ${c(`${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)}`)}`);

    _ledger.get(slug).redeemResult = {
      success: true, txHash: `DRY-REDEEM-${Date.now()}`,
      usdcReceived: payout, pnl, outcome: resolvedOutcome, won,
    };
    return;
  }

  // ── 4. Guard: conditionId required ────────────────────────────────────────
  if (!bet.conditionId) {
    log.error(`  Missing conditionId for ${slug} — cannot redeem.`);
    _ledger.get(slug).redeemResult = { success: false, reason: 'no_condition_id' };
    return;
  }

  try {
    // ── 5. Verify oracle reported on-chain (payoutDenominator > 0) ──────────
    const payoutDenom = await checkPayoutDenominator(bet.conditionId);

    if (payoutDenom !== null) {
      log.redeem(`  On-chain payoutDenominator: ${payoutDenom.toString()}`);
      if (payoutDenom.toString() === '0' || payoutDenom === 0n) {
        log.warn('  Oracle has not reported on-chain yet (reportPayouts pending) — retrying…');
        setTimeout(() => pollAndRedeem(slug, attempt + 1), REDEEM.pollIntervalMs);
        return;
      }
    }

    // ── 6. Build and relay the redeem transaction ───────────────────────────
    const relay = getRelayClient();
    const isNegRisk = bet.negRisk === true;

    let redeemTx;
    let redeemLabel;

    if (isNegRisk) {
      // NegRisk adapter: pass token amounts [yesAmount, noAmount]
      // Redeem all tokens for both outcomes — winner pays $1, loser pays $0
      const yesAmount = won && ourSide === 'UP'
        ? BigInt(Math.floor(bet.sharesFilled * 1e6))
        : 0n;
      const noAmount = won && ourSide === 'DOWN'
        ? BigInt(Math.floor(bet.sharesFilled * 1e6))
        : 0n;

      redeemTx = buildNegRiskRedeemTx(bet.conditionId, [yesAmount, noAmount]);
      redeemLabel = 'NegRisk adapter redeem';
    } else {
      // Standard CTF redeem — burns all tokens for the condition, pays winners
      redeemTx = buildCtfRedeemTx(bet.conditionId);
      redeemLabel = 'CTF redeem';
    }

    log.redeem(`  Relaying ${redeemLabel} via Builder Relayer…`);
    log.redeem(`    Target   : ${redeemTx.to}`);
    log.redeem(`    Condition: ${bet.conditionId}`);
    log.redeem(`    Method   : redeemPositions`);
    log.redeem(`    Wallet   : ${CFG.signatureType === 1 ? 'PROXY' : 'SAFE'}`);

    const response = await relay.execute([redeemTx], `redeem ${slug}`);
    log.redeem(`  Tx relayed — waiting for confirmation…`);

    const result = await response.wait();

    if (result && result.transactionHash) {
      const payout = won ? bet.sharesFilled * 1.00 : 0;
      const pnl = payout - bet.betSizeUsdc;
      const c = pnl >= 0 ? chalk.greenBright : chalk.redBright;

      log.divider();
      console.log(chalk.bgCyan.black.bold('  ┌─────────────────────────────────────────┐  '));
      console.log(chalk.bgCyan.black.bold('  │       REDEMPTION CONFIRMED ✓            │  '));
      console.log(chalk.bgCyan.black.bold('  └─────────────────────────────────────────┘  '));
      console.log(chalk.white(`  Market     : ${slug}`));
      console.log(chalk.white(`  Tx Hash    : ${result.transactionHash}`));
      console.log(chalk.white(`  Block      : ${result.blockNumber || 'n/a'}`));
      console.log(chalk.white(`  Our bet    : ${ourSide}`));
      console.log(chalk.white(`  Outcome    : ${resolvedOutcome}`));
      console.log(chalk.white(`  Result     : ${won ? '🎉 WIN' : '😞 LOSS'}`));
      console.log(chalk.white(`  Shares     : ${bet.sharesFilled.toFixed(4)}`));
      console.log(chalk.white(`  Payout     : $${payout.toFixed(4)} USDC.e`));
      console.log(chalk.white(`  Cost       : $${bet.betSizeUsdc.toFixed(2)} USDC`));
      console.log(c(`  P&L        : ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)} USDC`));
      log.divider();

      _ledger.get(slug).redeemResult = {
        success: true,
        txHash: result.transactionHash,
        blockNumber: result.blockNumber || null,
        usdcReceived: payout,
        pnl,
        outcome: resolvedOutcome,
        won,
      };
    } else {
      log.error(`  Relay returned no transaction hash — redemption may have failed.`);
      _ledger.get(slug).redeemResult = { success: false, reason: 'no_tx_hash' };

      if (attempt < REDEEM.maxAttempts - 1) {
        log.info('  Retrying redemption in 30s…');
        setTimeout(() => pollAndRedeem(slug, attempt + 1), 30_000);
      }
    }

  } catch (err) {
    log.error(`  Redemption relay failed: ${err.message}`);

    if (err.message.includes('revert') || err.message.includes('CALL_EXCEPTION')) {
      log.warn('  This usually means the UMA oracle hasn\'t settled on-chain yet.');
      log.warn(`  Retrying in ${REDEEM.pollIntervalMs / 1000}s…`);
      setTimeout(() => pollAndRedeem(slug, attempt + 1), REDEEM.pollIntervalMs);
    } else if (err.message.includes('auth') || err.message.includes('401') || err.message.includes('403')) {
      log.error('  Builder authentication failed — check BUILDER_API_KEY / SECRET / PASSPHRASE');
      _ledger.get(slug).redeemResult = { success: false, reason: 'auth_failed' };
    } else {
      log.warn(`  Retrying in ${REDEEM.pollIntervalMs / 1000}s…`);
      setTimeout(() => pollAndRedeem(slug, attempt + 1), REDEEM.pollIntervalMs);
    }
  }
}

function scheduleRedemption(slug, asset) {
  const secsLeft = slugSecsLeft(slug);
  const delayMs = Math.max((secsLeft + 10) * 1000, 1000);
  log.info(`${asset.label}: Redemption poll starts in ${(delayMs / 1000).toFixed(0)}s (after expiry + 10s buffer)`);
  setTimeout(() => pollAndRedeem(slug, 0), delayMs);
}

// ──────────────────────────────────────────────────────────────────────────────
//  SECTION 11 — MARKET META CACHE + WS SUBSCRIPTIONS
// ──────────────────────────────────────────────────────────────────────────────

const _metaCacheMap = new Map();
let _wsSubscribed = new Set();

async function resolvedMeta(slug) {
  if (_metaCacheMap.has(slug)) return _metaCacheMap.get(slug);
  const meta = await fetchMarketMeta(slug);
  if (!meta) return null;
  _metaCacheMap.set(slug, meta);
  log.info(`  [${slug}] Market: "${meta.question}"`);
  log.info(`    UP   token: …${meta.upTokenId?.slice(-10)}`);
  log.info(`    DOWN token: …${meta.downTokenId?.slice(-10)}`);
  if (meta.negRisk) log.info(`    NegRisk  : YES`);
  return meta;
}

function ensureWsSubscription(meta) {
  const tokens = [meta.upTokenId, meta.downTokenId].filter(Boolean);
  const fresh = tokens.filter(t => !_wsSubscribed.has(t));
  if (fresh.length) {
    wsMonitor.subscribe(fresh);
    fresh.forEach(t => _wsSubscribed.add(t));
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//  SECTION 12 — POLL LOOP  (runs every POLL_INTERVAL_MS)
// ──────────────────────────────────────────────────────────────────────────────

const _pnlScheduled = new Set();
const _redeemScheduled = new Set();
const _bettedIntervals = new Set();

function scheduleSnapshotAndRedemption(slug, asset) {
  if (!_pnlScheduled.has(slug)) {
    _pnlScheduled.add(slug);
    const secsLeft = slugSecsLeft(slug);
    const snapDelay = Math.max((secsLeft - 1) * 1000, 500);
    log.info(`${asset.label}: P&L snapshot in ${(snapDelay / 1000).toFixed(1)}s`);
    setTimeout(() => takePnlSnapshot(slug), snapDelay);
  }

  if (!_redeemScheduled.has(slug)) {
    _redeemScheduled.add(slug);
    scheduleRedemption(slug, asset);
  }
}

async function evaluateAsset(asset, timeLeft) {
  const slug = buildSlug(asset.slugPrefix);

  const meta = await resolvedMeta(slug);
  if (!meta || !meta.upTokenId || !meta.downTokenId) {
    log.warn(`  ${asset.label}: market not indexed yet — skipping`);
    return null;
  }

  ensureWsSubscription(meta);

  const [upP, downP] = await Promise.all([
    livePrice(meta.upTokenId),
    livePrice(meta.downTokenId),
  ]);

  const src = wsMonitor.getPrice(meta.upTokenId) != null ? 'WS' : 'REST';
  log.scan(
    `  ${asset.emoji} ${asset.label.padEnd(3)}  UP: ${pct(upP).padStart(7)}  ` +
    `DOWN: ${pct(downP).padStart(7)}  (${src})`
  );

  const upFit = upP != null && upP > CFG.probMin && upP < CFG.probMax;
  const downFit = downP != null && downP > CFG.probMin && downP < CFG.probMax;

  if (!upFit && !downFit) return null;

  let side, price, tokenId;
  if (upFit && downFit) {
    if ((upP ?? 0) >= (downP ?? 0)) { side = 'UP'; price = upP; tokenId = meta.upTokenId; }
    else { side = 'DOWN'; price = downP; tokenId = meta.downTokenId; }
  } else if (upFit) {
    side = 'UP'; price = upP; tokenId = meta.upTokenId;
  } else {
    side = 'DOWN'; price = downP; tokenId = meta.downTokenId;
  }

  return { asset, slug, meta, side, price, tokenId };
}

async function poll() {
  const timeLeft = secsToExpiry();
  const intervalKey = currentIntervalKey();

  log.divider();
  log.scan(`⏱  ${timeLeft}s to expiry  |  interval: ${intervalStart()}`);

  for (const asset of CFG.assets) {
    const slug = buildSlug(asset.slugPrefix);
    if (hasBet(slug)) {
      scheduleSnapshotAndRedemption(slug, asset);
    }
  }

  if (timeLeft >= CFG.expiryThresholdSecs) return;

  if (_bettedIntervals.has(intervalKey)) {
    const bettedSlug = CFG.assets
      .map(a => buildSlug(a.slugPrefix))
      .find(s => hasBet(s));
    const b = bettedSlug ? getBet(bettedSlug) : null;
    if (b) log.scan(`Already bet this interval on ${bettedSlug} (${b.side} @ ${pct(b.fillPrice)}) — idle`);
    return;
  }

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

  log.divider();
  log.trade(`🎯  SIGNAL  —  ${asset.emoji} ${asset.label}`);
  log.trade(`    Slug    : ${slug}`);
  log.trade(`    Side    : ${side}`);
  log.trade(`    Prob    : ${pct(price)}`);
  log.trade(`    Bet     : $${CFG.betSizeUsdc} USDC`);
  log.trade(`    Expiry  : ${timeLeft}s`);
  log.divider();

  let orderId, fillPrice, sharesFilled;

  if (CFG.dryRun) {
    orderId = `DRY-${Date.now()}`;
    fillPrice = price;
    sharesFilled = CFG.betSizeUsdc / price;
    log.dry(`[SIMULATED] FOK BUY  ${asset.label} ${side}  $${CFG.betSizeUsdc}  @${pct(price)}`);
  } else {
    const result = await placeOrder({ tokenId, price, sizeUsdc: CFG.betSizeUsdc, label: `${asset.label}-${side}` });
    if (!result.success) {
      log.error(`Bet failed: ${result.detail}`);
      return;
    }
    orderId = result.orderId;
    fillPrice = result.fillPrice ?? price;
    sharesFilled = result.sharesFilled ?? CFG.betSizeUsdc / price;
  }

  recordBet(slug, {
    side,
    asset: asset.label,
    betSizeUsdc: CFG.betSizeUsdc,
    orderId,
    fillPrice,
    sharesFilled,
    tokenId,
    conditionId: signal.meta.conditionId || null,
    negRisk: signal.meta.negRisk || false,
    placedAt: new Date().toISOString(),
  });

  _bettedIntervals.add(intervalKey);
  log.ok(`Bet recorded ✓  ${asset.label} ${side}  orderId=${orderId}`);

  scheduleSnapshotAndRedemption(slug, asset);
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
    const redeem = b.redeemResult;

    console.log(chalk.cyan(`  ${b.slug}`));
    console.log(`    Asset    : ${b.asset || 'unknown'}`);
    console.log(`    Side     : ${b.side}`);
    console.log(`    Order    : ${b.orderId}`);
    console.log(`    Fill     : ${pct(b.fillPrice)}  × ${b.sharesFilled?.toFixed(4)} shares`);
    console.log(`    Cost     : $${b.betSizeUsdc}`);

    if (redeem?.success) {
      totalPnl += redeem.pnl;
      const plColour = redeem.pnl >= 0 ? chalk.green : chalk.red;
      console.log(`    Outcome  : ${redeem.won ? '🎉 WIN' : '😞 LOSS'}  (${redeem.outcome})`);
      console.log(`    Redeemed : ✅  tx: ${redeem.txHash?.slice(0, 20)}…`);
      console.log(`    Payout   : $${redeem.usdcReceived?.toFixed(4)} USDC.e`);
      console.log(`    P&L      : ${plColour(`${redeem.pnl >= 0 ? '+' : ''}$${redeem.pnl.toFixed(4)}`)}`);
    } else if (redeem) {
      console.log(chalk.yellow(`    Redeem   : ❌ ${redeem.reason || 'failed'} — tokens remain in wallet (redeemable anytime)`));
    } else {
      console.log(chalk.gray('    Redeem   : ⏳ pending (resolution not yet detected)'));
    }

    if (snap) {
      const pl = snap.unrealisedPnl;
      if (!redeem?.success) totalPnl += pl;
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

const hasBuilderCreds = !!(CFG.builderApiKey && CFG.builderSecret && CFG.builderPassphrase);

log.divider();
console.log('');
console.log('   🤖  Polymarket Multi-Asset 5-Minute Up/Down Bot  (single-file)');
console.log('');
console.log(`   Assets     :  BTC (1st) → XRP (2nd) → SOL (3rd)  [priority order]`);
console.log(`   Strategy   :  ${pct(CFG.probMin)} < P < ${pct(CFG.probMax)}  — first qualifying asset wins`);
console.log(`   Trigger    :  last ${CFG.expiryThresholdSecs}s before expiry`);
console.log(`   Bet size   :  $${CFG.betSizeUsdc} USDC  (one bet per 5-min window)`);
console.log(`   Redeem     :  Builder Relayer Client (gasless, Safe/Proxy)`);
console.log(`   P&L snap   :  T − 1s before market close`);
console.log(`   Auth type  :  ${CFG.signatureType === 0 ? '0 — EOA / MetaMask' : CFG.signatureType === 1 ? '1 — Google / Magic Link proxy' : '2 — Gnosis Safe'}`);
console.log(`   Builder    :  ${hasBuilderCreds ? '✅ credentials set' : '⚠️  NOT SET (redemption will fail)'}`);
console.log(`   Mode       :  ${CFG.dryRun ? '✅  DRY-RUN (no real orders)' : '🔴  LIVE TRADING'}`);
console.log(`   Poll       :  every ${CFG.pollIntervalMs}ms`);
console.log(`   Redeem     :  poll every ${REDEEM.pollIntervalMs / 1000}s, up to ${REDEEM.maxAttempts} attempts`);
console.log('');
log.divider();

if (!CFG.dryRun) {
  if (!CFG.privateKey || CFG.privateKey === '0xYOUR_PRIVATE_KEY_HERE') { log.error('PRIVATE_KEY missing/placeholder in .env'); process.exit(1); }
  if (!CFG.funderAddress || CFG.funderAddress === '0xYOUR_WALLET_ADDRESS_HERE') { log.error('FUNDER_ADDRESS missing/placeholder in .env'); process.exit(1); }

  log.info('Initialising CLOB trader…');
  try {
    await initTrader();
    log.ok('Trader ready.');
  } catch (err) {
    log.error(`Trader init failed: ${err.message}`);
    process.exit(1);
  }

  // Verify Polygon RPC for on-chain reads (payoutDenominator check)
  log.info('Verifying Polygon RPC connectivity (viem public client)…');
  try {
    const blockNum = await getViemPublicClient().getBlockNumber();
    log.ok(`Polygon RPC connected — latest block: ${blockNum}`);
  } catch (err) {
    log.warn(`Polygon RPC check failed: ${err.message}`);
    log.warn('payoutDenominator pre-check will be skipped — relayer will still attempt redemption.');
  }

  // Initialise relayer client (validates Builder creds)
  log.info('Initialising Builder Relayer Client…');
  try {
    getRelayClient();
  } catch (err) {
    log.error(`Relayer init failed: ${err.message}`);
    log.warn('Redemption will not work — but bets can still be placed.');
  }

} else {
  log.dry('Trader + Relayer init skipped (dry-run).');
}

process.on('uncaughtException', err => log.error(`Uncaught: ${err.message}`));
process.on('unhandledRejection', err => log.error(`Unhandled rejection: ${err}`));

process.on('SIGINT', () => { printSessionSummary(); wsMonitor.close(); process.exit(0); });
process.on('SIGTERM', () => { printSessionSummary(); wsMonitor.close(); process.exit(0); });

log.info(`Polling every ${CFG.pollIntervalMs}ms — press Ctrl+C to stop`);

await poll();
setInterval(poll, CFG.pollIntervalMs);
