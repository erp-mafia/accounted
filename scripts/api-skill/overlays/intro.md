# Accounted API integration

Accounted is Swedish double-entry bookkeeping (bokföring) as a service: BAS
chart of accounts, verifikationer with legally immutable audit trails, VAT
(moms), payroll (lön), invoicing, bank reconciliation, and statutory reports,
exposed as a REST API designed for agents and integrations first.

**This skill is for building software against the REST API** (an app, a
backend job, an agent tool layer). If the goal is to *operate* a ledger
conversationally (book receipts, run month close), use the Accounted MCP
connector and its workflow skills instead: install the `accounted` plugin or
see https://app.gnubok.se/docs/api/connect-claude.

If you have used Stripe's API the shape will feel familiar: bearer keys, dated
versions, idempotency keys, webhook signatures, cursor pagination. The domain
rules are Swedish accounting law; the Gotchas section below stops the classic
violations before you ship them.
