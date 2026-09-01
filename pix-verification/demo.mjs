/**
 * Proving a PIX settled — without an API key.
 *
 *   node demo.mjs
 *
 * Node 18+. No dependencies, no config, no secrets. The sandbox key used to
 * MINT a payment is created at runtime and thrown away. The verification
 * itself uses no key at all — that is the whole demonstration.
 */
import {
  verifyPix,
  acceptPayment,
  parseE2E,
  brlToCents,
  centsToBrl,
  verifyUrl,
  SANDBOX_ISPB,
  DEFAULT_BASE_URL as BASE,
} from './verify.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let act = 0;
const section = (title) => console.log(`\n${'─'.repeat(66)}\n${++act}. ${title}\n${'─'.repeat(66)}`);
const line = (k, v) => console.log(`   ${String(k).padEnd(22)} ${v}`);
const verdict = (r) =>
  `${r.accepted ? 'ACCEPT' : 'REJECT'}${r.accepted ? '' : `  (${r.reason})`}`;

/** Keyed call — used only to CREATE payments, never to verify one. */
async function api(path, { method = 'GET', key, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      accept: 'application/json',
      ...(key ? { 'X-API-Key': key } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

/** Run a sandbox cash-out to completion so we own a genuine E2E. */
async function settleOne(key, amount, label) {
  const quote = await api('/cash-outs', {
    method: 'POST',
    key,
    body: {
      asset: 'USDT',
      network: 'polygon',
      amount,
      pix_key: 'demo@lunium.dev',
      pix_key_type: 'email',
      external_id: `pix-verification-${label}-${Date.now()}`,
    },
  });
  if (quote.body?.erro) return { refused: quote.body };

  const id = quote.body.cashout_id;
  await api(`/cash-outs/${id}/accept`, { method: 'POST', key });

  for (let i = 0; i < 20; i++) {
    const { body } = await api(`/cash-outs/${id}`, { key });
    if (['COMPLETED', 'FAILED', 'REFUNDED', 'EXPIRED'].includes(body.state)) return body;
    await sleep(2500);
  }
  return { state: 'TIMED_OUT' };
}

/**
 * A real, settled, PRODUCTION payment, used when we cannot mint one of our own.
 * It is safe to publish: the endpoint returns initials only — no PIX key, no
 * full name, no CPF. This is the same identifier the README shows.
 */
const PUBLIC_EXAMPLE_E2E = 'E37293930202607312006361894c4a82';

/**
 * Get a sandbox key. Reuses $LUNIUM_API_KEY when set, because minting keys is
 * capped at 10 per day per IP — a real limit a public example will hit.
 *
 * Returns null rather than exiting. Losing the key costs us the MINTING half
 * of the demo; the VERIFICATION half needs no credential and is the entire
 * point of this repository, so it must still run. A clone that prints nothing
 * on a shared office IP teaches the reader nothing.
 */
async function getSandboxKey() {
  if (process.env.LUNIUM_API_KEY) {
    console.log('   using $LUNIUM_API_KEY from the environment');
    return process.env.LUNIUM_API_KEY;
  }
  let body;
  try {
    ({ body } = await api('/keys/sandbox', {
      method: 'POST',
      body: { name: 'pix-verification-demo' },
    }));
  } catch (error) {
    console.log(`   Could not reach the key endpoint: ${error?.message ?? error}`);
    return null;
  }
  if (body?.api_key) return body.api_key;

  console.log(`   No sandbox key this run: ${body?.erro ?? 'unknown'}`);
  if (body?.detail) console.log(`   ${body.detail}`);
  if (body?.retry_after_s) {
    console.log(`   Renews in ~${Math.ceil(body.retry_after_s / 3600)}h. To use a key you already have:`);
  } else {
    console.log('   To use a key you already have:');
  }
  console.log('     LUNIUM_API_KEY=lun_test_… node demo.mjs');
  console.log('\n   Continuing WITHOUT a key. Everything below that verifies a payment');
  console.log('   needs no credential, so it still runs — that is the whole thesis.');
  return null;
}

// ── 1 ────────────────────────────────────────────────────────────────────
section('Limits come from the API, never from the source code');
const KEY = await getSandboxKey();

let co = null;
if (KEY) {
  const { status: meStatus, body: me } = await api('/keys/me', { key: KEY });
  if (!me?.limits) {
    console.error(`   GET /keys/me returned HTTP ${meStatus}: ${JSON.stringify(me).slice(0, 200)}`);
    console.error('   Is $LUNIUM_API_KEY a valid sandbox key? Unset it to mint a fresh one.');
    process.exit(1);
  }
  co = me.limits.per_operation.cashout;
  line('tier', me.limits.tier);
  line('cash-out per operation', `${centsToBrl(co.min_brl_cents)} .. ${centsToBrl(co.max_brl_cents)} BRL`);
  line('cash-in per operation', `${centsToBrl(me.limits.per_operation.cashin.min_brl_cents)} .. ${centsToBrl(me.limits.per_operation.cashin.max_brl_cents)} BRL`);
  line('payee daily cap', `${centsToBrl(me.limits.payee_limits.daily_cents)} BRL per CPF/CNPJ`);
  console.log('   These numbers moved before and will move again. Read them; do not ship them.');
} else {
  console.log('   (skipped — GET /keys/me is the one call here that needs a key)');
  console.log('   Limits live at GET /keys/me and nowhere else. There is no constant in');
  console.log('   this repository holding a minimum or a maximum, precisely so that a');
  console.log('   change on the server cannot leave this code quietly wrong.');
}

// ── 2 ────────────────────────────────────────────────────────────────────
section('Mint a real settled payment (this part DOES need a key)');
let settled = null;
let E2E = PUBLIC_EXAMPLE_E2E;

if (KEY) {
  settled = await settleOne(KEY, '10.00', 'ok');
  if (!settled.pix_e2e) {
    console.error(`   Expected a settled order, got: ${JSON.stringify(settled).slice(0, 300)}`);
    process.exit(1);
  }
  E2E = settled.pix_e2e;
  line('state', settled.state);
  line('amount', `${settled.amount} USDT -> BRL ${settled.brl_amount}`);
  line('E2E', E2E);
  const quoted = brlToCents(settled.brl_amount);
  line('within limits?', quoted >= co.min_brl_cents && quoted <= co.max_brl_cents ? 'yes (checked against /keys/me)' : 'NO');
} else {
  console.log('   (skipped — no key, so we borrow a payment already on the record)');
  line('E2E', E2E);
}
const parts = parseE2E(E2E);
line('  ispb', `${parts.ispb}  (${parts.ispb === SANDBOX_ISPB ? '00000000 = sandbox, belongs to no institution' : 'a real Banco Central participant'})`);
line('  stamp', parts.stamp);

// ── 3 ────────────────────────────────────────────────────────────────────
section('Verify it with NO credential — the front door');
console.log(`   GET ${verifyUrl(E2E)}`);
console.log('   headers: { accept: application/json }   <- no X-API-Key, no Authorization\n');
const found = await verifyPix(E2E);
if (!found.ok) {
  console.error(`   Could not verify ${E2E}: ${found.reason} — ${found.detail ?? ''}`);
  console.error('   Everything below reads from this payment, so there is nothing to show.');
  console.error('   If you are offline, that is the cause; the verifier is a public GET.');
  process.exit(1);
}
line('ok', found.ok);
line('settled by', found.payment.settledBy);
line('amount', `BRL ${found.payment.amountBrl} (${found.payment.amountCents} cents)`);
line('paid at', found.payment.paidAtRaw);
line('receiver', found.payment.receiverInitials);
line('institution', found.payment.institution);
line('sandbox flag', found.payment.sandbox);
console.log('   Note what is NOT here: no PIX key, no full name, no CPF.');
console.log('   It proves the payment without exposing either party.');

// ── 4 ────────────────────────────────────────────────────────────────────
section('The three answers you must handle');
const shapes = [
  ['exists', E2E],
  ['well-formed, never settled here', 'E60746948202608311200abc12345678'],
  ['malformed', 'E123-not-an-e2e'],
];
for (const [label, id] of shapes) {
  const r = await verifyPix(id);
  console.log(`   ${label}`);
  line('  -> ok', r.ok);
  line('  -> reason', r.ok ? '(verified)' : r.reason);
  if (!r.ok) line('  -> detail', (r.detail ?? '').slice(0, 96));
}
console.log('\n   "not_found" means Lunium did not settle it. It does NOT mean the PIX');
console.log('   never happened — another institution may have. Absence is not disproof.');

// ── 5 ────────────────────────────────────────────────────────────────────
section('How a third party uses this for a payment it did not make');
console.log('   Someone says "I paid you, here is the E2E". You have no key, no');
console.log('   account, and no view of their bank. verificado:true is NOT enough.\n');

// Read what is owed off the VERIFIED payment, not off the order we created —
// this half of the demo must work for someone who has no key and no order.
const owed = found.payment.amountCents;
const ledger = new Set();
const sandboxProof = found.payment.sandbox;

// The demo E2E is freshly minted when we have a key, and a months-old
// production payment when we do not. Widen the freshness window in the second
// case so the OTHER checks are what we are actually reading.
const AGE = sandboxProof ? 60 : 5_000_000;
const base = { allowSandbox: true, maxAgeMinutes: AGE };

const scenarios = [
  [sandboxProof
    ? 'honest claim, but sandbox proof offered as real money'
    : 'production payment, sandbox proof not permitted (this one is production)',
    E2E, { amountCents: owed, maxAgeMinutes: AGE, allowSandbox: false }],
  ['invented E2E ("trust me, I paid")',
    'E60746948202608311200abc12345678', { ...base, amountCents: owed }],
  ['real payment, wrong amount (owed 1 centavo more)',
    E2E, { ...base, amountCents: owed + 1 }],
  ['real payment, but older than the freshness window allows',
    E2E, { ...base, amountCents: owed, maxAgeMinutes: 0 }],
  // The two fail-open holes a policy function must not have. Both of these
  // used to be ACCEPTED, because a check that is skipped is a check that passes.
  ['caller FORGOT to pass the amount at all',
    E2E, { ...base }],
  ['amount arrived as a STRING off a JSON body — parsed, not skipped',
    E2E, { ...base, amountCents: String(owed) }],
  ['amount is junk the caller never validated',
    E2E, { ...base, amountCents: 'twenty reais' }],
];

for (const [label, id, expectation] of scenarios) {
  const r = await acceptPayment(id, expectation);
  console.log(`   ${label}`);
  console.log(`     ${verdict(r)}`);
  for (const c of r.checks) console.log(`       ${c.pass ? 'ok  ' : 'FAIL'} ${c.name.padEnd(14)} ${c.detail}`);
}

console.log('\n   ...and the same E2E twice, against a ledger that remembers:');
const first = await acceptPayment(E2E, { ...base, amountCents: owed, alreadyCredited: ledger });
console.log(`     first  -> ${verdict(first)}`);
if (first.accepted) ledger.add(first.payment.e2e);
const second = await acceptPayment(E2E, { ...base, amountCents: owed, alreadyCredited: ledger });
console.log(`     second -> ${verdict(second)}`);
// A plain Array is what most people reach for before they reach for a Set.
// It must behave, not throw: acceptPayment promises a verdict, always.
const asArray = await acceptPayment(E2E, { ...base, amountCents: owed, alreadyCredited: [E2E] });
console.log(`     ledger given as a plain Array -> ${verdict(asArray)}`);

// ── 6 ────────────────────────────────────────────────────────────────────
section('The bad path, on purpose (sandbox triggers)');
if (KEY) {
  console.log('   Trigger .02 — the payout fails. A failed order never earns an E2E,');
  console.log('   so there is nothing to verify, and the verifier says so.\n');
  const failed = await settleOne(KEY, '10.02', 'fail');
  line('state', failed.state);
  line('pix_e2e', String(failed.pix_e2e));
  line('verify_url', String(failed.verify_url));
  console.log('   A payer could still hand you a plausible-looking id. Check it:');
  const bogus = await verifyPix('E00000000202609010040deadbeef000');
  line('  -> ok', bogus.ok);
  line('  -> reason', bogus.reason);
  line('  -> detail', (bogus.detail ?? '').slice(0, 90));

  console.log('\n   Trigger .04 — refused for limits. Even the ERROR carries live numbers:\n');
  const refused = await settleOne(KEY, '10.04', 'limit');
  if (refused.refused) {
    line('erro', refused.refused.erro);
    line('acao', refused.refused.acao);
    line('limits.min_brl_cents', refused.refused.limits?.min_brl_cents);
    line('limits.max_brl_cents', refused.refused.limits?.max_brl_cents);
    console.log('   Read those. Do not paste them into a constant.');
  }
} else {
  console.log('   (skipped — the .02/.04 triggers need a key to place an order)');
}

// ── 7 ────────────────────────────────────────────────────────────────────
section('When the verifier itself is unreachable');
console.log('   The branch that decides whether your checkout blocks or leaks.');
console.log('   Pointed at a dead port, with a 1s timeout — no network needed.\n');
const down = await verifyPix(E2E, { baseUrl: 'http://127.0.0.1:9', timeoutMs: 1000 });
line('ok', down.ok);
line('reason', down.reason);
line('detail', (down.detail ?? '').slice(0, 80));
console.log('\n   verifyPix did not throw — it returned a verdict, so your handler');
console.log('   cannot forget a try/catch and credit the order by accident.');
const downVerdict = await acceptPayment(E2E, { ...base, amountCents: owed },
  { baseUrl: 'http://127.0.0.1:9', timeoutMs: 1000 });
line('acceptPayment', verdict(downVerdict));
console.log('   "Cannot check" is NOT "checked and fine". It fails closed: an outage');
console.log('   on our side must never turn into free goods on yours. Retry later —');
console.log('   the E2E is immutable, so the same question has the same answer.');

console.log(`\n${'─'.repeat(66)}`);
console.log('Done. Verification never sent a credential. Docs: https://docs.luniumpay.com');
console.log(`${'─'.repeat(66)}\n`);
