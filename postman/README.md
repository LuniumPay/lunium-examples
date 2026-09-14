# Lunium Postman collection

This directory contains a secret-free Postman collection for the public Lunium
API. It covers health, sandbox provisioning, live limits, a complete sandbox
cash-out, cash-in catalog/preview, and webhook transport testing.

## Import and run

1. Import `Lunium.postman_collection.json`.
2. Import `Lunium.sandbox.postman_environment.json` into a private workspace.
3. Run `01 — Create sandbox key` once.
4. Copy the returned `lun_test_…` value into the private environment's
   `api_key` secret. The collection intentionally does not save or print it.
5. Run requests in numerical order.

The sandbox key quota is per IP. Reuse a key you already created rather than
minting one on every collection run.

## Safety boundary

- No real key, PIX key, taxpayer number, wallet owned by a user, or personal
  data is stored in these files.
- Never publish an exported environment after adding a key.
- Never send crypto to a sandbox `deposit_address`.
- Cash-in preview and contract validation work with sandbox. A payable PIX QR
  requires a production key created with `POST /keys`.
- Read the current contract from <https://api.luniumpay.com/openapi.json>.

