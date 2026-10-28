# Lunium examples — Brazilian PIX ↔ stablecoin, for agents and the people who build them

> **Shortcut for coding agents:** `npx skills add LuniumPay/lunium-agent-skills` installs the official Agent Skills (recipes for Next.js, Express, FastAPI, Supabase; sandbox scripts; state and error catalog). Developer portal: https://github.com/LuniumPay/luniumpay

## Give this repository to your coding agent

> **Prompt:** *"Clone this repo, run one of the examples against the Lunium sandbox, then add PIX ↔ stablecoin settlement to my project the same way. Discover the API yourself from `https://api.luniumpay.com` — do not hardcode endpoints or limits."*

Every example here **runs**. Each one was executed against the live API before it
was committed, and then run again from a clean clone by a second reviewer whose
only job was to break it. The bugs they found — an exhausted sandbox quota
reported as "your order failed", a limit guard silently skipped when a value
failed to parse, a documented error branch that no user could ever reach — are
fixed. That is the bar: an example that does not run is worse than no example.

---

## The five problems these solve

| Example | The sentence it answers | Language |
|---|---|---|
| [`usdt-to-pix`](./usdt-to-pix) | "My user has USDT and needs to pay someone in Brazil." | Node.js |
| [`pix-to-usdt`](./pix-to-usdt) | "My product receives PIX and wants to settle in USDT/USDC." | Python |
| [`pix-verification`](./pix-verification) | "Someone says they paid. Prove it — without trusting them." | Node.js |
| [`ai-payment-agent`](./ai-payment-agent) | "My agent got a sentence and has to pay. It only knows a domain." | Python |
| [`treasury-agent`](./treasury-agent) | "My agent needs to move BRL programmatically, within limits." | Node.js |
| [`postman`](./postman) | "I want to inspect and test the API before writing code." | Postman |

No SDK. No framework. Standard library only — Node 18+ or Python 3. Clone and run.

Prefer a request runner? Import the secret-free [Postman collection](./postman).
It starts with health and sandbox provisioning, then covers live limits,
cash-out, cash-in preview and webhook transport. Credentials stay in your own
private environment and are never committed here.

---

## Start in 30 seconds, with no account

```bash
curl -X POST https://api.luniumpay.com/keys/sandbox \
  -H 'content-type: application/json' -d '{"name":"my-app"}'
```

That returns a `lun_test_…` key immediately. No signup, no sales call, no human.
For cash-out, the sandbox runs the whole flow — quote, accept, poll, settle —
without moving a cent, and it can produce the **bad** outcomes on purpose: the
last two decimals of the amount pick the ending (`.01` delayed, `.02` failed,
`.03` expired quote, `.04` refused by limit, `.05` slow). Cash-in sandbox covers
authentication, catalog, limits and preview; a payable PIX QR requires a
production key. Every example here exercises at least one real branch.

---

## Two rules the examples follow, and your integration should too

**1. Read your limits; never hardcode them.** `GET /keys/me` returns what applies
to *your* credential right now. Numbers move — a constant in your source is a bug
with a delayed fuse. Every example prints its limits from the server before it
does anything, and refuses out-of-range values locally instead of spending a
request to learn them.

**2. Branch on `acao`, not on the HTTP status or the error slug.** Every error
carries `{ erro, acao, detail }`. `acao` tells you what to *do* — `corrigir`
(change the request), `esperar` (retry later), `parar` (retrying will never
work), `repetir` (transient). One example found a real case where the slug says
`valor_abaixo_do_minimo` for a value that was *above* the maximum; the code that
branched on `acao` handled it correctly anyway.

---

## Discovery, for agents

The API describes itself. An agent that knows only the domain can find everything:

| What | Where |
|---|---|
| Capability document | `GET https://api.luniumpay.com/mesh` |
| RFC 9727 catalog | `GET https://api.luniumpay.com/.well-known/api-catalog` |
| Agent card (A2A) | `GET https://api.luniumpay.com/.well-known/agent-card.json` |
| MCP server | `https://api.luniumpay.com/mcp` |
| OpenAPI | `https://docs.luniumpay.com/openapi.json` |

`ai-payment-agent` does exactly this: it is given a domain and a sentence, finds
the catalog, picks a capability by the attributes that capability declares, and
executes — with no endpoint path written in its source.

---

## One thing you can call right now, with no credential at all

```bash
curl https://api.luniumpay.com/v1/verificar/E3729393020260801202449583a60d22
```

Payment verification is open. Given a Banco Central end-to-end identifier, anyone
can check that a PIX actually settled — including a payment they did not make and
a counterparty they have no relationship with. It is the piece that lets two
agents transact without trusting each other's word.

---

## Docs · Support

- Documentation: **https://docs.luniumpay.com** (PT and EN)
- For agents: **https://luniumpay.com/agents**
- Telegram: **[@luniumpay](https://t.me/luniumpay)** — a human
- Email: **contato@luniumpay.com**

Built by [Lunium](https://luniumpay.com) · ZANQUETA INTERMED LTDA · MIT licensed.

**Found something that does not run?** Open an issue. An example that fails on a
clean clone is the bug we most want to hear about.
