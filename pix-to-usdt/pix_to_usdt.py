#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pix-to-usdt — receive a PIX payment and settle it in USDT.

Standard library only. No dependencies, no framework, no secrets in this file:
if LUNIUM_API_KEY is unset, a sandbox key is created at runtime.

Steps, in order:
  1. get a key .......................... POST /keys/sandbox  (or $LUNIUM_API_KEY)
  2. read YOUR key's limits ............. GET  /keys/me
  3. read THIS PAYER's ladder ........... GET  /cashin/limits?payer_tax=
  4. exercise a real error path ......... POST /cashin/preview with (max + 1)
  5. forecast the 24h RETENTION ......... computed from 2 and 3, never a constant
  6. quote the crypto ................... POST /cashin/preview
  7. create the charge, print the QR .... POST /cashin/charge
  8. poll to a terminal state ........... GET  /cashin/{id}/status

Docs: https://docs.luniumpay.com   OpenAPI: https://docs.luniumpay.com/openapi.json
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("LUNIUM_API_BASE", "https://api.luniumpay.com")
TIMEOUT = 30
MAX_RETRY_SLEEP = 60  # a 429 can ask for 23 hours. Never block a process on that.

# Sandbox keys are capped (10 per day per IP) and never expire from use, so the
# first one is cached here instead of burning the quota on every run.
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".lunium-sandbox-key")

# Exit codes, so a shell caller can branch without parsing text.
EXIT_OK = 0        # charge reached `paid`
EXIT_HELD = 2      # PIX paid, provider holding for ~24h (NOT a failure)
EXIT_NO_CASHIN = 3 # this key cannot issue charges (sandbox keys never can)
EXIT_STOP = 4      # API said `acao: parar`
EXIT_FIX = 5       # API said `acao: corrigir`
EXIT_PENDING = 6   # still unpaid when we stopped waiting
EXIT_WAIT = 7      # API said `acao: esperar` - a ceiling that renews, not a dead end


def must(cond, msg):
    """Like assert, but survives `python3 -O`. A self-test that silently stops
    checking under -O is worse than no self-test."""
    if not cond:
        raise RuntimeError(msg)


# --------------------------------------------------------------------------
# Transport
# --------------------------------------------------------------------------

class LuniumError(Exception):
    """Every Lunium error is the same envelope: {erro, acao, detail, request_id}.

    Branch on `acao`, not on the HTTP status. Three values, three behaviours:
        parar    -> stop. Retrying cannot help.
        corrigir -> fix a field and send it again.
        esperar  -> a ceiling was hit; it renews (midnight, Brasilia time).
    """

    def __init__(self, http, payload):
        self.http = http
        self.payload = payload if isinstance(payload, dict) else {"detail": str(payload)}
        self.code = self.payload.get("erro", "http_%s" % http)
        self.acao = self.payload.get("acao", "parar")
        self.detail = self.payload.get("detail", "")
        self.request_id = self.payload.get("request_id", "")
        self.limits = self.payload.get("limits") or {}
        super().__init__("[%s] %s %s" % (http, self.code, self.detail))


def call(method, path, body=None, key=None, _attempt=1):
    """One HTTP call. Returns parsed JSON, or raises LuniumError / OSError."""
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    headers = {"accept": "application/json", "user-agent": "lunium-pix-to-usdt/1.0"}
    if data is not None:
        headers["content-type"] = "application/json"
    if key:
        headers["X-API-Key"] = key

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            payload = json.loads(raw)
        except ValueError:
            payload = {"detail": raw[:400]}
        # 429 is the one status worth retrying inside the transport: the server
        # says how long to wait, so waiting is not a guess. But obey it only
        # while it stays short - a daily quota answers with tens of thousands of
        # seconds, and sleeping on that is a hung process, not a retry.
        if e.code == 429 and _attempt <= 3:
            wait = float(e.headers.get("Retry-After") or payload.get("retry_after_s") or 5)
            if wait <= MAX_RETRY_SLEEP:
                print("   rate limited, sleeping %.0fs (Retry-After)" % wait)
                time.sleep(wait)
                return call(method, path, body, key, _attempt + 1)
            print("   rate limited for %.0fs - too long to wait in-process, raising" % wait)
        raise LuniumError(e.code, payload)


def brl(cents):
    return "R$ %s" % ("{:,.2f}".format((cents or 0) / 100.0))


def pick(d, *names):
    """Read the first field that exists. Response shapes gain fields over time;
    a reader that tolerates that does not break on a Tuesday."""
    for n in names:
        if isinstance(d, dict) and d.get(n) not in (None, ""):
            return d[n]
    return None


def rule(title):
    print("\n" + title)
    print("-" * max(60, len(title)))


# --------------------------------------------------------------------------
# Charge states
# --------------------------------------------------------------------------

# waiting -> keep polling · held -> paid but frozen · done/dead -> terminal
STATES = {
    "pending":      ("waiting", "nobody has paid the QR yet"),
    "under_review": ("waiting", "PIX received, settlement in transit"),
    "delayed":      ("held",    "PIX WAS PAID - the provider is holding the release"),
    "paid":         ("done",    "credited, crypto released"),
    "expired":      ("dead",    "nobody paid before the QR expired"),
    "refunded":     ("dead",    "the money went back to the payer"),
    "failed":       ("dead",    "settlement failed"),
}


def classify(state):
    """An unknown state is NOT a failure. Keep polling: guessing 'failed' here
    is how an integrator tells a customer their paid PIX was lost."""
    return STATES.get((state or "").lower(), ("waiting", "unrecognised state - keep polling"))


# --------------------------------------------------------------------------
# Steps
# --------------------------------------------------------------------------

def get_key(cli_key=None):
    """--key, then the environment, then the local cache, then create one. No key
    is ever written into this repository - the cache file is gitignored."""
    key = cli_key or os.environ.get("LUNIUM_API_KEY")
    if key:
        print("key      : from %s (%s...)" % ("--key" if cli_key else "$LUNIUM_API_KEY", key[:14]))
        return key, key.startswith("lun_test_")

    if os.path.exists(CACHE):
        with open(CACHE) as fh:
            key = fh.read().strip()
        if key:
            print("key      : reusing the sandbox key cached in %s (%s...)"
                  % (os.path.basename(CACHE), key[:14]))
            return key, True

    try:
        made = call("POST", "/keys/sandbox", {"name": "pix-to-usdt-example"})
    except LuniumError as e:
        # The quota is 10 keys per DAY per IP - not per person. An office, a CI
        # runner and a second clone behind the same address all share it, so a
        # first-time reader can hit this having created nothing. Say so, and exit
        # on `acao` rather than assuming the worst of its three meanings.
        print("could not create a sandbox key: %s" % (e.detail or e.code))
        print("acao=%s  erro=%s  req_id=%s" % (e.acao, e.code, e.request_id))
        print("")
        print("The sandbox quota is per IP per day and renews at midnight, Brasilia")
        print("time. A key you already made still works - they do not expire from use:")
        print("")
        print("    python3 pix_to_usdt.py --key lun_test_...")
        print("    LUNIUM_API_KEY=lun_test_... python3 pix_to_usdt.py")
        print("")
        print("To mint one once the quota renews:")
        print("    curl -X POST %s/keys/sandbox \\" % BASE)
        print("         -H 'content-type: application/json' -d '{\"name\":\"my-app\"}'")
        raise SystemExit(EXIT_WAIT if e.acao == "esperar" else EXIT_STOP)

    key = pick(made, "api_key", "key", "apiKey")
    if not key:
        print("POST /keys/sandbox answered without an api_key field:")
        print(json.dumps(made, indent=2, ensure_ascii=False)[:400])
        raise SystemExit(EXIT_STOP)
    # Create it 0600 from the first byte. open()+chmod() leaves the key
    # world-readable for the moment in between, which on a shared box is enough.
    fd = os.open(CACHE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(key)
    print("key      : created at runtime, POST /keys/sandbox -> %s..." % key[:14])
    print("           cached in %s so re-runs do not spend the daily quota"
          % os.path.basename(CACHE))
    return key, True


def read_limits(key):
    """The whole point: the numbers live on the server, not in this file."""
    me = call("GET", "/keys/me", key=key)
    lim = me.get("limits", {})
    cashin = lim.get("per_operation", {}).get("cashin", {})
    payer = lim.get("payer_limits", {})
    print("tier     : %s" % lim.get("tier"))
    print("per charge      : %s .. %s      <- limits.per_operation.cashin"
          % (brl(cashin.get("min_brl_cents")), brl(cashin.get("max_brl_cents"))))
    print("daily (this key): %s of %s left <- limits.available_today_cents"
          % (brl(lim.get("available_today_cents")), brl(lim.get("daily_limit_cents"))))
    print("rate limit      : %s req/min           <- key.rate_limit_per_minute"
          % me.get("key", {}).get("rate_limit_per_minute"))
    return me, cashin, payer


def read_ladder(key, payer_tax):
    """Ask before charging. `max_amount_cents` is the largest value that clears
    with no hold right now - guessing and taking a 403 becomes a loop."""
    lad = call("GET", "/cashin/limits?" + urllib.parse.urlencode({"payer_tax": payer_tax}), key=key)
    print("payer    : %s" % lad.get("payer_tax"))
    print("stage    : %s" % lad.get("stage"))
    print("clears now without a hold: %s   <- max_amount_cents" % brl(lad.get("max_amount_cents")))
    return lad


def forecast_retention(amount_cents, ladder, cashin_limits, payer_limits):
    """Decide, BEFORE showing a QR, whether this charge will be held - and say so.

    Not one number below is written in this file. The threshold comes from the
    payer ladder, the ceiling from the key, the hold window from the key. When
    the provider moves them, this code keeps telling the truth.
    """
    no_hold_ceiling = ladder.get("max_amount_cents")
    per_charge_max = cashin_limits.get("max_brl_cents")
    per_charge_min = cashin_limits.get("min_brl_cents")
    hold_hours = payer_limits.get("first_window_hours")

    print("requested                 : %s" % brl(amount_cents))
    print("credited immediately up to: %s" % brl(no_hold_ceiling))
    print("accepted but held up to   : %s" % brl(per_charge_max))

    if per_charge_min is not None and amount_cents < per_charge_min:
        return "refused", "below the key minimum (%s)" % brl(per_charge_min), None
    if per_charge_max is not None and amount_cents > per_charge_max:
        return "refused", "above the key maximum (%s)" % brl(per_charge_max), None
    if no_hold_ceiling is not None and amount_cents > no_hold_ceiling:
        if hold_hours:
            when = "arrives in about %sh" % hold_hours
        else:
            when = "is released after a hold the API did not put a number on"
        msg = ("Your customer pays now and the crypto %s. "
               "Say it on the checkout screen, before the QR." % when)
        return "held", msg, hold_hours
    return "immediate", "Credited on payment, no hold.", None


def poll(key, cashin_id, interval, deadline):
    """Poll to a terminal state. `delayed` ends the loop on purpose: the release
    is ~24h away and no foreground process should sit on that - a webhook should.
    """
    seen = None
    while True:
        try:
            st = call("GET", "/cashin/%s/status" % urllib.parse.quote(str(cashin_id)), key=key)
        except LuniumError as e:
            if e.code == "nao_encontrado":
                print("   the id does not exist for this key - stop, do not retry it")
                return "nao_encontrado", {}
            raise

        state = (pick(st, "status", "state", "situacao") or "unknown").lower()
        kind, meaning = classify(state)
        if state != seen:
            print("   [%s] %-13s %s" % (time.strftime("%H:%M:%S"), state, meaning))
            seen = state
        settlement = pick(st, "settlement_status")
        if settlement and state in ("paid", "delayed"):
            print("   settlement_status: %s" % settlement)

        if kind == "held":
            until = pick(st, "delay_until", "delayed_until", "held_until")
            print("   RETENTION: the PIX was paid. delay_until = %s" % until)
            print("   Do NOT create a second charge and do NOT tell the customer it failed.")
            return state, st
        if kind in ("done", "dead"):
            return state, st
        if time.time() > deadline:
            print("   still %s when the wait ran out - use the webhook for the rest" % state)
            return state, st
        time.sleep(interval)


# --------------------------------------------------------------------------

def prove_poller(key):
    """The charge could not be created, so there is no id to follow. Rather than
    leave the polling loop as code nobody ran, point it at an id that does not
    exist: the loop, the request and the `nao_encontrado` branch all execute for
    real. A poller that cannot tell 'wrong id' from 'not paid yet' either spins
    forever or declares a paid charge dead."""
    rule("8. POLLING  GET /cashin/{id}/status")
    print("No charge exists to follow, so the loop is exercised against an id")
    print("that does not exist - the request below is real:")
    state, _ = poll(key, "cin_this_id_does_not_exist", interval=10.0, deadline=time.time() + 5)
    must(state == "nao_encontrado", "a bad id must end the loop, not extend it")
    selftest()


def selftest():
    """Local check of the state machine - no network, and labelled as such."""
    rule("STATE MACHINE (local, no API calls) - how each state is classified")
    for s in ["pending", "under_review", "delayed", "paid", "expired", "refunded",
              "failed", "some_state_invented_next_year"]:
        kind, meaning = classify(s)
        flag = "STOP LOOP" if kind in ("done", "dead", "held") else "keep polling"
        print("  %-30s %-8s %-13s %s" % (s, kind, flag, meaning))
    must(classify("delayed")[0] == "held", "`delayed` means paid-and-frozen, never failed")
    must(classify("whatever")[0] == "waiting", "an unknown state must never mean failure")
    print("\nok: `delayed` is money-in-hand, and an unknown state never means failure.")


def main():
    ap = argparse.ArgumentParser(description="Receive a PIX, settle in USDT.")
    ap.add_argument("--amount-cents", type=int, default=25000, help="charge value in cents (default 25000 = R$ 250.00)")
    ap.add_argument("--payer-tax", default="12345678909", help="payer CPF/CNPJ, digits only")
    ap.add_argument("--address", default="0x17B4c2fD0A4B2A6d4e1F0C9e3B5a7D8c9E0f6249", help="wallet that receives the USDT")
    ap.add_argument("--chain", default="polygon")
    ap.add_argument("--asset", default="usdt")
    ap.add_argument("--wait", type=int, default=90, help="seconds to poll before handing over to the webhook")
    ap.add_argument("--key", help="API key; overrides $LUNIUM_API_KEY and the local cache")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        selftest()
        return EXIT_OK

    rule("1. KEY  (nothing is stored in this file)")
    key, is_sandbox = get_key(args.key)
    print("mode     : %s" % ("SANDBOX - no real money moves" if is_sandbox
                             else "PRODUCTION - this key moves real money"))

    rule("2. LIMITS, READ FROM THE SERVER  GET /keys/me")
    me, cashin_limits, payer_limits = read_limits(key)

    rule("3. THIS PAYER'S LADDER  GET /cashin/limits")
    ladder = read_ladder(key, args.payer_tax)

    rule("4. ERROR PATH, ON PURPOSE  POST /cashin/preview above the maximum")
    over = (cashin_limits.get("max_brl_cents") or 0) + 1
    print("asking for %s, which is the key's own maximum + 1 cent..." % brl(over))
    try:
        call("POST", "/cashin/preview", {"amount_cents": over, "asset": args.asset, "chain": args.chain}, key=key)
        print("unexpected: the API accepted a value above its stated maximum")
    except LuniumError as e:
        print("HTTP %s  erro=%s  acao=%s" % (e.http, e.code, e.acao))
        print("detail : %s" % e.detail)
        print("req_id : %s" % e.request_id)
        if e.acao == "corrigir":
            print("handled: `corrigir` means fix the field and resend - so we clamp to")
            print("         the maximum the server just told us, and carry on.")
        elif e.acao == "esperar":
            print("handled: `esperar` means a ceiling renews at midnight (Brasilia).")
        else:
            print("handled: `parar` means retrying cannot help.")
        if e.code == "valor_abaixo_do_minimo":
            print("note   : the `erro` slug reads 'abaixo do minimo' for a value that is")
            print("         ABOVE the maximum. This is exactly why you branch on `acao`")
            print("         and read `detail` - never on the slug or the HTTP status.")

    under = max((cashin_limits.get("min_brl_cents") or 1) - 1, 0)
    print("\nand the other bound: %s, one cent under the key's own minimum..." % brl(under))
    try:
        call("POST", "/cashin/preview", {"amount_cents": under, "asset": args.asset, "chain": args.chain}, key=key)
        print("unexpected: the API accepted a value below its stated minimum")
    except LuniumError as e:
        print("HTTP %s  erro=%s  acao=%s  detail=%s" % (e.http, e.code, e.acao, e.detail))
        print("handled: both ends of the window came from the server, not from here.")

    rule("5. RETENTION FORECAST  (no number below is written in the code)")
    verdict, note, hold_hours = forecast_retention(args.amount_cents, ladder, cashin_limits, payer_limits)
    print("verdict                   : %s" % {
        "immediate": "CREDITED IMMEDIATELY",
        "held": "ACCEPTED, THEN HELD %s BY THE PROVIDER" % (
            "~%sh" % hold_hours if hold_hours else "FOR AN UNSTATED WINDOW"),
        "refused": "WOULD BE REFUSED",
    }[verdict])
    print("tell the customer         : %s" % note)
    if verdict == "refused":
        print("\nNothing was created. Pick a value inside the range above.")
        return EXIT_FIX

    rule("6. QUOTE  POST /cashin/preview")
    q = call("POST", "/cashin/preview",
             {"amount_cents": args.amount_cents, "asset": args.asset, "chain": args.chain}, key=key)
    print("pays        : %s" % brl(q.get("amount_cents")))
    print("fees        : %s  (%s bps + %s fixed)"
          % (brl(q.get("fee_total_cents")), q.get("admin_fee_bps"), brl(q.get("admin_fee_fixed_cents"))))
    print("net         : %s" % brl(q.get("net_cents")))
    print("rate        : %s BRL per USDT" % q.get("brl_per_usdt"))
    print("DELIVERED   : %s %s   <- usdt_amount is the source of truth, do not recompute"
          % (q.get("usdt_amount"), args.asset.upper()))

    rule("7. CHARGE  POST /cashin/charge")
    try:
        ch = call("POST", "/cashin/charge", {
            "amount_cents": args.amount_cents,
            "payer_tax_number": args.payer_tax,
            "payout_address": args.address,
            "chain": args.chain,
            "asset": args.asset,
            "external_id": "pix-to-usdt-%d" % int(time.time()),
        }, key=key)
    except LuniumError as e:
        print("HTTP %s  erro=%s  acao=%s" % (e.http, e.code, e.acao))
        print("detail : %s" % e.detail)
        print("req_id : %s" % e.request_id)
        if e.code == "sandbox_sem_cashin":
            print("\nhandled: a sandbox key never issues a charge, because the QR it")
            print("         returned would be payable by anyone with a phone. Every")
            print("         step above ran for real; only this one needs a live key.")
            print("         Re-run with:  LUNIUM_API_KEY=lun_live_... python3 pix_to_usdt.py")
            prove_poller(key)
            return EXIT_NO_CASHIN
        if e.acao == "corrigir":
            return EXIT_FIX
        if e.acao == "esperar":
            print("\nhandled: a daily ceiling was hit. It renews at midnight, Brasilia time.")
            return EXIT_STOP
        return EXIT_STOP

    print(json.dumps(ch, indent=2, ensure_ascii=False)[:1200])
    cashin_id = pick(ch, "id", "cashin_id", "charge_id")
    br_code = pick(ch, "br_code", "brcode", "copia_e_cola", "pix_copia_e_cola", "qr_code", "emv")
    print("\nPIX COPY-AND-PASTE (give this string to the payer):\n%s" % br_code)
    if verdict == "held":
        print("\nSHOW THIS NEXT TO THE QR: payment clears now, crypto is released in %s."
              % ("~%sh" % hold_hours if hold_hours else "a later window"))

    rule("8. POLLING  GET /cashin/{id}/status")
    rate = me.get("key", {}).get("rate_limit_per_minute")
    if rate:
        # A quarter of the budget at most, and never faster than once per 10s.
        interval = max(10.0, 240.0 / rate)
        budget = "%s req/min" % rate
    else:
        interval = 30.0  # limit unreported -> go slow rather than guess a number
        budget = "unreported, so this backs off"
    print("every %.0fs = %.1f req/min against a budget of %s, for up to %ss"
          % (interval, 60.0 / interval, budget, args.wait))
    state, _ = poll(key, cashin_id, interval, time.time() + args.wait)

    kind, _ = classify(state)
    if kind == "held":
        return EXIT_HELD
    if state == "paid":
        return EXIT_OK
    return EXIT_PENDING if kind == "waiting" else EXIT_STOP


if __name__ == "__main__":
    try:
        sys.exit(main())
    except LuniumError as e:
        print("\nunhandled API error: %s" % e, file=sys.stderr)
        sys.exit(EXIT_STOP)
    except (urllib.error.URLError, OSError) as e:
        print("\nnetwork problem, nothing was created: %s" % e, file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nstopped. The charge, if created, is still alive on the server.", file=sys.stderr)
        sys.exit(130)
