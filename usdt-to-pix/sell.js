#!/usr/bin/env node
'use strict';
/**
 * Sell USDT (Polygon) and get paid to a PIX key.
 * Lunium API · plain Node 18+ · zero dependencies.
 *
 * What this file is actually trying to teach:
 *   1. Limits are DATA, not constants. They come from GET /keys/me. Never hardcode a number.
 *   2. Refuse locally what the API would refuse anyway. A 403 in production is a terrible
 *      way to find out what your limits are.
 *   3. The quote is the price oracle. When you sell a crypto amount you don't know the
 *      reais until the API tells you — so guard the QUOTED reais, right before you accept.
 *   4. Poll with backoff. Treat an unknown state as "keep waiting", never as a crash.
 *   5. The unhappy path is a first-class path, not an afterthought.
 *
 * Usage:
 *   node sell.js                          # happy path (12.00 USDT)
 *   node sell.js --amount 10.02           # sandbox trigger: the order FAILS
 *   node sell.js --brl 100                # sell by reais instead of by crypto
 *   node sell.js --brl 300000             # refused before any cash-out call, from live limits
 *   node sell.js --expire                 # drives a real API error: cotacao_expirada
 *
 * Env:
 *   LUNIUM_API_KEY   optional. Omit it and this script mints a free sandbox key at runtime.
 *   LUNIUM_BASE_URL  optional. Defaults to https://api.luniumpay.com
 *
 * Exit codes: 0 completed · 1 order failed · 2 refused locally · 3 refused by the API
 *             4 polling budget exhausted · 5 environment (API unreachable / no key available)
 */

const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.LUNIUM_BASE_URL || 'https://api.luniumpay.com';

// ---------------------------------------------------------------- tiny utils

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// An amount we could not parse is NOT zero. Printing "R$ 0,00" for a real payout is
// how a display bug becomes a support ticket, so unparseable stays visibly unparseable.
const money = (cents) =>
  cents == null || !Number.isFinite(cents)
    ? '(unparseable amount)'
    : (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Reais as a decimal string -> integer cents. No floats: money and binary fractions don't mix. */
function toCents(value) {
  const m = String(value).trim().replace(',', '.').match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] || '0').padEnd(2, '0'));
}

const say = (s = '') => console.log(s);
const step = (n, s) => console.log(`\n\x1b[1m${n}. ${s}\x1b[0m`);
const warn = (s) => console.log(`   ! ${s}`);

function humanDuration(ms) {
  if (ms < 0) return 'expired';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

// ---------------------------------------------------------------- http layer

/**
 * Every Lunium error has the same shape:
 *   { erro, acao, detail, request_id, limits? }
 * `acao` is the part worth reading: "corrigir" means YOUR input is wrong and retrying
 * the exact same call will fail the exact same way. Anything else may be worth a retry.
 */
class LuniumError extends Error {
  constructor(status, body, headerRequestId) {
    super(body?.detail || body?.erro || `HTTP ${status}`);
    this.name = 'LuniumError';
    this.status = status;
    this.code = body?.erro || null;
    this.action = body?.acao || null;
    this.limits = body?.limits || null;
    this.retryAfterS = Number(body?.retry_after_s) || 0;
    this.requestId = body?.request_id || headerRequestId || null;
  }
  get retryable() {
    return this.action !== 'corrigir' && (this.status === 429 || this.status >= 500);
  }
}

/** Longest server-requested pause we are willing to sleep through inside a retry. */
const MAX_RETRY_AFTER_S = 30;

const backoff = (attempt, base = 500, cap = 8000) =>
  Math.min(cap, base * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);

async function api(path, { method = 'GET', body, key, tries = 4 } = {}) {
  let last;
  for (let attempt = 1; attempt <= tries; attempt++) {
    let res, text;
    try {
      res = await fetch(BASE + path, {
        method,
        headers: { 'content-type': 'application/json', ...(key ? { 'X-API-Key': key } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      text = await res.text();
    } catch (e) {
      // Network/timeout. A dropped connection is not a "no" — you don't know if the
      // server acted. Retrying is safe here because the same external_id is carried along.
      last = Object.assign(new Error(`could not reach ${BASE}${path} — ${e.message}`), {
        retryable: true,
        kind: 'network', // an unreachable API is an environment problem, not a failed order
        hint: `   Tried ${tries}x. Is this machine online? Is LUNIUM_BASE_URL right (${BASE})?`,
      });
      if (attempt === tries) throw last;
      await sleep(backoff(attempt));
      continue;
    }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* server sent non-JSON */ }
    if (res.ok) return json ?? {};

    const err = new LuniumError(res.status, json, res.headers.get('x-request-id'));
    if (!err.retryable || attempt === tries) throw err;

    // Honour Retry-After, but never blindly. This endpoint can answer a 429 with
    // retry-after: 83323 (the daily quota resets at midnight). Sleeping on that
    // inside a retry loop is not patience, it is a hang. Above the ceiling we
    // stop and let the caller decide.
    const retryAfter = Number(res.headers.get('retry-after')) || err.retryAfterS || 0;
    if (retryAfter > MAX_RETRY_AFTER_S) {
      err.message += `  [server asked for ${retryAfter}s — too long to sleep on, not retrying]`;
      throw err;
    }
    await sleep(retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
    last = err;
  }
  throw last;
}

// ---------------------------------------------------------------- the flow

const KEY_CACHE = path.join(__dirname, '.lunium-sandbox-key'); // gitignored, sandbox only

async function getKey() {
  if (process.env.LUNIUM_API_KEY) {
    say(`   using LUNIUM_API_KEY from the environment (${process.env.LUNIUM_API_KEY.slice(0, 12)}…)`);
    return process.env.LUNIUM_API_KEY;
  }
  // Reuse before you mint. Sandbox keys are capped at 10 per day per IP and they
  // never expire, so a script that mints one per run walls itself off by lunchtime.
  try {
    const cached = fs.readFileSync(KEY_CACHE, 'utf8').trim();
    if (cached.startsWith('lun_test_')) {
      say(`   reusing the cached sandbox key from ${path.basename(KEY_CACHE)} (${cached.slice(0, 16)}…)`);
      return cached;
    }
  } catch { /* no cache yet — mint one below */ }

  try {
    const r = await api('/keys/sandbox', { method: 'POST', body: { name: 'usdt-to-pix-example' } });
    try { fs.writeFileSync(KEY_CACHE, r.api_key, { mode: 0o600 }); } catch { /* read-only fs is fine */ }
    say(`   minted a sandbox key: ${r.api_key.slice(0, 16)}…  (no signup, no secret committed)`);
    return r.api_key;
  } catch (e) {
    if (e instanceof LuniumError && e.code === 'limite_de_chaves_teste') {
      // 10 keys per day PER IP. On a shared or office IP you can hit this on your very
      // first run, having minted nothing. That is not a crash and not a failed order.
      e.kind = 'setup';
      e.message = 'out of sandbox keys for today (10 per day per IP, resets at midnight)';
      e.hint = [
        '   Any lun_test_ key from an earlier run still works — they never expire:',
        '     LUNIUM_API_KEY=lun_test_… node sell.js',
        '   If a teammate on your IP already made one, reuse theirs. Nothing here needs a fresh key.',
      ].join('\n');
    }
    throw e;
  }
}

/**
 * The whole point of this function: these numbers are READ, never written.
 * When Lunium raises the ceiling tomorrow, this script picks it up with no code change.
 */
function readLimits(me) {
  const l = me?.limits || {};
  const co = l.per_operation?.cashout || l.cashout || {};
  return {
    tier: l.tier || null,
    minCents: num(co.min_brl_cents),
    maxCents: num(co.max_brl_cents),
    payeeDailyCents: num(l.payee_limits?.daily_cents),
    payeeScope: l.payee_limits?.scope || 'payee',
    feeBps: num(me?.key?.fee_bps),
    sandbox: Boolean(me?.key?.sandbox),
    cashoutEnabled: me?.key?.cashout_enabled !== false,
  };
}

function guard(cents, lim) {
  if (lim.minCents == null || lim.maxCents == null) {
    warn('/keys/me did not return cash-out min/max. Not inventing numbers — deferring to the API.');
    return [];
  }
  const problems = [];
  if (cents < lim.minCents) problems.push(`${money(cents)} is below the per-transaction minimum of ${money(lim.minCents)}`);
  if (cents > lim.maxCents) problems.push(`${money(cents)} is above the per-transaction maximum of ${money(lim.maxCents)}`);
  if (lim.payeeDailyCents != null && cents > lim.payeeDailyCents) {
    problems.push(`${money(cents)} in one order already exceeds the ${money(lim.payeeDailyCents)} daily cap per ${lim.payeeScope}`);
  }
  return problems;
}

function showRate(q, feeBps) {
  const amount = Number(q.amount);
  const brl = Number(q.brl_amount);
  if (!(amount > 0) || !(brl > 0)) return;
  const rate = brl / amount;
  say(`   implied rate      ${rate.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 4 })} per ${q.asset}`);
  say(`                     (brl_amount ÷ amount — the only rate that is a promise)`);
  if (feeBps != null) {
    const gross = rate / (1 - feeBps / 10_000);
    say(`   your key's fee    ${feeBps} bps (${(feeBps / 100).toFixed(2)}%), read from /keys/me`);
    say(`   ⇒ gross rate      ~${gross.toFixed(4)} per ${q.asset}  (derived for intuition, not a quoted number)`);
  }
}

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'REFUNDED', 'EXPIRED', 'CANCELLED', 'CANCELED']);

async function poll(key, id, { budgetMs = 6 * 60_000 } = {}) {
  const t0 = Date.now();
  let delay = 2000, seen = null, dots = 0;
  while (Date.now() - t0 < budgetMs) {
    const o = await api(`/cash-outs/${id}`, { key });
    if (o.state !== seen) {
      if (dots) { process.stdout.write('\n'); dots = 0; }
      seen = o.state;
      const known = TERMINAL.has(o.state) ? '' : ' (waiting)';
      say(`   [+${humanDuration(Date.now() - t0).padStart(7)}] ${o.state}${known}`);
    } else {
      process.stdout.write('.'); dots++;
    }
    if (TERMINAL.has(o.state)) { if (dots) process.stdout.write('\n'); return o; }
    await sleep(delay);
    delay = Math.min(Math.round(delay * 1.6), 15_000); // gentle: the key allows 60 req/min
  }
  if (dots) process.stdout.write('\n');
  return null; // budget exhausted — see main(): this is NOT the same as a failed order
}

// ---------------------------------------------------------------- cli

function parseArgs(argv) {
  const out = { asset: 'USDT', network: 'polygon', pixKey: 'demo@lunium.dev', pixKeyType: 'email' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) { console.error(`missing value after ${flag}`); process.exit(2); }
      return v;
    };
    if (flag === '--amount') out.amount = val();
    else if (flag === '--brl') out.brl = val();
    else if (flag === '--pix-key') out.pixKey = val();
    else if (flag === '--pix-key-type') out.pixKeyType = val();
    else if (flag === '--asset') out.asset = val();
    else if (flag === '--network') out.network = val();
    else if (flag === '--expire') out.expire = true;
    else if (flag === '-h' || flag === '--help') out.help = true;
    else { console.error(`unknown flag: ${flag}`); process.exit(2); }
  }
  if (out.amount && out.brl) { console.error('use --amount OR --brl, not both'); process.exit(2); }
  if (out.expire) {
    // The 5s-expiry trigger is chosen by the last two decimals of `amount`.
    if (out.brl) { console.error('--expire is driven by --amount (a .03 value), so it cannot be combined with --brl'); process.exit(2); }
    if (!out.amount || !/\.03$/.test(out.amount)) out.amount = '10.03';
  }
  if (!out.amount && !out.brl) out.amount = '12.00';
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    say('node sell.js [--amount <crypto> | --brl <reais>] [--pix-key <key>] [--pix-key-type cpf|cnpj|phone|email|random]');
    say('             [--asset USDT] [--network polygon]');
    say('');
    say('  node sell.js                 happy path, 12.00 USDT');
    say('  node sell.js --amount 10.02  sandbox trigger: the order FAILS');
    say('  node sell.js --brl 300000    refused before any cash-out call, from live limits');
    say('  node sell.js --expire        waits out the quote, so the accept hits cotacao_expirada');
    return 0;
  }

  say('\x1b[1mUSDT (Polygon) → PIX · Lunium\x1b[0m');
  say(`base: ${BASE}`);

  // 1 ─────────────────────────────────────────────────────────── credentials
  step(1, 'Get a key');
  const key = await getKey();

  // 2 ──────────────────────────────────────────────────── limits, from the API
  step(2, 'Read YOUR limits from GET /keys/me (never hardcode these)');
  const me = await api('/keys/me', { key });
  const lim = readLimits(me);
  say(`   tier              ${lim.tier ?? 'n/a'}${lim.sandbox ? '   [SANDBOX — no money moves]' : ''}`);
  say(`   cash-out per tx   ${lim.minCents != null ? money(lim.minCents) : '?'} … ${lim.maxCents != null ? money(lim.maxCents) : '?'}`);
  say(`   payee daily cap   ${lim.payeeDailyCents != null ? `${money(lim.payeeDailyCents)} per ${lim.payeeScope}` : 'not reported'}`);
  if (!lim.cashoutEnabled) { warn('this key has cash-out disabled — stopping here'); return 2; }

  // 3 ───────────────────────────────── local guard, BEFORE spending a round-trip
  step(3, 'Guard the amount locally');
  if (args.brl) {
    const cents = toCents(args.brl);
    if (cents == null) { warn(`--brl ${args.brl} is not a valid amount in reais`); return 2; }
    const problems = guard(cents, lim);
    if (problems.length) {
      say(`   \x1b[31mrefused locally\x1b[0m — no cash-out was sent (only /keys/me, to learn these numbers):`);
      for (const p of problems) say(`     · ${p}`);
      say(`   Those numbers came from /keys/me a second ago. Nothing is hardcoded here,`);
      say(`   so the day the ceiling moves this check moves with it.`);
      return 2;
    }
    say(`   ${money(cents)} fits inside the limits above → proceeding`);
  } else {
    if (!/^\d+(\.\d{1,8})?$/.test(String(args.amount).trim())) {
      warn(`--amount ${args.amount} is not a plain decimal: use a dot, not a comma (10.02, not 10,02)`);
      return 2;
    }
    say(`   selling ${args.amount} ${args.asset}: the reais are unknown until the API quotes it,`);
    say(`   so the guard runs in step 5, on the quoted value, right before accepting.`);
  }

  // 4 ──────────────────────────────────────────────────────────────── quote
  const externalId = `usdt-to-pix-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  step(4, 'Quote — POST /cash-outs');
  say(`   external_id ${externalId}  ← generate and persist this BEFORE the call:`);
  say(`   if the response is lost in the network, it is the only handle you have on the order.`);
  const body = {
    asset: args.asset,
    network: args.network,
    pix_key: args.pixKey,
    pix_key_type: args.pixKeyType,
    external_id: externalId,
    ...(args.brl ? { brl_amount: args.brl } : { amount: args.amount }),
  };

  let quote;
  try {
    quote = await api('/cash-outs', { method: 'POST', body, key });
  } catch (e) {
    if (!(e instanceof LuniumError)) throw e;
    say(`   \x1b[31mAPI refused the quote\x1b[0m`);
    say(`     erro       ${e.code}`);
    say(`     acao       ${e.action}${e.action === 'corrigir' ? '  ← do not retry, fix the input' : ''}`);
    say(`     detail     ${e.message}`);
    say(`     request_id ${e.requestId}   ← quote this to support, it is the whole story`);
    if (e.limits) say(`     limits     ${JSON.stringify(e.limits)}   ← the API hands you the numbers, use them`);
    return 3;
  }
  say(`   cashout_id        ${quote.cashout_id}`);
  say(`   selling           ${quote.amount} ${quote.asset} on ${quote.network}`);
  say(`   you receive       ${money(toCents(quote.brl_amount))} to ${quote.pix_key_type}:${quote.pix_key}`);
  showRate(quote, lim.feeBps);

  // 5 ─────────────────────────── guard the QUOTED value before committing to it
  step(5, 'Guard the quoted value, then accept');
  const quotedCents = toCents(quote.brl_amount);
  if (quotedCents == null) {
    // Skipping the check because the value looked odd would accept an amount we cannot
    // verify. An unparseable price is not a price.
    say(`   \x1b[31mrefusing to accept\x1b[0m — brl_amount ${JSON.stringify(quote.brl_amount)} did not parse as reais,`);
    say(`   so the limit check could not run. Refusing beats accepting a number you cannot check.`);
    return 2;
  }
  const problems = guard(quotedCents, lim);
  if (problems.length) {
    say(`   \x1b[31mrefusing to accept\x1b[0m — the quote came back outside your limits:`);
    for (const p of problems) say(`     · ${p}`);
    say(`   A quote is free and uncommitted. Walking away here costs nothing.`);
    return 2;
  }
  say(`   ${money(quotedCents)} is inside your limits → accepting`);

  if (args.expire) {
    const ms = new Date(quote.expires_at).getTime() - Date.now();
    const waitMs = Math.max(0, ms) + 3000;
    say(`   \x1b[33m--expire\x1b[0m: this quote dies in ${humanDuration(ms)}. Waiting ${humanDuration(waitMs)} on purpose`);
    say(`   so the accept below runs against a price that no longer exists.`);
    await sleep(waitMs);
  }

  let order;
  try {
    order = await api(`/cash-outs/${quote.cashout_id}/accept`, { method: 'POST', body: {}, key });
  } catch (e) {
    if (!(e instanceof LuniumError)) throw e;
    say(`   \x1b[31maccept refused\x1b[0m: ${e.code} — ${e.message}  (request_id ${e.requestId})`);
    if (e.code === 'cotacao_expirada') say(`   The price you were holding is gone. Quote again — never retry the accept.`);
    return 3;
  }

  // 6 ────────────────────────────────────────────── where to send, and by when
  step(6, 'Send the deposit');
  const msLeft = new Date(order.expires_at).getTime() - Date.now();
  say(`   state             ${order.state}`);
  say(`   deposit address   ${order.deposit_address}   (${order.network})`);
  if (order.deposit_tag) say(`   deposit tag/memo  ${order.deposit_tag}   ← REQUIRED; a deposit without it is a lost deposit`);
  say(`   send exactly      ${order.amount} ${order.asset}`);
  say(`   deadline          ${order.expires_at}  (${humanDuration(msLeft)} from now)`);
  say(`   after the deadline the quote is dead: quote again, do not re-accept.`);
  if (order.sandbox) say(`   \x1b[33m${order.aviso_sandbox}\x1b[0m`);

  // 7 ─────────────────────────────────────────────────── poll with backoff
  step(7, 'Poll with backoff (2s → 15s, cap)');
  const final = await poll(key, order.cashout_id);

  if (!final) {
    say(`\n   \x1b[33mpolling budget exhausted\x1b[0m — and that is NOT a failed order.`);
    say(`   The order is alive server-side. Keep ${order.cashout_id} / ${externalId}, resume polling,`);
    say(`   or register a webhook and stop polling altogether.`);
    return 4;
  }

  // 8 ──────────────────────────────────────────────────────────── outcome
  step(8, `Outcome: ${final.state}`);
  if (final.state === 'COMPLETED') {
    say(`   paid              ${money(toCents(final.brl_amount))} to ${final.pix_key}`);
    say(`   PIX E2E           ${final.pix_e2e}`);
    say(`   paid at           ${final.pix_paid_at}`);
    if (final.verify_url) {
      say(`   verify            ${final.verify_url}`);
      try {
        const v = await api(`/v1/verificar/${final.pix_e2e}`); // deliberately: no key, no header
        say(`   ↳ checked with NO api key at all:`);
        say(`     pago=${v.pago}  valor_brl=${v.valor_brl}  instituicao=${v.instituicao}`);
        say(`     recebedor=${v.recebedor_iniciais}  ← initials only: proof of payment, not a data leak`);
        say(`   Anyone your customer forwards that link to can check the payment. You are not the proof.`);
      } catch (e) {
        warn(`verification lookup failed: ${e.message}`);
      }
    }
    return 0;
  }

  say(`   \x1b[31mthe order did not pay out\x1b[0m`);
  say(`   cashout_id        ${final.cashout_id}`);
  say(`   external_id       ${final.external_id}`);
  say(`   refund address    ${final.refund_address ?? 'null'}`);
  say(`   refund tx         ${final.refund_tx_hash ?? 'null'}`);
  say(`   Read this honestly: a terminal ${final.state} carries no free-text reason field.`);
  say(`   So do not screen-scrape one. What you do instead:`);
  say(`     · ${final.state} is terminal. Never re-accept and never re-send to ${final.deposit_address}.`);
  say(`     · If crypto did arrive, refund_address / refund_tx_hash is where it goes back —`);
  say(`       poll those two fields instead of guessing.`);
  say(`     · Open support with cashout_id + external_id. Those two identify it completely.`);
  say(`     · For the customer: quote again. A new quote is a new price, not a retry.`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    // An unreachable API or an exhausted key quota is an environment problem. Exiting 1
    // would claim "the order failed", which is a lie, and a stack trace tells the reader
    // nothing they can act on. Both get their own code and one actionable line.
    if (e?.kind === 'network' || e?.kind === 'setup') {
      console.error(`\n\x1b[31m${e.message}\x1b[0m`);
      if (e.hint) console.error(e.hint);
      process.exit(5);
    }
    console.error(`\n\x1b[31munhandled: ${e.stack || e.message}\x1b[0m`);
    process.exit(1);
  });
