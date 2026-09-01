#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
A payment agent that starts from a domain name and nothing else.

Give it a sentence in plain language:

    "pague R$ 50,00 para a chave PIX x@y.com usando USDT"
    "pay R$ 120.00 to PIX key 11999998888 with USDC"

It then:

  1. fetches the discovery document at https://<domain>/mesh
  2. picks a capability by its declared ATTRIBUTES (intent, input_assets,
     output_currencies, payment_rails) -- never by guessing from its name
  3. reads that capability's runbook to learn which URLs to call
  4. creates its own sandbox credential
  5. reads the live limits and checks the order against them
  6. quotes, confirms, polls to a terminal state
  7. proves settlement through the open, keyless verification capability

The point of this example is what is NOT in it. There is exactly one
hardcoded string in this file that ties it to Lunium: the domain below.
Every path -- the credential endpoint, the quote endpoint, the confirm
endpoint, the polling endpoint, the limits endpoint, the verification
endpoint -- is read out of the discovery document at runtime. If Lunium
moves an endpoint tomorrow, this file keeps working.

There is no LLM here. The "reasoning" is a small regex parser, deliberately,
so that nothing distracts from the two things worth copying: discovery and
execution.

Standard library only. Python 3.7+.
"""

from __future__ import print_function

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from decimal import Decimal, ROUND_HALF_UP

# --------------------------------------------------------------------------
# The one and only vendor-specific fact in this file: who to ask.
# --------------------------------------------------------------------------
DEFAULT_DOMAIN = "api.luniumpay.com"

# Where ANY well-behaved API publishes its own index. This is RFC 9727, an
# IETF standard -- not something Lunium invented -- which is why starting here
# rather than at a vendor path is the honest version of "I only know a domain".
WELL_KNOWN_CATALOG = "/.well-known/api-catalog"
# Used only if the provider publishes no catalog. Documented in their guide.
FALLBACK_DISCOVERY = "/mesh"

USER_AGENT = "lunium-ai-payment-agent/1.0 (+https://github.com/lunium/lunium-oss)"

# Test credentials are rate limited per IP per day and they never expire, so
# reusing one is both polite and necessary. Precedence: --api-key, then this
# environment variable, then the on-disk cache, then a freshly minted key.
ENV_KEY = "LUNIUM_API_KEY"
KEY_CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".sandbox-key.json")

# States that end an order. Everything else means "keep waiting".
# MANUAL_REVIEW and DELAYED look alarming and are NOT failures -- an agent
# that treats them as terminal will report a false failure on a payment that
# is about to succeed. This is the single most expensive bug in this domain.
TERMINAL_STATES = frozenset(
    ["COMPLETED", "FAILED", "REFUNDED", "EXPIRED", "CANCELLED", "CANCELED"]
)
SUCCESS_STATES = frozenset(["COMPLETED"])


# ==========================================================================
# Errors
# ==========================================================================


class TransportError(Exception):
    """The network or the response body failed us, before any business logic."""


class ApiError(Exception):
    """A structured refusal from the API. Carries the machine-readable fields."""

    def __init__(self, status, payload):
        self.status = status
        self.payload = payload if isinstance(payload, dict) else {}
        self.code = self.payload.get("erro") or self.payload.get("error") or "unknown"
        self.action = self.payload.get("acao") or self.payload.get("action")
        self.detail = self.payload.get("detail") or self.payload.get("message") or ""
        self.limits = self.payload.get("limits")
        self.request_id = self.payload.get("request_id")
        super(ApiError, self).__init__("%s (HTTP %s): %s" % (self.code, status, self.detail))


class DiscoveryError(Exception):
    """The discovery document did not contain something we need."""


class ParseError(Exception):
    """The instruction could not be understood."""


class PolicyRefusal(Exception):
    """We refused locally, before spending an API call."""


# ==========================================================================
# HTTP
# ==========================================================================


def http_json(method, url, body=None, api_key=None, timeout=30):
    """One tiny JSON-over-HTTP helper. Returns the decoded body or raises ApiError."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"accept": "application/json", "user-agent": USER_AGENT}
    if data is not None:
        headers["content-type"] = "application/json"
    if api_key:
        headers["X-API-Key"] = api_key

    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        response = urllib.request.urlopen(request, timeout=timeout)
        try:
            raw = response.read().decode("utf-8", "replace")
            status = response.getcode()
        finally:
            response.close()
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        status = exc.code
    except urllib.error.URLError as exc:
        raise TransportError("could not reach %s: %s" % (url, exc.reason))

    try:
        payload = json.loads(raw) if raw.strip() else {}
    except ValueError:
        raise TransportError("non-JSON response from %s (HTTP %s): %s" % (url, status, raw[:200]))

    if status >= 400:
        raise ApiError(status, payload)
    return payload


# ==========================================================================
# Discovery -- everything below is read from /mesh, nothing is assumed
# ==========================================================================


class Discovery(object):
    """A thin, defensive reader over the provider's discovery document."""

    def __init__(self, domain):
        self.domain = domain
        self.url, self.doc, self.via = self._bootstrap(domain)

    # -- bootstrap ---------------------------------------------------------

    @staticmethod
    def _looks_like_discovery(doc):
        """Identify the discovery document by its CONTENT, not by its URL."""
        return isinstance(doc, dict) and "capacidades" in doc and "execucao" in doc

    @staticmethod
    def _catalog_links(catalog):
        """Pull candidate hrefs out of an RFC 9727 linkset, richest relation first."""
        hrefs, extras = [], []
        for entry in (catalog or {}).get("linkset", []):
            if not isinstance(entry, dict):
                continue
            for relation, items in entry.items():
                if not isinstance(items, list):
                    continue
                bucket = hrefs if relation == "service-meta" else extras
                for item in items:
                    if isinstance(item, dict) and item.get("href"):
                        bucket.append(item["href"])
        return hrefs + extras

    def _bootstrap(self, domain):
        """Domain -> standard catalog -> the provider's discovery document.

        We do not know which of the catalog's links is the discovery document,
        so we fetch them in order and keep the first one that IS one. Same
        principle as everywhere else here: recognise things by shape.
        """
        catalog_url = "https://%s%s" % (domain, WELL_KNOWN_CATALOG)
        try:
            catalog = http_json("GET", catalog_url)
        except (ApiError, TransportError):
            catalog = None

        for href in self._catalog_links(catalog):
            try:
                doc = http_json("GET", href)
            except (ApiError, TransportError):
                continue
            if self._looks_like_discovery(doc):
                return href, doc, "RFC 9727 catalog at %s" % WELL_KNOWN_CATALOG

        fallback = "https://%s%s" % (domain, FALLBACK_DISCOVERY)
        doc = http_json("GET", fallback)
        if self._looks_like_discovery(doc):
            return fallback, doc, "documented fallback path"
        raise DiscoveryError("%s publishes no discovery document I can read" % domain)

    # -- identity ----------------------------------------------------------

    def who(self):
        block = self.doc.get("quem_somos", {})
        return {
            "name": block.get("nome") or self.domain,
            "org": block.get("organizacao"),
            "does": block.get("o_que_faz"),
            "docs": block.get("documentacao"),
        }

    # -- capability selection ---------------------------------------------

    @staticmethod
    def _accepts(declared, value):
        """A capability may declare '*' meaning 'any'."""
        if not declared:
            return False
        return "*" in declared or value in declared

    def known_intents(self):
        by_intent = self.doc.get("como_escolher_capacidade", {}).get("por_intencao", {})
        return set(by_intent.keys())

    def select_capability(self, intent, asset=None, currency=None, rail=None):
        """Choose a capability by what it DECLARES, not by what it is called.

        This is the part worth copying. We never write `if asset == "USDT":
        call /cash-outs`. We ask the provider which of its capabilities accepts
        this asset, produces this currency and rides this rail.
        """
        scored = []
        for name, cap in self.doc.get("capacidades", {}).items():
            if intent not in (cap.get("intent") or []):
                continue
            if asset and not self._accepts(cap.get("input_assets"), asset):
                continue
            if currency and currency not in (cap.get("output_currencies") or []):
                continue
            if rail and rail not in (cap.get("payment_rails") or []):
                continue
            # Prefer a capability that names our asset explicitly over a
            # catch-all, and prefer the faster settlement path.
            specificity = 0 if "*" in (cap.get("input_assets") or []) else 2
            speed = 1 if cap.get("settlement_speed") == "seconds" else 0
            scored.append((specificity + speed, name, cap))

        if not scored:
            raise DiscoveryError(
                "no capability at %s accepts intent=%s asset=%s currency=%s rail=%s"
                % (self.domain, intent, asset, currency, rail)
            )
        scored.sort(key=lambda item: item[0], reverse=True)
        _, name, cap = scored[0]
        alternatives = [item[1] for item in scored[1:]]
        return name, cap, alternatives

    # -- runbooks ----------------------------------------------------------

    def runbook(self, capability_name):
        """Find the execution recipe for a capability.

        One runbook can serve several capabilities; the document says so with
        `tambem_serve_para` ("also serves"). We follow that pointer instead of
        assuming the runbook is keyed by the capability's own name.
        """
        execution = self.doc.get("execucao", {})
        entry = execution.get(capability_name)
        # A runbook is either a sequence of numbered steps, or -- for a
        # single-call capability like verification -- one bare URL.
        if isinstance(entry, dict) and (self._steps(entry) or entry.get("url")):
            return capability_name, entry
        for key, value in execution.items():
            if not isinstance(value, dict):
                continue
            if capability_name in (value.get("tambem_serve_para") or []):
                return key, value
        raise DiscoveryError("no runbook published for capability '%s'" % capability_name)

    @staticmethod
    def _steps(runbook):
        """Ordered (name, method, url) triples for a runbook."""
        steps = []
        for key in sorted(k for k in runbook if k.startswith("passo")):
            value = runbook[key]
            if isinstance(value, dict) and value.get("url"):
                steps.append((key, (value.get("metodo") or "GET").upper(), value["url"], value))
        return steps

    def plan(self, capability_name):
        """Turn a runbook into the three calls we need, chosen by SHAPE.

        We do not look for a step called "quote". We look for the step that
        creates something (POST, no placeholder in the URL), the step that
        confirms it (POST, placeholder), and the step that reads it back
        (GET, placeholder). Shape survives renaming; names do not.
        """
        source, runbook = self.runbook(capability_name)
        create = confirm = poll = None
        for _, method, url, meta in self._steps(runbook):
            templated = "{" in url
            if method == "POST" and not templated and create is None:
                create = (url, meta)
            elif method == "POST" and templated and confirm is None:
                confirm = (url, meta)
            elif method == "GET" and templated and poll is None:
                poll = (url, meta)
        if not create or not confirm:
            raise DiscoveryError(
                "runbook '%s' does not expose a create+confirm pair" % source
            )
        return {
            "source": source,
            "create_url": create[0],
            "create_meta": create[1],
            "confirm_url": confirm[0],
            "poll_url": poll[0] if poll else None,
        }

    def simple_url(self, capability_name):
        """A one-call capability (like verification): first published URL."""
        _, runbook = self.runbook(capability_name)
        if runbook.get("url"):
            return runbook["url"], runbook
        steps = self._steps(runbook)
        if not steps:
            raise DiscoveryError("capability '%s' publishes no URL" % capability_name)
        return steps[0][2], steps[0][3]

    # -- onboarding and limits --------------------------------------------

    def credential_endpoint(self):
        """Where a brand new agent gets a test credential, per the document."""
        start = self.doc.get("como_comecar", {})
        for key in sorted(k for k in start if k.startswith("passo")):
            step = start[key]
            if not isinstance(step, dict) or not step.get("url"):
                continue
            if "chave" in key or "key" in key or "sandbox" in key:
                return (step.get("metodo") or "POST").upper(), step["url"], step
        raise DiscoveryError("discovery document does not say how to get a credential")

    def limits_endpoint(self):
        """Where this credential's live limits live. Never hardcode the numbers."""
        for key, value in self.doc.get("execucao", {}).items():
            if not isinstance(value, dict) or not value.get("url"):
                continue
            haystack = (key + " " + str(value.get("observacao", ""))).lower()
            if "limite" in haystack or "limit" in haystack:
                return (value.get("metodo") or "GET").upper(), value["url"]
        raise DiscoveryError("discovery document does not say where limits are published")

    def catalog_url(self):
        return self.doc.get("ativos_e_redes", {}).get("catalogo")

    def instant_pairs(self):
        """Asset/network pairs the provider settles immediately."""
        pairs = []
        for item in self.doc.get("ativos_e_redes", {}).get("instantaneo", []) or []:
            if isinstance(item, dict) and item.get("ativo"):
                pairs.append((item["ativo"].upper(), item.get("rede")))
        return pairs

    def known_assets(self):
        """Every asset symbol the document mentions, for the parser's vocabulary."""
        assets = set()
        for cap in self.doc.get("capacidades", {}).values():
            for field in ("input_assets", "output_currencies"):
                for value in cap.get(field) or []:
                    if value and value != "*":
                        assets.add(value.upper())
        for asset, _ in self.instant_pairs():
            assets.add(asset)
        return assets

    def network_for(self, asset):
        """Ask the document, then the catalog. Never keep a list in the code."""
        for candidate, network in self.instant_pairs():
            if candidate == asset.upper() and network:
                return network
        catalog = self.catalog_url()
        if catalog:
            try:
                data = http_json("GET", catalog)
            except (ApiError, TransportError):
                return None
            for entry in _iter_catalog(data):
                if str(entry.get("asset", entry.get("ativo", ""))).upper() != asset.upper():
                    continue
                network = entry.get("network") or entry.get("rede")
                if isinstance(network, list) and network:
                    return network[0]
                if network:
                    return network
        return None


def _iter_catalog(data):
    """The catalog may be a list, or a dict wrapping a list. Handle both."""
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict):
                yield item
    elif isinstance(data, dict):
        for value in data.values():
            if isinstance(value, list):
                for item in value:
                    if isinstance(item, dict):
                        yield item


def _read_cached_key(domain):
    """A sandbox key is not a secret worth protecting, but it is worth keeping."""
    try:
        with open(KEY_CACHE) as handle:
            return json.load(handle).get(domain)
    except (IOError, OSError, ValueError):
        return None


def _write_cached_key(domain, key):
    try:
        data = {}
        if os.path.exists(KEY_CACHE):
            with open(KEY_CACHE) as handle:
                data = json.load(handle)
        data[domain] = key
        with open(KEY_CACHE, "w") as handle:
            json.dump(data, handle, indent=2)
        return True
    except (IOError, OSError, ValueError):
        return False


def fill(url_template, value):
    """Substitute whatever placeholder the document used: {id}, {e2e}, ..."""
    return re.sub(r"\{[^}]+\}", urllib.parse.quote(str(value), safe=""), url_template)


# ==========================================================================
# Limits -- read at runtime, never written down
# ==========================================================================


class Limits(object):
    """The live limits for THIS credential. Every number comes off the wire."""

    def __init__(self, payload):
        self.raw = payload
        limits = payload.get("limits", {}) if isinstance(payload, dict) else {}
        self.tier = limits.get("tier")

        block = {}
        if isinstance(limits.get("cashout"), dict):
            block = limits["cashout"]
        elif isinstance(limits.get("per_operation"), dict):
            block = limits["per_operation"].get("cashout") or {}
        self.min_cents = block.get("min_brl_cents")
        self.max_cents = block.get("max_brl_cents_por_transacao") or block.get("max_brl_cents")
        self.note = block.get("nota")

        payee = limits.get("payee_limits") or {}
        self.payee_daily_cents = payee.get("daily_cents")
        self.payee_scope = payee.get("scope")

    def check(self, cents):
        """Return None if allowed, otherwise a human sentence explaining why not."""
        if self.min_cents is not None and cents < self.min_cents:
            return "%s is below this credential's minimum of %s" % (brl(cents), brl(self.min_cents))
        if self.max_cents is not None and cents > self.max_cents:
            return "%s is above this credential's maximum of %s" % (brl(cents), brl(self.max_cents))
        return None

    def describe(self):
        parts = []
        if self.tier:
            parts.append("tier=%s" % self.tier)
        if self.min_cents is not None and self.max_cents is not None:
            parts.append("per operation %s .. %s" % (brl(self.min_cents), brl(self.max_cents)))
        if self.payee_daily_cents:
            parts.append("per recipient/day %s (%s)" % (brl(self.payee_daily_cents), self.payee_scope))
        return ", ".join(parts) if parts else "no limit block published"


def brl(cents):
    if cents is None:
        return "R$ ?"
    return "R$ %s" % ("{:,.2f}".format(cents / 100.0).replace(",", "@").replace(".", ",").replace("@", "."))


# ==========================================================================
# The "reasoning": a small, honest parser
# ==========================================================================

RE_MONEY = re.compile(r"(?:R\$|BRL)\s*([\d][\d.,]*)", re.IGNORECASE)
RE_UUID = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")
RE_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
RE_PHONE = re.compile(r"\+55[\s-]?\(?\d{2}\)?[\s-]?9?\d{4}[\s-]?\d{4}")
RE_DIGITS = re.compile(r"\b[\d][\d.\-/]{9,17}\b")

SELL_WORDS = (
    "pague", "pagar", "paga", "envie", "enviar", "mande", "mandar", "transfira",
    "transferir", "venda", "vender", "sacar", "saque",
    "pay", "send", "sell", "cash out", "cashout", "off-ramp", "offramp", "withdraw",
)
BUY_WORDS = (
    "compre", "comprar", "cobrar", "cobranca", "cobrança", "receba em",
    "buy", "charge", "on-ramp", "onramp", "top up",
)
VERIFY_WORDS = ("verifique", "verificar", "confira", "conferir", "prove", "verify", "check")


class Order(object):
    def __init__(self, intent, brl_cents, asset, pix_key, pix_key_type):
        self.intent = intent
        self.brl_cents = brl_cents
        self.asset = asset
        self.pix_key = pix_key
        self.pix_key_type = pix_key_type

    def __repr__(self):
        return "Order(intent=%s, %s, asset=%s, key=%s/%s)" % (
            self.intent, brl(self.brl_cents), self.asset, self.pix_key, self.pix_key_type
        )


def parse_brl_to_cents(text):
    """Read a Brazilian or English money string into integer cents.

    '50' -> 5000   '50,04' -> 5004   '50.04' -> 5004
    '1.234,56' -> 123456   '1,234.56' -> 123456   '1.234' -> 123400
    """
    value = text.strip()
    if "," in value and "." in value:
        if value.rindex(",") > value.rindex("."):
            value = value.replace(".", "").replace(",", ".")   # 1.234,56
        else:
            value = value.replace(",", "")                     # 1,234.56
    elif "," in value:
        value = value.replace(",", ".")                        # 50,04
    elif "." in value:
        # '1.234' is one thousand two hundred thirty four; '50.04' is fifty and four cents.
        if len(value.rsplit(".", 1)[1]) == 3:
            value = value.replace(".", "")
    try:
        amount = Decimal(value)
    except Exception:
        raise ParseError("could not read an amount from %r" % text)
    return int((amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def classify_pix_key(text):
    """Infer the PIX key and its type. Order matters: most specific first."""
    match = RE_UUID.search(text)
    if match:
        return match.group(0), "random"
    match = RE_EMAIL.search(text)
    if match:
        return match.group(0), "email"
    match = RE_PHONE.search(text)
    if match:
        return "+55" + re.sub(r"\D", "", match.group(0))[-11:], "phone"
    for candidate in RE_DIGITS.findall(text):
        digits = re.sub(r"\D", "", candidate)
        if len(digits) == 11:
            return digits, "cpf"
        if len(digits) == 14:
            return digits, "cnpj"
    raise ParseError("no PIX key found (expected an e-mail, phone, CPF, CNPJ or random key)")


def parse_instruction(text, vocabulary, default_asset=None):
    """Turn a sentence into an Order. No model, no magic -- just regex.

    `vocabulary` is the asset set learned from the discovery document, so even
    the parser holds no hardcoded list of coins.
    """
    lowered = text.lower()

    if any(word in lowered for word in VERIFY_WORDS) and not any(w in lowered for w in SELL_WORDS):
        intent = "verify_payment"
    elif any(word in lowered for word in BUY_WORDS) and not any(w in lowered for w in SELL_WORDS):
        intent = "buy_crypto"
    elif any(word in lowered for word in SELL_WORDS):
        intent = "sell_crypto"
    else:
        raise ParseError("no known action in %r (try 'pague'/'pay', 'compre'/'buy', 'verifique')" % text)

    money = RE_MONEY.search(text)
    if not money:
        raise ParseError("no BRL amount found -- write it as 'R$ 50,00'")
    cents = parse_brl_to_cents(money.group(1))

    # Remove the money expression before hunting for numeric PIX keys,
    # so 'R$ 50' is never mistaken for a document number.
    without_money = text[: money.start()] + " " + text[money.end():]
    pix_key, pix_key_type = classify_pix_key(without_money)

    asset = None
    for symbol in sorted(vocabulary, key=len, reverse=True):
        if re.search(r"\b%s\b" % re.escape(symbol), text, re.IGNORECASE):
            if symbol != "BRL":
                asset = symbol
                break
    if asset is None:
        asset = default_asset
    if asset is None:
        raise ParseError("no asset named and the provider published no default")

    return Order(intent, cents, asset, pix_key, pix_key_type)


# ==========================================================================
# Output
# ==========================================================================


class Trace(object):
    def __init__(self, quiet=False):
        self.n = 0
        self.quiet = quiet

    def step(self, title):
        self.n += 1
        if not self.quiet:
            print("\n[%d] %s" % (self.n, title))

    def say(self, line, indent=4):
        if not self.quiet:
            print(" " * indent + line)

    def rule(self, title=""):
        if not self.quiet:
            print("\n" + "=" * 72)
            if title:
                print(title)
                print("=" * 72)


# ==========================================================================
# The agent
# ==========================================================================


class PaymentAgent(object):
    def __init__(self, domain=DEFAULT_DOMAIN, discovery=None, api_key=None, trace=None,
                 use_cache=True):
        self.domain = domain
        self.trace = trace or Trace()
        self.discovery = discovery
        self.api_key = api_key
        self.use_cache = use_cache
        self.limits = None

    # -- setup -------------------------------------------------------------

    def discover(self):
        if self.discovery is None:
            self.trace.step("Discovering %s (the only thing I was told)" % self.domain)
            self.discovery = Discovery(self.domain)
            who = self.discovery.who()
            self.trace.say("found via: %s" % self.discovery.via)
            self.trace.say("document : %s" % self.discovery.url)
            self.trace.say("provider : %s (%s)" % (who["name"], who["org"]))
            self.trace.say("does     : %s" % who["does"])
            self.trace.say("published %d capabilities" % len(self.discovery.doc.get("capacidades", {})))
        return self.discovery

    def obtain_credential(self, use_cache=None):
        use_cache = self.use_cache if use_cache is None else use_cache
        if self.api_key:
            return self.api_key

        self.trace.step("Getting a credential")

        env_key = os.environ.get(ENV_KEY)
        if env_key:
            self.api_key = env_key
            self.trace.say("reusing the key in $%s (test keys do not expire)" % ENV_KEY)
            return self.api_key

        if use_cache:
            cached = _read_cached_key(self.domain)
            if cached:
                self.api_key = cached
                self.trace.say("reusing the key cached in %s" % os.path.basename(KEY_CACHE))
                return self.api_key

        method, url, meta = self.discovery.credential_endpoint()
        self.trace.say("%s %s   (learned from the document, not hardcoded)" % (method, url))
        try:
            payload = http_json(method, url, body={"name": "ai-payment-agent"})
        except ApiError as exc:
            if exc.status == 429:
                raise PolicyRefusal(
                    "the provider caps new test keys per IP per day (%s).\n"
                    "    Test keys never expire, so reuse one you already have:\n"
                    "        export %s=lun_test_...\n"
                    "    or pass --api-key lun_test_..." % (exc.detail, ENV_KEY)
                )
            raise

        key = payload.get("api_key")
        if not key:
            raise DiscoveryError("credential endpoint returned no api_key")
        self.api_key = key
        self.trace.say("minted    : %s... (sandbox=%s)" % (key[:18], payload.get("sandbox")))
        if meta.get("precisa_de_humano") is False:
            self.trace.say("no human, no signup -- an agent can onboard itself")
        if use_cache and _write_cached_key(self.domain, key):
            self.trace.say("cached it in %s so re-runs do not burn the daily quota"
                           % os.path.basename(KEY_CACHE))
        return key

    def read_limits(self):
        method, url = self.discovery.limits_endpoint()
        self.trace.step("Reading the limits that apply to me right now")
        self.trace.say("%s %s" % (method, url))
        self.limits = Limits(http_json(method, url, api_key=self.api_key))
        self.trace.say(self.limits.describe())
        self.trace.say("^ these numbers are NOT in my source code. They can change today.")
        return self.limits

    # -- planning ----------------------------------------------------------

    def plan_for(self, order):
        self.trace.step("Choosing a capability by its declared attributes")
        known = self.discovery.known_intents()
        if order.intent not in known:
            raise DiscoveryError(
                "provider does not publish intent '%s' (it knows: %s)"
                % (order.intent, ", ".join(sorted(known)))
            )
        name, cap, alternatives = self.discovery.select_capability(
            intent=order.intent, asset=order.asset, currency="BRL", rail="PIX"
        )
        self.trace.say("intent=%s asset=%s -> BRL over PIX" % (order.intent, order.asset))
        self.trace.say("chose '%s': %s" % (name, cap.get("descricao")))
        if alternatives:
            self.trace.say("(also matched: %s -- picked the most specific/fastest)" % ", ".join(alternatives))
        plan = self.discovery.plan(name)
        self.trace.say("runbook  : %s" % plan["source"])
        self.trace.say("quote    : POST %s" % plan["create_url"])
        self.trace.say("confirm  : POST %s" % plan["confirm_url"])
        self.trace.say("track    : GET  %s" % plan["poll_url"])
        plan["capability"] = name
        return plan

    # -- execution ---------------------------------------------------------

    def quote(self, plan, order, refund_address=None, external_id=None):
        network = self.discovery.network_for(order.asset)
        if not network:
            raise DiscoveryError("provider publishes no network for %s" % order.asset)
        body = {
            "asset": order.asset,
            "network": network,
            "brl_amount": "%d.%02d" % (order.brl_cents // 100, order.brl_cents % 100),
            "pix_key": order.pix_key,
            "pix_key_type": order.pix_key_type,
            # An idempotency handle of our own making. Without it, a retry
            # after a timeout is a second payment.
            "external_id": external_id or ("agent-" + uuid.uuid4().hex[:16]),
        }
        if refund_address:
            body["refund_address"] = refund_address
        quote = http_json("POST", plan["create_url"], body=body, api_key=self.api_key)
        return quote

    def confirm(self, plan, quote_id):
        return http_json("POST", fill(plan["confirm_url"], quote_id), api_key=self.api_key)

    def poll(self, plan, order_id, timeout=180, interval=2.0):
        """Poll to a terminal state, and be patient with the scary ones."""
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            state = http_json("GET", fill(plan["poll_url"], order_id), api_key=self.api_key)
            current = state.get("state")
            if current != last:
                marker = ""
                if current not in TERMINAL_STATES and current in ("MANUAL_REVIEW", "DELAYED"):
                    marker = "   <- not a failure. Keep waiting."
                self.trace.say(("%-18s %s" % (current, marker)).rstrip())
                last = current
            if current in TERMINAL_STATES:
                return state
            time.sleep(interval)
        raise TransportError("order %s did not settle within %ss (last state: %s)" % (order_id, timeout, last))

    def verify(self, e2e):
        """Close the loop with the OPEN capability: prove the PIX really settled.

        This one needs no credential at all -- which is exactly why it is
        useful between two parties that have no reason to trust each other.
        """
        name, cap, _ = self.discovery.select_capability(intent="verify_payment", rail="PIX")
        url_template, meta = self.discovery.simple_url(name)
        keyless = meta.get("precisa_de_chave") is False
        self.trace.step("Proving the payment settled (capability '%s')" % name)
        self.trace.say("GET %s   (needs a key: %s)" % (fill(url_template, e2e), not keyless))
        return http_json("GET", fill(url_template, e2e), api_key=None if keyless else self.api_key)

    # -- the whole thing ---------------------------------------------------

    def run(self, instruction, refund_address=None, approval_delay=0.0,
            poll_timeout=180, max_requotes=2):
        self.discover()
        vocabulary = self.discovery.known_assets()
        default_pairs = self.discovery.instant_pairs()
        default_asset = default_pairs[0][0] if default_pairs else None

        self.trace.step("Reading the instruction")
        self.trace.say("> %s" % instruction)
        order = parse_instruction(instruction, vocabulary, default_asset)
        self.trace.say("understood: pay %s to PIX key %s (%s), funded with %s"
                       % (brl(order.brl_cents), order.pix_key, order.pix_key_type, order.asset))

        plan = self.plan_for(order)
        self.obtain_credential()
        limits = self.read_limits()

        # Local guard: refuse before spending a call, using the live numbers.
        self.trace.step("Checking the order against those limits, before calling")
        problem = limits.check(order.brl_cents)
        if problem:
            self.trace.say("REFUSED locally: %s" % problem)
            self.trace.say("No API call was made. The limit came from the wire, not from a constant.")
            raise PolicyRefusal(problem)
        self.trace.say("%s is inside %s .. %s -- proceeding"
                       % (brl(order.brl_cents), brl(limits.min_cents), brl(limits.max_cents)))

        external_id = "agent-" + uuid.uuid4().hex[:16]
        attempt = 0
        while True:
            attempt += 1
            self.trace.step("Quoting (attempt %d)" % attempt)
            try:
                quote = self.quote(plan, order, refund_address, external_id)
            except ApiError as exc:
                self._explain_api_error(exc)
                raise

            quote_id = quote.get("cashout_id") or quote.get("id")
            self.trace.say("order    : %s" % quote_id)
            self.trace.say("price    : %s %s for %s" % (quote.get("amount"), order.asset, brl(order.brl_cents)))
            self.trace.say("expires  : %s" % quote.get("expires_at"))

            if approval_delay:
                self.trace.say("...waiting %.0fs, as if a human were approving this" % approval_delay)
                time.sleep(approval_delay)

            self.trace.step("Confirming (this is the point of no return)")
            try:
                confirmed = self.confirm(plan, quote_id)
            except ApiError as exc:
                # A quote that timed out is not an error to report -- it is a
                # quote to redo. The API even tells us so in `acao`.
                if "expir" in (exc.code or "") and attempt <= max_requotes:
                    self.trace.say("refused : %s" % exc.code)
                    self.trace.say("detail  : %s" % exc.detail)
                    self.trace.say("-> the price aged out while we deliberated. Re-quoting,")
                    self.trace.say("   which is the ONLY safe move: never retry a confirm.")
                    external_id = "agent-" + uuid.uuid4().hex[:16]
                    approval_delay = 0.0
                    continue
                self._explain_api_error(exc)
                raise
            break

        self.trace.say("deposit  : %s (%s on %s)"
                       % (confirmed.get("deposit_address"), confirmed.get("amount"), confirmed.get("network")))
        if confirmed.get("aviso_sandbox"):
            self.trace.say("note     : %s" % confirmed["aviso_sandbox"])

        self.trace.step("Tracking the order to a terminal state")
        final = self.poll(plan, quote_id, timeout=poll_timeout)
        state = final.get("state")

        if state not in SUCCESS_STATES:
            self.trace.step("Settlement did not succeed")
            self.trace.say("final state: %s" % state)
            self.trace.say("The BRL leg did not go out. The crypto is returned to")
            self.trace.say("refund_address (%s) -- which is why you always send one."
                           % (confirmed.get("refund_address") or "NOT SET on this order"))
            return {"ok": False, "state": state, "order": final}

        self.trace.say("paid     : %s" % brl(order.brl_cents))
        self.trace.say("e2e      : %s" % final.get("pix_e2e"))

        receipt = self.verify(final["pix_e2e"])
        self.trace.say("settled  : %s (paid=%s)" % (receipt.get("verificado"), receipt.get("pago")))
        self.trace.say("amount   : R$ %s to %s at %s"
                       % (receipt.get("valor_brl"), receipt.get("recebedor_iniciais"), receipt.get("instituicao")))
        self.trace.say("funded by: %s %s on %s"
                       % ((receipt.get("origem_cripto") or {}).get("quantidade"),
                          order.asset,
                          (receipt.get("origem_cripto") or {}).get("rede")))
        return {"ok": True, "state": state, "order": final, "receipt": receipt}

    def _explain_api_error(self, exc):
        self.trace.say("REFUSED by the API")
        self.trace.say("code    : %s" % exc.code)
        self.trace.say("action  : %s" % exc.action)
        self.trace.say("detail  : %s" % exc.detail)
        if exc.limits:
            self.trace.say("the refusal carried the limits, so I do not have to guess:")
            for key in ("min_brl_cents", "max_brl_cents", "quoted_brl_cents"):
                if key in exc.limits:
                    self.trace.say("  %-18s %s" % (key, brl(exc.limits[key])), indent=6)
        if exc.request_id:
            self.trace.say("request : %s  (quote this to support)" % exc.request_id)


# ==========================================================================
# Demo
# ==========================================================================

DEMO_KEY = "x@y.com"


def run_demo(domain, poll_timeout, api_key=None, use_cache=True):
    """Six runs against the live sandbox: one good, five that go wrong.

    The sandbox picks the outcome from the last two decimals of the amount,
    so every failure below is reproducible on your machine, today.
    """
    trace = Trace()
    trace.rule("SETUP -- one discovery, one credential, shared by every scenario")
    boot = PaymentAgent(domain=domain, trace=trace, api_key=api_key, use_cache=use_cache)
    boot.discover()
    boot.obtain_credential()
    discovery, api_key = boot.discovery, boot.api_key

    def agent():
        return PaymentAgent(domain=domain, discovery=discovery, api_key=api_key, trace=trace)

    results = []

    # ---- 1. the happy path ------------------------------------------------
    trace.rule("SCENARIO 1 -- a payment that works, end to end")
    outcome = agent().run(
        "pague R$ 50,00 para a chave PIX %s usando USDT" % DEMO_KEY,
        poll_timeout=poll_timeout,
    )
    results.append(("1 happy path", "settled and verified" if outcome["ok"] else outcome["state"]))

    # ---- 2. refused locally ----------------------------------------------
    trace.rule("SCENARIO 2 -- below the minimum: refused WITHOUT calling the API")
    try:
        agent().run("pague R$ 1,00 para a chave PIX %s usando USDT" % DEMO_KEY,
                    poll_timeout=poll_timeout)
        results.append(("2 local guard", "UNEXPECTED: it went through"))
    except PolicyRefusal as exc:
        results.append(("2 local guard", "refused locally: %s" % exc))

    # ---- 3. refused by the server ----------------------------------------
    trace.rule("SCENARIO 3 -- trigger .04: the server refuses on limits")
    try:
        agent().run("pague R$ 50,04 para a chave PIX %s usando USDT" % DEMO_KEY,
                    poll_timeout=poll_timeout)
        results.append(("3 server limit", "UNEXPECTED: it went through"))
    except ApiError as exc:
        results.append(("3 server limit", "handled: %s" % exc.code))

    # ---- 4. the quote expires while we deliberate -------------------------
    trace.rule("SCENARIO 4 -- trigger .03: the quote dies while a human approves")
    outcome = agent().run(
        "pague R$ 50,03 para a chave PIX %s usando USDT" % DEMO_KEY,
        approval_delay=7.0,
        poll_timeout=poll_timeout,
    )
    results.append(("4 expired quote", "recovered by re-quoting" if outcome["ok"] else outcome["state"]))

    # ---- 5. the payout itself fails --------------------------------------
    trace.rule("SCENARIO 5 -- trigger .02: accepted, then the payout FAILS")
    outcome = agent().run(
        "pague R$ 50,02 para a chave PIX %s usando USDT" % DEMO_KEY,
        refund_address="0x04198C0dA1b0b0c9b0F0a0e0D0c0B0a090807060",
        poll_timeout=poll_timeout,
    )
    results.append(("5 failed payout", "reported as %s, refund path named" % outcome["state"]))

    # ---- 6. a scary state that is not a failure --------------------------
    trace.rule("SCENARIO 6 -- trigger .01: MANUAL_REVIEW, which impatient agents misread")
    outcome = agent().run(
        "pague R$ 50,01 para a chave PIX %s usando USDT" % DEMO_KEY,
        poll_timeout=max(poll_timeout, 180),
    )
    results.append(("6 manual review", "waited it out -> %s" % outcome["state"]))

    trace.rule("SUMMARY")
    for name, result in results:
        print("  %-18s %s" % (name, result))
    print("""
The lesson is what this program never had to know:
  - not one endpoint path (all read from /mesh)
  - not one limit value (all read from the live credential)
  - not one asset or network list (all read from the provider)
Only the domain. Everything else it asked for.""")
    return results


# ==========================================================================
# CLI
# ==========================================================================


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="An agent that pays a PIX key with stablecoins, starting from a domain.",
    )
    parser.add_argument("instruction", nargs="?",
                        help='e.g. "pague R$ 50,00 para a chave PIX x@y.com usando USDT"')
    parser.add_argument("--domain", default=DEFAULT_DOMAIN, help="provider domain (default: %(default)s)")
    parser.add_argument("--demo", action="store_true", help="run all six scenarios, good and bad")
    parser.add_argument("--api-key", default=None,
                        help="reuse a credential instead of minting one (or set $%s)" % ENV_KEY)
    parser.add_argument("--no-cache", action="store_true",
                        help="do not read or write the local sandbox-key cache")
    parser.add_argument("--refund-address", default=None,
                        help="where the crypto goes back if the PIX leg fails (send one in production)")
    parser.add_argument("--approval-delay", type=float, default=0.0,
                        help="seconds to wait between quote and confirm, to simulate a human")
    parser.add_argument("--poll-timeout", type=int, default=180, help="seconds to wait for settlement")
    args = parser.parse_args(argv)

    try:
        if args.demo or not args.instruction:
            if not args.demo and not args.instruction:
                print("No instruction given -- running the demo. Use -h for options.\n")
            run_demo(args.domain, args.poll_timeout,
                     api_key=args.api_key, use_cache=not args.no_cache)
            return 0

        agent = PaymentAgent(domain=args.domain, api_key=args.api_key,
                             use_cache=not args.no_cache)
        outcome = agent.run(
            args.instruction,
            refund_address=args.refund_address,
            approval_delay=args.approval_delay,
            poll_timeout=args.poll_timeout,
        )
        return 0 if outcome["ok"] else 1

    except PolicyRefusal as exc:
        # Already narrated in-line when it came from a limit check; printed
        # here when it came from anywhere else (a capped credential, say).
        if str(exc).strip():
            print("\nStopped: %s" % exc, file=sys.stderr)
        return 2
    except ParseError as exc:
        print("\nCould not understand the instruction: %s" % exc, file=sys.stderr)
        return 2
    except ApiError as exc:
        # An ApiError raised outside quote/confirm was never narrated, so say
        # it plainly here rather than exiting mute.
        print("\nThe API refused: %s" % exc, file=sys.stderr)
        if exc.request_id:
            print("request_id: %s" % exc.request_id, file=sys.stderr)
        return 1
    except (DiscoveryError, TransportError) as exc:
        print("\n%s: %s" % (type(exc).__name__, exc), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
