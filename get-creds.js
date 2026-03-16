// get-creds.js  —  Polymarket API credential generator
// Run once:  node get-creds.js
// Then paste the 3 output lines into your .env

import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet }    from 'ethers';
import axios         from 'axios';

const HOST   = 'https://clob.polymarket.com';
const PK     = process.env.PRIVATE_KEY;
const FUNDER = process.env.FUNDER_ADDRESS;
const SIG    = parseInt(process.env.SIGNATURE_TYPE ?? '1', 10);

if (!PK || PK.includes('YOUR_PRIVATE')) {
  console.error('\nERROR: Set PRIVATE_KEY in .env first.\n'); process.exit(1);
}

const signer = new Wallet(PK);
const EOA    = signer.address;

console.log('\n' + '─'.repeat(64));
console.log('  Polymarket credential generator');
console.log('─'.repeat(64));
console.log(`\n  EOA (from private key) : ${EOA}`);
console.log(`  FUNDER_ADDRESS in .env : ${FUNDER || '(not set)'}`);
console.log(`  SIGNATURE_TYPE         : ${SIG}\n`);

// ── Network check ────────────────────────────────────────────────────────────
let serverTs;
try {
  const { data } = await axios.get(`${HOST}/time`, { timeout: 5000 });
  serverTs = data.time ?? Math.floor(Date.now() / 1000);
  console.log(`  Server time OK: ${serverTs}\n`);
} catch (e) {
  console.error(`ERROR: Cannot reach ${HOST}\n`); process.exit(1);
}

// ── Normalise credentials — SDK uses both .key and .apiKey in different versions
function normaliseCreds(r) {
  if (!r) return null;
  if (r.error) return null;
  // SDK may return { key, secret, passphrase } OR { apiKey, secret, passphrase }
  const apiKey = r.apiKey || r.key;
  if (!apiKey) return null;
  return { apiKey, secret: r.secret, passphrase: r.passphrase };
}

// ── Helper ────────────────────────────────────────────────────────────────────
async function tryCreds(label, fn) {
  try {
    const raw    = await fn();
    const creds  = normaliseCreds(raw);
    if (creds) {
      console.log(`  ✓  ${label}`);
      return creds;
    }
    // Log what came back so we can diagnose
    console.log(`  ✗  ${label}: response=${JSON.stringify(raw)}`);
  } catch (e) {
    const msg = e.message?.replace(/\[CLOB Client\] request error [\s\S]*/m, '').trim() || e.message;
    console.log(`  ✗  ${label}: ${msg}`);
  }
  return null;
}

// ── Attempt 1: plain client — deriveApiKey ONLY (GET, not POST) ───────────────
// This should work for accounts that already have keys from browser trading.
console.log('Attempt 1: deriveApiKey with plain client…');
const plain = new ClobClient(HOST, 137, signer);
let creds = await tryCreds('deriveApiKey (plain)', () => plain.deriveApiKey());

// ── Attempt 2: plain client — createOrDeriveApiKey ───────────────────────────
if (!creds) {
  console.log('\nAttempt 2: createOrDeriveApiKey with plain client…');
  creds = await tryCreds('createOrDeriveApiKey (plain)', () => plain.createOrDeriveApiKey());
}

// ── Attempt 3: full client with signatureType + funder ────────────────────────
if (!creds && FUNDER) {
  console.log('\nAttempt 3: deriveApiKey with full client (sig type + funder)…');
  const full = new ClobClient(HOST, 137, signer, undefined, SIG, FUNDER);
  creds = await tryCreds('deriveApiKey (full)', () => full.deriveApiKey());
  if (!creds)
    creds = await tryCreds('createOrDeriveApiKey (full)', () => full.createOrDeriveApiKey());
}

// ── Attempt 4: raw HTTP GET /auth/api-key (derive only, no create) ─────────────
if (!creds) {
  console.log('\nAttempt 4: raw HTTP GET /auth/api-key (derive existing key)…');
  try {
    const domain = { name: 'ClobAuthDomain', version: '1', chainId: 137 };
    const types  = { ClobAuth: [
      { name: 'address',   type: 'address' },
      { name: 'timestamp', type: 'string'  },
      { name: 'nonce',     type: 'uint256' },
      { name: 'message',   type: 'string'  },
    ]};

    // Try nonce 0 first, then 1, then 2
    for (const nonce of [0, 1, 2]) {
      const ts  = Math.floor(Date.now() / 1000);
      const val = { address: EOA, timestamp: String(ts), nonce, message: 'This message attests that I control the given wallet' };
      const sig = await signer._signTypedData(domain, types, val);
      const hdrs = { 'POLY_ADDRESS': EOA, 'POLY_SIGNATURE': sig, 'POLY_TIMESTAMP': String(ts), 'POLY_NONCE': String(nonce) };

      try {
        // GET = derive existing key
        const { data } = await axios.get(`${HOST}/auth/api-key`, { headers: hdrs, timeout: 8000 });
        const norm = normaliseCreds(data);
        if (norm) {
          console.log(`  ✓  GET /auth/api-key nonce=${nonce}`);
          creds = norm;
          break;
        }
        console.log(`  ✗  GET nonce=${nonce}: ${JSON.stringify(data)}`);
      } catch (e) {
        console.log(`  ✗  GET nonce=${nonce}: ${JSON.stringify(e.response?.data ?? e.message)}`);
      }
    }
  } catch (e) {
    console.log(`  ✗  raw GET setup error: ${e.message}`);
  }
}

// ── Attempt 5: raw HTTP POST with funder address as POLY_ADDRESS ───────────────
// Some proxy wallet setups require POLY_ADDRESS = proxy address (not EOA)
if (!creds && FUNDER) {
  console.log('\nAttempt 5: raw HTTP with POLY_ADDRESS = proxy/funder address…');
  try {
    const domain = { name: 'ClobAuthDomain', version: '1', chainId: 137 };
    const types  = { ClobAuth: [
      { name: 'address',   type: 'address' },
      { name: 'timestamp', type: 'string'  },
      { name: 'nonce',     type: 'uint256' },
      { name: 'message',   type: 'string'  },
    ]};

    for (const [polyAddr, label] of [[EOA, 'EOA'], [FUNDER, 'PROXY']]) {
      const ts  = Math.floor(Date.now() / 1000);
      const val = { address: polyAddr, timestamp: String(ts), nonce: 0, message: 'This message attests that I control the given wallet' };
      const sig = await signer._signTypedData(domain, types, val);
      const hdrs = { 'POLY_ADDRESS': polyAddr, 'POLY_SIGNATURE': sig, 'POLY_TIMESTAMP': String(ts), 'POLY_NONCE': '0', 'Content-Type': 'application/json' };

      try {
        const { data } = await axios.get(`${HOST}/auth/api-key`, { headers: hdrs, timeout: 8000 });
        const norm = normaliseCreds(data);
        if (norm) { console.log(`  ✓  GET with POLY_ADDRESS=${label}`); creds = norm; break; }
        console.log(`  ✗  GET POLY_ADDRESS=${label}: ${JSON.stringify(data)}`);
      } catch (e) {
        console.log(`  ✗  GET POLY_ADDRESS=${label}: ${JSON.stringify(e.response?.data ?? e.message)}`);
      }
    }
  } catch (e) {
    console.log(`  ✗  Attempt 5 error: ${e.message}`);
  }
}

// ── Result ────────────────────────────────────────────────────────────────────
if (!creds) {
  console.log('\n' + '─'.repeat(64));
  console.log('All attempts failed.\n');
  console.log('DIAGNOSIS:');
  console.log(`  Your EOA  : ${EOA}`);
  console.log(`  Your PROXY: ${FUNDER}`);
  console.log('');
  console.log('The "Could not create api key" error from Polymarket means the server');
  console.log('is rejecting the request. Most common cause for an active account:');
  console.log('');
  console.log('  → Your PRIVATE_KEY may not match your account.');
  console.log('    The key you use must be the one that controls proxy', FUNDER);
  console.log('');
  console.log('  Try this: Go to polymarket.com → Cash → ⋯ menu → Export Private Key');
  console.log('  (NOT reveal.magic.link — use the in-app export directly)');
  console.log('  Paste that key as PRIVATE_KEY in .env and re-run.\n');
  process.exit(1);
}

console.log('\n' + '─'.repeat(64));
console.log('SUCCESS — paste these 3 lines into your .env:\n');
console.log(`CLOB_API_KEY=${creds.apiKey}`);
console.log(`CLOB_SECRET=${creds.secret}`);
console.log(`CLOB_PASSPHRASE=${creds.passphrase}`);
console.log('\n' + '─'.repeat(64));
console.log('\nDone!  Run:  node bot.js\n');
