/**
 * Open PIX verification against the Lunium API.
 *
 * The whole point of this file: NOTHING here sends a credential.
 * GET /v1/verificar/{e2e} is a public endpoint. No API key, no account,
 * no signup. That is what lets a party who did NOT make a payment check
 * that the payment really settled.
 *
 * Node 18+. Standard library only (native fetch). No dependencies.
 */

export const DEFAULT_BASE_URL = 'https://api.luniumpay.com';
const VERIFY_PATH = '/v1/verificar/';

// Native fetch landed in Node 18. Without this, Node 16 fails deep inside a
// request with a bare "fetch is not defined" and the reader blames the API.
if (typeof fetch !== 'function') {
  throw new Error(
    'This example needs Node 18+ for the built-in fetch (you are on ' +
      `${typeof process !== 'undefined' ? process.version : 'an unknown runtime'}). ` +
      'Upgrade Node, or pass your own fetch-compatible implementation.',
  );
}

/**
 * The Banco Central end-to-end identifier is 32 characters:
 *   E + ISPB(8 digits) + YYYYMMDDHHMM(12 digits) + 11 alphanumerics
 * Example: E37293930202607312006361894c4a82
 */
export const E2E_PATTERN = /^E\d{20}[A-Za-z0-9]{11}$/;

/** Split an E2E into its parts. Returns null if it is not well formed. */
export function parseE2E(e2e) {
  const id = String(e2e ?? '').trim();
  if (!E2E_PATTERN.test(id)) return null;
  return {
    e2e: id,
    ispb: id.slice(1, 9),           // the institution that originated the PIX
    stamp: id.slice(9, 21),         // YYYYMMDDHHMM, as claimed by that institution
    suffix: id.slice(21),
  };
}

/**
 * Parse a BRL decimal string ("49.24") into integer cents.
 * Money is compared in integers. Never compare reais as floats:
 * 0.1 + 0.2 !== 0.3, and a payment that is one centavo off is not the payment.
 */
export function brlToCents(value) {
  const m = /^(\d{1,15})(?:[.,](\d{1,2}))?$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? '').padEnd(2, '0'));
  return whole * 100 + frac;
}

export function centsToBrl(cents) {
  const sign = cents < 0 ? '-' : '';
  const n = Math.abs(Math.trunc(cents));
  return `${sign}${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`;
}

/**
 * Coerce a caller-supplied "amount in centavos" to a safe integer.
 *
 * This exists because the value almost never arrives as a clean number in real
 * code: it comes off `req.body`, a form field, an env var or a DB column, and
 * arrives as the STRING "1462". A `typeof x === 'number'` guard silently drops
 * the amount check for every one of those callers — which means the payment is
 * accepted for any value at all. Parse it, or refuse it. Never skip it.
 *
 * Returns null when the value cannot be trusted as an integer centavo amount.
 */
export function toCents(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && /^\d{1,15}$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/**
 * Does a ledger already contain this E2E?
 *
 * Accepts a Set, a Map, an Array, or a predicate function, and never throws.
 * `acceptPayment` advertises that it always resolves to a tagged result; a
 * caller who hands us a plain Array must not blow that contract up with
 * "alreadyCredited.has is not a function".
 */
function ledgerHas(ledger, e2e) {
  if (!ledger) return false;
  if (typeof ledger.has === 'function') return ledger.has(e2e) === true;
  if (typeof ledger.includes === 'function') return ledger.includes(e2e);
  if (typeof ledger === 'function') return ledger(e2e) === true;
  return false;
}

/** A link a human can open to see the same proof. */
export function verifyUrl(e2e, baseUrl = DEFAULT_BASE_URL) {
  return `${baseUrl}${VERIFY_PATH}${encodeURIComponent(String(e2e).trim())}`;
}

/**
 * ISPB 00000000 belongs to no real Banco Central participant. Sandbox
 * identifiers are minted under it, so the E2E itself carries the fact —
 * independently of any field the payload may or may not include.
 */
export const SANDBOX_ISPB = '00000000';

/** Map the API's Portuguese payload onto a stable shape. */
function normalize(body) {
  // Two independent signals, OR-ed together, because each can fail alone:
  // the `sandbox` flag is absent from production payloads (so a missing flag
  // must never be read as "this is production"), and the ISPB is structural —
  // it is inside the identifier the payer handed you and cannot be dropped by
  // a payload change. If either says sandbox, treat it as sandbox.
  const ispb = parseE2E(body.e2e)?.ispb ?? null;
  const sandbox = body.sandbox === true || ispb === SANDBOX_ISPB;

  return {
    e2e: body.e2e,
    paid: body.pago === true,
    amountBrl: body.valor_brl,
    amountCents: brlToCents(body.valor_brl),
    // ISO 8601 WITH an explicit offset ("-03:00") in production. Do not assume
    // UTC and do not assume the reader's local zone: read the offset that is there.
    paidAtRaw: body.pago_em,
    paidAt: body.pago_em ? new Date(body.pago_em) : null,
    receiverInitials: body.recebedor_iniciais ?? null, // initials only, by design
    institution: body.instituicao ?? null,
    settledBy: body.liquidado_por ?? null,
    cryptoOrigin: body.origem_cripto ?? null,
    receiptUrl: body.comprovante_url ?? null,
    // True when EITHER the payload flags it or the ISPB is the sandbox one.
    sandbox,
    ispb,
  };
}

/**
 * Verify one E2E. Never throws; always resolves to a tagged result.
 *
 *   { ok: true,  payment }
 *   { ok: false, reason: 'not_found' | 'invalid_format' | 'unavailable' }
 *
 * 'not_found' means "Lunium did not settle this". It does NOT mean the PIX
 * never happened — another institution may have settled it. Absence of a
 * record here is not evidence of absence of a payment.
 */
export async function verifyPix(e2e, options = {}) {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? 8000;

  const parsed = parseE2E(e2e);
  if (!parsed) {
    return {
      ok: false,
      reason: 'invalid_format',
      e2e: String(e2e ?? '').trim(),
      detail: 'Not a Banco Central end-to-end id (E + 31 chars, 32 total).',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let body;
  try {
    response = await fetch(verifyUrl(parsed.e2e, baseUrl), {
      method: 'GET',
      // Deliberately no Authorization and no X-API-Key. This is the demonstration.
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    body = await response.json();
  } catch (error) {
    return {
      ok: false,
      reason: 'unavailable',
      e2e: parsed.e2e,
      detail: `Could not reach the verifier: ${error?.message ?? error}`,
    };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 200 && body?.verificado === true) {
    return { ok: true, e2e: parsed.e2e, payment: normalize(body), raw: body };
  }
  if (response.status === 404 || body?.erro === 'nao_encontrado') {
    return { ok: false, reason: 'not_found', e2e: parsed.e2e, detail: body?.mensagem, raw: body };
  }
  if (response.status === 400 || body?.erro === 'e2e_invalido') {
    return { ok: false, reason: 'invalid_format', e2e: parsed.e2e, detail: body?.mensagem, raw: body };
  }
  return {
    ok: false,
    reason: 'unavailable',
    e2e: parsed.e2e,
    detail: `Unexpected HTTP ${response.status}`,
    raw: body,
  };
}

/**
 * The policy a third party actually needs.
 *
 * Someone tells your system "I paid you, here is the E2E". You did not make
 * that payment and you cannot see their bank. `verificado: true` alone is NOT
 * enough to release goods. Four things sink you if you skip them:
 *
 *   1. sandbox  - anyone can mint a sandbox E2E for free, and it verifies true.
 *                 Refuse sandbox proof in production. This is the sharp edge.
 *   2. amount   - the settled value must be the value you are owed, to the centavo.
 *   3. freshness- an E2E from last year is a real payment for something else.
 *   4. replay   - the same E2E must never be credited twice.
 *
 * Every check FAILS CLOSED. A missing or unparseable expectation is a
 * rejection, never a skipped check: the caller who forgets to pass the amount
 * must not be handed an `accepted: true` that silently checked nothing.
 *
 * @param {string} e2e
 * @param {object} expectation
 * @param {number|string} expectation.amountCents  what you are owed, in centavos. REQUIRED.
 * @param {boolean} [expectation.allowSandbox=false]
 * @param {number} [expectation.maxAgeMinutes=60]
 * @param {number} [expectation.maxClockSkewMinutes=5] tolerance for a future timestamp
 * @param {Set<string>|Array<string>|Function} [expectation.alreadyCredited] your ledger
 */
export async function acceptPayment(e2e, expectation = {}, options = {}) {
  const {
    amountCents,
    allowSandbox = false,
    maxAgeMinutes = 60,
    maxClockSkewMinutes = 5,
    alreadyCredited = new Set(),
  } = expectation;

  const result = await verifyPix(e2e, options);
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });

  if (!result.ok) {
    add('settled', false, `${result.reason}: ${result.detail ?? ''}`.trim());
    return { accepted: false, reason: result.reason, checks, payment: null, raw: result.raw };
  }

  const p = result.payment;
  add('settled', true, `${p.settledBy} confirms BRL ${p.amountBrl}`);

  add(
    'not_sandbox',
    allowSandbox || !p.sandbox,
    !p.sandbox
      ? 'production identifier'
      : allowSandbox
        ? 'sandbox identifier, explicitly allowed by this caller'
        : 'sandbox identifier — free to mint, worth no money',
  );

  // The amount check is MANDATORY and always appears in `checks`. Skipping it
  // when the caller passed nothing (or passed the string "1462" off a JSON
  // body) would accept a R$1 payment against a R$1.000 order.
  const wantCents = toCents(amountCents);
  if (wantCents === null) {
    add(
      'amount_matches',
      false,
      amountCents === undefined
        ? 'no amountCents given — refusing to accept an unchecked amount'
        : `amountCents is not an integer centavo amount: ${JSON.stringify(amountCents)}`,
    );
  } else if (p.amountCents === null) {
    add('amount_matches', false, `could not parse the settled amount ${JSON.stringify(p.amountBrl)}`);
  } else {
    add(
      'amount_matches',
      p.amountCents === wantCents,
      `expected ${centsToBrl(wantCents)}, settled ${p.amountBrl}`,
    );
  }

  // Bound BOTH sides of the window. An age that is negative means the payment
  // claims to have settled in the future — clock skew at best, a forged or
  // mis-parsed timestamp at worst. Unbounded below, `age <= max` waves through
  // a payment dated ten years from now.
  if (p.paidAt && !Number.isNaN(p.paidAt.getTime())) {
    const ageMin = (Date.now() - p.paidAt.getTime()) / 60000;
    const tooOld = ageMin > maxAgeMinutes;
    const inFuture = ageMin < -Math.abs(maxClockSkewMinutes);
    add(
      'recent_enough',
      !tooOld && !inFuture,
      inFuture
        ? `settled ${Math.abs(ageMin).toFixed(1)} min in the FUTURE, beyond ${maxClockSkewMinutes} min of skew`
        : `settled ${ageMin.toFixed(1)} min ago, window is ${maxAgeMinutes} min`,
    );
  } else {
    add('recent_enough', false, 'no usable timestamp');
  }

  const replayed = ledgerHas(alreadyCredited, p.e2e);
  add(
    'not_replayed',
    !replayed,
    replayed ? 'this E2E was already credited' : 'first time seen',
  );

  const failed = checks.find((c) => !c.pass);
  return {
    accepted: !failed,
    reason: failed ? failed.name : null,
    checks,
    payment: p,
    raw: result.raw,
  };
}
