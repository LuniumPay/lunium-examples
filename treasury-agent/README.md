## Give this repository to your coding agent

> Prompt: "Using this repo as the reference, write me a treasury routine that reads my
> live limits from `GET /keys/me` and `GET /catalog` on every run, reports how much BRL
> still fits today on each route (cash-in, payout, cash-out), refuses anything over the
> ceiling before it hits the network, and then executes one small payout end to end.
> Never hardcode a limit — read it. Never retry a POST that moves money — use `external_id`."

---

# Treasury agent

An agent that moves money must not carry the limits in its source code. Tiers change,
daily buckets reset at midnight, routes unlock as volume settles. This example is one
file of plain Node that reads every ceiling at runtime, computes what still fits today,
proves its own guard rails by getting refused four times, and then pays out.

There is not a single hardcoded amount in `treasury.mjs`. Even the payout amount is
derived: it is the API's own minimum, rounded up to a whole real, plus one cent of
sandbox trigger.

## Run it

```bash
cd treasury-agent
node treasury.mjs
```

Node 18+ (native `fetch` and `AbortSignal.timeout`; the script checks and says so instead
of dying on a missing global). No dependencies, no install, no signup — it mints its own
sandbox key on the first run. Takes about 80 seconds, most of it watching a held order
settle.

The sandbox allows **10 keys per IP per day**, and keys never expire with use, so the first
run writes the key it minted to `.lunium-sandbox-key` (mode 0600, gitignored) and every run
after that reuses it. Re-run as often as you like; only run number one spends quota.

To use a key you already have, or to run this on a machine where the file cannot be written:

```bash
LUNIUM_API_KEY=lun_test_... node treasury.mjs
```

If you hit `429 limite_de_chaves_teste` on a first run, this IP has already spent its ten
keys today — pass one you already hold, or wait for midnight (America/Sao_Paulo).

## What it does

| Step | Call | Point being made |
|---|---|---|
| 1 | `POST /keys/sandbox` | No secret in the repo; the key is minted at runtime |
| 2 | `GET /keys/me` | The ceilings, read fresh — never assumed |
| 3 | `GET /catalog` | Which assets and networks can actually settle |
| 4 | `GET /cashin/limits?payer_tax=` | The *second* axis: the payer has a ladder of their own |
| 5 | local guard · `POST /payouts` · `.04` · `.03` | Four refusals, and the fix each one calls for |
| 6 | `POST /cash-outs` → `/accept` → poll | The payout itself |
| 7 | `GET /keys/me` again · `GET /v1/verificar/{e2e}` | Reconcile, then audit without a key |

## The headroom model

Three routes share one wallet but not one ceiling:

- **cash-in** (`POST /cashin/charge`) — PIX in, crypto out. Draws on the key's daily bucket.
- **payout** (`POST /payouts`) — PIX out, no crypto leg. Same bucket; unlocks automatically
  once the key settles enough volume.
- **cash-out** (`POST /cash-outs`) — crypto in, PIX out. No daily bucket on the key, but the
  *receiving* CPF/CNPJ has a daily cap of its own.

The ceiling that binds is the **minimum of every cap that applies** — per-transaction max,
what is left in today's bucket, and the per-counterparty cap. That one line of arithmetic
is the whole treasury model, and it is only correct on fresh numbers:

```js
const caps = [perOp.max_brl_cents, dailyLeft, ...extraCaps].filter(Number.isFinite);
const ceiling = Math.min(...caps);
```

The per-payer ladder is deliberately *not* folded into that minimum. It caps the payer, not
the key — a key with R$ 5.000 of room still has R$ 5.000 of room even when the payer in front
of it can only pay R$ 200. Two axes, checked separately, combined at the moment of the charge.

## Expected output

```
route    min         max           left today    fits now      status
------------------------------------------------------------------------------
cash-in  R$ 1,02     R$ 6.000,00   R$ 5.000,00   R$ 5.000,00   open
  POST /cashin/charge  ->  binding constraint: today's remaining bucket
  payer ladder on top: R$ 200,00 first transaction, maturing to R$ 6.000,00/day
  room for 4901 more minimum-sized operations today
payout   R$ 1,00     R$ 6.000,00   R$ 5.000,00   -             LOCKED
  unlocks automatically at R$ 1.000,00 settled — R$ 1.000,00 to go
cash-out R$ 6,00     R$ 250.000,00 no daily cap  R$ 100.000,00 open
  also capped at R$ 100.000,00 per receiving cpf_cnpj/day
```

Then four refusals, then the payout: `AWAITING_DEPOSIT → DEPOSIT_DETECTED → PAYING_OUT →
MANUAL_REVIEW → COMPLETED`, ending with a Banco Central E2E id and a URL that anyone can
verify without credentials.

Your numbers will differ from the ones above. That is the entire point — run it and read
what your key actually says.

## The failure paths, on purpose

Every example here exercises the unhappy path, because that is the code you will actually
be debugging at 3am.

**Local refusal, no network call.** Asking for one cent above the ceiling is blocked before a
request goes out. Cheaper than a 400, and it is the only thing standing between a looping
agent and its own daily cap.

**Locked route** (`403 payout_nao_liberado`). A sandbox key has not settled anything, so
direct PIX payout is closed. The agent catches it, reads `acao: "esperar"`, and falls back
to the route that is open instead of retrying into a wall.

**Server-side limit refusal** (`400`, sandbox trigger `.04`). The refusal carries a `limits`
object holding the exact numbers you were judged by — log it, do not guess at it.

**Stale quote** (`400 cotacao_expirada`, sandbox trigger `.03`). The example quotes, sits on
it past expiry the way a slow approval loop would, then accepts. This is the one that teaches
what `acao: "corrigir"` actually means: the *price* went stale, so the fix is a **new quote**,
never a repeated accept. An agent that reads "corrigir" as "retry the same POST" will hammer a
write that can never succeed — and on a route that is not expired, that same reflex pays twice.

**No answer at all.** Timeouts, DNS and TLS failures never produce an `acao`, so there is
nothing to branch on. The error handler treats an unanswered write as STOP, not as success.

Every error response carries `acao`, which is the machine-readable answer to "what now":

```js
parar    -> STOP, do not retry; a human or a config change is required
corrigir -> FIX the request and try again
esperar  -> WAIT, the condition clears on its own
```

Branch on that field, not on a regex over the message.

## Two rules worth stealing

**Never retry a POST that moves money.** Reads retry on 429/5xx; writes get `retries: 0` and
an `external_id` instead. A retried payout is a double payment waiting to happen.

**Reconcile against the server, not your ledger.** The script keeps a local tally of what it
committed, then prints the drift against `used_today_cents`. Drift is normal here (cash-out
does not draw on the daily bucket) — what matters is that the server is treated as the
authority and the ledger as a guess.

## Sandbox triggers

The last two decimals of the amount pick the outcome, so you can test every branch on demand:

| Amount ends in | Outcome |
|---|---|
| `.01` | held by the provider, then settles on its own — used by this example |
| `.02` | fails |
| `.03` | quote expires in 5s — used by this example |
| `.04` | refused on limits, with the `limits` object filled — used by this example |
| `.05` | settles slowly (~2 min), for testing patient polling |

Sandbox notes: no money moves and the deposit address has no owner — never fund it. Orders are
deleted 2 hours after creation. Sandbox volume does not accrue toward tier unlocks, which is why
the payout route stays locked no matter how many times you run this.

## Going to production

Swap the sandbox key for a live one and the code is unchanged — that is the test of whether you
hardcoded anything. In production the deposit address must actually be funded before the PIX
goes out, and `MANUAL_REVIEW` means a real hold rather than a trigger you asked for.

## Docs

- Documentation — https://docs.luniumpay.com
- OpenAPI — https://docs.luniumpay.com/openapi.json
- Agent discovery — `GET https://api.luniumpay.com/mesh` (no key required)
- MCP — https://api.luniumpay.com/mcp · A2A — https://api.luniumpay.com/a2a
