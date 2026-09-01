## Give this repository to your coding agent

> Prompt: "Read `pix_to_usdt.py` and add the same PIX-to-USDT flow to my checkout.
> Create the charge, show the copy-and-paste PIX string, and poll `GET
> /cashin/{id}/status` to a terminal state. Three rules from that file are not
> optional: (1) before the QR is rendered, decide whether this amount will be held
> for ~24h and say so on the screen — read the threshold from `GET /cashin/limits?payer_tax=`
> (`max_amount_cents`) and the ceiling from `GET /keys/me`
> (`limits.per_operation.cashin`), and do not write `200` or `6000` anywhere in my
> code; (2) treat `delayed` as *paid and frozen*, never as a failure — it must not
> trigger a retry, a second charge, or a 'payment failed' screen; (3) branch on the
> `acao` field of the error envelope, never on the HTTP status or the `erro` slug.
> Send `external_id` on every charge. Then show me the diff and tell me which of my
> existing screens now lie to the customer."

---

# pix-to-usdt

Receive a PIX payment and settle it in USDT: one Python file, **no
dependencies** — standard library only, no framework, no key in the source.

The interesting part is not the happy path. It is the two things that cost real
money when an integrator gets them wrong:

1. **Retention.** Past a per-payer ceiling, the provider holds the money for 24
   hours before releasing the crypto. The charge is still accepted. Your customer
   pays, sees nothing arrive, and opens a ticket — unless you told them first.
   This example decides that **before printing the QR** and prints the sentence
   you should show.
2. **`delayed` is not a failure.** It means *the PIX was paid* and the release is
   frozen. Code that reads it as an error tells a paying customer their money is
   gone, or worse, charges them a second time.

## What it does

| # | step | call |
|---|---|---|
| 1 | get a key (`--key` → env → local cache → create one) | `POST /keys/sandbox` |
| 2 | read **your** limits | `GET /keys/me` |
| 3 | read **this payer's** ladder | `GET /cashin/limits?payer_tax=` |
| 4 | trip a real error on purpose, at **both** bounds | `POST /cashin/preview` at max + 1, then min − 1 |
| 5 | forecast the 24h retention | computed from 2 and 3 |
| 6 | quote the crypto | `POST /cashin/preview` |
| 7 | create the charge, print the copy-and-paste string | `POST /cashin/charge` |
| 8 | poll to a terminal state | `GET /cashin/{id}/status` |

## Run it

```bash
python3 pix_to_usdt.py
```

Python 3.7+. Nothing to install. No signup: with no key supplied, the script
creates a sandbox key at runtime and caches it in `.lunium-sandbox-key`
(gitignored, created `0600`) so re-runs do not spend the quota.

> **The sandbox quota is 10 keys per day per _IP_, not per person.** An office, a
> VPN, a CI runner and a second clone all share it. If you clone this on an
> address that already spent its ten, step 1 stops with `acao=esperar` and
> **exit 7** — that is not your repository being broken. Reuse a key you already
> have; sandbox keys never expire from use:
>
> ```bash
> python3 pix_to_usdt.py --key lun_test_...
> ```

```bash
python3 pix_to_usdt.py --amount-cents 15000    # below the ceiling: credited immediately
python3 pix_to_usdt.py --amount-cents 25000    # above it: accepted, held ~24h
python3 pix_to_usdt.py --amount-cents 900000   # above the key maximum: refused, nothing created
python3 pix_to_usdt.py --selftest              # state machine only, no network
LUNIUM_API_KEY=lun_live_… python3 pix_to_usdt.py   # real QR, real polling
```

Other knobs: `--payer-tax`, `--address`, `--chain`, `--asset`, `--wait`, and
`LUNIUM_API_BASE` to point the whole script at another host.

## What to expect

The retention forecast, from a real run at R$ 250.00 — every number below was
read from the API seconds earlier, none of them is in the source:

```
5. RETENTION FORECAST  (no number below is written in the code)
---------------------------------------------------------------
requested                 : R$ 250.00
credited immediately up to: R$ 200.00
accepted but held up to   : R$ 6,000.00
verdict                   : ACCEPTED, THEN HELD ~24h BY THE PROVIDER
tell the customer         : Your customer pays now and the crypto arrives in about 24h.
                            Say it on the checkout screen, before the QR.

6. QUOTE  POST /cashin/preview
------------------------------------------------------------
pays        : R$ 250.00
fees        : R$ 7.23  (250 bps + R$ 1.00 fixed)
net         : R$ 242.77
rate        : 5.20 BRL per USDT
DELIVERED   : 46.663206 USDT   <- usdt_amount is the source of truth, do not recompute
```

Your `DELIVERED` line will not match that digit for digit — the rate moves
between runs. That is the point of the arrow: read `usdt_amount`, never
recompute it from the printed rate.

### One step needs a live key

A **sandbox key cannot create a PIX charge**, by design: the QR it returned would
be payable by anyone with a phone. So on a sandbox key step 7 answers:

```
7. CHARGE  POST /cashin/charge
------------------------------------------------------------
HTTP 400  erro=sandbox_sem_cashin  acao=parar
```

The script treats that as the documented outcome it is — explains it, exits `3`,
and does not fake a QR. Steps 1–6 are fully real on a sandbox key; steps 7 and 8
run against production unchanged. So the polling loop is not shipped untested,
step 8 still runs: it is pointed at an id that does not exist, which exercises the
loop, the request and the `nao_encontrado` branch for real. A poller that cannot
tell *"wrong id"* from *"not paid yet"* either spins forever or buries a payment.

## The three lessons

**Never hardcode a limit.** `R$ 200` and `R$ 6,000` are today's numbers. They are
in `GET /keys/me` (`limits.per_operation.cashin`) and `GET /cashin/limits`
(`max_amount_cents` — "the largest value that passes right now"). Step 4 asks for
the key's own maximum **plus one cent**, then its minimum **minus one cent**, so
the demo can never go stale: whatever the window becomes, the script finds both
edges and trips them.

**Branch on `acao`, not on the HTTP status — and not on the `erro` slug either.**
Every Lunium error is the same envelope — `{erro, acao, detail, request_id}`. Step
4 shows why the slug is the wrong thing to switch on: a value *above* the maximum
comes back as `erro=valor_abaixo_do_minimo`, whose text says the opposite of what
happened. `acao` is the field that is always true:

| `acao` | meaning |
|---|---|
| `corrigir` | fix a field and send it again |
| `esperar` | a ceiling was hit; it renews at midnight, Brasília time |
| `parar` | stop, retrying cannot help |

**Obey `Retry-After`, but cap it.** A per-minute limit answers with seconds; a
daily quota answers with *83,511 seconds*. Sleeping on that is a hung process,
not a retry. This script sleeps up to 60s and raises beyond that. (It learned
this the hard way — the first version slept for 23 hours.)

## Exit codes

| code | meaning |
|---|---|
| 0 | charge reached `paid` |
| 2 | PIX paid, held ~24h — **not** a failure |
| 3 | this key cannot issue charges (every sandbox key) |
| 4 | API said `acao: parar` |
| 5 | API said `acao: corrigir` |
| 6 | still unpaid when the wait ran out — hand over to the webhook |
| 7 | API said `acao: esperar` — a ceiling that renews, so retry later, not now |

## Notes

- Polling is the fallback, not the plan. The script polls at a quarter of the
  key's stated budget, floors at 10s, and backs off to 30s if the API does not
  report a rate limit at all. In production, use the webhook.
- `usdt_amount` from the preview is the source of truth. Do not recompute it from
  the rate: the displayed rate is rounded, the settled one is not.
- Send `external_id` on every charge — it is the reconciliation key and makes the
  call idempotent.
- `--selftest` uses a `must()` helper rather than `assert`, so it still checks
  something under `python3 -O`.

## Docs

- API reference — https://docs.luniumpay.com
- OpenAPI — https://docs.luniumpay.com/openapi.json
- Written for agents — https://api.luniumpay.com/llms.txt
- Agent discovery (no key) — https://api.luniumpay.com/mesh
