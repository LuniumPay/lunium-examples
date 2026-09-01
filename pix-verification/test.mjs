/**
 * Offline tests for verify.mjs.
 *
 *   node test.mjs
 *
 * These run against a throwaway local HTTP server, never the real API, so they
 * are deterministic, need no key, and pass on a plane. Every case here is a
 * behaviour that once went the wrong way — a check that silently passed, or a
 * throw that escaped a function documented never to throw.
 */
import http from 'node:http';
import {
  verifyPix,
  acceptPayment,
  parseE2E,
  brlToCents,
  centsToBrl,
  toCents,
} from './verify.mjs';

const PROD_E2E = 'E37293930202607312006361894c4a82';
const SBX_E2E = 'E00000000202609010047a32b9c5d895';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`); }
};
const group = (t) => console.log(`\n${t}`);

/** A fake verifier we fully control. */
function serve(handler) {
  const srv = http.createServer((req, res) => {
    const e2e = decodeURIComponent(req.url.split('/').pop());
    const { status, body } = handler(e2e);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((r) => srv.listen(0, () => r({
    baseUrl: `http://127.0.0.1:${srv.address().port}`,
    close: () => srv.close(),
  })));
}

const settledBody = (over = {}) => ({
  verificado: true, pago: true, e2e: PROD_E2E, valor_brl: '14.62',
  pago_em: new Date().toISOString(), recebedor_iniciais: 'J. S. C.',
  instituicao: 'BANCO INTER S.A.', liquidado_por: 'Lunium', ...over,
});

// ── pure helpers ─────────────────────────────────────────────────────────
group('money and identifiers');
ok('brlToCents("14.62") === 1462', brlToCents('14.62') === 1462);
ok('brlToCents("14,62") === 1462 (comma decimal)', brlToCents('14,62') === 1462);
ok('brlToCents("14.6") === 1460 (one decimal place)', brlToCents('14.6') === 1460);
ok('brlToCents("14") === 1400', brlToCents('14') === 1400);
ok('brlToCents("abc") === null', brlToCents('abc') === null);
ok('centsToBrl(1462) === "14.62"', centsToBrl(1462) === '14.62');
ok('centsToBrl(5) === "0.05"', centsToBrl(5) === '0.05');
ok('round-trips 0.01 through 999.99', (() => {
  for (let c = 1; c <= 99999; c += 7) if (brlToCents(centsToBrl(c)) !== c) return false;
  return true;
})());
ok('parseE2E splits the ISPB', parseE2E(PROD_E2E)?.ispb === '37293930');
ok('parseE2E rejects a short id', parseE2E('E123') === null);
ok('parseE2E rejects 33 chars', parseE2E(PROD_E2E + 'x') === null);

group('toCents refuses what it cannot trust');
ok('accepts a number', toCents(1462) === 1462);
ok('accepts a numeric string (JSON bodies give strings)', toCents('1462') === 1462);
ok('rejects a float', toCents(14.62) === null);
ok('rejects a negative', toCents(-5) === null);
ok('rejects NaN', toCents(NaN) === null);
ok('rejects undefined', toCents(undefined) === null);
ok('rejects "14.62" (reais, not centavos)', toCents('14.62') === null);
ok('rejects an object', toCents({}) === null);

// ── verifyPix contract ───────────────────────────────────────────────────
group('verifyPix never throws, always tags');
{
  const s = await serve(() => ({ status: 200, body: settledBody() }));
  const r = await verifyPix(PROD_E2E, { baseUrl: s.baseUrl });
  ok('200 + verificado:true -> ok', r.ok === true);
  ok('amount parsed to cents', r.payment.amountCents === 1462);
  ok('production payload is NOT flagged sandbox', r.payment.sandbox === false);
  s.close();
}
{
  const s = await serve(() => ({ status: 404, body: { erro: 'nao_encontrado', mensagem: 'x' } }));
  const r = await verifyPix(PROD_E2E, { baseUrl: s.baseUrl });
  ok('404 -> not_found (not an exception)', r.ok === false && r.reason === 'not_found');
  s.close();
}
{
  const r = await verifyPix('nonsense');
  ok('malformed id short-circuits with no round trip', r.reason === 'invalid_format');
}
{
  const r = await verifyPix(PROD_E2E, { baseUrl: 'http://127.0.0.1:9', timeoutMs: 500 });
  ok('dead endpoint -> unavailable, no throw', r.ok === false && r.reason === 'unavailable');
}
{
  const s = await serve(() => ({ status: 500, body: { erro: 'boom' } }));
  const r = await verifyPix(PROD_E2E, { baseUrl: s.baseUrl });
  ok('500 -> unavailable', r.reason === 'unavailable');
  s.close();
}

// ── the fail-closed policy ───────────────────────────────────────────────
group('acceptPayment fails CLOSED');
{
  const s = await serve(() => ({ status: 200, body: settledBody() }));
  const at = { baseUrl: s.baseUrl };

  const happy = await acceptPayment(PROD_E2E, { amountCents: 1462 }, at);
  ok('correct amount, fresh, production -> ACCEPT', happy.accepted === true);

  const noAmount = await acceptPayment(PROD_E2E, {}, at);
  ok('omitted amountCents -> REJECT (was: silently accepted)',
    noAmount.accepted === false && noAmount.reason === 'amount_matches');
  ok('  and the check is present in the report, not skipped',
    noAmount.checks.some((c) => c.name === 'amount_matches'));

  const strAmount = await acceptPayment(PROD_E2E, { amountCents: '1462' }, at);
  ok('amountCents as string "1462" -> ACCEPT (was: check skipped entirely)',
    strAmount.accepted === true);

  const wrongStr = await acceptPayment(PROD_E2E, { amountCents: '100' }, at);
  ok('wrong amount as string -> REJECT', wrongStr.accepted === false);

  const offByOne = await acceptPayment(PROD_E2E, { amountCents: 1463 }, at);
  ok('one centavo off -> REJECT', offByOne.reason === 'amount_matches');

  const junk = await acceptPayment(PROD_E2E, { amountCents: 'many' }, at);
  ok('junk amountCents -> REJECT', junk.accepted === false);

  const arrayLedger = await acceptPayment(
    PROD_E2E, { amountCents: 1462, alreadyCredited: [PROD_E2E] }, at);
  ok('ledger as an Array -> REJECT, no throw (was: TypeError)',
    arrayLedger.accepted === false && arrayLedger.reason === 'not_replayed');

  const fnLedger = await acceptPayment(
    PROD_E2E, { amountCents: 1462, alreadyCredited: (id) => id === PROD_E2E }, at);
  ok('ledger as a predicate -> REJECT', fnLedger.reason === 'not_replayed');

  const setLedger = await acceptPayment(
    PROD_E2E, { amountCents: 1462, alreadyCredited: new Set([PROD_E2E]) }, at);
  ok('ledger as a Set -> REJECT', setLedger.reason === 'not_replayed');
  s.close();
}

group('freshness is bounded on BOTH sides');
{
  const future = new Date(Date.now() + 10 * 365 * 24 * 3600e3).toISOString();
  const s = await serve(() => ({ status: 200, body: settledBody({ pago_em: future }) }));
  const r = await acceptPayment(PROD_E2E, { amountCents: 1462 }, { baseUrl: s.baseUrl });
  ok('settled 10 years in the FUTURE -> REJECT (was: accepted)',
    r.accepted === false && r.reason === 'recent_enough');
  s.close();
}
{
  const skew = new Date(Date.now() + 60e3).toISOString(); // 1 min ahead
  const s = await serve(() => ({ status: 200, body: settledBody({ pago_em: skew }) }));
  const r = await acceptPayment(PROD_E2E, { amountCents: 1462 }, { baseUrl: s.baseUrl });
  ok('1 min of clock skew is tolerated -> ACCEPT', r.accepted === true);
  s.close();
}
{
  const old = new Date(Date.now() - 48 * 3600e3).toISOString();
  const s = await serve(() => ({ status: 200, body: settledBody({ pago_em: old }) }));
  const r = await acceptPayment(PROD_E2E, { amountCents: 1462 }, { baseUrl: s.baseUrl });
  ok('two days old, 60 min window -> REJECT', r.reason === 'recent_enough');
  s.close();
}
{
  const s = await serve(() => ({ status: 200, body: settledBody({ pago_em: undefined }) }));
  const r = await acceptPayment(PROD_E2E, { amountCents: 1462 }, { baseUrl: s.baseUrl });
  ok('no timestamp at all -> REJECT', r.reason === 'recent_enough');
  s.close();
}

group('sandbox proof is refused by default');
{
  // The payload does NOT say sandbox; only the ISPB betrays it.
  const s = await serve(() => ({
    status: 200, body: settledBody({ e2e: SBX_E2E, sandbox: undefined }),
  }));
  const r = await acceptPayment(SBX_E2E, { amountCents: 1462 }, { baseUrl: s.baseUrl });
  ok('ISPB 00000000 alone marks it sandbox -> REJECT',
    r.accepted === false && r.reason === 'not_sandbox');
  const allowed = await acceptPayment(
    SBX_E2E, { amountCents: 1462, allowSandbox: true }, { baseUrl: s.baseUrl });
  ok('  ...unless the caller opts in explicitly', allowed.accepted === true);
  s.close();
}
{
  const s = await serve(() => ({ status: 200, body: settledBody({ sandbox: true }) }));
  const r = await acceptPayment(PROD_E2E, { amountCents: 1462 }, { baseUrl: s.baseUrl });
  ok('payload flag alone also marks it sandbox -> REJECT', r.reason === 'not_sandbox');
  s.close();
}

group('an unreachable verifier never becomes an acceptance');
{
  const r = await acceptPayment(PROD_E2E, { amountCents: 1462 },
    { baseUrl: 'http://127.0.0.1:9', timeoutMs: 500 });
  ok('verifier down -> REJECT, reason unavailable',
    r.accepted === false && r.reason === 'unavailable');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
