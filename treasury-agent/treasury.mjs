#!/usr/bin/env node
/**
 * Lunium treasury agent — move BRL programmatically, with the ceilings read at runtime.
 *
 * The whole point of this file: an agent that moves money must not carry the limits
 * in its source code. Tiers change, daily buckets reset, routes unlock as volume
 * settles. Every number printed below is read from GET /keys/me and GET /catalog
 * on this run. Search this file for a hardcoded real — there is none.
 *
 * Requires Node >= 18 (native fetch). No dependencies.
 * Runs against the public sandbox: no money moves, no signup, key created at runtime.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Fail loudly on an old runtime instead of dying on `AbortSignal.timeout is not a function`.
if (typeof fetch !== 'function' || typeof AbortSignal?.timeout !== 'function') {
  console.error(`This example needs Node 18+ (native fetch + AbortSignal.timeout). You are on ${process.version}.`);
  process.exit(1);
}

const BASE = process.env.LUNIUM_BASE || 'https://api.luniumpay.com';
const HTTP_TIMEOUT_MS = 15_000;
const POLL_BUDGET_MS = 210_000;

/* The sandbox hands out 10 keys per IP per day and they never expire with use, so a
 * script that mints a fresh one on every run bricks the repo by the eleventh run —
 * and a key you never printed is a key you cannot fall back to. Cache it next to the
 * script (gitignored, 0600) and reuse it. */
const KEY_CACHE = join(dirname(fileURLToPath(import.meta.url)), '.lunium-sandbox-key');
const readCachedKey = () => { try { return readFileSync(KEY_CACHE, 'utf8').trim() || null; } catch { return null; } };
const cacheKey = (k) => { try { writeFileSync(KEY_CACHE, k + '\n', { mode: 0o600 }); return true; } catch { return false; } };
const maskKey = (k) => `${k.slice(0, 17)}...`;

/* ------------------------------------------------------------------ *
 * HTTP layer
 * ------------------------------------------------------------------ */

class LuniumError extends Error {
  constructor(status, body, method, path) {
    super(body?.detail || body?.erro || `HTTP ${status} on ${method} ${path}`);
    this.name = 'LuniumError';
    this.status = status;
    this.code = body?.erro ?? null;       // machine-readable error id
    this.action = body?.acao ?? null;     // "parar" (stop) | "corrigir" (fix) | "esperar" (wait)
    this.limits = body?.limits ?? null;   // filled on limit refusals: the numbers you were judged by
    this.requestId = body?.request_id ?? null;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `retries` is deliberately 0 for anything that moves money. A retried POST is a
 * double payment waiting to happen; idempotency comes from `external_id` instead.
 * Reads are retried on 429/5xx only — a 4xx is a decision the server already made.
 */
async function call(method, path, { key = null, body = null, retries = 0 } = {}) {
  const headers = { accept: 'application/json' };
  if (key) headers['X-API-Key'] = key;
  if (body) headers['content-type'] = 'application/json';

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(400 * 2 ** attempt);

    let res;
    try {
      res = await fetch(BASE + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (e) {
      lastErr = new Error(`network failure on ${method} ${path}: ${e.message}`);
      continue;
    }

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }

    if (res.ok) return json ?? {};

    const err = new LuniumError(res.status, json, method, path);
    if ((res.status === 429 || res.status >= 500) && attempt < retries) { lastErr = err; continue; }
    throw err;
  }
  throw lastErr;
}

const get  = (path, key) => call('GET',  path, { key, retries: 2 });
const post = (path, key, body) => call('POST', path, { key, body });

/* ------------------------------------------------------------------ *
 * Money helpers — integer cents everywhere, never a float
 * ------------------------------------------------------------------ */

const brl = (cents) =>
  Number.isFinite(cents)
    ? (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    : 'no cap';

const decimals = (cents) => (cents / 100).toFixed(2);

/** Smallest legal amount for a route, bumped to a whole real so the cents are ours
 *  to use as a sandbox trigger. Derived from the API's minimum — not from a constant. */
const smallestWithTrigger = (minCents, trigger) => {
  // If the server did not state a minimum, we do not get to guess one. Inventing a
  // fallback here is exactly the hardcoded limit this example exists to argue against.
  if (!Number.isFinite(minCents) || minCents <= 0) {
    throw new Error('GET /keys/me returned no minimum for this route — refusing to invent one');
  }
  return Math.ceil(minCents / 100) * 100 + trigger;
};

const line = (ch = '-') => console.log(ch.repeat(78));
const head = (n, total, title) => { console.log(); line('='); console.log(`[${n}/${total}] ${title}`); line('='); };

/* ------------------------------------------------------------------ *
 * The headroom model — everything below is derived, nothing is assumed
 * ------------------------------------------------------------------ */

/**
 * Three BRL routes share one wallet but not one ceiling:
 *   cash-in  PIX in  -> crypto out    (counts against the key's daily bucket)
 *   payout   PIX out, no crypto leg   (same daily bucket; unlocks with settled volume)
 *   cash-out crypto in -> PIX out     (no daily bucket on the key; capped per receiving CPF/CNPJ)
 *
 * The ceiling that actually binds is the MINIMUM of every cap that applies. That is
 * the only arithmetic a treasury agent really needs, and it must run on fresh numbers.
 */
function buildHeadroom(me) {
  const L = me.limits;
  const bucket = {
    cap: L.daily_limit_cents,
    used: L.used_today_cents,
    left: L.available_today_cents,
    appliesTo: L.daily_limit_applies_to || [],
  };

  const routeSpec = [
    { id: 'cash-in',  op: 'cashin',  endpoint: 'POST /cashin/charge', enabled: me.key.cashin_enabled,  lock: null },
    { id: 'payout',   op: 'payout',  endpoint: 'POST /payouts',       enabled: me.key.payout_enabled,  lock: me.payout },
    { id: 'cash-out', op: 'cashout', endpoint: 'POST /cash-outs',     enabled: me.key.cashout_enabled, lock: null },
  ];

  return {
    bucket,
    routes: routeSpec.map((r) => {
      const perOp = L.per_operation[r.op] || {};
      const usesBucket = bucket.appliesTo.includes(r.id);
      const dailyLeft = usesBucket ? bucket.left : (L[r.op]?.daily_limit_cents ?? null);

      // Extra ceilings that are not the key's own bucket.
      const extra = [];
      if (r.id === 'cash-out' && L.payee_limits?.daily_cents) {
        extra.push({ label: `per receiving ${L.payee_limits.scope}/day`, cents: L.payee_limits.daily_cents });
      }
      // The payer ladder is a SECOND, independent axis: it caps the payer, not the key.
      // Folding it into the key's ceiling would understate what the key can do all day.
      const note = r.id === 'cash-in' && L.payer_limits
        ? `payer ladder on top: ${brl(L.payer_limits.first_transaction_cents)} first transaction,` +
          ` maturing to ${brl(L.payer_limits.mature_daily_cents)}/day — check GET /cashin/limits per payer`
        : null;

      const caps = [perOp.max_brl_cents, dailyLeft, ...extra.map((e) => e.cents)]
        .filter((c) => typeof c === 'number');
      const ceiling = caps.length ? Math.min(...caps) : Infinity;
      const binding =
        ceiling === dailyLeft ? "today's remaining bucket"
        : ceiling === perOp.max_brl_cents ? 'per-transaction max'
        : (extra.find((e) => e.cents === ceiling)?.label ?? 'per-transaction max');

      return {
        ...r,
        note,
        min: perOp.min_brl_cents ?? null,
        max: perOp.max_brl_cents ?? null,
        usesBucket,
        dailyLeft: dailyLeft ?? Infinity,
        extra,
        ceiling,
        binding,
        // how many minimum-sized operations still fit today
        opsLeft: r.enabled && perOp.min_brl_cents && Number.isFinite(dailyLeft ?? Infinity)
          ? Math.floor((dailyLeft ?? 0) / perOp.min_brl_cents)
          : Infinity,
      };
    }),
  };
}

function printHeadroom(h, me) {
  const L = me.limits;
  console.log(`tier "${L.tier}"  ·  settled volume ${brl(L.settled_volume_cents)}` +
    (L.next_tier ? `  ·  next tier "${L.next_tier.tier}" at ${brl(L.next_tier.unlocks_at_settled_volume_cents)}` +
      ` (daily ${brl(L.next_tier.daily_limit_cents)})` : ''));
  console.log(`shared daily bucket [${h.bucket.appliesTo.join(' + ')}]: ` +
    `${brl(h.bucket.cap)} cap · ${brl(h.bucket.used)} used · ${brl(h.bucket.left)} left`);
  console.log();

  const cols = [['route', 9], ['min', 12], ['max', 14], ['left today', 14], ['fits now', 14], ['status', 9]];
  console.log(cols.map(([t, w]) => t.padEnd(w)).join(''));
  line();
  for (const r of h.routes) {
    console.log(
      r.id.padEnd(9) +
      brl(r.min).padEnd(12) +
      brl(r.max).padEnd(14) +
      (Number.isFinite(r.dailyLeft) ? brl(r.dailyLeft) : 'no daily cap').padEnd(14) +
      (r.enabled ? brl(r.ceiling) : '-').padEnd(14) +
      (r.enabled ? 'open' : 'LOCKED')
    );
    console.log(`  ${r.endpoint}  ->  binding constraint: ${r.enabled ? r.binding : 'route not unlocked'}`);
    for (const e of r.extra) console.log(`  also capped at ${brl(e.cents)} ${e.label}`);
    if (r.note) console.log(`  ${r.note}`);
    if (Number.isFinite(r.opsLeft)) console.log(`  room for ${r.opsLeft} more minimum-sized operations today`);
    if (!r.enabled && r.lock) {
      console.log(`  unlocks automatically at ${brl(r.lock.unlocks_at_settled_volume_cents)} settled` +
        ` — ${brl(r.lock.remaining_cents)} to go`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * A local ledger: what this agent believes it committed today.
 * The server is the authority; the ledger exists to be reconciled against it.
 * ------------------------------------------------------------------ */

const ledger = { committed: [], get totalCents() { return this.committed.reduce((s, e) => s + e.cents, 0); } };

/** The guard that runs BEFORE the network call. Cheaper than a 400, and it is the
 *  only thing standing between a looping agent and its own daily cap. */
function guard(route, cents) {
  if (!route.enabled) return { ok: false, why: `route "${route.id}" is locked on this key` };
  if (cents < route.min) return { ok: false, why: `${brl(cents)} is below the ${brl(route.min)} minimum` };
  if (cents > route.ceiling) return { ok: false, why: `${brl(cents)} exceeds ${brl(route.ceiling)} (${route.binding})` };
  if (route.usesBucket && ledger.totalCents + cents > route.dailyLeft) {
    return { ok: false, why: `local ledger already committed ${brl(ledger.totalCents)} of ${brl(route.dailyLeft)}` };
  }
  return { ok: true };
}

/** Every API refusal carries `acao`: what the caller should do next. Branch on it. */
function explain(err) {
  if (!(err instanceof LuniumError)) {
    // Timeout, DNS, TLS, unparseable body: the server never rendered a verdict, so there
    // is no `acao` to branch on. Silence is not consent — treat it as STOP.
    console.log(`  no answer from the server: ${err.message}`);
    console.log('  nothing to branch on -> treat an unanswered write as STOP, never as success');
    return;
  }
  const plan = {
    parar:    'STOP — do not retry; a human or a config change is required',
    corrigir: 'FIX — change the request and try again',
    esperar:  'WAIT — the condition clears on its own; retry later',
  }[err.action] || 'UNKNOWN action, treat as STOP';
  console.log(`  refused: ${err.status} ${err.code}  ->  ${plan}`);
  console.log(`  server said: ${err.message}`);
  if (err.limits) console.log(`  limits object: ${JSON.stringify(err.limits)}`);
  if (err.requestId) console.log(`  request_id: ${err.requestId}  (quote this in support)`);
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'EXPIRED', 'REFUNDED', 'CANCELLED', 'CANCELED']);

async function main() {
  const runId = `treasury-${Date.now()}`;
  console.log(`Lunium treasury agent  ·  ${BASE}  ·  run ${runId}`);

  /* 1 — credentials. No secret in this repository: the key is minted at runtime and
   *     then cached on disk, because the sandbox allows only 10 keys per IP per day
   *     and a key that is never persisted cannot be reused after the cap is hit. */
  head(1, 7, 'sandbox key');
  const fromEnv = process.env.LUNIUM_API_KEY || null;
  let key = fromEnv || readCachedKey();
  if (key) {
    console.log(`reusing ${maskKey(key)}  (from ${fromEnv ? 'LUNIUM_API_KEY' : KEY_CACHE})`);
    console.log('  sandbox keys never expire with use — re-running costs nothing from the daily quota');
  } else {
    const k = await post('/keys/sandbox', null, { name: 'treasury-agent' });
    key = k.api_key;
    console.log(`minted ${k.key.prefix}...  (sandbox=${k.sandbox}, fee ${k.key.fee_bps} bps, ${k.key.rate_limit_per_minute} req/min)`);
    if (cacheKey(key)) console.log(`  cached to ${KEY_CACHE} — the next run reuses it instead of minting another`);
    else console.log(`  could not write the cache; copy this now or you will burn another:  LUNIUM_API_KEY=${key}`);
  }

  /* 2 — the ceilings, read fresh. */
  head(2, 7, 'GET /keys/me — the ceilings, read at runtime');
  const me = await get('/keys/me', key);
  const h = buildHeadroom(me);
  printHeadroom(h, me);

  /* 3 — what can actually be settled. */
  head(3, 7, 'GET /catalog — what this key can settle');
  const cat = await get('/catalog', key);
  console.log(`fast rails (seconds to settle): ${cat.fast.map((f) => `${f.asset}/${f.network}`).join(', ')}`);
  const networks = new Set(cat.convert.flatMap((c) => c.networks));
  console.log(`convert rail: ${cat.convert.length} assets across ${networks.size} networks`);
  console.log(`dex rail: whitelisted tokens on ${cat.dex.chains.join(', ')}`);
  const rail = cat.fast[0];
  const railLimits = cat.convert.find((c) => c.asset === rail.asset);
  console.log(`chosen settlement rail: ${rail.asset} on ${rail.network}` +
    (railLimits ? ` (crypto-side range ${railLimits.min}–${railLimits.max} ${rail.asset})` : ''));

  /* 4 — per-payer headroom, the other axis nobody remembers to check. */
  head(4, 7, 'GET /cashin/limits — headroom of one specific payer');
  const payerTax = '11144477735'; // a synthetic CPF; sandbox never sees a real one
  try {
    const pl = await get(`/cashin/limits?payer_tax=${payerTax}`, key);
    console.log(`payer ${pl.payer_tax}  stage "${pl.stage}"`);
    console.log(`  ${brl(pl.available_cents)} available of ${brl(pl.limit_cents)} (used ${brl(pl.used_cents)})`);
    console.log(`  ${pl.explicacao}`);
    const ci = h.routes.find((r) => r.id === 'cash-in');
    console.log(`  two axes: the KEY allows ${brl(ci.ceiling)} per charge, this PAYER allows ${brl(pl.max_amount_cents)}`);
    console.log(`  => the charge you may actually create is ${brl(Math.min(ci.ceiling, pl.max_amount_cents))}` +
      ` — always the smaller of the two`);
  } catch (e) { explain(e); }

  /* 5 — the bad paths, on purpose. */
  head(5, 7, 'guard rails — four refusals, and the fix each one calls for');
  const cashout = h.routes.find((r) => r.id === 'cash-out');
  const payoutRoute = h.routes.find((r) => r.id === 'payout');

  console.log('(a) local guard, no network call: ask for one cent above the ceiling');
  const overshoot = cashout.ceiling + 1;
  const g = guard(cashout, overshoot);
  console.log(`  requested ${brl(overshoot)} on cash-out -> ${g.ok ? 'allowed' : 'BLOCKED LOCALLY: ' + g.why}`);

  console.log('\n(b) route lock: try the direct-PIX payout the key has not unlocked yet');
  try {
    const r = await post('/payouts', key, {
      amount_cents: smallestWithTrigger(payoutRoute.min, 0),
      pix_key: 'tesouraria@exemplo.com',
      pix_key_type: 'email',
      external_id: `${runId}-payout`,
    });
    console.log(`  payout accepted: ${JSON.stringify(r).slice(0, 160)}`);
  } catch (e) {
    explain(e);
  }

  console.log('\n(c) sandbox trigger .04: a quote the server refuses on limits');
  const refusedCents = smallestWithTrigger(cashout.min, 4);
  try {
    await post('/cash-outs', key, {
      asset: rail.asset, network: rail.network,
      brl_amount: decimals(refusedCents),
      pix_key: 'tesouraria@exemplo.com', pix_key_type: 'email',
      external_id: `${runId}-refused`,
    });
    console.log('  unexpected: the .04 trigger did not refuse');
  } catch (e) {
    explain(e);
  }

  console.log('\n(d) sandbox trigger .03: the quote expires before you get around to accepting it');
  const staleCents = smallestWithTrigger(cashout.min, 3);
  try {
    const stale = await post('/cash-outs', key, {
      asset: rail.asset, network: rail.network,
      brl_amount: decimals(staleCents),
      pix_key: 'tesouraria@exemplo.com', pix_key_type: 'email',
      external_id: `${runId}-stale`,
    });
    console.log(`  quoted ${stale.cashout_id}, priced at ${stale.amount} ${stale.asset}, valid until ${stale.expires_at}`);
    console.log('  now deliberately sitting on it past expiry, the way a slow approval loop would');
    await sleep(7000);
    await post(`/cash-outs/${stale.cashout_id}/accept`, key, {});
    console.log('  unexpected: the expired quote was still accepted');
  } catch (e) {
    explain(e);
    console.log('  note the fix "corrigir" means a NEW quote, not a repeated accept: the price is what');
    console.log('  went stale, so retrying the same accept can never succeed — and blind POST retries');
    console.log('  against a write that moves money are how an agent pays twice.');
  }

  /* 6 — the actual payout, through the route that is open. */
  head(6, 7, 'execute a small payout on the open route');
  const amountCents = smallestWithTrigger(cashout.min, 1); // .01 => sandbox holds it, then settles
  console.log(`route chosen: cash-out (payout is locked) · amount ${brl(amountCents)} = ` +
    `the ${brl(cashout.min)} minimum rounded up, plus the .01 sandbox trigger (held, then settles on its own)`);

  const pre = guard(cashout, amountCents);
  if (!pre.ok) { console.log(`  blocked locally: ${pre.why}`); return; }
  console.log('  local guard: pass');

  const quote = await post('/cash-outs', key, {
    asset: rail.asset, network: rail.network,
    brl_amount: decimals(amountCents),
    pix_key: 'tesouraria@exemplo.com', pix_key_type: 'email',
    external_id: `${runId}-payout-real`, // idempotency key: this is why POSTs are never retried blindly
  });
  ledger.committed.push({ id: quote.cashout_id, cents: amountCents });
  console.log(`  quote ${quote.cashout_id}: deposit ${quote.amount} ${quote.asset} -> PIX ${brl(amountCents)}`);
  console.log(`  quote expires ${quote.expires_at} — accept before that or it dies unaccepted`);

  const accepted = await post(`/cash-outs/${quote.cashout_id}/accept`, key, {});
  console.log(`  accepted: state ${accepted.state}, deposit address ${accepted.deposit_address}`);
  console.log('  (sandbox settles without a real deposit; in production this address must be funded)');

  const started = Date.now();
  let order = accepted, delay = 3000;
  while (!TERMINAL.has(order.state) && Date.now() - started < POLL_BUDGET_MS) {
    await sleep(delay);
    delay = Math.min(delay * 1.4, 12_000); // back off: a held order is not an emergency
    order = await get(`/cash-outs/${quote.cashout_id}`, key);
    const secs = String(Math.round((Date.now() - started) / 1000)).padStart(3);
    console.log(`  +${secs}s  ${order.state}${order.state === 'MANUAL_REVIEW' ? '  (provider holding — this is the .01 trigger, not a failure)' : ''}`);
  }

  if (order.state === 'COMPLETED') {
    console.log(`  settled: E2E ${order.pix_e2e} at ${order.pix_paid_at}`);
    console.log(`  auditable at ${order.verify_url}`);
  } else {
    console.log(`  ended in ${order.state} — treasury must reconcile this one by hand`);
    ledger.committed = ledger.committed.filter((e) => e.id !== quote.cashout_id);
  }

  /* 7 — reconcile the local ledger against the server's own count. */
  head(7, 7, 'reconciliation — re-read the ceilings, never assume them');
  const after = buildHeadroom(await get('/keys/me', key));
  console.log(`local ledger committed today: ${brl(ledger.totalCents)} across ${ledger.committed.length} operation(s)`);
  console.log(`server bucket now: ${brl(after.bucket.used)} used of ${brl(after.bucket.cap)}, ` +
    `${brl(after.bucket.left)} left  (bucket covers ${after.bucket.appliesTo.join(' + ')})`);
  const drift = ledger.totalCents - after.bucket.used;
  console.log(`drift: ${brl(Math.abs(drift))} — expected here: cash-out is not in the daily bucket,` +
    ' and sandbox volume never accrues to the tier. Reconcile against the server, not the ledger.');
  console.log();
  for (const r of after.routes) {
    if (!r.enabled) { console.log(`  still fits today on ${r.id.padEnd(9)}: nothing — route locked`); continue; }
    console.log(`  still fits today on ${r.id.padEnd(9)}: ${brl(r.ceiling)} per operation` +
      (Number.isFinite(r.dailyLeft) ? `, ${brl(r.dailyLeft)} total` : ', no daily total'));
  }

  /* keyless proof: anyone can verify the E2E without credentials. */
  if (order.pix_e2e) {
    console.log();
    const v = await get(`/v1/verificar/${order.pix_e2e}`, null);
    console.log(`keyless verification of ${order.pix_e2e} (no X-API-Key sent):`);
    console.log(`  verificado=${v.verificado} pago=${v.pago} valor=${v.valor_brl} em ${v.pago_em}` +
      (v.sandbox ? ' [sandbox]' : ''));
    console.log('  anyone holding the E2E can audit this payout without credentials.');
  }
}

main().catch((e) => {
  console.error();
  if (e instanceof LuniumError) {
    console.error(`FATAL ${e.status} ${e.code} — ${e.message}`);
    if (e.requestId) console.error(`request_id: ${e.requestId}`);
    if (e.code === 'limite_de_chaves_teste') {
      console.error('hint: the sandbox allows 10 keys per IP per day; they do not expire with use.');
      console.error(`      this script caches the key it mints at ${KEY_CACHE},`);
      console.error('      so a normal re-run never mints a second one. If you hit the cap before that');
      console.error('      cache existed, reuse any lun_test_ key you already have:');
      console.error('        LUNIUM_API_KEY=lun_test_... node treasury.mjs');
      console.error('      Otherwise the quota renews at midnight (America/Sao_Paulo).');
    }
  } else {
    console.error(`FATAL ${e.message}`);
  }
  process.exitCode = 1;
});
