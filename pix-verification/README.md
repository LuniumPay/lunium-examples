## Give this repository to your coding agent

> Prompt: "Copy `verify.mjs` from this repo into my project and use it to gate
> order fulfilment. When a customer claims they paid and gives me the Banco
> Central E2E id, call
> `acceptPayment(e2e, { amountCents, maxAgeMinutes, alreadyCredited })` and
> release the order only when it returns `accepted: true`; when it returns
> false, log `result.reason` and every entry of `result.checks` so support can
> see which rule failed. Pass `amountCents` as the order total in integer
> centavos — never reais, never a float. Leave `allowSandbox` at its default so
> sandbox identifiers are refused. Persist credited E2Es in my database, not in
> a `Set`, and pass a lookup as `alreadyCredited` so a restart cannot let the
> same payment through twice. Treat `reason: 'unavailable'` as *retry later*,
> never as a rejection of the customer. Read limits from `GET /keys/me`; do not
> hardcode any minimum or maximum. Then run `node test.mjs` and add a test that
> covers my own checkout's amount mismatch."

---

# Prove a PIX settled — without an API key

Every PIX in Brazil gets an **E2E** (end-to-end) identifier from the Banco Central:
32 characters, like `E37293930202607312006361894c4a82`. It is the receipt number of
the rails themselves.

`GET https://api.luniumpay.com/v1/verificar/{e2e}` is **open**. No key, no account,
no signup, no rate-limit ceremony. That matters because the party who most needs to
check a payment is the party who *didn't make it* — a marketplace, an escrow, a
supplier, an AI agent acting for someone else. They have no relationship with the
payer's bank and no reason to take "trust me, I paid" at face value.

```js
import { verifyPix } from './verify.mjs';

const r = await verifyPix('E37293930202607312006361894c4a82');
// { ok: true, payment: { amountBrl: '14.62', paidAt: …, institution: 'BANCO INTER S.A.', … } }
```

That request carries no credential. Look at `verify.mjs` — there is no place to put one.

## What comes back

**It exists.** HTTP 200, `verificado: true`, plus the amount, the timestamp with an
explicit offset, the receiving institution, and the receiver's *initials only*:

```json
{ "verificado": true, "pago": true, "e2e": "E37293930202607312006361894c4a82",
  "valor_brl": "14.62", "pago_em": "2026-07-31T17:07:21-03:00",
  "recebedor_iniciais": "J. S. C.", "instituicao": "BANCO INTER S.A.",
  "liquidado_por": "Lunium", "comprovante_url": "https://app.luniumpay.com/comprovante/…" }
```

No PIX key, no full name, no CPF. It proves the payment without exposing either party.

**It doesn't.** HTTP 404, `erro: "nao_encontrado"` — and read the wording carefully:

> "Nenhum pagamento com este identificador foi liquidado pela Lunium. Isso não
> significa que o PIX não existiu — pode ter sido feito por outra instituição."

Lunium didn't settle it. That is **not** proof the PIX never happened; some other
institution may have settled it. Absence of a record is not evidence of absence.
Treat `not_found` as "unproven", never as "fraud".

**It's malformed.** HTTP 400, `erro: "e2e_invalido"`. `verify.mjs` catches this
locally with a regex before spending a round trip.

## The part that will bite you

`verificado: true` is **not** enough to release goods. Four checks stand between a
verified identifier and money you can keep:

| Check | Why |
|---|---|
| `not_sandbox` | Anyone can mint a sandbox E2E for free in one HTTP call, and it verifies `true`. The payload flags it with `sandbox: true`. **Refuse it in production.** |
| `amount_matches` | Compared in integer centavos. A payment one centavo off is not your payment, and floats will lie to you about that. |
| `recent_enough` | A genuine E2E from last year is a genuine payment — for something else. |
| `not_replayed` | The same E2E must never be credited twice. Keep a ledger. |

`acceptPayment()` runs all four and hands back every check with its reasoning, so a
rejection tells you *which* rule failed rather than just "no".

### Every check fails closed

A check that is *skipped* is a check that *passes*, and that is how money leaks. So
none of these can be skipped by accident:

| You do this | What happens |
|---|---|
| Forget `amountCents` entirely | **REJECT** — `amount_matches` still appears in `checks`, failed, saying no amount was given. It does not quietly accept any value. |
| Pass `amountCents` as `"1462"` — a string, the way it arrives off `req.body`, a form field or a DB column | Parsed and compared. A `typeof x === 'number'` guard would have dropped the check and accepted a R$1 payment against a R$1.000 order. |
| Pass `amountCents` as `14.62`, a float in reais | **REJECT** — this is centavos; reais with a decimal point are refused rather than truncated. |
| Hand a payment timestamped in the *future* | **REJECT** — the freshness window is bounded on both sides, with 5 minutes of clock skew allowed. `age <= max` alone waves through a payment dated ten years out. |
| Pass `alreadyCredited` as an Array instead of a `Set` | Works. It accepts a `Set`, `Map`, `Array` or predicate, and never throws — `acceptPayment` always resolves to a verdict. |
| Call it while the verifier is unreachable | **REJECT**, `reason: 'unavailable'`. "Could not check" is not "checked and fine". Retry later; an E2E is immutable, so the same question always has the same answer. |

The last one is the branch people forget. An outage on our side must never become
free goods on yours, so treat `unavailable` as *retry*, not as a verdict about
the customer.

Sandbox detection uses two independent signals: the `sandbox` field in the payload
**and** ISPB `00000000` in the identifier itself. A missing field is never read as
"this is production".

## Run it

```bash
node demo.mjs      # Node 18+, no install, no dependencies, no secrets
node test.mjs      # 44 assertions, fully offline, no key, no network
```

The demo creates its own throwaway sandbox key at runtime, mints a genuinely settled
payment, then verifies it with no credential, walks the three response shapes, runs
seven acceptance scenarios, and deliberately breaks things using the sandbox triggers.
Takes about a minute, mostly waiting on settlement.

Sandbox keys are capped at **10 per day per IP** — a cap a public example hits
constantly, including on the very first clone from a shared office or CI address.
When that happens the demo does **not** stop. It says so, drops the minting half,
and runs everything else against a payment already on the record, because the
verification half needs no credential and that is the entire point:

```
No sandbox key this run: limite_de_chaves_teste
Continuing WITHOUT a key. Everything below that verifies a payment
needs no credential, so it still runs — that is the whole thesis.
```

To get the minting half back, reuse a key you already have — a sandbox key does not
expire with use:

```bash
LUNIUM_API_KEY=lun_test_… node demo.mjs
```

`test.mjs` never touches the network: it stands up a throwaway local server and
asserts the policy against it, so it passes offline and on a plane.

## Don't hardcode limits

The two cents of the `amount` steer the sandbox: `.01` delays, `.02` fails, `.03`
expires the quote in 5s, `.04` refuses on limits, `.05` settles slowly. The demo uses
`.02` and `.04` to exercise the unhappy path.

Limits live at `GET /keys/me`, and even the `.04` refusal hands back the live numbers
in a `limits` object. They have changed before and will change again — read them, do
not paste them into a constant:

```js
const { limits } = await (await fetch('https://api.luniumpay.com/keys/me',
  { headers: { 'X-API-Key': key } })).json();
limits.per_operation.cashout;   // { min_brl_cents, max_brl_cents }
```

## Files

- **`verify.mjs`** — the whole library, standard library only. `verifyPix()` (never
  throws, returns a tagged result), `acceptPayment()` (the four-check policy, all of
  it fail-closed), plus `parseE2E`, `brlToCents`, `centsToBrl`, `toCents`, `verifyUrl`,
  `SANDBOX_ISPB`. Copy this one file into your project; there is nothing else to take.
- **`demo.mjs`** — the runnable story, against the live API. Degrades to the keyless
  half when no sandbox key is available.
- **`test.mjs`** — 44 offline assertions pinning the policy. No key, no network.
- **`package.json`** — declares `engines.node >= 18` and zero dependencies.

## More

- Docs: <https://docs.luniumpay.com> · OpenAPI: <https://docs.luniumpay.com/openapi.json>
- Agent discovery: `GET https://api.luniumpay.com/mesh` (no key)
- MCP: `https://api.luniumpay.com/mcp` · A2A: `https://api.luniumpay.com/a2a`

Sandbox identifiers use ISPB `00000000`, which belongs to no real institution, and
sandbox orders disappear two hours after creation. The format is identical to
production so your parser behaves the same in both.
