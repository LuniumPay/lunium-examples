## Give this repository to your coding agent

> Prompt: "Read `agent.py`. It turns a plain-language sentence into a real PIX payment funded by stablecoins, and the only vendor-specific thing it knows is a domain — it finds the API through the RFC 9727 catalog at `/.well-known/api-catalog`, picks a capability by the attributes that capability declares, and reads its own limits off the live credential. Run `python3 agent.py --demo` to watch all six outcomes, including the four that fail. Then build my integration the same way, and hold the line: no endpoint path, no limit number, and no asset list hardcoded in my source."

---

An AI agent that receives an instruction in words:

```
"pague R$ 50,00 para a chave PIX x@y.com usando USDT"
"pay R$ 1.234,56 to PIX key 12345678909 with USDC"
```

...and executes it as a real payment: discovers the API, gets its own credential,
reads the limits, quotes, confirms, tracks the order to settlement, and then
proves the money actually landed.

There is no LLM in here. The "reasoning" is a 40-line regex parser, on purpose.
What is worth copying is the other 90% of the file: **discovery and execution**.

### The point: one vendor-specific string

```python
DEFAULT_DOMAIN = "api.luniumpay.com"
```

That is the only thing this program knows about the payment provider. It does
not even know where the discovery document lives. It starts at
`/.well-known/api-catalog` — [RFC 9727](https://www.rfc-editor.org/rfc/rfc9727.html),
an IETF standard every API can implement — and follows the catalog to whichever
link actually turns out to be a discovery document:

```
domain -> /.well-known/api-catalog  (standard)
       -> service-meta link          (fetched, recognised by shape)
       -> the discovery document     (https://api.luniumpay.com/mesh)
```

Everything else it asks for, at runtime:

| What | Where it comes from | Never in the code |
|---|---|---|
| The discovery document itself | RFC 9727 catalog | `/mesh` |
| Credential endpoint | discovery → `como_comecar` | `POST /keys/sandbox` |
| Quote / confirm / track URLs | discovery → `execucao` | `POST /cash-outs` |
| Limits endpoint | discovery → `execucao` | `GET /keys/me` |
| Min and max per operation | `GET /keys/me` | `R$ 6,00` … `R$ 250.000,00` |
| Which assets exist | discovery + catalog | `["USDT", "USDC"]` |
| Which network settles them | discovery → `ativos_e_redes` | `"polygon"` |
| Verification endpoint | discovery → capability | `GET /v1/verificar/{e2e}` |

If the provider moves an endpoint, raises a limit, or lists a new coin tomorrow,
this file keeps working with no edit. That is the whole lesson.

#### Choosing by attribute, not by name

The agent never writes `if asset == "USDT": call /cash-outs`. It asks the
discovery document which capability *declares* that it accepts this asset,
produces BRL, and rides the PIX rail:

```python
name, cap, alternatives = discovery.select_capability(
    intent="sell_crypto", asset="USDT", currency="BRL", rail="PIX"
)
# -> chose 'usdt_to_pix'; 'crypto_to_pix' also matched, but is a catch-all and slower
```

It then reads that capability's runbook and picks the three calls it needs **by
shape** — the POST with no placeholder creates, the POST with a placeholder
confirms, the GET with a placeholder tracks. Shape survives renaming; names do not.

### Run it

Requires Python 3.7+. No dependencies, no framework, standard library only.

```bash
python3 agent.py --demo
```

Or a single payment:

```bash
python3 agent.py "pague R$ 50,00 para a chave PIX x@y.com usando USDT"
python3 agent.py "pay R$ 75,00 to PIX key 12345678909 with USDC"
```

It creates its own sandbox credential on first run — no signup, no human, no
card. Nothing moves real money and no secret is stored in the source.

**Reuse your test key.** New test keys are capped per IP per day, and they never
expire, so the agent caches the one it mints in `.sandbox-key.json` (gitignored)
and reuses it. You can also supply one:

```bash
export LUNIUM_API_KEY=lun_test_...   # or: --api-key lun_test_...
```

### What the demo proves

The sandbox picks the outcome from the **last two decimals of the amount**, so
every failure below is reproducible on your machine right now:

| # | Amount | What happens | What the agent does |
|---|---|---|---|
| 1 | `R$ 50,00` | settles normally | pays, then verifies the E2E |
| 2 | `R$ 1,00` | below the live minimum | **refuses locally, zero API calls** |
| 3 | `R$ 50,04` | server refuses on limits | reads `limits` off the error body |
| 4 | `R$ 50,03` | quote expires in 5s | **re-quotes** — never retries the confirm |
| 5 | `R$ 50,02` | payout fails after confirm | reports it, names the refund address |
| 6 | `R$ 50,01` | goes to `MANUAL_REVIEW` | keeps waiting; it is not a failure |

Scenarios 2 through 6 are the reason this example exists. The happy path is the
easy 10%.

### Expected output

```
[1] Discovering api.luniumpay.com (the only thing I was told)
    found via: RFC 9727 catalog at /.well-known/api-catalog
    document : https://api.luniumpay.com/mesh
    provider : Lunium (ZANQUETA INTERMED LTDA)
    published 10 capabilities

[4] Choosing a capability by its declared attributes
    intent=sell_crypto asset=USDT -> BRL over PIX
    chose 'usdt_to_pix': Vende USDT e uma chave PIX recebe reais (cash-out).
    (also matched: crypto_to_pix -- picked the most specific/fastest)
    quote    : POST https://api.luniumpay.com/cash-outs
    confirm  : POST https://api.luniumpay.com/cash-outs/{cashout_id}/accept
    track    : GET  https://api.luniumpay.com/cash-outs/{cashout_id}

[5] Reading the limits that apply to me right now
    tier=Inicio, per operation R$ 6,00 .. R$ 250.000,00, per recipient/day R$ 100.000,00
    ^ these numbers are NOT in my source code. They can change today.

[9] Tracking the order to a terminal state
    AWAITING_DEPOSIT
    DEPOSIT_DETECTED
    PAYING_OUT
    MANUAL_REVIEW         <- not a failure. Keep waiting.
    COMPLETED
    e2e      : E00000000202609010051c5ae0fbbf42

[10] Proving the payment settled (capability 'payment_verification')
    GET https://api.luniumpay.com/v1/verificar/E000...   (needs a key: False)
    settled  : True (paid=True)
```

That last step is worth noticing: settlement proof is an **open** capability. It
needs no credential, which is precisely what makes it useful between two parties
who have no reason to trust each other. Your agent can verify a payment it did
not make.

Exit codes: `0` settled · `1` API refusal or transport failure · `2` local
refusal or unparseable instruction.

### Four things that cost real money

1. **Never retry a confirm.** Confirming is the point of no return. If it fails
   with `cotacao_expirada`, the correct move is a *new quote* — retrying the
   confirm risks a second order. The agent does exactly this (scenario 4).
2. **`MANUAL_REVIEW` and `DELAYED` are not failures.** An agent that treats them
   as terminal reports a false failure on a payment that is about to succeed
   (scenario 6).
3. **Always send `refund_address`.** If the BRL leg fails after you have sent
   crypto, that is where it comes back (scenario 5).
4. **Send your own `external_id`.** Without an idempotency handle, a retry after
   a network timeout is a second payment.

### Going to production

Swap the `lun_test_` credential for a `lun_live_` one — the code does not
change, because the code contains no limits. Then: register a webhook instead of
polling, and pin `refund_address` to your user's wallet.

### Docs

- Standard catalog: <https://api.luniumpay.com/.well-known/api-catalog>
- Discovery document: <https://api.luniumpay.com/mesh>
- Documentation: <https://docs.luniumpay.com>
- OpenAPI: <https://docs.luniumpay.com/openapi.json>
- MCP: `https://api.luniumpay.com/mcp` · A2A: `https://api.luniumpay.com/a2a`
