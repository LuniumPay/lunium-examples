## Give this repository to your coding agent

> Prompt: "Using `sell.js` in this repo as the reference implementation, add USDT→PIX payouts to our app: read the per-transaction and per-payee limits from `GET /keys/me` at runtime instead of hardcoding them, refuse out-of-range amounts locally before spending a request, then quote → guard the *quoted* reais → accept → poll with backoff to a terminal state. Handle the three failures separately: an expired quote (`erro: cotacao_expirada`, `acao: corrigir`) must be re-quoted and never re-accepted, a `FAILED` order must never trigger a re-send to its dead deposit address, and a polling timeout must not be reported as a failed order. Verify `node sell.js`, `node sell.js --expire` and `node sell.js --amount 10.02` all still run against the sandbox before you call it done."

---

Sell USDT on Polygon, get paid to a Brazilian PIX key. One file, plain Node 18+, **zero dependencies**, runs against the live sandbox without a signup.

```
node sell.js
```

That is the whole setup. No `npm install`, no `.env`, no account: the script mints a free sandbox key at runtime and caches it in a gitignored file.

## What it does

| Step | Call | The point |
| --- | --- | --- |
| 1 | `POST /keys/sandbox` | Free key, no signup. Cached locally — see *Sandbox keys are rationed* below. |
| 2 | `GET /keys/me` | **Read your limits.** They are data, not constants. |
| 3 | — | Refuse locally what the API would refuse anyway. |
| 4 | `POST /cash-outs` | Quote. Prints the implied rate: `brl_amount ÷ amount`. |
| 5 | `POST /cash-outs/{id}/accept` | Lock the price, get the deposit address and the deadline. |
| 6 | `GET /cash-outs/{id}` | Poll with exponential backoff until a terminal state. |
| 7 | `GET /v1/verificar/{e2e}` | Prove the PIX was paid — **without any API key**. |

## Run it

```bash
node sell.js                  # happy path: 12.00 USDT → PIX
node sell.js --brl 100        # sell by reais instead of by crypto
node sell.js --amount 10.02   # sandbox trigger: the order FAILS
node sell.js --brl 300000     # refused before any cash-out call, using live limits
node sell.js --expire         # drives a real API error: the quote dies before the accept
node sell.js --help
```

Flags: `--amount` *or* `--brl`, `--pix-key`, `--pix-key-type` (`cpf|cnpj|phone|email|random`), `--asset`, `--network`.

Exit codes: `0` completed · `1` order failed · `2` refused locally · `3` refused by the API · `4` polling budget exhausted · `5` environment (API unreachable, or no sandbox key available).

Exit `5` is deliberately not `1`: "I could not reach the API" and "the order failed" are different
facts, and a caller that conflates them will retry the wrong one.

## What you should see

Happy path, real output, trimmed:

```
2. Read YOUR limits from GET /keys/me (never hardcode these)
   tier              Inicio   [SANDBOX — no money moves]
   cash-out per tx   R$ 6,00 … R$ 250.000,00
   payee daily cap   R$ 100.000,00 per cpf_cnpj

4. Quote — POST /cash-outs
   cashout_id        sbx_1e1992a3a9df89ea6b0874d4
   selling           12.00 USDT on polygon
   you receive       R$ 59,08 to email:demo@lunium.dev
   implied rate      R$ 4,9233 per USDT
                     (brl_amount ÷ amount — the only rate that is a promise)
   your key's fee    250 bps (2.50%), read from /keys/me

6. Send the deposit
   deposit address   0xd14fc27a267be07ef581ea70116325606ebabce6   (polygon)
   send exactly      12.00 USDT
   deadline          2026-09-01T00:58:32.184Z  (15m 00s from now)

7. Poll with backoff (2s → 15s, cap)
   [+     0s] AWAITING_DEPOSIT (waiting)
   [+    10s] PAYING_OUT (waiting)
   [+    19s] COMPLETED

8. Outcome: COMPLETED
   PIX E2E           E00000000202609010043b0ef2a4fe28
   ↳ checked with NO api key at all:
     pago=true  valor_brl=59.08  instituicao=INSTITUIÇÃO DE TESTE (SANDBOX)
     recebedor=T. S. T.  ← initials only: proof of payment, not a data leak
```

## The four things worth copying

**1. Never hardcode a limit.** The minimum is R$ 6,00 and the maximum R$ 250.000,00 *today*. Both live in `GET /keys/me` → `limits.per_operation.cashout`, and both will move. `sell.js` reads them on every run; if the API stops reporting them, it says so and defers to the server rather than inventing a number.

**2. Refuse locally, don't learn from a 403.** `node sell.js --brl 300000` never sends a
cash-out. It does make two calls first — the key and `GET /keys/me` — because the numbers it
refuses you with have to come from somewhere, and hardcoding them is the thing this example
exists to argue against. What it never does is discover the ceiling by bouncing off it:

```
3. Guard the amount locally
   refused locally — no request was sent:
     · R$ 300.000,00 is above the per-transaction maximum of R$ 250.000,00
     · R$ 300.000,00 in one order already exceeds the R$ 100.000,00 daily cap per cpf_cnpj
```

**3. Guard the *quoted* value, not your guess.** When you sell `12 USDT` you don't know the reais until the API prices it. So the guard runs a second time in step 5, between the quote and the accept. A quote is free and uncommitted — walking away there costs nothing.

**4. A polling timeout is not a failed order.** If the budget runs out, the order is still alive server-side. Keep the `cashout_id` and your `external_id`, resume polling, or register a webhook and stop polling entirely.

## The unhappy path

`node sell.js --amount 10.02` drives a real failure to a terminal state:

```
7. Poll with backoff (2s → 15s, cap)
   [+     0s] AWAITING_DEPOSIT (waiting)
   [+    10s] PAYING_OUT (waiting)
   [+    19s] FAILED

8. Outcome: FAILED
   the order did not pay out
   refund address    null
   refund tx         null
   Read this honestly: a terminal FAILED carries no free-text reason field.
   So do not screen-scrape one. What you do instead:
     · FAILED is terminal. Never re-accept and never re-send to 0xd26a34a6…
     · If crypto did arrive, refund_address / refund_tx_hash is where it goes back —
       poll those two fields instead of guessing.
     · Open support with cashout_id + external_id. Those two identify it completely.
     · For the customer: quote again. A new quote is a new price, not a retry.
```

### The other unhappy path: a price that died

`node sell.js --expire` quotes, then deliberately waits past `expires_at` before accepting:

```
5. Guard the quoted value, then accept
   R$ 49,39 is inside your limits → accepting
   --expire: this quote dies in 4s. Waiting 7s on purpose
   so the accept below runs against a price that no longer exists.
   accept refused: cotacao_expirada — [SANDBOX] A cotação expirou. Cote de novo — não repita o aceite.
   The price you were holding is gone. Quote again — never retry the accept.
```

`acao` is `corrigir`, so the retry loop does not touch it — retrying an expired quote produces an
identical failure forever. The fix is a new quote, which is a new price your customer has to accept.

### Sandbox triggers

The last two decimals of `amount` choose the ending. Same for any whole number — `5.01`, `10.01` and `250.01` all do the same thing.

| `amount` ends in | What happens |
| --- | --- |
| `.01` | Order goes `DELAYED`, then finishes on its own |
| `.02` | Order **fails** |
| `.03` | The quote expires in 5 seconds |
| `.04` | Refused for limits, with `limits` filled in |
| `.05` | Finishes slowly (~2 min) — tests your polling's patience |

## Every error has the same shape

```json
{ "erro": "cotacao_expirada", "acao": "corrigir",
  "detail": "A cotação expirou. Cote de novo — não repita o aceite.",
  "request_id": "req_c6cd4bfdd1af4c1497df" }
```

`acao` is the field to branch on. **`corrigir` means your input is wrong and the identical retry will fail identically** — `sell.js` never retries those, and retries only `429` and `5xx`. Limit refusals also carry a `limits` object with the actual numbers, so you never have to guess. Log `request_id`; it is the entire story for support.

Retry-After is honoured, but capped at 30s (`MAX_RETRY_AFTER_S`). This is not theoretical: the sandbox-key endpoint answers a quota 429 with `retry-after: 83323`, and a loop that sleeps on that has not retried, it has hung.

### Sandbox keys are rationed

10 per day per IP, resetting at midnight, and they never expire — so **reuse, don't mint.** `sell.js` caches its key in `.lunium-sandbox-key` (gitignored) and reuses it forever. If you do run out:

```bash
LUNIUM_API_KEY=lun_test_… node sell.js
```

The quota is per **IP**, not per person, so on an office or shared connection you can hit it on
your first run having minted nothing. That exits `5` with the line above — not a stack trace, and
not exit `1`. Any `lun_test_` key from any earlier run works; they never expire.

## Sandbox vs production

Same code, same limits, same error shapes. In the sandbox no money moves, the quote is fixed (so your tests don't depend on a market), orders are deleted after 2 hours, and the test E2E carries ISPB `00000000`, which belongs to no institution — identical in format so your parser behaves the same.

**Never send crypto to a sandbox `deposit_address`. It has no owner and the funds are gone.** To go live, swap in a `lun_live_` key; nothing else in this file changes.

## Links

- Docs — https://docs.luniumpay.com
- OpenAPI — https://docs.luniumpay.com/openapi.json
- Agent discovery — `GET https://api.luniumpay.com/mesh` (no key required)
- MCP — https://api.luniumpay.com/mcp · A2A — https://api.luniumpay.com/a2a

## License

MIT — see `LICENSE`.
