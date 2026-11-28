<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Banking endpoints

Bank transactions (ingest, categorize, match against invoices), cash accounts with the bank-reported balance, PSD2 connection health (sync freshness, consent expiry), the Open Payments bank feed (reachable banks, connections, the switch from Enable Banking, the signatory link), bank reconciliation runs, file imports (SIE, bank statements), the point-of-sale business days a connected POS system delivers, booked as daily takings vouchers, and the webshop orders the Shopify, WooCommerce and Zettle syncs deliver, booked one by one with your own lines.

Conventions (auth, envelope, pagination, dry-run, idempotency, standard errors)
are in SKILL.md and are not repeated per endpoint.

### `GET /api/v1/companies/{companyId}/bank-connections`

**List PSD2 bank connections with sync freshness and consent expiry.**
`scope:companies:read · risk:low · idempotent`

Returns every bank connection for the company with its aggregator (enable_banking or open_payments), status, last successful sync (last_synced_at), consent expiry (consent_expires) and any user-facing error message. Connections sync automatically once a day server-side; this endpoint tells you whether that is still happening. The Open Payments rows with their accounts, the reachable banks and the switch from Enable Banking: GET /bank-feed, /bank-feed/banks, /bank-feed/switch-progress.

**Use when:** You need to verify bank data is current before building on it (liquidity, reconciliation, reports), or to detect a dead connection that needs BankID re-authorisation.
**Do not use for:** Fetching transactions (use /transactions) or account balances (use /cash-accounts). Triggering a sync: POST /bank-connections/{connectionId}/sync.

**Pitfalls:**
- last_synced_at is null until the first sync completes (about a minute after connecting); it does NOT mean the connection is broken.
- A connection can hold status=active with a stale last_synced_at (older than ~36 hours): treat the data as suspect, but do NOT assume re-authorisation fixes it. Common causes are a lapsed subscription (this endpoint then answers with a capability error) or every account deselected in settings.
- status=expired means the PSD2 consent is dead: only the user can fix it, with BankID in a browser. An open_payments row is renewed from the Kopplingar page or from a signatory link (POST /bank-feed/invites with replace_connection_id).
- error_message is Swedish and user-facing: show it verbatim rather than translating.
- sunset=true on an enable_banking row means the old provider has ended: the row is kept for its history but fetches nothing, and a sync is refused with 410 ENABLE_BANKING_SUNSET. Do not ask the user to renew it; they switch to the new connection on the Kopplingar page (GET /bank-feed/switch-progress has the state) or import bank statements as files where the new provider does not reach the bank.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    bank_connections: { connection_id: string, bank: string | null, aggregator: "enable_banking" | "open_payments", status: "pending" | "pending_selection" | "active" | "expired" | "error", since: string, last_synced_at: string | null, consent_expires: string | null, error_message: string | null, sunset?: boolean }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "bank_connections": [
      {
        "connection_id": "4f6c…",
        "bank": "Swedbank",
        "aggregator": "open_payments",
        "status": "active",
        "since": "2026-08-01T00:00:00Z",
        "last_synced_at": "2026-08-31T05:04:12Z",
        "consent_expires": "2026-11-01T00:00:00Z",
        "error_message": null
      }
    ]
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/bank-connections/{connectionId}/sync`

**Sync one bank connection now instead of waiting for the nightly run.**
`scope:transactions:write · risk:low · idempotent`

Fetches new transactions and balances for one PSD2 bank connection right away. The window is chosen server-side: the last 7 days, widened to cover any gap since last_synced_at, capped at 90 days. Returns how many transactions were imported and the new last_synced_at. A connection synced within the last 15 minutes is refused with 429 BANK_SYNC_COOLDOWN and next_allowed_at: the data is already fresh. Not dry-runnable: the bank call itself is the side effect.

**Use when:** GET /bank-connections shows a stale last_synced_at on an active connection and you need current bank data before building on it (liquidity, reconciliation, a report), or the user asks for the latest transactions now.
**Do not use for:** Polling. Connections sync every night on their own; call this once when freshness matters, then read /transactions. Fixing a dead connection: status=expired needs BankID in a browser, not a sync.

**Pitfalls:**
- Idempotency-Key is optional here. If you send one, use a fresh key per attempt: a cooldown answer is never cached, but a completed sync is, and replaying it fetches nothing new.
- 429 BANK_SYNC_COOLDOWN follows a recent successful sync OR a recent attempt that failed (the 15-minute lease is taken before the bank is called, on every instance). Compare last_synced_at from GET /bank-connections: if it is fresh, use the data you have; if it is still stale, the previous attempt failed, so retry once after next_allowed_at (Retry-After is set).
- 429 BANK_RATE_LIMITED is the BANK limiting the consent (PSD2 banks allow only a few unattended fetches per day), not this API. The connection stays valid: do not renew it. Wait until next_allowed_at (Retry-After is set); it is our cooldown, not a reset time confirmed by the bank.
- 409 BANK_SESSION_EXPIRED means the bank reported the consent dead during the sync; the connection is now status=expired. Hand the user the connect link; no API call revives it.
- imported: 0 is normal on a quiet account. Banks report with up to 48 hours of delay, so today's transactions often arrive tomorrow.
- Costs one Enable Banking call per enabled account: 403 CAPABILITY_BLOCKED when the company has no bank_sync entitlement.
- 410 ENABLE_BANKING_SUNSET means the old provider (enable_banking rows) has ended and the connection fetches nothing any more: no retry helps. GET /bank-connections marks these rows with sunset=true; the person switches to the new connection from the Kopplingar page (or imports bank statements as files where the new provider does not reach the bank).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `connectionId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    connection_id: string,
    bank: string | null,
    imported: number,
    duplicates: number,
    from_date: string,
    to_date: string,
    last_synced_at: string,
    enriched_updated?: number,
    window_enriched?: boolean | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "connection_id": "4f6c…",
    "bank": "Swedbank",
    "imported": 3,
    "duplicates": 12,
    "from_date": "2026-08-26",
    "to_date": "2026-09-02",
    "last_synced_at": "2026-09-02T09:14:03Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/bank-feed`

**The company's Open Payments bank connections and whether it may make one.**
`scope:transactions:read · risk:low · idempotent`

Answers available (and why not), the connections made through Open Payments with their accounts, and whether the calling person has a personnummer on file for BankID.

**Use when:** Rendering the bank connections a company reads through Open Payments.
**Do not use for:** Enable Banking connections.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    available: boolean,
    reason: "no_connector" | "not_in_pilot" | "subscription" | null,
    connections: { connection_id: string, bank_name: string | null, bic: string | null, provider: string, status: string, consent_expires: string | null, last_synced_at: string | null, initial_sync_completed_at: string | null, error_message: string | null, accounts: { uid: string, name: string | null, iban: string | null, currency: string, enabled: boolean, ledger_account: string | null, usage: string | null }[] }[],
    signer_known: boolean
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "available": true,
    "reason": null,
    "connections": [],
    "signer_known": true
  }
}
```

---

### `GET /api/v1/companies/{companyId}/bank-feed/banks`

**The banks a company can connect with BankID through Open Payments.**
`scope:transactions:read · risk:low · idempotent`

Lists the banks the account information provider reaches (BIC, name, logo, whether BankID can be signed in our screen, and `reached`: whether Open Payments reads the bank for this company yet). Answers OPEN_BANKING_NOT_AVAILABLE when reading through Open Payments is not switched on for the company.

**Use when:** Before starting a bank connection with BankID.
**Do not use for:** Enable Banking connections (the bank list of the enable-banking extension).

**Pitfalls:**
- A sparbank is reached through SWEDSESS with its affiliate id; ask bank for the list.
- reached false: the bank is listed but not read through Open Payments for this company yet; import its bank statements as a file.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    banks: { bic: string, name: string, logo_url: string | null, decoupled: boolean | null, redirect: boolean | null, reached: boolean }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "banks": [
      {
        "bic": "SWEDSESS",
        "name": "Swedbank",
        "logo_url": null,
        "decoupled": true,
        "redirect": false,
        "reached": true
      }
    ]
  }
}
```

---

### `GET /api/v1/companies/{companyId}/bank-feed/banks/{bic}`

**One bank's details: how a person signs there, and the sparbanker behind a shared BIC.**
`scope:transactions:read · risk:low · idempotent`

Whether the bank signs BankID in our screen (decoupled) or on its own page (redirect), how many days of history it serves, and the savings banks reached through it (Swedbank: the sparbanker and Ölands Bank). Answered from a 24 h cache.

**Use when:** After a bank is picked and before BankID starts: to show the sparbank picker and choose the signing method.
**Do not use for:** Listing banks (bank-feed.banks).

**Pitfalls:**
- A sparbank is connected through SWEDSESS with its affiliate_id from this answer.
- The BIC is upper case (SWEDSESS, not swedsess).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `bic` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    bic: string,
    name: string,
    decoupled: boolean | null,
    redirect: boolean | null,
    affiliates: { affiliate_id: string, name: string }[],
    transaction_history_max_days: number | null,
    extended_transaction_history_max_days: number | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "bic": "SWEDSESS",
    "name": "Swedbank",
    "decoupled": true,
    "redirect": true,
    "affiliates": [
      {
        "affiliate_id": "08999",
        "name": "Sparbanken Nord"
      }
    ],
    "transaction_history_max_days": 88,
    "extended_transaction_history_max_days": 760
  }
}
```

---

### `POST /api/v1/companies/{companyId}/bank-feed/invites`

**Send the company's firmatecknare a link to connect the bank with BankID, without an Accounted login.**
`scope:transactions:write · risk:medium · idempotent · dry-run`

Creates a signed link, valid 7 days, that opens the Koppla banken flow for this company at /koppla/<token> without a login: the firmatecknare picks the bank (or gets the one named), signs the consent with BankID and chooses the accounts; the link is consumed when the accounts are selected. With recipient_email the link is mailed (template bank_connect_invite); the URL is answered either way for the sender to pass on. Owners and admins only.

**Use when:** A byrå or a company admin cannot sign the bank consent themselves: the firmatecknare holds the bank access.
**Do not use for:** Connecting the bank in person (start the consent instead), or a company not switched on for Open Payments (OPEN_BANKING_NOT_AVAILABLE).

**Pitfalls:**
- The URL carries the credential: hand it to the firmatecknare only.
- replace_connection_id names the connection the new one takes over from (an Enable Banking row for a switch, an Open Payments row for a renewal).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  bic?: string | null,
  replace_connection_id?: string | null,
  offer_payments?: boolean,
  recipient_email?: string | null,
  bank_name?: string | null
}
```

Example request:
```json
{
  "recipient_email": "anna@example.se",
  "offer_payments": true
}
```

Response `200`:
```ts
{
  data: { invite_id: string, url: string, expires_at: string, email_sent: boolean },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "invite_id": "4f6c1a2b-9c0d-4e8f-8a1b-2c3d4e5f6a7b",
    "url": "https://app.accounted.se/koppla/...",
    "expires_at": "2026-10-19T09:14:03Z",
    "email_sent": true
  }
}
```

---

### `GET /api/v1/companies/{companyId}/bank-feed/switch-progress`

**Where the company stands in the switch from Enable Banking to Open Payments.**
`scope:transactions:read · risk:low · idempotent`

The campaign (on, deadline, days left), the company's state (the Enable Banking connections still to switch, the ones at banks Open Payments does not reach) and, for an owner or admin, the totals across companies (counts per bank, no company identities). Null company when the campaign does not apply to it.

**Use when:** Rendering the switch deadline, the deep link to the switch, or the operators' counter.
**Do not use for:** Starting the switch: that is bank-feed.start with replace_connection_id, and a person's BankID.

**Pitfalls:**
- totals come from a service-role RPC and are null for members below admin.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    campaign: { on: boolean, deadline: string | null, days_left: number | null, passed: boolean },
    company: { state: "done" | "pending" | "uncovered", pending: { connection_id: string, bank_name: string }[], uncovered: { connection_id: string, bank_name: string }[], open_payments: number, deadline: string, days_left: number, passed: boolean, urgent: boolean } | null,
    totals: { companies: { pending: number, uncovered: number, done: number }, connections: { pending: number, uncovered: number, switched: number }, banks: { bank: string, pending: number, uncovered: number, switched: number }[] } | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "campaign": {
      "on": true,
      "deadline": "2026-11-09",
      "days_left": 20,
      "passed": false
    },
    "company": null,
    "totals": null
  }
}
```

---

### `GET /api/v1/companies/{companyId}/cash-accounts`

**List bank/cash accounts with the bank-reported balance.**
`scope:transactions:read · risk:low · idempotent`

Returns the company's cash accounts (bank accounts, kassa) with their BAS ledger mapping and, for PSD2-connected accounts, the balance the bank itself reported at the last sync: balance (booked), available_balance, and balance_updated_at (when it was fetched). Pass ?enabled_only=true to return only accounts that sync.

**Use when:** You need the current bank balance per account (e.g. a covering decision before a payment run), or cash_account_id values to filter transaction listings.
**Do not use for:** The bookkept 19xx balance: use the trial-balance or balance-sheet reports. The two legitimately differ (pending bookings, timing).

**Pitfalls:**
- balance/available_balance are what the BANK reported, refreshed at most every 12h (PSD2 quota): check balance_updated_at before treating them as current.
- balance is null for manual and SIE-imported accounts, and for PSD2 accounts that have not completed a sync since connecting.
- available_balance is null when the bank reports no available balance type; that does not mean 0.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `enabled_only` | query | `"true" \| "false"` | no | true returns only enabled accounts. Default: all accounts. |

Response `200`:
```ts
{
  data: {
    cash_accounts: { cash_account_id: string, handle?: string, ledger_account: string, name: string | null, currency: string, iban: string | null, is_primary: boolean, enabled: boolean, source: "enable_banking" | "open_payments" | "manual" | "sie_import", balance: number | null, available_balance: number | null, balance_updated_at: string | null }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "cash_accounts": [
      {
        "cash_account_id": "ca_…",
        "ledger_account": "1930",
        "name": "Företagskonto",
        "currency": "SEK",
        "iban": "SE4550000000058398257466",
        "is_primary": true,
        "enabled": true,
        "source": "enable_banking",
        "balance": 125430.5,
        "available_balance": 123930.5,
        "balance_updated_at": "2026-09-01T05:12:44.000Z"
      }
    ]
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/cash-accounts`

**Create a bank account by hand (no bank connection), with the payee details invoices print, or a company card.**
`scope:companies:write · risk:low · idempotent · dry-run`

Adds a manual bank account (cash_accounts, source manual) in a currency, on the next free BAS 19xx ledger account for that currency unless ledger_account (1920-1999) is given, and adds that account to the chart if missing. payee holds what customer invoices print (bankgiro, IBAN, ...); invoice_payee defaults to true. A later bank connection with the same IBAN takes this row over in place. With kind card it adds a company card (företagskort) instead: its statement rows book against a liability account (2480-2489, 2890, 2894, 2896, 2899; the first one no account holds and no verifikat uses unless ledger_account is given), card_issuer is required and payee fields are refused. Owner/admin only. Idempotent. Dry-runnable.

**Use when:** The company has a bank account that is not connected through the bank integration (a savings account, a currency account, a bank without PSD2) and it should appear in Konton, the booking flows or on invoices.
**Do not use for:** Connecting a bank (the bank connection flow creates its own accounts), changing an existing account (PATCH /cash-accounts/{id}) or choosing which account invoices print by default (PUT /cash-accounts/payee-defaults).

**Pitfalls:**
- An IBAN another account of the company already carries returns 409 CASH_ACCOUNT_IBAN_DUPLICATE: one physical account must exist once.
- A ledger_account another cash account holds returns 409 CASH_ACCOUNT_LEDGER_TAKEN; omit it to get the next free one.
- ledger_account is a STRING in 1920-1999 ("1931"), never a number, and never a till (1910-1919) or a PSP clearing account.
- A company card (kind card) takes ledger_account in 2480-2489, 2890, 2894, 2896 or 2899 (never 2893), and no payee or invoice_payee: a card is never printed on invoices.
- A card purchase is stored with a negative amount (money owed grows), the payment from the bank with a positive one: the company perspective of every cash account.
- Owner or admin only: a member key gets 403 FORBIDDEN.
- Creating an account does not make it the default payee: set that with PUT /cash-accounts/payee-defaults.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  name: string,
  currency: "SEK" | "EUR" | "USD" | "GBP" | "NOK" | "DKK" | "CHF" | "CAD",
  ledger_account?: string,
  invoice_payee?: boolean,
  payee?: {
    bank_name?: string | null,
    clearing_number?: string | null | "",
    account_number?: string | null | "",
    bankgiro?: string | null | "",
    plusgiro?: string | null | "",
    swish?: string | null,
    iban?: string | null | "",
    bic?: string | null | "",
    bank_code?: string | null | "",
    foreign_account_number?: string | null | ""
  },
  kind?: "bank" | "card",
  card_issuer?: "eurocard" | "seb_kort" | "amex" | "handelsbanken" | "first_card" | "danske" | "swedbank" | "qred" | "mynt" | "pleo" | "other",
  card_last4?: string[],
  voucher_series?: string | null
}
```

Example request:
```json
{
  "name": "Sparkonto",
  "currency": "SEK",
  "payee": {
    "bank_name": "SEB",
    "bankgiro": "5050-1234"
  }
}
```

Response `200`:
```ts
{
  data: {
    cash_account_id: string,
    handle?: string,
    kind: "bank" | "card",
    ledger_account: string,
    card_issuer: string | null,
    card_last4: string[] | null,
    name: string | null,
    currency: string,
    iban: string | null,
    source: "enable_banking" | "open_payments" | "manual" | "sie_import",
    bank_connected: boolean,
    enabled: boolean,
    is_primary: boolean,
    voucher_series: string | null,
    invoice_payee: boolean,
    payee: { bank_name: string | null, clearing_number: string | null, account_number: string | null, bankgiro: string | null, plusgiro: string | null, swish: string | null, iban: string | null, bic: string | null, bank_code: string | null, foreign_account_number: string | null }
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "cash_account_id": "7f3a…",
    "kind": "bank",
    "ledger_account": "1931",
    "card_issuer": null,
    "card_last4": null,
    "name": "Sparkonto",
    "currency": "SEK",
    "iban": "SE4550000000058398257466",
    "source": "manual",
    "bank_connected": false,
    "enabled": true,
    "is_primary": false,
    "voucher_series": null,
    "invoice_payee": true,
    "payee": {
      "bank_name": "SEB",
      "clearing_number": null,
      "account_number": null,
      "bankgiro": "5050-1234",
      "plusgiro": null,
      "swish": null,
      "iban": "SE4550000000058398257466",
      "bic": "ESSESESS",
      "bank_code": null,
      "foreign_account_number": null
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/cash-accounts/{id}`

**Edit a bank account: verifikationsserie, payee details, name, or turn it on/off.**
`scope:companies:write · risk:medium · idempotent · dry-run · reversible`

Sparse update of one cash account. voucher_series (one letter A-Z, null clears) sets the verifikationsserie for entries booked from the account. The payee fields (bank_name, clearing_number, account_number, bankgiro, plusgiro, swish, iban, bic, bank_code, foreign_account_number), name and invoice_payee decide what customer invoices print; "" or null clears a field. enabled=false hides an account no bank connection holds from Konton and the booking flows. The ledger account (POST /cash-accounts/change-ledgers) and the primary flag are not editable here. Idempotent. Dry-runnable.

**Use when:** The company changes bank details customers pay to, wants its own voucher series per bank account, or stops using a manually added account.
**Do not use for:** Making an account the primary (POST /cash-accounts/{id}/set-primary), choosing the default payee per currency (PUT /cash-accounts/payee-defaults) or moving a transaction to another account.

**Pitfalls:**
- Payee fields, name, invoice_payee and enabled are owner/admin only (403 FORBIDDEN); voucher_series alone is open to any writer.
- Payee fields on a PSP clearing account or a till return 400 INVOICE_PAYEE_ACCOUNT_INVALID: only 1920-1999 bank accounts print on invoices.
- enabled on an account a bank connection holds returns 409 CASH_ACCOUNT_ENABLED_BANK_MANAGED; disabling the primary returns 400 CASH_ACCOUNT_DISABLE_PRIMARY, and one with unbooked transactions 400 CASH_ACCOUNT_DISABLE_UNRESOLVED.
- An iban another account already carries (printed or as its bank identity iban, enabled or not) returns 409 CASH_ACCOUNT_IBAN_DUPLICATE with details.existing_cash_account_id. If that account was added by mistake: on it, send enabled=false and iban "" (one request is fine). On a disabled account typed in by hand, clearing or changing iban also moves its bank identity iban, which frees the IBAN for the right account.
- Changing voucher_series only affects entries booked afterwards; nothing posted is renumbered.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  bank_name?: string | null,
  clearing_number?: string | null | "",
  account_number?: string | null | "",
  bankgiro?: string | null | "",
  plusgiro?: string | null | "",
  swish?: string | null,
  iban?: string | null | "",
  bic?: string | null | "",
  bank_code?: string | null | "",
  foreign_account_number?: string | null | "",
  voucher_series?: string | null,
  name?: string | null,
  invoice_payee?: boolean,
  enabled?: boolean
}
```

Example request:
```json
{
  "bankgiro": "5050-1234",
  "invoice_payee": true
}
```

Response `200`:
```ts
{
  data: {
    cash_account_id: string,
    handle?: string,
    kind: "bank" | "card",
    ledger_account: string,
    card_issuer: string | null,
    card_last4: string[] | null,
    name: string | null,
    currency: string,
    iban: string | null,
    source: "enable_banking" | "open_payments" | "manual" | "sie_import",
    bank_connected: boolean,
    enabled: boolean,
    is_primary: boolean,
    voucher_series: string | null,
    invoice_payee: boolean,
    payee: { bank_name: string | null, clearing_number: string | null, account_number: string | null, bankgiro: string | null, plusgiro: string | null, swish: string | null, iban: string | null, bic: string | null, bank_code: string | null, foreign_account_number: string | null }
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "cash_account_id": "7f3a…",
    "kind": "bank",
    "ledger_account": "1931",
    "card_issuer": null,
    "card_last4": null,
    "name": "Sparkonto",
    "currency": "SEK",
    "iban": "SE4550000000058398257466",
    "source": "manual",
    "bank_connected": false,
    "enabled": true,
    "is_primary": false,
    "voucher_series": null,
    "invoice_payee": true,
    "payee": {
      "bank_name": "SEB",
      "clearing_number": null,
      "account_number": null,
      "bankgiro": "5050-1234",
      "plusgiro": null,
      "swish": null,
      "iban": "SE4550000000058398257466",
      "bic": "ESSESESS",
      "bank_code": null,
      "foreign_account_number": null
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/cash-accounts/{id}/set-primary`

**Make a bank account the company's primary.**
`scope:companies:write · risk:medium · idempotent · dry-run · reversible`

The primary is where bookings land when nothing else says which bank account they belong to: the skattekonto counter leg and transactions with no cash account. It must be an enabled SEK giro or bank account (BAS 1920-1999). The flag moves in one transaction and the change is logged with the acting user. Only bookings made afterwards follow the new primary; nothing posted changes. Owner/admin only. Idempotent. Dry-runnable.

**Use when:** The company's main business account is not the one marked primary (typically the seeded 1930).
**Do not use for:** Choosing which account invoices print (PUT /cash-accounts/payee-defaults) or moving transactions between accounts.

**Pitfalls:**
- A disabled, non-SEK or non-bank account (till, PSP clearing) returns 400 CASH_ACCOUNT_PRIMARY_INELIGIBLE with details.reason.
- Owner or admin only: a member key gets 403 FORBIDDEN.
- Takes no body; the account id is in the path.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Response `200`:
```ts
{
  data: {
    cash_account_id: string,
    handle?: string,
    kind: "bank" | "card",
    ledger_account: string,
    card_issuer: string | null,
    card_last4: string[] | null,
    name: string | null,
    currency: string,
    iban: string | null,
    source: "enable_banking" | "open_payments" | "manual" | "sie_import",
    bank_connected: boolean,
    enabled: boolean,
    is_primary: boolean,
    voucher_series: string | null,
    invoice_payee: boolean,
    payee: { bank_name: string | null, clearing_number: string | null, account_number: string | null, bankgiro: string | null, plusgiro: string | null, swish: string | null, iban: string | null, bic: string | null, bank_code: string | null, foreign_account_number: string | null }
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "cash_account_id": "7f3a…",
    "kind": "bank",
    "ledger_account": "1931",
    "card_issuer": null,
    "card_last4": null,
    "name": "Sparkonto",
    "currency": "SEK",
    "iban": "SE4550000000058398257466",
    "source": "manual",
    "bank_connected": false,
    "enabled": true,
    "is_primary": true,
    "voucher_series": null,
    "invoice_payee": true,
    "payee": {
      "bank_name": "SEB",
      "clearing_number": null,
      "account_number": null,
      "bankgiro": "5050-1234",
      "plusgiro": null,
      "swish": null,
      "iban": "SE4550000000058398257466",
      "bic": "ESSESESS",
      "bank_code": null,
      "foreign_account_number": null
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/cash-accounts/change-ledgers`

**Change which 19xx ledger account bank-connected accounts book on from now on.**
`scope:companies:write · risk:medium · idempotent · dry-run · reversible`

Moves one or more accounts that one bank connection syncs (Enable Banking or Open Payments) to other 19xx ledger accounts, as the dashboard does under Inställningar > Kopplingar. Unbooked bank rows follow the account; posted verifikat stay on the old ledger account (move a balance with a voucher if needed). Another account of the connection on a requested ledger account swaps to the mover's old one. Owner/admin only. Dry-run first: the preview lists each move with booked and unbooked row counts.

**Use when:** A company migrated from another system books its bank on other 19xx accounts than the bank connection chose.
**Do not use for:** Accounts typed in by hand or from SIE (no bank connection), or rebooking posted verifikat (accounted_correct_entry).

**Pitfalls:**
- All accounts must be synced by one active bank connection: 400 VALIDATION_ERROR with details.reason several_connections or not_bank_connected; a connection not active answers BANK_LEDGER_CHANGE_NOT_ACTIVE.
- A ledger account another bank account holds is refused with a sentence naming it; two moves to the same ledger account return BANK_SELECTION_LEDGER_CONFLICT.
- Owner or admin only: a member key gets 403 FORBIDDEN.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{ accounts: { cash_account_id: string, ledger_account: string }[] }
```

Example request:
```json
{
  "accounts": [
    {
      "cash_account_id": "7f3a…",
      "ledger_account": "1933"
    }
  ]
}
```

Response `200`:
```ts
{
  data: {
    connection_id: string,
    moves: { cash_account_id: string | null, name: string | null, iban_last4: string | null, currency: string, from_ledger: string | null, to_ledger: string, booked_rows: number, unbooked_rows: number, swapped: boolean }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "connection_id": "0c1d…",
    "moves": [
      {
        "cash_account_id": "7f3a…",
        "name": "Valutakonto",
        "iban_last4": null,
        "currency": "USD",
        "from_ledger": "1930",
        "to_ledger": "1933",
        "booked_rows": 4,
        "unbooked_rows": 20,
        "swapped": false
      }
    ]
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PUT /api/v1/companies/{companyId}/cash-accounts/payee-defaults`

**Choose which bank account invoices in a currency tell the customer to pay to.**
`scope:companies:write · risk:medium · idempotent · dry-run · reversible`

Sets (or clears with cash_account_id null) the default payee account for one currency: every new invoice in that currency prints this account's payment details unless the invoice picks another. The account must be a bank account (1920-1999), enabled, flagged invoice_payee, and carry what the currency needs (an IBAN for anything but SEK). Answers every per-currency default after the change. Owner/admin only. Idempotent. Dry-runnable.

**Use when:** The company wants EUR invoices paid to its EUR account, or changes which SEK account customers pay to.
**Do not use for:** Editing the bank details themselves (PATCH /cash-accounts/{id}) or the primary account (set-primary).

**Pitfalls:**
- An account that cannot print for the currency returns 400 INVOICE_PAYEE_ACCOUNT_INVALID with details.reason (not_bank_account, disabled, not_payee, unusable_for_currency).
- Invoices already sent keep the payment details they were sent with.
- Owner or admin only: a member key gets 403 FORBIDDEN.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  currency: "SEK" | "EUR" | "USD" | "GBP" | "NOK" | "DKK" | "CHF" | "CAD",
  cash_account_id: string | null
}
```

Example request:
```json
{
  "currency": "EUR",
  "cash_account_id": "7f3a…"
}
```

Response `200`:
```ts
{
  data: { defaults: { currency: string, cash_account_id: string }[] },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "defaults": [
      {
        "currency": "EUR",
        "cash_account_id": "7f3a…"
      }
    ]
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/imports/bank`

**Import a bank-file (CSV / Excel / XML / CAMT053).**
`scope:transactions:write · risk:medium · idempotent`

Accepts a bank statement file (CSV in UTF-8 / UTF-16 / Windows-1252, an Excel workbook .xls / .xlsx, or camt.053 XML; up to 10 MB) as multipart/form-data. Auto-detects the bank format (SEB, Swedbank, Handelsbanken, Nordea, Nordea Business, Lansforsakringar, Lunar, ICA Banken, Skandia, Wise transaction history, Wise balance statement, the Mynt card export, CAMT053, generic CSV) or honors a `format` override. Parses transactions, ingests them into the `transactions` table (NOT into journal entries: see BFL note in pitfalls), and emits `transaction.synced` events. Returns operation_id for polling.

**Use when:** Importing a bank statement export for a period. Common with PSD2 bank connections that don't auto-sync, or for legacy bank accounts.
**Do not use for:** SIE bookkeeping import (use /imports/sie). Auto-bank sync (use the enable-banking extension). Single-transaction creation (use POST /transactions/ingest with a 1-element array).

**Pitfalls:**
- File size cap: 10 MB. Larger files require splitting client-side.
- `format` query parameter is optional; auto-detection works for all supported banks. Pass `format` only to force a specific format. Accepted values: seb, swedbank, handelsbanken, nordea, nordea_business, lansforsakringar, ica_banken, skandia, lunar, northmill, wise, wise_statement, mynt, generic_csv, camt053.
- Wise transaction-history rows with refunded or unknown statuses, unknown directions, or different source and target currencies are rejected instead of guessed. Import the matching per-currency Wise balance statements.
- Duplicate detection is by external_id (composed from format + date + description + amount + row index, or the camt.053 entry reference / Wise transfer id where the file carries one); a re-import of the same file typically deduplicates rather than creating doubles.
- Rows bind to the cash account the file names when the company already has it. A file covering a period a completed SIE import booked is matched against the imported vouchers and never auto-categorized.
- A row the parser cannot read is skipped and the rest are imported. The operation still ends succeeded, so read its result: `import_complete: false` means rows are missing, `transactions_skipped` counts them and `skipped_rows` names each with its row and reason. Correct the file and import it again: rows already in are recognised.
- A generic CSV whose amounts read a thousand apart under the two decimal marks ("349.000"), with no other amount settling which, is refused with 400 VALIDATION_ERROR and imports nothing. Write the amounts with two decimals.
- BFL 5 kap 6-7 §§ note: this endpoint creates `transactions` rows (the underlag for a verifikation), NOT verifikationer themselves. The verifikation content requirements are in BFL 5 kap 6-7 §§; until each transaction is matched to an invoice/supplier-invoice (POST /transactions/{id}/match-*) or categorised (POST /transactions/{id}/categorize), the bookkeeping obligation isn't discharged. A successful import here means the data is ingested: not booked.
- A successful import returns operation_id; poll /operations/{id} for the final ingested/duplicates/errors counts and whether the file was read to its last row (`import_complete`).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `format` | query | `"nordea" \| "nordea_business" \| "seb" \| "swedbank" \| "handelsbanken" \| "lansforsakringar" \| "ica_banken" \| "skandia" \| "lunar" \| "northmill" \| "wise" \| "wise_statement" \| "mynt" \| "generic_csv" \| "camt053"` | no | Force this bank file format instead of auto-detection. Omit to auto-detect. |

Response `200`:
```ts
{
  data: { operation_id: string, type: "import.bank", status: "queued", poll_url: string },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "operation_id": "op_a8f1…",
    "type": "import.bank",
    "status": "queued",
    "poll_url": "/api/v1/operations/op_a8f1…",
    "webhook_event": "operation.completed"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/imports/bank/{id}/undo`

**Undo a bank file import: delete the rows it created that are still unbooked.**
`scope:transactions:write · risk:high · idempotent · dry-run`

Hard-deletes every transaction the import created that is still unbooked (ignored rows included) and marks the import undone, so the same file can be imported again. Rows that are booked or linked to a verifikat, and rows with payment match history, are never touched: they are counted in skipped_booked and skipped_match_history, and their verifikat stay as they are (unlink or reverse them separately). Owner/admin only. Idempotent. Dry-runnable (the dry run counts what would be deleted and skipped).

**Use when:** The wrong file, the wrong account or a duplicate file was imported and its rows should go.
**Do not use for:** Removing single rows (DELETE /transactions/{id} for manual rows; ignore bank rows), bank-feed rows (they have no import), or SIE imports (POST /imports/sie/{id}/undo).

**Pitfalls:**
- Only a completed import can be undone: 409 BANK_FILE_UNDO_NOT_COMPLETED otherwise.
- Owner or admin only: a member key gets 403 BANK_FILE_UNDO_FORBIDDEN.
- Booked rows survive the undo (skipped_booked > 0): to remove them, reverse their verifikat first, then delete or ignore the rows.
- Imports made before rows were stamped with their import id delete nothing (deleted_transactions 0).
- transaction_id (any row the import created) stands in for the import id over MCP, where import ids are not listed; the staged undo is pinned to the import it resolved to. Over v1 the path names the import: a body transaction_id is refused.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{ transaction_id?: string }
```

Example request:
```json
{}
```

Response `200`:
```ts
{
  data: {
    bank_file_import_id: string,
    deleted_transactions: number,
    skipped_booked: number,
    skipped_match_history: number
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "bank_file_import_id": "9a8b…",
    "deleted_transactions": 212,
    "skipped_booked": 3,
    "skipped_match_history": 0
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/imports/deposit-specification`

**Attach a deposit specification (BG Max or camt.054) to the bank rows that are its deposits.**
`scope:transactions:write · risk:medium · idempotent · dry-run`

Reads Bankgirot's BG Max file or the bank's ISO 20022 camt.054 notification of incoming payments (sent as base64) and attaches each deposit's payments to the stored bank row that is that deposit, as the row's parts: payer, organisation number, OCR or invoice number, message and amount per payment. Each payment gets the open customer invoice its reference names as a suggestion; nothing is booked. Never creates a bank row and never changes one's amount, date or text. Uploading the same file again writes the same parts.

**Use when:** A bank row is a deposit of several incoming payments (a bankgiro deposit) or carries no payer and no OCR, and the bank or Bankgirot delivers a file that says who paid what.
**Do not use for:** Bank statements that should create bank rows (POST /imports/bank), or booking the payments (match the bank row to its invoices after this).

**Pitfalls:**
- Send the file bytes as standard, padded base64 in content_base64, up to about 3 MB of file. The format is read from the content, not the file name.
- A file cut short still attaches the deposits it holds whole: issues then says the file may be truncated (a BG Max file without its end record, a camt.054 file without its closing element). Send the whole file again to attach the rest.
- A deposit whose bank row has not synced yet answers status no_row and attaches nothing: sync the bank and send the same file again.
- A deposit that fits two bank rows equally well answers status ambiguous and is left for a person.
- A deposit whose payments do not add up to it is left out and counted in rejected_deposits.
- A file that is neither format answers 400 BGMAX_NOT_DEPOSIT_FILE; a file with nothing to attach answers 400 BGMAX_NO_DEPOSITS or CAMT054_NO_DEPOSITS with the first issues in details.
- dry_run=true reads and matches without writing: the same summary with applied false.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ filename: string, content_base64: string }
```

Example request:
```json
{
  "filename": "camt054_20261201.xml",
  "content_base64": "PD94bWwgdmVyc2lvbj0i…"
}
```

Response `200`:
```ts
{
  data: {
    filename: string,
    format: "bgmax" | "camt054",
    date_from: string | null,
    date_to: string | null,
    rejected_deposits: number,
    issues: { severity: "info" | "warning" | "error", message: string }[],
    applied: boolean,
    deposits: number,
    payments: number,
    matched_deposits: number,
    matched_payments: number,
    suggested_payments: number,
    ready_rows: number,
    booked_rows: number,
    no_row: number,
    ambiguous: number,
    outcomes: { date: string, amount: number, bankgiro: string | null, payments: number, status: "matched" | "no_row" | "ambiguous", transaction_id: string | null, suggested: number }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "filename": "camt054_20261201.xml",
    "format": "camt054",
    "date_from": "2026-12-01",
    "date_to": "2026-12-01",
    "rejected_deposits": 0,
    "issues": [],
    "applied": true,
    "deposits": 2,
    "payments": 4,
    "matched_deposits": 1,
    "matched_payments": 3,
    "suggested_payments": 3,
    "ready_rows": 1,
    "booked_rows": 0,
    "no_row": 1,
    "ambiguous": 0,
    "outcomes": [
      {
        "date": "2026-12-01",
        "amount": 1500,
        "bankgiro": "123-4567",
        "payments": 3,
        "status": "matched",
        "transaction_id": "7c1d…",
        "suggested": 3
      },
      {
        "date": "2026-12-01",
        "amount": 250,
        "bankgiro": null,
        "payments": 1,
        "status": "no_row",
        "transaction_id": null,
        "suggested": 0
      }
    ]
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/imports/sie`

**Import a SIE4 file.**
`scope:bookkeeping:write · risk:high · idempotent · reversible`

Accepts a SIE4 file (CP437 / Windows-1252 / UTF-8 auto-detected, up to 50 MB) as the request body, parses it, checks for duplicate imports by file-hash, and replays every #VER + #TRANS into the company's bookkeeping. Returns an `operation_id` immediately: poll `GET /api/v1/operations/{id}` for status + final result. The byte-equivalent dashboard route at /api/import/sie/execute backs the same lib helper, so a SIE imported via v1 matches what the dashboard would produce.

**Use when:** Migrating bookkeeping data from another system (Fortnox, Bokio, Visma) into Accounted, restoring from a backup .se file, or recreating a period from an archive.
**Do not use for:** Bank transaction CSV/XML imports (use POST /imports/bank). Single-voucher creation (use POST /journal-entries). Importing into a period that already has posted entries: SIE imports run on a fresh period.

**Pitfalls:**
- Body content-type must be multipart/form-data with either a `file` field carrying the .se / .sie / .si file, or `storagePath` and `filename` fields from the signed-upload endpoint.
- Files up to 50 MB use POST /imports/sie/upload, then upload bytes to Storage and submit storagePath + filename. Inline multipart is limited by the hosting gateway.
- An identical retry returns the same execution. Deliberate replacement requires options.onExistingPeriod=replace and options.supersedesImportId naming the reviewed predecessor, and uses a new batch after storno.
- A fiscal year that already has a posted ingående balans booked outside an import (by hand or by a year-end close) answers 409 SIE_IMPORT_PERIOD_HAS_OPENING_BALANCE when the import would book the file's IB on top of it (importOpeningBalances true and no earlier bookkeeping): resend with options.importOpeningBalances=false to import the vouchers on top of the posted IB. A year that already holds an import answers 409 SIE_IMPORT_PERIOD_ALREADY_IMPORTED.
- To add only the file's vouchers the year does not hold yet (the last weeks booked in the old system, a card provider, payroll or POS export), send options.onExistingPeriod=append: they post as their own batch beside the year's import, numbers continuing per series, and undo alone. A voucher with the same source series and number as a posted one is skipped when identical and refuses the whole append when changed (409 SIE_IMPORT_APPEND_CONFLICT, details.conflicts). One with the same date and lines as a posted entry but no matching number is a possible duplicate, skipped unless options.includePossibleDuplicates=true. Also 409: an #IB unlike the year's (SIE_IMPORT_APPEND_OPENING_BALANCE_DIFFERS), an unbalanced or unmapped new voucher (SIE_IMPORT_APPEND_INVALID_VOUCHERS), nothing new (SIE_IMPORT_APPEND_NOTHING_NEW), a closed or locked period (SIE_IMPORT_PERIOD_LOCKED). options.seriesMap books a source series in another ({"K":"A"}). The year's import cannot be undone or replaced while an append is live (409 SIE_IMPORT_HAS_LIVE_APPEND).
- A file with #VER and no #IB, #UB or #RES (a card provider, payroll or POS export) is never a replacement of an imported year: 409 SIE_IMPORT_VOUCHERS_ONLY_FILE. Never undo the year's import for it: append it (options.onExistingPeriod=append).
- A file whose #ORGNR is not the company's organisation number answers 409 SIE_IMPORT_ORG_NUMBER_MISMATCH with both numbers in details. Check with the user, then resend with options.confirmOrgNumberMismatch=true to import it anyway. A file without #ORGNR is not checked.
- The operation can take 1-5 minutes for multi-year files. The HTTP response returns immediately with operation_id; poll /operations/{id} every ~2s for status.
- Chunks are visible while importing. Filing and export are held until completion. Undo uses batch storno and retains accounting history.
- options (a JSON string field) takes createFiscalPeriod, importOpeningBalances, importTransactions, updateAccountNames (each default true), voucherSeries (for vouchers the file gives no series; default B, as the dashboard), openingBalanceSeries (default: a series the file does not use), markImportedNoDocRequired (default false), onlyUsedAccounts (default false; true leaves out the BAS accounts with no balance and no voucher line in the file, while the file's own non-BAS accounts are still created and the archived file keeps everything), onExistingPeriod (block, replace or append), supersedesImportId, includePossibleDuplicates, seriesMap and confirmOrgNumberMismatch; any other key is 400.
- Account mappings are generated server-side from the file's #KONTO records (plus stored per-company overrides), by the same rules as the dashboard upload: a class 9 account carrying amounts is mapped to 2999 OBS-konto, also over a stored class 9 mapping. By default the file's account names are carried into the chart, renaming existing accounts whose names differ: pass options.updateAccountNames=false to keep BAS default names.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { operation_id: string, type: "import.sie", status: "queued", poll_url: string },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "operation_id": "7ce97122-264e-49ca-a795-e01dc77425e7",
    "type": "import.sie",
    "status": "queued",
    "poll_url": "/api/v1/operations/7ce97122-264e-49ca-a795-e01dc77425e7"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/imports/sie/{id}/resume`

**Resume an interrupted SIE import from where it stopped.**
`scope:bookkeeping:write · risk:medium · idempotent · dry-run`

Re-queues a paused or interrupted durable SIE import (or an interrupted undo) so the worker continues from the last committed chunk; entries already posted are not posted again. A finished run (completed, undone, failed) is answered unchanged. Allowed to the user who ran the import and to owners/admins. Idempotent. Dry-runnable.

**Use when:** An SIE import stopped part-way (state paused, or running with no progress) and should continue.
**Do not use for:** Starting a new import (POST /imports/sie) or cancelling one (POST /imports/sie/{id}/undo).

**Pitfalls:**
- Another user's import needs an owner or admin key: 403 FORBIDDEN otherwise.
- Legacy imports made before durable jobs return 409 SIE_IMPORT_LEGACY_REVIEW_REQUIRED.
- Resuming an undo that a lock stopped returns 409 SIE_IMPORT_PERIOD_LOCKED until the user unlocks the range in details.reason; it then continues from the last committed chunk.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Response `200`:
```ts
{
  data: {
    import_id: string,
    action: "undo" | "resume",
    state: string,
    phase: string | null,
    accepted: true
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "import_id": "7ce9…",
    "action": "resume",
    "state": "running",
    "phase": "vouchers",
    "accepted": true
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/imports/sie/{id}/undo`

**Undo an SIE import by batch storno: every entry it posted is reversed, nothing is deleted.**
`scope:bookkeeping:write · risk:high · idempotent · dry-run`

Queues a batch storno of the import: each verifikat the import posted gets a reversing entry (BFL 5 kap 5 §) and the originals stay in the ledger. Asynchronous: the answer carries state "undoing" and the worker finishes in the background (state "undone"). Refused while another SIE run is active, while a reversal of an imported voucher is already in progress, while an imported voucher has a live correction, or when a date a storno must carry is locked (the fiscal year is closed or locked, or the company lock date covers it). Owner/admin only. Idempotent. Dry-runnable (the dry run counts the entries that would be reversed).

**Use when:** An SIE file was imported into the wrong company or year, or with a wrong mapping, and its entries must be cancelled before a corrected import.
**Do not use for:** Removing single vouchers (POST /journal-entries/{id}/reverse), bank file imports (POST /imports/bank/{id}/undo), or legacy imports made before durable jobs (409 SIE_IMPORT_LEGACY_REVIEW_REQUIRED: review them in the app).

**Pitfalls:**
- Nothing is deleted: the ledger keeps both the imported entries and their reversals, and voucher numbers are never reused.
- Each storno is dated like the voucher it reverses. A closed or locked fiscal year, or a company lock date on or after the first imported voucher, returns 409 SIE_IMPORT_PERIOD_LOCKED before anything is queued; details.reason names the locked range and what to unlock (the user's decision).
- Another active run or a live correction returns 409 SIE_IMPORT_ACTION_CONFLICT with details.reason.
- Owner or admin only: a member key gets 403 FORBIDDEN.
- Undoing an already undone import answers its state unchanged.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{ reason?: string }
```

Example request:
```json
{
  "reason": "Importerad till fel räkenskapsår"
}
```

Response `200`:
```ts
{
  data: {
    import_id: string,
    action: "undo" | "resume",
    state: string,
    phase: string | null,
    accepted: true
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "import_id": "7ce9…",
    "action": "undo",
    "state": "undoing",
    "phase": "undo",
    "accepted": true
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/imports/sie/upload`

**Reserve a direct SIE upload.**
`scope:bookkeeping:write · risk:low · reversible`

Upload exact bytes to uploadUrl with PUT, then submit storagePath and filename to POST /imports/sie. The upload URL expires after two hours.

**Use when:** Importing files larger than the function request limit.
**Do not use for:** Booking a voucher: this only reserves storage.

**Pitfalls:**
- Use the returned URL once with PUT and application/octet-stream. Submit the returned storagePath after upload completes.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Request body:
```ts
{ filename: string, size: number }
```

Example request:
```json
{
  "filename": "export.se",
  "size": 10485760
}
```

Response `200`:
```ts
{
  data: { storagePath: string, uploadUrl: string, filename: string },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "storagePath": "company/sie-intake/upload.se",
    "uploadUrl": "https://storage.example/upload",
    "filename": "export.se"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/imports/skattekonto-file`

**Import a skattekontoutdrag file (Skatteverket tax account statement) into the skattekonto rows.**
`scope:transactions:write · risk:medium · idempotent · dry-run`

Parses the statement (the CSV export or legacy .skv from Skatteverket's Skattekonto e-tjänst, sent as base64), deduplicates it server-side against the skattekonto rows already stored, inserts the new events (source file_import), promotes upcoming rows the statement proves settled and skips duplicates. Books nothing: the rows are booked afterwards through the skattekonto rules, like synced rows. A file already imported is refused; a file naming another organisation number or not summing is refused unless confirmed. Idempotent. Dry-runnable: the dry run parses and counts and writes nothing.

**Use when:** The company has no Skatteverket connection (self-hosted, or not yet connected) and the skattekonto should be reconciled and booked from the statement file.
**Do not use for:** Companies with a Skatteverket connection (the hourly sync fetches the same events), bank statements (POST /imports/bank), or booking the rows (the skattekonto booking tools).

**Pitfalls:**
- Send the file bytes base64-encoded in content_base64, up to about 3 MB of file; the filename matters for legacy .skv detection.
- A file already imported answers 409 SKATTEKONTO_FILE_DUPLICATE with details.import_id.
- A header organisation number that is not the company's answers 409 SKATTEKONTO_FILE_ORG_NUMBER_MISMATCH: check the file, then resend with confirm_org_number_mismatch=true.
- A statement whose saldo markers do not sum (filtered, truncated or edited) answers 409 SKATTEKONTO_FILE_SUM_MISMATCH: resend with confirm_sum_mismatch=true only if the gap is understood.
- A file that is not a skattekontoutdrag answers 400 SKATTEKONTO_FILE_NOT_RECOGNIZED: a bank CSV is never accepted here.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  filename: string,
  content_base64: string,
  confirm_org_number_mismatch?: boolean,
  confirm_sum_mismatch?: boolean
}
```

Example request:
```json
{
  "filename": "Kontoutdrag 556677-8899 2026-05-03--2026-08-01.csv",
  "content_base64": "U2thdHRla29udG8…"
}
```

Response `200`:
```ts
{
  data: {
    import_id: string,
    imported: number,
    duplicates: number,
    promoted: number,
    errors: number,
    date_from: string,
    date_to: string,
    closing_saldo: number | null,
    file_hash: string,
    variant: "csv" | "skv",
    row_count: number
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "import_id": "1f0c…",
    "imported": 14,
    "duplicates": 2,
    "promoted": 1,
    "errors": 0,
    "date_from": "2026-05-03",
    "date_to": "2026-08-01",
    "closing_saldo": 23490,
    "file_hash": "9a1b…",
    "variant": "csv",
    "row_count": 17
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/pos-sales/clearing-balance`

**The till's card and Swish money not yet in the bank: the clearing account balance and the days not booked yet.**
`scope:transactions:read · risk:low · idempotent`

accounts: the accounts the connections book card and Swish to (1686 by default; a kind mapped to a bank account clears nothing). ledger_balance: debit minus credit on them as of as_of (default today), read as the balance sheet reads it, ingående balans included; null when no fiscal year covers as_of. unbooked_days and unbooked_amount: the days up to as_of not booked yet and their card and Swish, tips included, which the ledger does not hold yet. With every day booked and every payout booked against the account, ledger_balance is the money still on its way; a negative or growing figure is a payout booked as sales or a day booked twice. Read-only.

**Use when:** A month-end check of the till's card and Swish against the bank, or before booking payouts against 1686.
**Do not use for:** Which bank row is which payout (accounted_suggest_categories proposes those), or the days themselves (GET /pos-sales/days).

**Pitfalls:**
- Two venues on one account share one ledger_balance: the ledger cannot tell them apart.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `as_of` | query | `string` | no | The date the balance is read as of; today when left out. |

Response `200`:
```ts
{
  data: {
    as_of: string,
    accounts: string[],
    ledger_balance: number | null,
    fiscal_period_id: string | null,
    unbooked_days: number,
    unbooked_amount: number
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "as_of": "2026-09-30",
    "accounts": [
      "1686"
    ],
    "ledger_balance": 14250.5,
    "fiscal_period_id": "4f2d…",
    "unbooked_days": 2,
    "unbooked_amount": 31480
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/pos-sales/connections`

**The point-of-sale venues the company has connected, with their health and account mapping.**
`scope:transactions:read · risk:low · idempotent`

Lists the company's POS connections (kassasystem) through Accounted Connect: the provider and venue, the status (active or disconnected), the health of the daily fetch (ok, degraded, action_required with the error code), the first business day fetched (sync_from) and the last one fetched without a gap (synced_through), and the account mapping each day is booked with (settings, defaults merged in). available is false when this installation has no connector key, so no POS system can be connected. Read-only.

**Use when:** Before reading or booking POS days, to see which venues feed the company and whether the fetch works.
**Do not use for:** The days themselves (GET /pos-sales/days) or venues not yet connected (GET /pos-sales/venues).

**Pitfalls:**
- health action_required means fetching stopped until a person acts: health_code says why (for example CONNECTOR_POS_PROVIDER_ACCESS_DENIED: the provider has not opened the venue for Accounted).
- Disconnected connections stay listed: their days are still the underlag of booked vouchers.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    available: boolean,
    connections: { connection_id: string, provider: string, provider_name: string, venue_ref: string, venue_name: string, status: "connecting" | "needs_setup" | "active" | "disconnected", health: "ok" | "degraded" | "action_required", health_code: string | null, sync_from: string, synced_through: string | null, last_success_at: string | null, next_run_at: string, settings: { tender_accounts: Record<string, string | null>, revenue_accounts: Record<string, string | null>, vat_accounts: Record<string, string | null>, tips_account: string, rounding_account: string, max_rounding: number }, created_at: string, ended_at: string | null }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "available": true,
    "connections": [
      {
        "connection_id": "0b3a…",
        "provider": "heynow",
        "provider_name": "Heynow",
        "venue_ref": "6081523749284167",
        "venue_name": "Restaurang Exempel",
        "status": "active",
        "health": "ok",
        "health_code": null,
        "sync_from": "2026-09-30",
        "synced_through": "2026-10-02",
        "last_success_at": "2026-10-03T04:15:02Z",
        "next_run_at": "2026-10-04T04:15:00Z",
        "settings": {
          "tender_accounts": {
            "card": "1686",
            "swish": "1686",
            "cash": "1910",
            "gift_card": "2421",
            "invoice": null,
            "prepaid": null,
            "other": null
          },
          "revenue_accounts": {
            "0": null,
            "6": "3003",
            "12": "3002",
            "25": "3001"
          },
          "vat_accounts": {
            "6": "2631",
            "12": "2621",
            "25": "2611"
          },
          "tips_account": "2820",
          "rounding_account": "3740",
          "max_rounding": 1
        },
        "created_at": "2026-10-03T09:00:00Z",
        "ended_at": null
      }
    ]
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/pos-sales/connections`

**Connect a point-of-sale venue, so its business days are fetched every morning.**
`scope:companies:write · risk:low · idempotent · dry-run · reversible`

Connects one venue listed by GET /pos-sales/venues to the company through Accounted Connect. From the next run on, every closed business day from sync_from on is fetched (each morning, after the venue closed) and stored with the provider's answer archived verbatim. Nothing is booked: each day waits for POST /pos-sales/days/{dayId}/book. sync_from defaults to yesterday; set it to the venue's first trading day to read earlier days. Dry-runnable.

**Use when:** A venue is listed as available and the company wants its daily sales in the books.
**Do not use for:** Getting a venue opened at the provider (the venue asks the provider, see accessRequestSv) or booking days.

**Pitfalls:**
- POS_ALREADY_CONNECTED: the venue is already connected; the connection id is in details.
- A venue another company holds answers POS_CONNECT_FAILED with details.connect_code CONNECTOR_POS_VENUE_TAKEN.
- Refused in the sandbox (POS_SANDBOX_BLOCKED).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{ provider: string, venue_ref: string, sync_from?: string }
```

Example request:
```json
{
  "provider": "heynow",
  "venue_ref": "6081523749284167",
  "sync_from": "2026-09-30"
}
```

Response `200`:
```ts
{
  data: { connection_id: string, venue_name: string, provider_name: string, sync_from: string },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "connection_id": "0b3a…",
    "venue_name": "Restaurang Exempel",
    "provider_name": "Heynow",
    "sync_from": "2026-09-30"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/pos-sales/connections/{connectionId}/disconnect`

**Stop fetching a point-of-sale venue's days.**
`scope:companies:write · risk:medium · idempotent · dry-run · reversible`

Ends a POS connection: no more days are fetched and the venue is released at Accounted Connect. Days already fetched stay, booked or not, with their archived provider answers; a disconnected venue can be connected again later. Idempotent. Dry-runnable.

**Use when:** The company stopped using the POS system or the venue closed.
**Do not use for:** Pausing a single day (just do not book it) or correcting a booked day (storno).

**Pitfalls:**
- Days not fetched before the disconnect are not fetched later unless the venue is connected again with an earlier sync_from.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `connectionId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Response `200`:
```ts
{
  data: { connection_id: string, status: "disconnected" },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "connection_id": "0b3a…",
    "status": "disconnected"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/pos-sales/connections/{connectionId}/settings`

**Change the accounts a point-of-sale venue's days are booked to.**
`scope:companies:write · risk:medium · idempotent · dry-run · reversible`

Updates the account mapping of one POS connection: an account per way of paying (tender_accounts: card, swish, cash, gift_card, invoice, prepaid, other; null = a person decides each time), the revenue and output VAT account per VAT rate (keys "25", "12", "6", "0"), the tips account, the rounding account and the largest rounding difference per day. Send only what changes; nested maps merge key by key. Every unbooked day is re-evaluated against the new mapping, so a day that waited on an account may become ready. Booked days never change. Dry-runnable.

**Use when:** A day is needs_review with tender_unmapped or vat_rate_unmapped, or the company books takings to other accounts than the BAS defaults.
**Do not use for:** Re-booking a booked day (reverse it with storno and book again).

**Pitfalls:**
- Defaults: card and Swish 1686 (cleared by the payouts, so revenue is never booked twice), cash 1910, redeemed gift cards 2421, tips 2820 (a liability until paid out through payroll), 25/12/6 % to 3001/3002/3003 with 2611/2621/2631, rounding 3740.
- Sales without VAT have no default account: in a restaurant they are often gift cards sold (2421) rather than exempt sales (3004).
- An account neither in the chart nor in BAS answers POS_SETTINGS_ACCOUNT_UNKNOWN.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `connectionId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  settings: {
    tender_accounts?: { card?: string | null, swish?: string | null, cash?: string | null, gift_card?: string | null, invoice?: string | null, prepaid?: string | null, other?: string | null },
    revenue_accounts?: { 0?: string | null, 6?: string | null, 12?: string | null, 25?: string | null },
    vat_accounts?: { 6?: string | null, 12?: string | null, 25?: string | null },
    tips_account?: string,
    rounding_account?: string,
    max_rounding?: number
  }
}
```

Example request:
```json
{
  "settings": {
    "revenue_accounts": {
      "0": "2421"
    },
    "tender_accounts": {
      "invoice": "1510"
    }
  }
}
```

Response `200`:
```ts
{
  data: {
    connection_id: string,
    settings: { tender_accounts: Record<string, string | null>, revenue_accounts: Record<string, string | null>, vat_accounts: Record<string, string | null>, tips_account: string, rounding_account: string, max_rounding: number },
    reevaluated_days: number
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "connection_id": "0b3a…",
    "reevaluated_days": 3
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/pos-sales/days`

**The business days fetched from the company's point-of-sale venues, newest first.**
`scope:transactions:read · risk:low · idempotent`

One row per venue and business day: sales (gross, net, VAT), tips, receipts, the payment split (tenders: card, swish, cash, gift_card, invoice, prepaid, other) and the VAT split, the status (ready to book, needs_review with the reasons, empty for a day without sales, booked with the verifikat), the hash of the archived provider answer, and whether a fetch after booking answered differently (changed_after_booking). Filter by date range, status or connection. Read-only.

**Use when:** To find the days to book, or to check which days a venue has delivered.
**Do not use for:** The receipts and the voucher a day books as (GET /pos-sales/days/{dayId}).

**Pitfalls:**
- A day is fetched the morning after it ends (from 06:00 Swedish time) and once more the next morning while unbooked.
- changed_after_booking true: the provider now answers something else than what was booked; compare and correct with storno if needed.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `from` | query | `string` | no | First business date, inclusive. |
| `to` | query | `string` | no | Last business date, inclusive. |
| `status` | query | `"ready" \| "needs_review" \| "empty" \| "booked"` | no |  |
| `connection_id` | query | `string` | no |  |
| `limit` | query | `number` | no |  |
| `offset` | query | `number` | no |  |

Response `200`:
```ts
{
  data: {
    days: { day_id: string, connection_id: string, business_date: string, currency: string, status: "ready" | "needs_review" | "empty" | "booked", review_reasons: { code: string, params: Record<string, {...}>, message?: string }[], gross: number, net: number, vat: number, tips: number, receipt_count: number, tenders: { kind: "card" | "swish" | "cash" | "gift_card" | "invoice" | "prepaid" | "other", method: string, amount: number, tips: number, receiptCount: number }[], vat_groups: { ratePercent: number, net: number, vat: number, gross: number }[], raw_sha256: string, fetched_at: string, changed_after_booking: boolean, journal_entry_id: string | null, booked_at: string | null }[],
    total: number
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "days": [
      {
        "day_id": "7c1e…",
        "connection_id": "0b3a…",
        "business_date": "2026-09-30",
        "currency": "SEK",
        "status": "ready",
        "review_reasons": [],
        "gross": 39070,
        "net": 34000,
        "vat": 5070,
        "tips": 640,
        "receipt_count": 212,
        "tenders": [
          {
            "kind": "card",
            "method": "card",
            "amount": 28640,
            "tips": 640,
            "receiptCount": 160
          },
          {
            "kind": "swish",
            "method": "swish",
            "amount": 6000,
            "tips": 0,
            "receiptCount": 40
          },
          {
            "kind": "cash",
            "method": "cash",
            "amount": 5070,
            "tips": 0,
            "receiptCount": 12
          }
        ],
        "vat_groups": [
          {
            "ratePercent": 25,
            "net": 9000,
            "vat": 2250,
            "gross": 11250
          },
          {
            "ratePercent": 12,
            "net": 22000,
            "vat": 2640,
            "gross": 24640
          },
          {
            "ratePercent": 6,
            "net": 3000,
            "vat": 180,
            "gross": 3180
          }
        ],
        "raw_sha256": "3f9a…",
        "fetched_at": "2026-10-01T04:15:00Z",
        "changed_after_booking": false,
        "journal_entry_id": null,
        "booked_at": null
      }
    ],
    "total": 1
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/pos-sales/days/{dayId}`

**One point-of-sale day: its receipts and the voucher it books as.**
`scope:transactions:read · risk:low · idempotent`

The full day: everything GET /pos-sales/days returns plus the day model (receipts with number, time, payment method and amount; sales per article group; refunds; discounts; the provider's issues) and the voucher the day books as with the current mapping (proposal: the lines, the rounding). reasons lists what needs a person; acknowledgeable is true when every reason is a provider issue, which acknowledge_issues on the booking accepts after review. Read-only.

**Use when:** Before booking a day, to review it and its voucher.
**Do not use for:** The day report PDF (the dashboard renders it).

**Pitfalls:**
- proposal.lines is empty while a reason other than a provider issue remains: fix the mapping first.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dayId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    day_id: string,
    connection_id: string,
    business_date: string,
    currency: string,
    status: "ready" | "needs_review" | "empty" | "booked",
    review_reasons: { code: string, params: Record<string, string | number>, message?: string }[],
    gross: number,
    net: number,
    vat: number,
    tips: number,
    receipt_count: number,
    tenders: { kind: "card" | "swish" | "cash" | "gift_card" | "invoice" | "prepaid" | "other", method: string, amount: number, tips: number, receiptCount: number }[],
    vat_groups: { ratePercent: number, net: number, vat: number, gross: number }[],
    raw_sha256: string,
    fetched_at: string,
    changed_after_booking: boolean,
    journal_entry_id: string | null,
    booked_at: string | null,
    description: string,
    venue_name: string,
    provider_name: string,
    proposal: { lines: { account_number: string, debit_amount: number, credit_amount: number, line_description?: string }[], rounding_amount: number },
    reasons: { code: string, params: Record<string, string | number>, message?: string }[],
    acknowledgeable: boolean,
    day: Record<string, unknown>
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "day_id": "7c1e…",
    "connection_id": "0b3a…",
    "business_date": "2026-09-30",
    "currency": "SEK",
    "status": "ready",
    "review_reasons": [],
    "gross": 39070,
    "net": 34000,
    "vat": 5070,
    "tips": 640,
    "receipt_count": 212,
    "tenders": [
      {
        "kind": "card",
        "method": "card",
        "amount": 28640,
        "tips": 640,
        "receiptCount": 160
      },
      {
        "kind": "swish",
        "method": "swish",
        "amount": 6000,
        "tips": 0,
        "receiptCount": 40
      },
      {
        "kind": "cash",
        "method": "cash",
        "amount": 5070,
        "tips": 0,
        "receiptCount": 12
      }
    ],
    "vat_groups": [
      {
        "ratePercent": 25,
        "net": 9000,
        "vat": 2250,
        "gross": 11250
      },
      {
        "ratePercent": 12,
        "net": 22000,
        "vat": 2640,
        "gross": 24640
      },
      {
        "ratePercent": 6,
        "net": 3000,
        "vat": 180,
        "gross": 3180
      }
    ],
    "raw_sha256": "3f9a…",
    "fetched_at": "2026-10-01T04:15:00Z",
    "changed_after_booking": false,
    "journal_entry_id": null,
    "booked_at": null,
    "description": "Dagskassa 2026-09-30 Restaurang Exempel (Heynow)",
    "proposal": {
      "lines": [
        {
          "account_number": "1686",
          "debit_amount": 28640,
          "credit_amount": 0,
          "line_description": "Kortbetalningar"
        },
        {
          "account_number": "3002",
          "debit_amount": 0,
          "credit_amount": 22000,
          "line_description": "Försäljning 12 % moms"
        }
      ],
      "rounding_amount": 0
    },
    "reasons": [],
    "acknowledgeable": false,
    "day": {}
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/pos-sales/days/{dayId}/book`

**Book a point-of-sale day as its daily takings voucher, with the day report as underlag.**
`scope:bookkeeping:write · risk:high · idempotent · dry-run`

Posts the day as one verifikat (source_type pos_daily_sales, dated the business day) through the bookkeeping engine: each way of paying debited to its account (card and Swish to the 1686 clearing account by default), sales credited per VAT rate with the output VAT, tips credited to the tips account, a rounding difference up to max_rounding on the rounding account. The lines are the server's, from the stored day and the connection's mapping, never the caller's. The day report (sales, payments, receipts, the archived answer's SHA-256) is archived on the verifikat. Refused when the day is booked, empty, needs review, changed since expected_raw_sha256, or the date is locked. Dry-runnable.

**Use when:** A day is ready (or needs_review with only provider issues a person has read) and should be booked.
**Do not use for:** Payouts from the card acquirer or the bank (book those against 1686 from the bank row) or a corrected day (storno, then book again).

**Pitfalls:**
- Pass expected_raw_sha256 from the day you reviewed: a newer fetch answers 409 POS_DAY_CHANGED instead of booking different figures.
- acknowledge_issues books past provider issues only; a missing account (tender_unmapped, vat_rate_unmapped) or an imbalance always stops the day.
- A posted verifikat is permanent: undo it with storno (POST /journal-entries/{id}/reverse), never by editing.
- The card acquirer's payout must clear 1686 when it reaches the bank, never be booked as sales again.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dayId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{ acknowledge_issues?: boolean, expected_raw_sha256?: string }
```

Example request:
```json
{
  "expected_raw_sha256": "3f9a…"
}
```

Response `200`:
```ts
{
  data: {
    journal_entry_id: string,
    voucher_series: string | null,
    voucher_number: number | null,
    entry_date: string,
    business_date: string,
    gross: number,
    underlag_document_id: string | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "journal_entry_id": "9a0b…",
    "voucher_series": "F",
    "voucher_number": 12,
    "entry_date": "2026-09-30",
    "business_date": "2026-09-30",
    "gross": 39070,
    "underlag_document_id": "5d2c…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/pos-sales/fetch`

**Fetch point-of-sale days now instead of waiting for the morning run.**
`scope:transactions:write · risk:low · idempotent · dry-run`

Runs the fetch for the company's active POS connections (or one): with business_dates, exactly those closed days (fetched again if stored); without, the regular plan (days not yet fetched, oldest first, then one more read of the two latest unbooked days). A booked day is never rewritten: a different answer only marks it changed_after_booking. Each day is one call to the provider, whose limit is ten an hour per venue, so the run stops at six. Nothing is booked. Dry-runnable.

**Use when:** A person corrected a day in the POS system, or wants yesterday before the morning run.
**Do not use for:** Today (a business day is fetched once it has ended) or booking.

**Pitfalls:**
- A rate-limited run answers with the per-connection result status failed and errorCode CONNECTOR_POS_PROVIDER_RATE_LIMITED; try again later.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ connection_id?: string, business_dates?: string[] }
```

Example request:
```json
{
  "business_dates": [
    "2026-10-02"
  ]
}
```

Response `200`:
```ts
{
  data: { results: (Record<string, unknown>)[] },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "results": [
      {
        "connectionId": "0b3a…",
        "status": "synced",
        "fetched": [
          "2026-10-02"
        ],
        "changed": [
          "2026-10-02"
        ],
        "changedAfterBooking": []
      }
    ]
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/pos-sales/venues`

**The point-of-sale venues this company may connect, and how to get one opened.**
`scope:transactions:read · risk:low · idempotent`

Asks Accounted Connect which POS venues are open to this company's organisation number: a POS provider opens a venue for Accounted when the venue asks it to, and Accounted records which organisation the venue belongs to. Each venue says whether this company already holds it (connected) and whether it is free (available). providers lists the POS providers this installation can use, each with accessRequestSv: what the venue sends the provider to get a venue opened. Read-only; nothing is connected.

**Use when:** To find the venue to connect with POST /pos-sales/connections, or to tell a person how to get their venue opened.
**Do not use for:** Venues already connected (GET /pos-sales/connections).

**Pitfalls:**
- An empty venues list means no provider has opened a venue for this organisation yet: follow accessRequestSv.
- POS_ORG_NUMBER_MISSING: the company has no organisation number to match venues against.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { org_number: string, venues: (Record<string, unknown>)[], providers: (Record<string, unknown>)[] },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "org_number": "5561234567",
    "venues": [
      {
        "provider": {
          "ref": "heynow",
          "displayName": "Heynow",
          "legalName": "Heynow AB",
          "portalUrl": "https://heynow.ai",
          "supportUrl": null,
          "accessRequestSv": "Be Heynow öppna API-åtkomst för Accounted…"
        },
        "venueRef": "6081523749284167",
        "name": "Restaurang Exempel",
        "connected": false,
        "available": true
      }
    ],
    "providers": []
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reconciliation/accounts`

**List the accounts that can be reconciled, with status per account.**
`scope:reconciliation:read · risk:low · idempotent`

Returns one row per reconcilable account (bank:<cash_account_id> for each enabled cash account, skattekonto when configured) with kind, number, currency, source (psd2 / bank_file / skatteverket_api / manual, synced_at, stale), status (reconciled | open | stale | not_configured, unexplained_difference, open_counts) and superseded_by for reconnect duplicates. Optional ?date_from / ?date_to scope the bank bridge (default: the calendar year to date). Pass ?with_status=false for a cheap list without status.

**Use when:** You need the side list of the Avstämning page, a month-end checklist, or to find the account_key to pass to the other reconciliation endpoints.
**Do not use for:** The bridge and rows for one account: use GET /reconciliation/accounts/{accountKey} and .../items.

**Pitfalls:**
- account_key is the identifier every other reconciliation endpoint takes: bank:<cash_account_id> or skattekonto. Do not pass the BAS number.
- status.state = stale means the outside truth is older than 7 days; the numbers are still computed, but judge them accordingly.
- superseded_by is set on an older cash account that shares IBAN + currency with a newer one (reconnect duplicate); it is kept in the list because it may still hold unlinked rows.
- Computing status per account runs one reconciliation per account; with_status=false skips that when you only need the list.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `date_from` | query | `string` | no | YYYY-MM-DD. Start of the bank bridge window. Default: 1 January of the current year. |
| `date_to` | query | `string` | no | YYYY-MM-DD. End of the bank bridge window. Default: today. |
| `with_status` | query | `"true" \| "false"` | no | false returns the list without computing status per account (one reconciliation per account). Default: true. |

Response `200`:
```ts
{
  data: {
    accounts: { account_key: string, kind: "bank" | "skattekonto" | "manual", account_number: string, name: string, currency: string, logo_url: string | null, source: { type: "psd2" | "bank_file" | "skatteverket_api" | "skatteverket_file" | "manual", synced_at: string | null, stale: boolean }, status: { state: "reconciled" | "open" | "stale" | "not_configured", as_of: string, unexplained_difference: number | null, open_counts: { proposed: number, unmatched_external: number, unmatched_ledger: number } } | null, superseded_by: string | null, signed_off_through?: string | null, balance?: number | null, balance_at?: string | null }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "accounts": [
      {
        "account_key": "bank:11111111-1111-4111-8111-111111111111",
        "kind": "bank",
        "account_number": "1930",
        "name": "Swedbank företagskonto",
        "currency": "SEK",
        "logo_url": null,
        "source": {
          "type": "psd2",
          "synced_at": "2026-08-20T06:40:00.000Z",
          "stale": false
        },
        "status": {
          "state": "open",
          "as_of": "2026-08-20T09:00:00.000Z",
          "unexplained_difference": 0,
          "open_counts": {
            "proposed": 0,
            "unmatched_external": 1,
            "unmatched_ledger": 1
          }
        },
        "superseded_by": null
      },
      {
        "account_key": "skattekonto",
        "kind": "skattekonto",
        "account_number": "1630",
        "name": "Skattekonto",
        "currency": "SEK",
        "logo_url": null,
        "source": {
          "type": "skatteverket_api",
          "synced_at": "2026-08-20T04:00:12.000Z",
          "stale": false
        },
        "status": {
          "state": "open",
          "as_of": "2026-08-20T04:00:12.000Z",
          "unexplained_difference": 0,
          "open_counts": {
            "proposed": 2,
            "unmatched_external": 3,
            "unmatched_ledger": 1
          }
        },
        "superseded_by": null
      }
    ]
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}`

**The reconciliation bridge for one account.**
`scope:reconciliation:read · risk:low · idempotent`

Returns external_balance (Skatteverket saldo; null for bank accounts until a statement balance exists), ledger_balance (1630 balance at the snapshot for skattekonto; period movement on the bank account), difference, unexplained_difference, is_reconciled, the bridge lines (label, amount, count, items_bucket) that explain the difference row by row, counts per bucket, and a kind block (skattekonto: saldo, fetched_at, history_start, opening_difference, upcoming; bank: today's bank status fields). Optional ?date_from / ?date_to: for skattekonto they scope the item lists only (the bridge is anchored at the snapshot); for bank they scope the bridge window.

**Use when:** You need to know whether an account reconciles and why not: the bridge is the explanation, the buckets are the work.
**Do not use for:** Listing the rows themselves (use .../items) or linking (POST .../links).

**Pitfalls:**
- Judge health on unexplained_difference, never on difference. The difference is expected to be non-zero while rows are unmatched; unexplained_difference is what is left once every bridge line is accounted for, and for skattekonto it is 0,00 whenever the data is consistent (a non-zero value is an integrity finding, not a task).
- stale = true means the outside truth is older than 7 days (Skatteverket connection needing re-consent is the usual cause). is_reconciled can still be true on stale data; read both.
- skattekonto.opening_difference is the gap between the derived saldo at history_start and the ledger before it; it belongs to migrated ledgers and is accepted once at sign-off, not worked down.
- skattekonto.before_history_count (and before_history_total) are the open Skatteverket rows dated before history_start: the 1630 opening balance carries them, so no bridge line or count holds them and the app's to-do list does not count them. They need no action: do not book, link or ignore them to clear a list. List them with ?bucket=before_history on the items endpoint.
- skattekonto.covered (through_date, kind, event_count, event_total, journal_entry_ids, entry_count) is set when unbooked rows are already in the ledger through verifikat on 1630 that no row is linked to, typically one summarised year-end or month-end verifikat: up to through_date those verifikat sum exactly to the open rows (events_equal), or 1630 already equals Skatteverket although the rows are unbooked (ledger_agrees). Do not book such rows (skattekonto booking, in the app and through the MCP tools, refuses them with LEDGER_COVER_EXISTS; v1 has no skattekonto booking endpoint): link them with POST .../links and allow_remainder: true.
- Bank accounts carry the legacy field set in the bank block (bank_transaction_total, gl_1930_period_movement, …) unchanged from /reconciliation/bank/status.
- bank.history_start is the first day the bank side covers (its earliest bank row, feed or imported file). When it falls inside the window, the verifikat dated before it with no bank link (bank.before_history_count, before_history_total) are outside difference, the counts and unexplained_difference: no bank row can match them. List them with ?bucket=before_history; importing the older history as a bank file moves history_start earlier. bank.opening_difference (saldo_at_start minus ledger_balance_before_start) is informational and null when the bank reports no balance.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `accountKey` | path | `string` | yes |  |
| `date_from` | query | `string` | no | YYYY-MM-DD. Bank: start of the bridge window (default 1 January of the current year). Skattekonto: scopes the item lists only; the bridge is anchored at the saldo snapshot. |
| `date_to` | query | `string` | no | YYYY-MM-DD. Bank: end of the bridge window (default today). Skattekonto: scopes the item lists only. |

Response `200`:
```ts
{
  data: {
    account_key: string,
    kind: "bank" | "skattekonto" | "manual",
    account_number: string,
    currency: string,
    window: { from: string | null, to: string | null },
    as_of: string,
    stale: boolean,
    external_balance: number | null,
    ledger_balance: number | null,
    difference: number | null,
    unexplained_difference: number | null,
    is_reconciled: boolean,
    bridge: { key: string, label_sv: string, label_en: string, amount: number, count: number | null, items_bucket: string | null }[],
    counts: { proposed: number, unmatched_external: number, unmatched_ledger: number, matched: number, ignored: number },
    skattekonto: { saldo_skatteverket: number | null, saldo_missing_reason?: "not_connected" | "not_fetched" | null, fetched_at: string | null, history_start: string | null, opening_difference: number | null, upcoming_count: number, upcoming_total: number, ledger_balance_before_start: number | null, before_history_count?: number, before_history_total?: number, covered?: { through_date: string, kind: "events_equal" | "ledger_agrees", event_count: number, event_total: number, journal_entry_ids: string[], entry_count: number } | null } | null,
    bank: Record<string, unknown> | null,
    manual?: { period_id: string, period_start: string, period_end: string, opening_balance: number, movement: number, closing_balance: number, specification: { provider: "ar" | "ap" | "vacation", label_sv: string, label_en: string, amount: number, unconverted_fx_count: number } | null } | null,
    signoff?: { id: string, handle?: string, account_key: string, through_date: string, external_balance: number | null, ledger_balance: number | null, unexplained_difference: number | null, note: string | null, signed_by: string, signed_at: string, reopened_at: string | null, reopened_by: string | null, reopen_reason: string | null } | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "account_key": "skattekonto",
    "kind": "skattekonto",
    "account_number": "1630",
    "currency": "SEK",
    "window": {
      "from": null,
      "to": null
    },
    "as_of": "2026-08-20T04:00:12.000Z",
    "stale": false,
    "external_balance": 53395,
    "ledger_balance": 30342,
    "difference": 23053,
    "unexplained_difference": 0,
    "is_reconciled": false,
    "bridge": [
      {
        "key": "external_balance",
        "label_sv": "Saldo hos Skatteverket",
        "label_en": "Balance at Skatteverket",
        "amount": 53395,
        "count": null,
        "items_bucket": null
      },
      {
        "key": "unmatched_external",
        "label_sv": "Händelser som saknas i bokföringen",
        "label_en": "Events missing from the ledger",
        "amount": -35553,
        "count": 5,
        "items_bucket": "unmatched_external"
      },
      {
        "key": "unmatched_ledger",
        "label_sv": "Rader på 1630 utan händelse hos Skatteverket",
        "label_en": "1630 lines without a Skatteverket event",
        "amount": 12500,
        "count": 1,
        "items_bucket": "unmatched_ledger"
      },
      {
        "key": "ledger_balance",
        "label_sv": "Bokfört på 1630",
        "label_en": "Booked on 1630",
        "amount": 30342,
        "count": null,
        "items_bucket": null
      }
    ],
    "counts": {
      "proposed": 2,
      "unmatched_external": 3,
      "unmatched_ledger": 1,
      "matched": 41,
      "ignored": 0
    },
    "skattekonto": {
      "saldo_skatteverket": 53395,
      "fetched_at": "2026-08-20T04:00:12.000Z",
      "history_start": "2025-01-17",
      "opening_difference": 0,
      "upcoming_count": 3,
      "upcoming_total": -18450,
      "ledger_balance_before_start": 0
    },
    "bank": null
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}/items`

**List the rows behind one account's bridge, bucketed.**
`scope:reconciliation:read · risk:low · idempotent`

Returns reconciliation items for one account. ?bucket selects one of proposed | unmatched_external | unmatched_ledger | matched | ignored | upcoming | before_history (default: all open buckets first, then matched; before_history only when asked for: rows dated before history_start, outside every bridge line; skattekonto rows the 1630 opening balance carries, or bank verifikat dated before the earliest bank row). Each item carries its side (external | ledger), a qualified item_id (skattekonto_transaction / transaction / journal_entry), date, description, signed amount, the proposal when one exists (journal_entry_id, voucher, confidence, reasons[]), link_problem when a link points at a reversed or draft entry, awaiting_external for fresh ledger lines, and the actions the row allows. Skattekonto only: a ledger row carries partially_linked (entry_amount, linked_amount, linked_count) when rows are linked to the verifikat without explaining all of it, and its amount is then what remains (entry_amount - linked_amount, either sign), and held_by_uncounted_rows (count, amount, external_ids) when rows point at the verifikat without counting in the comparison yet (an upcoming row booked ahead, or one dated after the fetched saldo): a new link to it is judged with those rows on it; an outside row carries covered_by_ledger: true when unlinked verifikat on 1630 already hold its event (link it, never book it). ?date_from / ?date_to scope the lists; rows outside the window are never hidden from the counts (older_unmatched_count).

**Use when:** You are about to link, book or ignore rows and need to see what is open and what is proposed.
**Do not use for:** The totals: those are on GET /reconciliation/accounts/{accountKey}.

**Pitfalls:**
- An item in bucket proposed is NOT linked: it carries a proposal to link. Apply it with POST .../links { use_proposals: true } or explicit pairs.
- actions lists what the row allows right now; an action not listed returns a structured error rather than silently doing nothing.
- Ledger items are one per verifikat: several 1630/1930 lines of the same entry are netted, because a link settles the whole entry.
- Pagination is ?limit (max 200) + ?cursor; next_cursor is null on the last page.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `accountKey` | path | `string` | yes |  |
| `bucket` | query | `"proposed" \| "unmatched_external" \| "unmatched_ledger" \| "matched" \| "ignored" \| "upcoming" \| "before_history"` | no | Only this bucket. Default: every open bucket first, then matched. |
| `date_from` | query | `string` | no | YYYY-MM-DD. Scopes the lists; rows before it still count in older_unmatched_count. |
| `date_to` | query | `string` | no | YYYY-MM-DD. Scopes the lists. |
| `limit` | query | `number` | no | Page size, 1-200 (default 50). |
| `cursor` | query | `string` | no | Opaque cursor from the previous page's next_cursor. Omit for the first page. |

Response `200`:
```ts
{
  data: {
    items: { item_id: string, item_type: "skattekonto_transaction" | "transaction" | "journal_entry", side: "external" | "ledger", bucket: "proposed" | "unmatched_external" | "unmatched_ledger" | "matched" | "ignored" | "upcoming" | "before_history", date: string, description: string, amount: number, currency: string, voucher_number?: number | null, voucher_series?: string | null, entry_status?: "draft" | "posted" | "reversed", linked_journal_entry_id?: string | null, linked_entry?: { entry_date: string, voucher_series: string | null, voucher_number: number | null, description: string } | null, link_problem?: "entry_reversed" | "entry_draft" | "entry_missing" | null, proposal?: { journal_entry_id: string, voucher_number: number | null, voucher_series: string | null, entry_date: string, description: string, entry_status: "draft" | "posted" | "reversed", confidence: number, reasons: string[], vouchers?: { journal_entry_id: string, voucher_number: number | null, voucher_series: string | null, entry_date: string, description: string, amount: number }[], external_ids?: string[] } | null, awaiting_external?: boolean, ib_eligible?: boolean, partially_linked?: { entry_amount: number, linked_amount: number, linked_count: number }, held_by_uncounted_rows?: { count: number, amount: number, external_ids: string[] }, covered_by_ledger?: boolean, before_history?: boolean, settlement?: { settlement_id: string, state: "settled" | "broken", settled_at: string, settled_by: string, counterparts: { journal_entry_id: string, voucher_series: string | null, voucher_number: number | null, entry_date: string | null, amount: number }[] } | null, actions: ("match" | "unmatch" | "book" | "ignore" | "unignore" | "review")[] }[],
    count: number,
    total_count: number,
    has_more: boolean,
    next_cursor: string | null,
    older_unmatched_count: number
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "items": [
      {
        "item_id": "33333333-3333-4333-8333-333333333333",
        "item_type": "skattekonto_transaction",
        "side": "external",
        "bucket": "proposed",
        "date": "2026-08-12",
        "description": "Inbetalning bokförd",
        "amount": 30000,
        "currency": "SEK",
        "proposal": {
          "journal_entry_id": "44444444-4444-4444-8444-444444444444",
          "voucher_number": 214,
          "voucher_series": "A",
          "entry_date": "2026-08-11",
          "description": "Inbetalning skattekonto",
          "entry_status": "posted",
          "confidence": 0.95,
          "reasons": [
            "exakt belopp på 1630",
            "1 dagars avstånd"
          ]
        },
        "actions": [
          "match",
          "book",
          "ignore"
        ]
      }
    ],
    "count": 1,
    "total_count": 1,
    "has_more": false,
    "next_cursor": null,
    "older_unmatched_count": 0
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}/items/{itemId}/ignore`

**Ignore or restore one outside row.**
`scope:reconciliation:write · risk:low · idempotent · dry-run · reversible`

Sets the ignore flag on one outside row (bank transaction or skattekonto row). Body { ignored: true | false }, default true. An ignored row never has a link; ignoring a linked row is refused (unlink first). Ignored rows are excluded from the unmatched totals and listed on the bridge's exclusion line so they never disappear silently.

**Use when:** A row will never have a counterpart (a duplicate from a reconnect, an event that predates the books) and should stop counting as work.
**Do not use for:** Rows that should be booked or linked; ignoring is triage, not settlement.

**Pitfalls:**
- Ignoring is reversible (ignored: false) and audited through the row itself; nothing is deleted.
- For the skattekonto, an ignored row still counts toward the derived opening balance (it is a real Skatteverket movement); the bridge shows it on its own line.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `accountKey` | path | `string` | yes |  |
| `itemId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ ignored?: boolean }
```

Example request:
```json
{
  "ignored": true
}
```

Response `200`:
```ts
{
  data: { external_id: string, is_ignored: boolean },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "external_id": "33333333-3333-4333-8333-333333333333",
    "is_ignored": true
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}/links`

**Link outside rows to existing verifikat (pairs or proposals).**
`scope:reconciliation:write · risk:medium · idempotent · dry-run · reversible`

Body: { pairs: [{ external_ids: [id], journal_entry_ids: [id], allocations? }] } and/or { use_proposals: true, confidence_threshold? }. Each pair is validated as the single-link paths validate (row open and not ignored, entry posted and not reversed, the entry's account lines settle the amount, entry not already linked) and applied independently: the response lists applied[] and skipped[{pair, code, message}] so partial success is explicit. On a bank account a pair may also be ONE transaction against SEVERAL verifikat (1:N): allocations[{journal_entry_id, amount}] gives the signed slice per verifikat (omitted: each slice defaults to the voucher's line on the account); the slices must sum to the transaction amount, and each applied link then carries allocated_amount. On the skattekonto a pair may carry allow_remainder: true to link rows to a summarised verifikat whose 1630 movement they do not settle (one year-end or month-end verifikat that books more events than these, some from before the fetched history): the link is then via "partial", and remainder_amount on each applied link is what the verifikat still holds on 1630 beyond the rows linked to it (ledger sign, either sign); it stays in unmatched_ledger with that amount. remainder_amount is also returned when a row settles one of several 1630 lines of a verifikat. On the skattekonto a pair may also be ONE row against SEVERAL verifikat whose open amounts on 1630 sum exactly to the event (a verifikat and the correction booked after it): each applied link carries via "split" and allocated_amount (that verifikat's whole open amount; allocations, when sent, must equal it), the verifikat leave unmatched_ledger together and are listed under matched with a settlement, and unlinking the row undoes it all. On a SEK bank account a pair may also carry NO external_ids and two or more journal_entry_ids: verifikat that take each other out on the account (a wrong verifikat and the correction booked by hand), each still without a bank row and summing to exactly zero; they leave unmatched_ledger together and are reported in settled[] with a settlement_id. Codes: UNSUPPORTED_PAIR_SHAPE, ALREADY_LINKED, ENTRY_NOT_FOUND, ENTRY_REVERSED, PAIR_NOT_CLOSED, ROW_IGNORED, NOT_FOUND, LINK_RACE, ENTRY_NOT_OPEN (a verifikat of a ledger-only pair already has a bank row, has no line on the account, or is an opening balance or a storno; for a skattekonto 1:N, the verifikat is not in the open 1630 list), ALREADY_SETTLED, BANK_ANCHOR_REFUSED (a verifikat does not book the row, or its 1:N slice, on the bank ledger in that direction, a dry run included; the rows of an N:1 pair are judged one by one, so a verifikat booking a payout net of its fees takes them only once it books the deposits in debet and the fees in kredit on the account; retrying unchanged will not help), VOUCHER_BANK_LEG_CONSUMED (other rows already hold what the verifikat books on the bank account in the row's direction, so the row does not fit: book it as its own verifikat, or unlink the wrong row first). ?dry_run=true returns the pairs that would be attempted without writing (a 1:N dry run resolves the slices).

**Use when:** An agent or integration has decided which rows explain each other, or wants to apply the proposals the sync already computed.
**Do not use for:** Booking new verifikat for rows that have no counterpart (use the transactions or skattekonto booking endpoints); reconciling across accounts.

**Pitfalls:**
- A pair is one OR MANY outside rows against exactly one verifikat (bank: independent links per transaction; skattekonto: all-or-nothing, the rows must sum to what the verifikat settles), or ONE outside row against SEVERAL verifikat (all-or-nothing; bank: the slices must sum to the transaction; skattekonto: the verifikat's open amounts on 1630 must sum exactly to the event, no allow_remainder). Several rows against several verifikat are UNSUPPORTED_PAIR_SHAPE, never silently reduced.
- A pair must close to the row's amount on the expected side (a single matching line, or the entry's lines on the account netting to it); a fee or rounding difference is PAIR_NOT_CLOSED here and needs a residual booking first.
- Skattekonto rows against a summarised verifikat never close: PAIR_NOT_CLOSED names both sums and the remainder. Repeat the pair with allow_remainder: true only when the verifikat really books those events; a dry run shows remainder_amount first. The link never changes unexplained_difference: the rows leave unmatched_external and the same amount leaves the verifikat.
- Skattekonto direction: a positive row is money into the skattekonto and needs a verifikat that debits the account, a negative row one that credits it. A row against a verifikat that books nothing on its side is WRONG_DIRECTION, with or without allow_remainder: link it to another verifikat, or book the row.
- ALREADY_LINKED on a skattekonto verifikat carries linked_external_ids, the rows that hold it. Such a row can be missing from the open lists (an upcoming row, or one dated after the fetched saldo): the verifikat then lists held_by_uncounted_rows in unmatched_ledger. Unlink the holder with DELETE .../links/{linkId} when its link is the wrong one.
- Links never touch the ledger, so they succeed in locked periods; unlink with DELETE .../links/{linkId} (linkId = the outside row id, or the settlement_id of a ledger-only pair).
- A ledger-only pair (no external_ids) is never proposed and never applied by use_proposals: two verifikat of opposite amounts are not necessarily a correction of each other, so name them explicitly. It books nothing: a verifikat that is wrong and has no correction yet still needs one.
- Idempotency-Key is required; repeating the same key replays the first response.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `accountKey` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  pairs?: { external_ids?: string[], journal_entry_ids: string[], allocations?: { journal_entry_id: string, amount: number }[], allow_remainder?: boolean }[],
  use_proposals?: boolean,
  confidence_threshold?: number
}
```

Example request:
```json
{
  "use_proposals": true,
  "confidence_threshold": 0.9
}
```

Response `200`:
```ts
{
  data: {
    dry_run: boolean,
    considered: number,
    applied: { external_id: string, journal_entry_id: string, via?: "line" | "entry_total" | "lines" | "partial", allocated_amount?: number, remainder_amount?: number }[],
    settled: { settlement_id: string | null, account_number: string, entries: { journal_entry_id: string, voucher_series: string | null, voucher_number: number | null, entry_date: string, amount: number }[] }[],
    skipped: { pair: { external_ids?: string[], journal_entry_ids: string[], allocations?: { journal_entry_id: string, amount: number }[], allow_remainder?: boolean }, code: string, message: string, linked_external_ids?: string[] }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "dry_run": false,
    "considered": 2,
    "applied": [
      {
        "external_id": "33333333-3333-4333-8333-333333333333",
        "journal_entry_id": "44444444-4444-4444-8444-444444444444",
        "via": "line"
      }
    ],
    "settled": [],
    "skipped": [
      {
        "pair": {
          "external_ids": [
            "55555555-5555-4555-8555-555555555555"
          ],
          "journal_entry_ids": [
            "66666666-6666-4666-8666-666666666666"
          ]
        },
        "code": "ALREADY_LINKED",
        "message": "Verifikatet är redan kopplat till en annan skattekonto-transaktion."
      }
    ]
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `DELETE /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}/links/{linkId}`

**Remove a link between an outside row and a verifikat.**
`scope:reconciliation:write · risk:low · idempotent · dry-run · reversible`

Clears the link on one outside row (bank transaction or skattekonto row). The verifikat is never edited or deleted (BFL); only the row's pointer is cleared, so the pair returns to the open buckets and proposals are recomputed on the next sync. Allowed in locked periods. ?dry_run=true reports what would be unlinked.

**Use when:** A link was wrong (a bulk proposal apply that paired the wrong verifikat, a manual mistake).
**Do not use for:** Undoing a booking: a residual or categorization booking is reversed through the journal-entry reverse endpoint, not by unlinking.

**Pitfalls:**
- linkId is the outside row id, not a separate link entity. The one exception: verifikat settled against each other (on a bank account a pair without external_ids; on the skattekonto the rest of a 1:N link) are undone with their settlement_id, which the items endpoint reports as settlement.settlement_id; the response then carries settlement_id and journal_entry_ids, and previous_journal_entry_id is null. Unlinking a skattekonto row that a 1:N link spread over several verifikat undoes its settlement too.
- Unlinking a row whose verifikat was stornoed is the expected fix for a link_problem = entry_reversed item; the row then shows under unmatched_external again.
- A bank row booked from itself (categorize, match-invoice, a direct booking) has no link to remove: its verifikat is its booking. Such a row lists no unmatch action, and DELETE answers 409 RECONCILIATION_UNLINK_IS_BOOKING; reverse the verifikat (POST /journal-entries/{id}/reverse) instead. A row with no link answers 409 RECONCILIATION_NOT_LINKED, an unknown id 404 NOT_FOUND.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `accountKey` | path | `string` | yes |  |
| `linkId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Response `200`:
```ts
{
  data: {
    external_id: string,
    previous_journal_entry_id: string | null,
    settlement_id?: string,
    journal_entry_ids?: string[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "external_id": "33333333-3333-4333-8333-333333333333",
    "previous_journal_entry_id": "44444444-4444-4444-8444-444444444444"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}/residual`

**Book the remainder of a bank selection as a fee/interest/rounding verifikat and link the selection.**
`scope:transactions:write · risk:medium · idempotent · dry-run`

Body: { external_ids: [transaction ids], journal_entry_id, kind: "bank_fee" | "interest_expense" | "interest_income" | "rounding", entry_date?, description? }. Computes the difference between the transactions' sum and the verifikat's net on the bank account, books it on 6570 / 8410 / 8310 / 3740 against the bank account (dated on the latest transaction by default), links the transactions to the main verifikat and anchors the residual verifikat through transaction_voucher_links. Bank accounts only (bank:<cash_account_id>). Refused when the difference is 0 (RESIDUAL_ZERO), above 5000 kr (RESIDUAL_TOO_LARGE: that is a missing booking, not a fee), or when the kind points the wrong way (RESIDUAL_DIRECTION). ?dry_run=true returns would_book without writing.

**Use when:** A manual match misses by a small amount that is genuinely a bank fee, interest or rounding, and you want to close it in one step instead of booking a verifikat and then linking.
**Do not use for:** Skattekonto rows (Skatteverket posts ränta and avgifter as their own rows: link them), or differences that are really a missing booking (book that properly).

**Pitfalls:**
- The kind must match the direction: money that left the bank unbooked is bank_fee / interest_expense; money that arrived unbooked is interest_income; rounding works either way.
- Links are made before the booking and undone if the booking is refused (a locked period), so a refusal leaves nothing half done.
- Idempotency-Key is required; repeating the same key replays the first response.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `accountKey` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  external_ids: string[],
  journal_entry_id: string,
  kind: "bank_fee" | "rounding" | "interest_income" | "interest_expense",
  entry_date?: string,
  description?: string
}
```

Example request:
```json
{
  "external_ids": [
    "22222222-2222-4222-8222-222222222222"
  ],
  "journal_entry_id": "44444444-4444-4444-8444-444444444444",
  "kind": "bank_fee"
}
```

Response `200`:
```ts
{
  data: {
    dry_run: boolean,
    residual_journal_entry_id?: string,
    residual_amount?: number,
    applied?: { external_id: string, journal_entry_id: string }[],
    skipped?: { code: string, message: string }[],
    would_book?: { kind: string, counter_account: string, ledger_account: string, currency: string, transactions_total: number, entry_net: number, residual_amount: number, entry_date: string, description: string, lines: { account_number: string, debit_amount: number, credit_amount: number }[] }
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "dry_run": false,
    "residual_journal_entry_id": "55555555-5555-4555-8555-555555555555",
    "residual_amount": -10,
    "applied": [
      {
        "external_id": "22222222-2222-4222-8222-222222222222",
        "journal_entry_id": "44444444-4444-4444-8444-444444444444"
      }
    ],
    "skipped": []
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}/signoff`

**Sign-off history for one reconcilable account.**
`scope:reconciliation:read · risk:low · idempotent · reversible`

Every "avstämt t.o.m." sign-off on the account, newest first. Active ones by default; ?include_reopened=true adds the reopened (undone) ones with their reopen stamp. The latest active sign-off also rides along on GET .../accounts/{accountKey} as `signoff`.

**Use when:** You need the attestation trail (who signed what through which date) for an account, e.g. for a close checklist or an audit question.
**Do not use for:** Deciding whether the account is reconciled today: read unexplained_difference on the account status for that.

**Pitfalls:**
- A sign-off is an assertion made at a point in time; rows or links added later can make the live bridge differ from the signed numbers. Compare signoff.unexplained_difference with the current status when that matters.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `accountKey` | path | `string` | yes |  |
| `limit` | query | `number` | no | Maximum number of sign-offs, at most 200 (default 50). |
| `include_reopened` | query | `string` | no | true or 1 also returns reopened (undone) sign-offs with their reopen stamp. Default: active only. |

Response `200`:
```ts
{
  data: {
    signoffs: { id: string, handle?: string, account_key: string, through_date: string, external_balance: number | null, ledger_balance: number | null, unexplained_difference: number | null, note: string | null, signed_by: string, signed_at: string, reopened_at: string | null, reopened_by: string | null, reopen_reason: string | null }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "signoffs": [
      {
        "id": "77777777-7777-4777-8777-777777777777",
        "account_key": "skattekonto",
        "through_date": "2026-07-31",
        "external_balance": 12450,
        "ledger_balance": 12450,
        "unexplained_difference": 0,
        "note": null,
        "signed_by": "88888888-8888-4888-8888-888888888888",
        "signed_at": "2026-08-03T09:12:00Z",
        "reopened_at": null,
        "reopened_by": null,
        "reopen_reason": null
      }
    ]
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}/signoff`

**Mark an account reconciled through a date (sign-off).**
`scope:reconciliation:signoff · risk:medium · idempotent · dry-run · reversible`

Body: { through_date: "YYYY-MM-DD", note?, force?, external_balance? }. Recomputes the bridge through the date and refuses unless unexplained_difference is zero; with force: true and a note it signs anyway and records the difference. Refuses dates in the future, dates past the skattekonto snapshot (NOT_FETCHED_THROUGH), and dates at or before an existing active sign-off (ALREADY_SIGNED_OFF: reopen that one first). For a manual:NNNN account without a system specification (anything but 1510/2440/2920/2940), external_balance is the balance per the signer's underlag in ledger sign (liabilities negative); the difference against the booked balance is recorded, and a non-zero one still needs force + note. A bank:<id> account without a bank connection (a card or cash account kept by hand or from files) takes the statement's balance at the end of through_date the same way: it is judged against the booked balance that day (ledger_balance) instead of the bridge, and refused on an account kept in another currency than the books. On a bank account with a bank connection, the skattekonto and specification accounts external_balance is refused (EXTERNAL_BALANCE_NOT_ALLOWED). ?dry_run=true returns would_sign without writing. Undo with POST .../signoff/{signoffId}/reopen.

**Use when:** The month (or period) is explained and you want the account marked as reconciled through its last day, as a human would in the Avstämning page.
**Do not use for:** Linking rows or booking anything: a sign-off changes no data in the ledger. Use .../links and the booking endpoints first.

**Pitfalls:**
- Refusal codes come back as VALIDATION_ERROR with details.code: INVALID_DATE, DATE_IN_FUTURE, NOT_FETCHED_THROUGH, OUTSIDE_UNKNOWN, NOT_RECONCILED, NOTE_REQUIRED, EXTERNAL_BALANCE_NOT_ALLOWED; ALREADY_SIGNED_OFF and SIGNOFF_RACE come back as CONFLICT.
- force: true without a note is NOTE_REQUIRED: the note is what the next reader sees next to the non-zero difference.
- Idempotency-Key is required; repeating the same key replays the first response.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `accountKey` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ through_date: string, note?: string | null, force?: boolean, external_balance?: number | null }
```

Example request:
```json
{
  "through_date": "2026-07-31"
}
```

Response `200`:
```ts
{
  data: {
    dry_run: boolean,
    signoff?: { id: string, handle?: string, account_key: string, through_date: string, external_balance: number | null, ledger_balance: number | null, unexplained_difference: number | null, note: string | null, signed_by: string, signed_at: string, reopened_at: string | null, reopened_by: string | null, reopen_reason: string | null },
    bank_balance?: { as_of: string, bank_balance: number | null, booked_balance: number | null, difference: number | null, unbooked: { count: number, total: number } | null, before_history: { history_start: string, difference: number } | null, rest: number | null } | null,
    warning?: { code: "BANK_BALANCE_DIFFERS" | "NO_BANK_BALANCE", message: string } | null,
    would_sign?: { account_key: string, through_date: string, external_balance: number | null, ledger_balance: number | null, unexplained_difference: number | null, is_reconciled: boolean, forced: boolean, previous_through_date: string | null, bank_balance: { as_of: string, bank_balance: number | null, booked_balance: number | null, difference: number | null, unbooked: { count: number, total: number } | null, before_history: { history_start: string, difference: number } | null, rest: number | null } | null, warning: { code: "BANK_BALANCE_DIFFERS" | "NO_BANK_BALANCE", message: string } | null }
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "dry_run": false,
    "signoff": {
      "id": "77777777-7777-4777-8777-777777777777",
      "account_key": "skattekonto",
      "through_date": "2026-07-31",
      "external_balance": 12450,
      "ledger_balance": 12450,
      "unexplained_difference": 0,
      "note": null,
      "signed_by": "88888888-8888-4888-8888-888888888888",
      "signed_at": "2026-08-03T09:12:00Z",
      "reopened_at": null,
      "reopened_by": null,
      "reopen_reason": null
    },
    "bank_balance": null,
    "warning": null
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}/signoff/{signoffId}/reopen`

**Reopen (undo) a reconciliation sign-off.**
`scope:reconciliation:signoff · risk:low · idempotent · dry-run · reversible`

Body: { reason? }. Stamps the sign-off reopened_at/by/reason; nothing is deleted and the ledger is untouched. After this the account can be signed off again for the same or an earlier date. A sign-off that is already reopened is ALREADY_REOPENED (CONFLICT).

**Use when:** A signed-off period turns out to need more work (a late bank row, a corrected verifikat) and the attestation must be withdrawn before it is redone.
**Do not use for:** Removing a link or un-booking anything: those are separate operations; reopening only withdraws the attestation.

**Pitfalls:**
- Reopening is recorded, not erased: the history endpoint (?include_reopened=true) keeps showing the row with its reopen stamp.
- Idempotency-Key is required; repeating the same key replays the first response.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `accountKey` | path | `string` | yes |  |
| `signoffId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ reason?: string | null }
```

Example request:
```json
{
  "reason": "Sen bankrad 31 juli kom in 3 augusti."
}
```

Response `200`:
```ts
{
  data: {
    signoff: { id: string, handle?: string, account_key: string, through_date: string, external_balance: number | null, ledger_balance: number | null, unexplained_difference: number | null, note: string | null, signed_by: string, signed_at: string, reopened_at: string | null, reopened_by: string | null, reopen_reason: string | null }
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "signoff": {
      "id": "77777777-7777-4777-8777-777777777777",
      "account_key": "skattekonto",
      "through_date": "2026-07-31",
      "external_balance": 12450,
      "ledger_balance": 12450,
      "unexplained_difference": 0,
      "note": null,
      "signed_by": "88888888-8888-4888-8888-888888888888",
      "signed_at": "2026-08-03T09:12:00Z",
      "reopened_at": "2026-08-04T07:30:00Z",
      "reopened_by": "88888888-8888-4888-8888-888888888888",
      "reopen_reason": "Sen bankrad 31 juli kom in 3 augusti."
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/reconciliation/bank/run`

**Run the bank-reconciliation matcher.**
`scope:transactions:write · risk:medium · idempotent · dry-run`

Walks all unbooked bank transactions in the requested date range and pairs them with open GL lines (1930-side) by amount + date proximity. Applies confirmed matches by setting transactions.journal_entry_id (the GL row already exists). Dry-runnable.

**Use when:** You want to auto-match outstanding bank transactions against existing journal entries: typically as the closing step of a sync. Dry-run first to inspect proposed matches.
**Do not use for:** Creating new journal entries: this only links bank transactions to existing GL lines. Matching to invoices: use `:match-invoice` or `:match-supplier-invoice` for explicit invoice payments.

**Pitfalls:**
- date_from / date_to default to the company's full bank history if omitted. Specify a window for predictable performance.
- account_number defaults to 1930. Multi-account companies must pass the BAS code of the account they are reconciling (e.g. 1932 for a EUR account), or it silently reconciles 1930.
- Idempotency-Key is mandatory.
- Without confidence_threshold, a non-dry run applies EVERY match found, including fuzzy ones at confidence 0.75. Pass confidence_threshold (0.9 recommended, matching accounted_auto_match_period) for unattended runs, or dry-run first and review matches.confidence before applying. Matches below the threshold are returned but not applied (skipped_below_threshold counts them).
- The 366-day window bound only applies when BOTH date_from and date_to are set; a single-sided or absent window scans full history.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ date_from?: string, date_to?: string, account_number?: string, confidence_threshold?: number }
```

Example request:
```json
{
  "date_from": "2026-05-01",
  "date_to": "2026-05-31",
  "confidence_threshold": 0.9
}
```

Response `200`:
```ts
{
  data: {
    matches: { transaction_id: string, transaction_date: string, transaction_description: string | null, transaction_amount: number, journal_entry_id: string, voucher_number: number | null, voucher_series: string | null, entry_date: string, entry_description: string | null, method: string, confidence: number }[],
    applied: number,
    errors: number,
    skipped_below_threshold: number
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "matches": [],
    "applied": 0,
    "errors": 0,
    "skipped_below_threshold": 0
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reconciliation/bank/status`

**Bank-reconciliation health snapshot.**
`scope:transactions:read · risk:low · idempotent`

Returns matched / unmatched counts and the balance delta between the bank ledger and the GL for the requested window. Optional ?date_from / ?date_to (default: company history).

**Use when:** You're building a dashboard widget, an audit report, or a pre-close check that needs to know how many bank transactions are still unbooked.
**Do not use for:** Running the matcher: that's POST `/reconciliation/bank/run`. Per-transaction detail: use the transaction list with `?status=unbooked`.

**Pitfalls:**
- A non-zero difference is normal between sync runs (uncleared cheques, in-flight transfers). Investigate only if it persists across reconciliations.
- difference compares against gl_1930_period_movement (movement excl. opening balance), NOT gl_1930_balance. Do not display gl_1930_balance next to difference.
- is_reconciled means |difference| < 0.01 for the window, an aggregate check, not a per-transaction guarantee.
- Judge health on unexplained_difference, NOT on difference. difference is just the gap between the two sides and is expected to be large mid-year; it is fully explained while every krona of it sits in unmatched_transaction_total, unmatched_gl_line_total or settled_gl_line_total. A non-zero unexplained_difference is the real finding: a matched pair disagreeing in amount, a voucher with several lines on the account, or a storno/correction line the candidate list hides.
- Ignored transactions are excluded from bank_transaction_total and difference (they never get a ledger counterpart); their count and sum are reported separately.
- On a foreign-currency account gl_1930_balance and gl_1930_opening_balance are null when the opening balance is not known in that currency: it is booked in SEK, and the ledger before it does not say what it is in the currency (an imported first year, or history booked in SEK only). The account still reconciles on its movement: difference and is_reconciled do not use the opening balance.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `date_from` | query | `string` | no | YYYY-MM-DD. Window start (inclusive). Omit for no lower bound. |
| `date_to` | query | `string` | no | YYYY-MM-DD. Window end (inclusive). Omit for no upper bound. |
| `account_number` | query | `string` | no | Settlement account (4-digit BAS number of a bank account, e.g. 1932). Default: 1930. Any other number must belong to one of the company's cash accounts. |

Response `200`:
```ts
{
  data: {
    bank_transaction_total: number,
    ignored_transaction_total: number,
    ignored_transaction_count: number,
    gl_1930_balance: number | null,
    gl_1930_period_movement: number,
    gl_1930_opening_balance: number | null,
    gl_1930_correction_adjustment: number,
    difference: number,
    is_reconciled: boolean,
    matched_count: number,
    unmatched_transaction_count: number,
    unmatched_transaction_total: number,
    unmatched_gl_line_count: number,
    unmatched_gl_line_total: number | null,
    settled_gl_entry_count: number,
    settled_gl_line_total: number,
    unexplained_difference: number | null,
    history_start: string | null,
    before_history_count: number,
    before_history_total: number,
    ledger_balance_before_start: number | null,
    saldo_at_start: number | null,
    opening_difference: number | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "bank_transaction_total": 48150,
    "ignored_transaction_total": 0,
    "ignored_transaction_count": 0,
    "gl_1930_balance": 98150,
    "gl_1930_period_movement": 48150,
    "gl_1930_opening_balance": 50000,
    "gl_1930_correction_adjustment": 0,
    "difference": 0,
    "is_reconciled": true,
    "matched_count": 142,
    "unmatched_transaction_count": 3,
    "unmatched_transaction_total": 1250,
    "unmatched_gl_line_count": 2,
    "unmatched_gl_line_total": 1250,
    "settled_gl_entry_count": 0,
    "settled_gl_line_total": 0,
    "unexplained_difference": 0
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/transactions`

**List transactions for a company.**
`scope:transactions:read · risk:low · idempotent`

Cursor-paginated transaction list ordered by created_at DESC, id ASC (newest-imported first; the `date` column is the transaction date and is filterable but not the sort key). Filter by ?status=booked|unbooked, ?currency, ?date_from / ?date_to, ?search (description or merchant name, case-insensitive), ?cash_account_id.

**Use when:** You need to walk a company's bank ledger: building a categorization queue, reconciling against external statements, or sampling for audit.
**Do not use for:** Looking up one transaction by id (use the detail endpoint). Reconciliation status (use /reconciliation/bank/status).

**Pitfalls:**
- Default page size is 50. Pass ?limit=100 for the maximum. Cursor pagination: pass ?cursor=<next_cursor> from the previous response.
- Filter on status rather than journal_entry_id: a bulk-booked, split or batch-allocated transaction is booked with journal_entry_id null. status=unbooked leaves out ignored and private rows; without status every row is listed. is_business / category live on the transaction row even before booking.
- reverse-charge or storno entries can leave a transaction with journal_entry_id pointing at a cancelled JE: check status on the JE separately.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `status` | query | `"booked" \| "unbooked"` | no | booked: anchored to a verifikat (journal_entry_id, a bulk booking or split, or a batch allocation). unbooked: the work queue, not ignored, not private and anchored to no verifikat. Default: every row. |
| `currency` | query | `string` | no | Only transactions in this currency code (e.g. SEK). |
| `date_from` | query | `string` | no | YYYY-MM-DD. Transactions dated on or after this date. |
| `date_to` | query | `string` | no | YYYY-MM-DD. Transactions dated on or before this date. |
| `search` | query | `string` | no | Case-insensitive match anywhere in the description or merchant name, 1-200 characters. |
| `cash_account_id` | query | `string` | no | Only transactions on this bank account (id from GET /cash-accounts). |
| `cursor` | query | `string` | no | Opaque cursor from the previous page's meta.next_cursor. Omit for the first page. |
| `limit` | query | `number` | no | Page size, 1-100 (default 50). Larger values are clamped to 100. |

Response `200`:
```ts
{
  data: { id: string, handle?: string, date: string, description: string | null, amount: number, currency: string, reference: string | null, merchant_name: string | null, journal_entry_id: string | null, invoice_id: string | null, supplier_invoice_id: string | null, is_business: boolean | null, category: string | null, import_source: string | null, cash_account_id: string | null, created_at: string, pending_operation_id: string | null }[],
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": [
    {
      "id": "a8f1…",
      "date": "2026-05-12",
      "description": "ICA MAXI",
      "amount": -349.5,
      "currency": "SEK",
      "merchant_name": "ICA MAXI",
      "journal_entry_id": null,
      "is_business": null,
      "category": null
    }
  ],
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12",
    "next_cursor": null
  }
}
```

---

### `GET /api/v1/companies/{companyId}/transactions/{id}`

**Retrieve a single transaction by id.**
`scope:transactions:read · risk:low · idempotent`

Returns the full transaction record including match state, booking state, and import metadata.

**Use when:** You have a transaction id (from the list or a webhook) and need the full record before deciding to categorize, match, or attach a document.
**Do not use for:** Walking the ledger: use the list endpoint with a cursor. Fetching the linked invoice/journal entry: separate endpoints.

**Pitfalls:**
- Both invoice_id (matched) and potential_invoice_id (suggested) can be set independently. The matched id is authoritative for accounting.
- reconciliation_method is null for transactions that have never been auto-reconciled. journal_entry_id may still be set via manual categorize.
- parts is the Bankgirot split of an Open Payments row (one part per payer or payee with the suggested invoice). With potential_match_method "bankgiro_split" every part resolved: settle them in one call with POST .../transactions/{id}/match-batch, one allocation per part (kind, the suggested invoice id, the part amount).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    id: string,
    handle?: string,
    date: string,
    value_date?: string | null,
    description: string | null,
    original_description?: string | null,
    amount: number,
    currency: string,
    amount_sek: number | null,
    reference: string | null,
    merchant_name: string | null,
    counterparty_account: string | null,
    counterparty_iban?: string | null,
    counterparty_org_number?: string | null,
    instructed_amount?: number | null,
    instructed_currency?: string | null,
    balance_after?: number | null,
    is_enriched?: boolean | null,
    journal_entry_id: string | null,
    invoice_id: string | null,
    supplier_invoice_id: string | null,
    potential_invoice_id: string | null,
    potential_supplier_invoice_id?: string | null,
    potential_journal_entry_id?: string | null,
    potential_match_confidence?: number | null,
    exchange_rate?: number | null,
    exchange_rate_date?: string | null,
    transaction_method?: string | null,
    title_edited_at?: string | null,
    is_business: boolean | null,
    category: string | null,
    receipt_id: string | null,
    document_id: string | null,
    external_id: string | null,
    provider_transaction_id?: string | null,
    end_to_end_id?: string | null,
    import_source: string | null,
    reconciliation_method: string | null,
    cash_account_id: string | null,
    potential_match_method?: string | null,
    parts?: { part_id: string, seq: number, amount: number, currency: string, counterparty_name: string | null, counterparty_org_number: string | null, counterparty_account: string | null, reference: string | null, invoice_numbers: string[], message: string | null, suggestion_reason: "ocr_exact" | "invoice_number" | "amount_only" | null, suggested_invoice: { kind: "customer_invoice" | "supplier_invoice", invoice_id: string, invoice_number: string | null, counterparty_name: string | null, remaining_amount: number, currency: string } | null }[],
    created_at: string,
    updated_at: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "a8f1…",
    "date": "2026-05-12",
    "amount": -349.5,
    "currency": "SEK",
    "journal_entry_id": null,
    "is_business": null
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/transactions/{id}`

**Edit an unbooked transaction: its working title, or which bank account it belongs to.**
`scope:transactions:write · risk:low · idempotent · dry-run · reversible`

description replaces the working title (the bank's original stays in original_description; sending it back restores the "not edited" state). account_number (a BAS 19xx account of one of the company's cash accounts, as a string) moves the row to that account, for rows that landed on the wrong account or on none; a disabled, unconnected target is turned back on. Only rows that are neither booked nor matched. Idempotent. Dry-runnable.

**Use when:** A bank label is cryptic and the user wants a readable title before booking, or a row sits under the wrong bank account and can never be reconciled there.
**Do not use for:** Booked rows (reverse the verifikat and rebook), changing the amount or date (bank data is never edited), or categorizing (POST /transactions/{id}/categorize).

**Pitfalls:**
- Send at least one of description or account_number.
- A booked or matched row returns 409 TRANSACTION_TITLE_LOCKED (title) or TRANSACTION_MOVE_BOOKED (move); a row bulk-booked into a samlingsverifikat also returns TRANSACTION_MOVE_BOOKED for a move.
- account_number is a STRING like "1931", never a number; an account that is not one of the company's cash accounts returns 404 TRANSACTION_MOVE_UNKNOWN_ACCOUNT, one in another currency 400 TRANSACTION_MOVE_CURRENCY_MISMATCH.
- A row never moves between a bank account and a company card (400 TRANSACTION_MOVE_KIND_MISMATCH): a card stores purchases with the opposite sign of its statement; undo the import and import the file to the right account.
- A bank-feed row cannot move onto another bank account's cash account: 409 TRANSACTION_MOVE_OTHER_BANK_ACCOUNT names the account it was fetched from. To put a whole bank account on another ledger account, change it in the bank settings.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ description?: string, account_number?: string }
```

Example request:
```json
{
  "description": "Lunch med kund"
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    handle?: string,
    description: string | null,
    title_edited_at: string | null,
    cash_account_id: string | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "a8f1…",
    "description": "Lunch med kund",
    "title_edited_at": "2026-06-01T10:00:00Z",
    "cash_account_id": "7f3a…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `DELETE /api/v1/companies/{companyId}/transactions/{id}`

**Delete an unbooked transaction that was added by hand (e.g. a duplicate you created).**
`scope:transactions:write · risk:medium · idempotent · dry-run`

Hard-deletes one transaction the company created in Accounted (manual entry or POST /transactions/ingest). Bank-synced and bank-file rows are an external record of money that moved and are never deleted: ignore them (POST /transactions/{id}/ignore). A booked or matched row is räkenskapsinformation and is never deleted either: unlink it or reverse (storno) its verifikat. Idempotent. Dry-runnable.

**Use when:** A manually added or API-ingested row is a mistake or a duplicate and has not been booked.
**Do not use for:** Rows from the bank feed or a bank file (POST /transactions/{id}/ignore), booked rows (unlink, or reverse the verifikat), or undoing a whole bank file (POST /imports/bank/{id}/undo).

**Pitfalls:**
- A booked or matched row returns 409 TRANSACTION_DELETE_BOOKED.
- A bank-synced or file-imported row returns 409 TRANSACTION_DELETE_IMPORTED: ignore it instead.
- A row with payment match history returns 409 TRANSACTION_DELETE_HAS_AUDIT_TRAIL at commit (the history is append-only); the dry run cannot see it.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Response `200`:
```ts
{
  data: { transaction_id: string, deleted: true },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "transaction_id": "a8f1…",
    "deleted": true
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/transactions/{id}/attach-document`

**Pin a document (receipt, invoice) to a bank transaction as its underlag.**
`scope:transactions:write · risk:medium · idempotent · dry-run · reversible`

Pins the document to the transaction. On an unbooked transaction the pin rides along when it is categorized; on a booked one the document becomes the verifikat's underlag at once (BFL 5 kap 6 §). The inbox item the document came from is marked matched. A document sits on one transaction at a time: one that another unbooked transaction holds (its pin, or its inbox item matched there) moves here, and that transaction lets go of it (moved_from_transaction_ids). Attaching another document replaces the pin and is logged as a rättelse; on a booked transaction whose pin is already its verifikat's underlag, the pin stays and the document is added to that verifikat as one more underlag. Idempotent. Dry-runnable.

**Use when:** A receipt or invoice in the archive belongs to a bank transaction (same date, amount, counterparty).
**Do not use for:** Linking a document to a verifikat with no bank transaction (POST /documents/{id}/link) or uploading a file (POST /documents).

**Pitfalls:**
- A document that asks for more than the transaction paid AND names another seller, or that names its seller and whose money goes the other way (a purchase on money in, a refund or credit note on money out), returns 409 DOC_ROW_MISMATCH with both sides in details; send mismatch_reason when it belongs anyway (an invoice paid in parts, a statement covering several payments).
- A document already underlag of ANOTHER verifikat, or held by another transaction that is booked (details.held_by_transaction_id), returns 409 DOC_ATTACH_OTHER_VERIFIKAT: it is never taken off a booked transaction. Details name that verifikat (journal_entry_id) and the one the transaction is booked on (transaction_journal_entry_id, null while unbooked). When one document backs both, link a copy to the transaction's verifikat: POST /documents/{id}/link with copy: true.
- A dry run lists the transactions the document would leave in moves_from_transaction_ids. One invoice paid in several parts does not stay on two unbooked transactions: book them, then link a copy to the second verifikat.
- A pinned document linked to a verifikat other than the transaction's own booking is never replaced: 409 DOC_ATTACH_REPLACES_POSTED. On the transaction's own verifikat the new document is added beside it (preview adds_to_verifikat; answer previous_document_id null).
- On a booked transaction in a locked period the pin is saved but the verifikat link is refused: 409 DOC_ATTACH_PERIOD_LOCKED. Adding beside a pin in a locked period writes nothing: PERIOD_LOCKED, as does a document that would have moved from another transaction (it stays where it is). A dry run, and so staging, answers PERIOD_LOCKED in all three cases.
- Check date, amount and counterparty on both sides first: once the transaction is booked the link is immutable.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{ document_id: string, mismatch_reason?: string }
```

Example request:
```json
{
  "document_id": "4f1c…"
}
```

Response `200`:
```ts
{
  data: {
    transaction_id: string,
    document_id: string,
    previous_document_id: string | null,
    journal_entry_id: string | null,
    moved_from_transaction_ids: string[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "transaction_id": "1f2e…",
    "document_id": "4f1c…",
    "previous_document_id": null,
    "journal_entry_id": null,
    "moved_from_transaction_ids": []
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/transactions/{id}/categorize`

**Categorize a transaction and create the journal entry.**
`scope:transactions:write · risk:medium · idempotent · dry-run · reversible`

Resolves the BAS account mapping for the transaction (via category, booking template, or counterparty template), creates the corresponding verifikation, and updates the transaction with is_business / category / journal_entry_id. Idempotent on (transaction, key). Dry-runnable.

**Use when:** You're categorizing a bank transaction. Pass `is_business: true` plus either `category`, `template_id` (booking template), `counterparty_template_id`, or `account_override`. For private transactions, `is_business: false` is enough.
**Do not use for:** Matching a payment to an invoice: use `:match-invoice` or `:match-supplier-invoice`, on an unbooked transaction. Uncategorizing: `:uncategorize`.

**Pitfalls:**
- A bank line the ledger already books (a booked sibling transaction, or a voucher booking the same amount on the bank account such as a supplier invoice marked paid) is refused with 409 TRANSACTION_BOOK_POSSIBLE_DUPLICATE and the candidate in `details.candidate`: link the transaction to that verifikat instead. Only if it is a genuinely separate event, resend with `force: true` plus `expected_duplicate_journal_entry_id` (or `expected_duplicate_transaction_id`) echoing the candidate; a stale id returns TRANSACTION_BOOK_FORCE_CANDIDATE_MISMATCH.
- A plain 244x (supplier payment) or 151x (customer receipt) categorization that an open invoice covers is refused with 409 TX_CATEGORIZE_SUGGEST_SI_MATCH / TX_CATEGORIZE_SUGGEST_CI_MATCH: match the invoice via `:match-supplier-invoice` / `:match-invoice`, or pass `confirm_no_match: true` to keep the plain categorization.
- Already-categorized fast path: if the transaction already has a journal_entry_id, only flags get updated. The JE is immutable post-commit.
- account_override must exist and be active in the chart of accounts (else TX_CATEGORIZE_INVALID_ACCOUNT). It books the business side gross unless you also pass vat_treatment or vat_amount: the category default VAT is never carried onto an arbitrary account.
- vat_amount replaces the rate-based VAT line with the underlag's actual moms (e.g. dricks); it needs a rate-based treatment, else TX_CATEGORIZE_INVALID_VAT_AMOUNT.
- vat_treatment reverse_charge without reverse_charge_kind takes the box (20, 21 or 22) from the seller country on the row's underlag and the category; when they cannot tell it, 400 TX_CATEGORIZE_REVERSE_CHARGE_BOX_UNKNOWN (details.reason): send reverse_charge_kind. Never ruta 21 by default.
- A template_id or counterparty_template_id books its own reverse-charge box (its basis pair's, or the one its cost account reports itself): a reverse_charge_kind it does not book, or one beside a template that books no reverse-charge purchase, is refused with 400 VALIDATION_ERROR (details.field reverse_charge_kind, details.template_boxes). Send its box or none, or book by category.
- A booking one of the company's blocks (booking review rules, Bokföringsregler > Spärrar in the app) matches is never booked from a key: it is staged for a person and answered 202 with the pending operation (staged_because BOOKING_REVIEW_REQUIRED). Approving it is web-only. With template_id or counterparty_template_id it cannot be staged and is refused with 409 BOOKING_REVIEW_REQUIRED.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  is_business: boolean,
  category?: "income_services" | "income_products" | "income_other" | "expense_equipment" | "expense_software" | "expense_travel" | "expense_office" | "expense_marketing" | "expense_professional_services" | "expense_education" | "expense_representation" | "expense_consumables" | "expense_vehicle" | "expense_telecom" | "expense_bank_fees" | "expense_card_fees" | "expense_currency_exchange" | "expense_other" | "private" | "uncategorized",
  template_id?: string,
  vat_treatment?: "standard_25" | "reduced_12" | "reduced_6" | "reverse_charge" | "export" | "exempt",
  reverse_charge_kind?: "eu_goods" | "eu_services" | "non_eu_services",
  vat_amount?: number,
  account_override?: string,
  counterparty_template_id?: string,
  dimensions?: Record<string, string>,
  user_description?: string,
  inbox_item_id?: string,
  proposal_id?: string,
  confirm_no_match?: boolean,
  confirm_foreign_seller_vat?: boolean,
  force?: boolean,
  expected_duplicate_transaction_id?: string,
  expected_duplicate_journal_entry_id?: string
}
```

Example request:
```json
{
  "is_business": true,
  "category": "expense_office"
}
```

Response `200`:
```ts
{
  data: {
    success: boolean,
    journal_entry_created: boolean,
    journal_entry_id: string | null,
    journal_entry_error: string | null,
    document_link_warning?: string | null,
    category: string,
    already_had_journal_entry?: boolean
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "success": true,
    "journal_entry_created": true,
    "journal_entry_id": "je_…",
    "category": "expense_office"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/transactions/{id}/detach-document`

**Take the pinned document off a bank transaction that is not booked against it.**
`scope:transactions:write · risk:low · idempotent · dry-run · reversible`

Clears the transaction's document pin and releases the inbox item matched to it, so the next booking does not anchor the detached document. Refused once the document is linked to a verifikat (BFL 5 kap 6 §): only a storno undoes that. A transaction with no document answers success. Answers detached_document_id. Idempotent. Dry-runnable.

**Use when:** The wrong receipt was attached to a transaction that is not yet booked.
**Do not use for:** A booked transaction (reverse or uncategorize it first), deleting the document (DELETE /documents/{id}) or releasing an inbox item's match (POST /inbox-items/{id}/unmatch-transaction).

**Pitfalls:**
- A document linked to a verifikat returns 409 DOC_DETACH_POSTED.
- A concurrent attach wins: the detach then answers 409 DOC_DETACH_CONCURRENT and changes nothing.
- The document itself stays in the archive.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Response `200`:
```ts
{
  data: { transaction_id: string, document_id: unknown, detached_document_id: string | null },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "transaction_id": "1f2e…",
    "document_id": null,
    "detached_document_id": "4f1c…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/transactions/{id}/ignore`

**Ignore a bank transaction (no verifikat, allowed in locked periods).**
`scope:transactions:write · risk:low · idempotent · dry-run · reversible`

Marks an unbooked bank transaction as ignored so it leaves the "to book" funnels and the reconciliation unmatched totals without creating a verifikat. Nothing is deleted and the flag is reversible with DELETE on the same path. Because no booking is written, a locked or closed fiscal period does not block it: this is the path for clearing rows that are not business events out of a closed period. A booked transaction (directly, via a payment allocation, or via a voucher link) is refused with 409 TX_IGNORE_ALREADY_BOOKED. Idempotent: ignoring an already-ignored row returns already_ignored: true. Dry-runnable.

**Use when:** The row is not an affärshändelse: a PSD2 ghost row, a duplicate from a bank reconnect, a transfer that never executed, rounding noise. Also the answer to TX_CATEGORIZE_PRIVATE_PERIOD_LOCKED from /categorize when the row should not be booked at all.
**Do not use for:** Real purchases, payments or owner withdrawals: those must be booked (categorize, match-invoice, or is_business: false in an open period). Ignoring is triage, not bookkeeping.

**Pitfalls:**
- Idempotency-Key is mandatory.
- A booked row cannot be ignored: reverse it first (POST /transactions/{id}/uncategorize) or unlink the payment/voucher.
- Ignored rows still exist and are listed on the reconciliation bridge's ignored line; they never disappear silently.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Response `200`:
```ts
{
  data: { success: boolean, transaction_id: string, is_ignored: true, already_ignored: boolean },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "success": true,
    "transaction_id": "tx_…",
    "is_ignored": true,
    "already_ignored": false
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `DELETE /api/v1/companies/{companyId}/transactions/{id}/ignore`

**Restore an ignored bank transaction to the "to book" list.**
`scope:transactions:write · risk:low · idempotent · dry-run · reversible`

Clears the ignore flag set by POST on the same path. The row comes back into the unbooked list and the reconciliation unmatched totals; no verifikat was ever written, so there is nothing to reverse. Idempotent: restoring a row that is not ignored returns was_ignored: false. Dry-runnable.

**Use when:** A row was ignored by mistake and should be booked after all.
**Do not use for:** Undoing a booking: that is a storno via POST /transactions/{id}/uncategorize.

**Pitfalls:**
- Idempotency-Key is mandatory.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Response `200`:
```ts
{
  data: { success: boolean, transaction_id: string, is_ignored: false, was_ignored: boolean },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "success": true,
    "transaction_id": "tx_…",
    "is_ignored": false,
    "was_ignored": true
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/transactions/{id}/link-journal-entry`

**Link a bank transaction to a verifikat that already books it (no new bookkeeping).**
`scope:transactions:write · risk:medium · idempotent · dry-run`

Anchors the row to an existing POSTED journal entry: the row counts as booked and leaves the to-book list, and nothing new is posted. With invoice_id the customer invoice is also settled against that same verifikat (an invoice_payments row, status paid or partially_paid), same currency only. A dry run answers the result the link would produce. Idempotent. Dry-runnable.

**Use when:** The affärshändelse was already booked by hand (a manual verifikat, a payment registered before the bank row arrived) and the bank row must point at it instead of being booked twice.
**Do not use for:** Booking the row (POST /transactions/{id}/categorize), matching it to an invoice with a new payment verifikat (POST /transactions/{id}/match-invoice), or one row against several vouchers (reconciliation links).

**Pitfalls:**
- A row already linked to a posted verifikat returns 409 LINK_TX_TX_ALREADY_LINKED; a pointer left by a storno does not count.
- The verifikat must be posted: LINK_TX_JE_NOT_POSTED otherwise.
- invoice_id: the invoice must be open (sent, overdue, partially_paid), not a credit note, and in the transaction currency (LINK_TX_INVOICE_CURRENCY_MISMATCH); cross-currency payments go through match-invoice.
- invoice_id: a row larger than what the invoice still owes returns 400 MATCH_AMOUNT_EXCEEDS_REMAINING, on a dry run too: nothing is written.
- invoice_id: the verifikat must settle the invoice on its own side (LINK_TX_INVOICE_SETTLEMENT_SIDE): a 151x credit for a booked invoice, including a kontantmetod invoice carried over the year end, a 19xx debit for a kontantmetod invoice never booked.
- Faktureringsmetoden with defer_invoice_booking (Registrera men bokför inte): when the invoice was sent without its verifikat and the linked verifikat clears 151x, the invoices :book step books the sale first (dated on the invoice date); sale_journal_entry_id names it and the dry run returns it as sale_entry. A verifikat that books the revenue itself (no 151x credit) is refused with LINK_TX_INVOICE_SETTLEMENT_SIDE before any sale is planned. When the book step refuses (PERIOD_LOCKED on the invoice date, INVOICE_BOOK_NO_FISCAL_PERIOD, INVOICE_BOOK_INVALID_STATUS for a partially paid invoice), the link is refused with that code, details.sale_first is true, and nothing is written.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{ journal_entry_id: string, invoice_id?: string }
```

Example request:
```json
{
  "journal_entry_id": "4d2a…"
}
```

Response `200`:
```ts
{
  data: {
    transaction_id: string,
    journal_entry_id: string,
    voucher_label: string,
    invoice_id: string | null,
    invoice_status: "paid" | "partially_paid" | null,
    paid_amount: number | null,
    remaining_amount: number | null,
    sale_journal_entry_id?: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "transaction_id": "a8f1…",
    "journal_entry_id": "4d2a…",
    "voucher_label": "A-12",
    "invoice_id": null,
    "invoice_status": null,
    "paid_amount": null,
    "remaining_amount": null
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/transactions/{id}/match-batch`

**Book one bank payment against several customer invoices, or several supplier invoices, in one verifikat.**
`scope:transactions:write · risk:high · idempotent · dry-run`

Allocates the transaction across N invoices of one kind: one samlingsverifikation (bank against 1510 or 2440, kursdifferens on 3960/7960 for foreign invoices, öresavrundning on 3740, a payment service's fees on their own cost lines) and one payment row per invoice, atomically. The allocations, less the fees for customer invoices or plus the fees for supplier invoices, must sum to the transaction amount. The dry run answers the exact lines (expected_lines) the verifikat would carry. Idempotent. Dry-runnable.

**Use when:** One incoming payment covers several customer invoices, or one outgoing transfer pays several supplier invoices.
**Do not use for:** One invoice (POST /transactions/{id}/match-invoice or match-supplier-invoice), mixing customer and supplier invoices, or several supplier invoices never booked under kontantmetoden.

**Pitfalls:**
- A bank row in a foreign currency returns 400 BATCH_FOREIGN_CURRENCY: the verifikat is in kronor and this door does not read the row's SEK. Match it to one invoice at a time (match-invoice, match-supplier-invoice). A SEK row against foreign invoices works: state each allocation in kronor, within 10 % of what the invoice is booked at (BATCH_FX_DEVIATION_TOO_LARGE).
- The allocation amounts must sum to |amount| of the transaction: BATCH_AMOUNT_EXCEEDS_TX / BATCH_AMOUNT_BELOW_TX otherwise.
- fees books a payment service's fee on the row: a payout net of Stripe's or a card acquirer's fee (customer invoices: allocations - fees = |amount|) or a bank's charge added to a payment (supplier invoices: allocations + fees = |amount|). Each invoice is allocated what it owed. At most 5 rows, each a debit on an active BAS class 6 account (6570 Bankkostnader, 6040 Kontokortsavgifter) with no VAT, since a payment service is exempt (ML 10 kap. 33 §): BATCH_FEE_ACCOUNT_INVALID otherwise. The fees must be smaller than the invoices (BATCH_FEE_TOO_LARGE). A platform's commission is a taxable service, not a fee row: book it from the platform's invoice.
- supplier_debts books the part of a supplier payment that pays invoices registered before the company kept its books here (a SIE import carries the 2440 balance, not the invoices): a debit on an active 244x account (2440 Leverantörsskulder), no VAT, since the moms was booked with the invoice. Supplier invoices only (BATCH_DEBT_SUPPLIER_ONLY); allocations + fees + supplier_debts = |amount|. Not a fee: it may be larger than the invoices. At most 5 fee and debt rows together (BATCH_DEBT_INVALID); another account returns BATCH_DEBT_ACCOUNT_INVALID.
- customer_receivables is the customer side: the part of an incoming payment (a Bankgirot deposit that also pays invoices issued in the bookkeeping kept before, which a SIE import carries only as the 1510 balance) booked as a credit on an active 151x account (1510 Kundfordringar), no VAT. Customer invoices only (BATCH_RECEIVABLE_CUSTOMER_ONLY); allocations - fees + customer_receivables = |amount|. It may be larger than the invoices. At most 5 fee and receivable rows together (BATCH_RECEIVABLE_INVALID); another account returns BATCH_RECEIVABLE_ACCOUNT_INVALID. total_debts in the answer is these rows together.
- A row that posted vouchers already explain (each invoice marked paid by hand) returns 409 BATCH_TX_POSSIBLE_DUPLICATE with the vouchers: link the row to them instead. force=true needs expected_journal_entry_ids naming exactly that set.
- Kontantmetoden: unbooked SEK customer invoices paid in full book their revenue and moms here (all or none, BATCH_CASH_LINES_MIXED). One unbooked supplier invoice allocated the whole row (no fees) is booked as match-supplier-invoice books it: cost and moms at payment, its lines in the dry run. Others return 400 BATCH_CASH_METHOD_UNBOOKED_INVOICE.
- Faktureringsmetoden with defer_invoice_booking (Registrera men bokför inte): each supplier invoice registered without its verifikat is booked first by the supplier-invoices :book step (dated on its invoice date), then the samlingsverifikation clears its 2440; registration_journal_entry_ids names them and the dry run shows them as registration_entries. A refusal of the book step (PERIOD_LOCKED on an invoice date, SI_BOOK_NO_FISCAL_PERIOD, SI_ACCRUED_COST_PERIOD_LOCKED, SI_BOOK_INVALID_STATUS for a partially paid invoice) refuses the batch with that code and details.registration_first, before anything is booked.
- Faktureringsmetoden with defer_invoice_booking (Registrera men bokför inte): each customer invoice sent without its verifikat gets its sale booked first by the invoices :book step (dated on its invoice date), then the samlingsverifikation clears its 1510; sale_journal_entry_ids names them and the dry run shows them as sale_entries. A refusal of the book step (PERIOD_LOCKED on an invoice date, INVOICE_BOOK_NO_FISCAL_PERIOD, INVOICE_BOOK_INVALID_STATUS for a partially paid invoice) refuses the batch with that code and details.sale_first, before anything is booked.
- Proformas and quotes return 400 MATCH_INVOICE_NOT_INVOICE_TYPE.
- A supplier invoice with a payment the bank holds (Betala via banken) is not refused: the row may be that payment. The dry run's preview.bank_payments names each such order (payment_order_id, status, signed, requested_execution_date, amount) and preview.warnings says it, as the answer's meta.warnings does, each warning naming the order (payment_order_id) and the invoice (supplier_invoice_id): SI_SIGNED_BANK_PAYMENT when a payment that is signed or being signed still goes out on its date, so unless this row is that payment the supplier is paid twice (cancel the order first with POST /payment-orders/{id}/cancel, or match another row); SI_UNSIGNED_BANK_PAYMENT when it waits unsigned: it never executes, and the status sync asks the bank to cancel it once the invoice no longer needs paying; SI_BANK_PAYMENT_CHECK_FAILED when the orders could not be read. Both are part of the preview a Preview-Token pins: an order that moves (signed, cancelled, executed) between the dry run and a commit or staging that sends its Preview-Token answers 409 PREVIEW_STALE with the preview as it now stands.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  allocations: { kind: "customer_invoice", invoice_id: string, amount: number } | { kind: "supplier_invoice", supplier_invoice_id: string, amount: number }[],
  force?: boolean,
  expected_journal_entry_ids?: string[],
  fees?: { account: string, amount: number, description?: string }[],
  supplier_debts?: { account: string, amount: number, description?: string }[],
  customer_receivables?: { account: string, amount: number, description?: string }[]
}
```

Example request:
```json
{
  "allocations": [
    {
      "kind": "customer_invoice",
      "invoice_id": "2b1c…",
      "amount": 500
    },
    {
      "kind": "customer_invoice",
      "invoice_id": "3c2d…",
      "amount": 750
    }
  ]
}
```

Response `200`:
```ts
{
  data: {
    journal_entry_id: string,
    voucher_series: string,
    voucher_number: number,
    allocations: { kind: "customer_invoice" | "supplier_invoice", invoice_id?: string, supplier_invoice_id?: string, payment_id: string, status: "paid" | "partially_paid", paid_amount: number, remaining_amount: number, amount: number }[],
    total_allocated: number,
    leftover: number,
    total_fees?: number,
    total_debts?: number,
    registration_journal_entry_ids?: Record<string, string>,
    sale_journal_entry_ids?: Record<string, string>
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "journal_entry_id": "4d2a…",
    "voucher_series": "A",
    "voucher_number": 12,
    "allocations": [],
    "total_allocated": 1250,
    "leftover": 0
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/transactions/{id}/match-expense-payout`

**Book an outgoing bank transaction as the repayment of one person's expense claims.**
`scope:transactions:write · risk:medium · idempotent · dry-run`

Books the bank row as the payout of the given registered claims: Debit their liability account (2013 for an enskild firma owner's 2018), Credit the transaction's own cash account, dated the transaction date, and links the row to the verifikat in the same transaction, so it can never be booked twice. The claims' total must equal the outflow to the öre. Idempotent. Dry-runnable.

**Use when:** An unbooked SEK outflow is the transfer that paid an owner or employee back for their utlägg.
**Do not use for:** A transfer with no bank row in Accounted (POST /expense-claims/payouts), partial repayments, or salary.

**Pitfalls:**
- The sum of the picked claims must equal |amount| exactly: 400 EXPENSE_PAYOUT_MATCH_AMOUNT otherwise.
- Only unbooked outgoing SEK rows: incoming returns EXPENSE_PAYOUT_MATCH_NOT_EXPENSE, another currency EXPENSE_PAYOUT_MATCH_CURRENCY, an already booked row EXPENSE_PAYOUT_MATCH_TX_ALREADY_LINKED.
- All claims must belong to one person and one liability account.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{ claim_ids: string[] }
```

Example request:
```json
{
  "claim_ids": [
    "5a0a…",
    "7b1c…"
  ]
}
```

Response `200`:
```ts
{
  data: {
    batch_id: string,
    journal_entry_id: string,
    voucher_number: number | null,
    total_sek: number,
    claim_count: number,
    transaction_id: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "transaction_id": "1f2e…",
    "batch_id": "e1f0…",
    "journal_entry_id": "4d2a…",
    "voucher_number": 119,
    "total_sek": 1596,
    "claim_count": 2
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/transactions/{id}/match-invoice`

**Match a positive bank transaction to a customer invoice.**
`scope:transactions:write · risk:high · idempotent`

Confirms an invoice match for a transaction. Creates the payment journal entry, links the transaction, updates the invoice status (paid / partially_paid) and inserts into invoice_payments. A transaction that is already booked is refused, never reversed here. Idempotent.

**Use when:** You have a bank receipt and a known open invoice it pays. The transaction must be positive (income), unbooked and not ignored.
**Do not use for:** Categorizing a transaction without an invoice: use `:categorize`. Matching to a supplier invoice: use `:match-supplier-invoice`. Bulk auto-match: use `POST /reconciliation/bank/run`.

**Pitfalls:**
- Proforma + delivery notes are rejected (MATCH_INVOICE_NOT_INVOICE_TYPE): only document_type='invoice' can be matched.
- Transaction must be positive (amount > 0): negative transactions return MATCH_INVOICE_NOT_INCOME.
- Invoice must be in sent / overdue / partially_paid status: paid or draft invoices return MATCH_INVOICE_NOT_OPEN. An invoice with an active credit note returns MATCH_INVOICE_CREDIT_NOTE.
- A transaction that is already booked returns 409 MATCH_INVOICE_TX_ALREADY_BOOKED and nothing is written: its pointer or a bank_line link names a posted verifikat, it is linked to an existing verifikat, or a posted verifikat was booked from it without being linked to it. details names it (journal_entry_id, voucher, via: pointer, link, reconciliation, named for that last case, or concurrent when another booking took the transaction first) and says in undo how to open the transaction: uncategorize (POST /transactions/{id}/uncategorize), unlink (the reconciliation unlink: the verifikat stays posted) or reverse_voucher (a storno of the verifikat, which releases every transaction on it). On via named, when the verifikat is the booking of this transaction, link the two instead (POST /transactions/{id}/link-journal-entry). If the verifikat already is this payment, do not match: link the invoice to it (accounted_link_invoice_to_voucher, or the invoice page). Before 2026-11-01 this endpoint reversed a categorization without being asked and booked a second verifikat on a transaction booked through a voucher link.
- An ignored transaction returns 409 BANK_ROW_IGNORED: restore it first (DELETE /transactions/{id}/ignore).
- A failed read of the transaction returns 503 BANK_ROW_READ_FAILED: nothing was booked, retry the same request.
- Kontantmetoden: an invoice never booked at issue is matched only by one payment of its whole amount. A partial payment, or the final payment of an invoice already part-paid, returns INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED (details.reason partial_payment | previously_partially_paid); book that payment as a manual journal entry.
- Faktureringsmetoden with defer_invoice_booking (Registrera men bokför inte): an invoice sent without its verifikat is booked first by the invoices :book step (dated on the invoice date), then the payment clears that 1510; sale_journal_entry_id names it. When the book step refuses (PERIOD_LOCKED on the invoice date, INVOICE_BOOK_NO_FISCAL_PERIOD, INVOICE_BOOK_INVALID_STATUS for a partially paid invoice) or the transaction date is locked (PERIOD_LOCKED with details.payment_date), the match is refused with that code, details.sale_first is true, and nothing is booked.
- Idempotency-Key is mandatory.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{
  invoice_id: string,
  force?: boolean,
  expected_journal_entry_id?: string,
  lines?: { account_number: string, debit_amount?: number, credit_amount?: number, line_description?: string, dimensions?: Record<string, string> }[],
  manual_exchange_rate?: number
}
```

Example request:
```json
{
  "invoice_id": "inv_…"
}
```

Response `200`:
```ts
{
  data: {
    success: boolean,
    invoice_status: string,
    paid_at: string | null,
    paid_amount: number,
    remaining_amount: number,
    journal_entry_id: string | null,
    sale_journal_entry_id?: string,
    category: string | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "success": true,
    "invoice_status": "paid",
    "paid_amount": 12500,
    "remaining_amount": 0,
    "journal_entry_id": "je_…",
    "category": null
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/transactions/{id}/match-supplier-invoice`

**Match a negative bank transaction to a supplier invoice.**
`scope:transactions:write · risk:high · idempotent`

Confirms a supplier invoice payment match. Creates the payment journal entry (accrual: 2440 debit, credit on the transaction's own settlement account, 1930 when unlinked; cash-method: collapsed registration+payment), updates supplier_invoices, inserts a supplier_invoice_payments row, and links the transaction. Handles FX differences for cross-currency payments (7960 gain / 3960 loss), a bank fee paid on top of the invoice (6570) and öresavrundning on a whole-krona SEK payment (3740). Same payment plan and verifikat as the dashboard match.

**Use when:** You have a bank payment and a known open supplier invoice. The transaction must be negative (expense) and not yet booked.
**Do not use for:** Categorizing a direct supplier expense without an invoice: use `:categorize`. Matching to a customer invoice: use `:match-invoice`. Bulk auto-match: `POST /reconciliation/bank/run`.

**Pitfalls:**
- Cash-method companies can settle a foreign invoice in full (booked at the payment-date rate); only a PARTIAL cash-method payment across currencies is rejected (MATCH_SI_CASH_FX_UNSUPPORTED): pay in full, switch to accrual, or book manually.
- Öresavrundning (both accounting methods): a SEK bank row less than 1 kr off the remaining balance of a SEK invoice (a whole-krona payment of an öre total) settles it in full. The payment account is credited with the bank amount and the residual is booked on 3740 (no VAT); paid_amount records the debt settled, not the cash moved. A shortfall of 1 kr or more is a partial payment (on a never-booked cash-method invoice it returns SI_CASH_PARTIAL_UNSUPPORTED).
- Bank fee on top: a same-currency row that pays more than the remaining balance settles the invoice in full; 2440 is cleared by the remaining balance only and the excess (up to 5 000 kr) is booked on 6570 and returned as bank_fee_sek (0 when there is none, and always 0 with custom lines, which book what they say). paid_amount never exceeds the invoice total. Check bank_fee_sek: a large one usually means the row pays another invoice too.
- A same-currency excess above the fee cap returns 400 MATCH_SI_AMOUNT_EXCEEDS_REMAINING and books nothing: allocate the payment across several invoices with POST /transactions/{id}/match-batch. Like every refusal, it runs before a categorization is reversed with storno_existing. A cross-currency match is not capped: it settles the remaining balance and books the whole SEK difference as kursdifferens (7960/3960).
- Faktureringsmetoden with defer_invoice_booking (Registrera men bokför inte): a supplier invoice registered without its verifikat is booked first by the supplier-invoices :book step (Debit cost + 2641 / Credit 2440, dated on the invoice date), then the payment clears that 2440; registration_journal_entry_id names it (null when nothing was booked first). When the book step refuses (invoice date in a locked period PERIOD_LOCKED, no fiscal year SI_BOOK_NO_FISCAL_PERIOD, a locked accrual month SI_ACCRUED_COST_PERIOD_LOCKED, a partially paid invoice SI_BOOK_INVALID_STATUS), the match is refused with that code, details.registration_first is true, and nothing is booked or reversed.
- A transaction that is already booked is refused with 409 MATCH_SI_TX_ALREADY_BOOKED and nothing is written: its pointer or a bank_line link names a posted verifikat, it is linked to an existing verifikat, or a posted verifikat was booked from it without being linked to it. details names it (journal_entry_id, voucher, via: pointer, link, reconciliation, named for that last case, or concurrent when another booking took the transaction first). When details.storno_allowed is true the booking is the transaction's own categorization: resend with storno_existing: true to reverse it (storno) and book the payment, after every other check has passed. A samlingsverifikat, a split or a reconciliation link is never reversed here: unlink or correct it first. Before 2026-10-28 this endpoint reversed a categorization without being asked and re-pointed a reconciliation link.
- A failed read of the transaction returns 503 BANK_ROW_READ_FAILED: nothing was booked, retry the same request.
- A posted verifikat that already books this payment (same SEK amount on the transaction's settlement account within 7 days, linked to no other transaction, e.g. a payment booked by hand) is refused with 409 MATCH_SI_POSSIBLE_DUPLICATE and nothing is written; details.candidate names it. Link the supplier invoice to that verifikat instead (POST /supplier-invoices/{id}/link-to-voucher), or, when the transaction is a separate payment, resend with force: true and expected_journal_entry_id set to details.candidate.journal_entry_id (a fresh Idempotency-Key). A stale id returns 409 MATCH_SI_FORCE_CANDIDATE_MISMATCH.
- Transaction must be negative (amount < 0). Positive returns MATCH_SI_NOT_EXPENSE.
- Supplier invoice must NOT be paid/credited already. paid/credited returns MATCH_SI_ALREADY_PAID; registered/approved/partially_paid/overdue are matchable.
- A payment the bank holds for the invoice (Betala via banken) is not refused: this row may be that payment. The answer's meta.warnings says so, each warning naming the order (payment_order_id) and the invoice (supplier_invoice_id): SI_SIGNED_BANK_PAYMENT when a payment that is signed or being signed still goes out on its date, so unless this row is that payment the supplier is paid twice (cancel the order with POST /payment-orders/{id}/cancel, or match another row); SI_UNSIGNED_BANK_PAYMENT when it waits unsigned: it never executes, and the status sync asks the bank to cancel it once the invoice no longer needs paying; SI_BANK_PAYMENT_CHECK_FAILED when the orders could not be read. This endpoint has no dry run. For a SEK row that pays no more than the invoice owes, the dry run of POST /transactions/{id}/match-batch with that one supplier_invoice allocation answers the same warnings; that endpoint refuses a row in another currency (BATCH_FOREIGN_CURRENCY), and a row that pays more needs its fees row.
- Idempotency-Key is mandatory.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{
  supplier_invoice_id: string,
  lines?: { account_number: string, debit_amount?: number, credit_amount?: number, line_description?: string, dimensions?: Record<string, string> }[],
  storno_existing?: boolean,
  force?: boolean,
  expected_journal_entry_id?: string
}
```

Example request:
```json
{
  "supplier_invoice_id": "si_…"
}
```

Response `200`:
```ts
{
  data: {
    success: boolean,
    invoice_status: string,
    paid_amount: number,
    remaining_amount: number,
    journal_entry_id: string | null,
    bank_fee_sek: number,
    registration_journal_entry_id: string | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "success": true,
    "invoice_status": "paid",
    "paid_amount": 5000,
    "remaining_amount": 0,
    "journal_entry_id": "je_…",
    "bank_fee_sek": 0,
    "registration_journal_entry_id": null
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/transactions/{id}/refresh-exchange-rate`

**Fill in the Riksbanken rate and SEK amount of an unbooked foreign-currency transaction.**
`scope:transactions:write · risk:low · idempotent · dry-run`

For an unbooked non-SEK row with no amount_sek/exchange_rate, fetches the Riksbanken rate for the transaction date and stores amount_sek, exchange_rate and exchange_rate_date. A SEK row, or one that already has both, is answered unchanged with refreshed=false. Idempotent. Dry-runnable (the dry run does not call Riksbanken).

**Use when:** A foreign-currency row shows no SEK amount (the rate lookup failed at ingest) and it is about to be booked.
**Do not use for:** Booked rows (the verifikat carries the rate; correct it with storno) or overriding a rate that is already set.

**Pitfalls:**
- A booked row returns 409 TX_EXCHANGE_RATE_BOOKED.
- Riksbanken unavailable returns 502 TX_EXCHANGE_RATE_UNAVAILABLE (retryable).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Response `200`:
```ts
{
  data: {
    transaction_id: string,
    currency: string,
    amount: number,
    amount_sek: number | null,
    exchange_rate: number | null,
    exchange_rate_date: string | null,
    refreshed: boolean
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "transaction_id": "a8f1…",
    "currency": "EUR",
    "amount": -100,
    "amount_sek": -1150.4,
    "exchange_rate": 11.504,
    "exchange_rate_date": "2026-05-12",
    "refreshed": true
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/transactions/{id}/uncategorize`

**Reverse the categorization of a transaction (storno + reset).**
`scope:transactions:write · risk:medium · idempotent · dry-run`

Storno the transaction's journal entry (BFL 5 kap 5 §: posted entries are never deleted, only cancelled via a reversing entry) and reset is_business / category / journal_entry_id on the transaction row. Idempotent: a second call on an already-uncategorized transaction returns 400 TX_UNCATEGORIZE_NOT_BOOKED. Dry-runnable.

**Use when:** You categorized a transaction by mistake and want to redo it from scratch. The storno keeps the audit trail intact.
**Do not use for:** Changing the categorization of an already-booked transaction: categorize again instead (the second call sees journal_entry_id and only updates flags). Reversing a payment match: there is no v1 verb for that yet.

**Pitfalls:**
- Idempotency-Key is mandatory.
- The storno creates a new (cancelling) journal entry. The original entry stays in the ledger marked as cancelled: voucher gaps are documented automatically.
- A transaction without a journal_entry_id returns 400 TX_UNCATEGORIZE_NOT_BOOKED: there is nothing to reverse.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Response `200`:
```ts
{
  data: { success: boolean, reversed_journal_entry_id: string },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "success": true,
    "reversed_journal_entry_id": "je_…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/transactions/batch-categorize`

**Categorize up to 100 transactions in one call (partial-success).**
`scope:transactions:write · risk:medium · idempotent · dry-run · reversible`

Per-item categorization mirroring the single :categorize endpoint. Same `{ results, summary }` shape as the other bulk endpoints. all_or_nothing: true returns 501 NOT_IMPLEMENTED. Idempotent over the whole batch.

**Use when:** You have many transactions to categorize with the same logic (e.g. apply a booking template across a queue, mark a batch as private, override accounts on a series).
**Do not use for:** Categorizing transactions with mixed logic: make multiple :categorize calls. Auto-categorization via templates: handled inside `ingest` for matching rows, no separate endpoint needed.

**Pitfalls:**
- Max 100 items per call. Sequential processing.
- Idempotency-Key covers the WHOLE batch: replays return the cached full response.
- all_or_nothing: true returns 501 NOT_IMPLEMENTED. Today only partial-success batches exist.
- Per item, the same double-booking guards as `:categorize`: TRANSACTION_BOOK_POSSIBLE_DUPLICATE (the ledger already books that bank line; override per item with `force: true` plus the echoed `expected_duplicate_journal_entry_id` / `expected_duplicate_transaction_id`) and TX_CATEGORIZE_SUGGEST_SI_MATCH / TX_CATEGORIZE_SUGGEST_CI_MATCH (an open invoice covers a plain 244x / 151x categorization; override with `confirm_no_match: true`). An item never dedupes against a verifikat booked earlier in the same batch.
- Per item as on `:categorize`: reverse_charge without reverse_charge_kind takes the box from the seller country on that row's underlag, else the item fails with TX_CATEGORIZE_REVERSE_CHARGE_BOX_UNKNOWN.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  items: { transaction_id: string, categorization: { is_business: boolean, category?: "income_services" | "income_products" | "income_other" | "expense_equipment" | "expense_software" | "expense_travel" | "expense_office" | "expense_marketing" | "expense_professional_services" | "expense_education" | "expense_representation" | "expense_consumables" | "expense_vehicle" | "expense_telecom" | "expense_bank_fees" | "expense_card_fees" | "expense_currency_exchange" | "expense_other" | "private" | "uncategorized", template_id?: string, vat_treatment?: "standard_25" | "reduced_12" | "reduced_6" | "reverse_charge" | "export" | "exempt", reverse_charge_kind?: "eu_goods" | "eu_services" | "non_eu_services", vat_amount?: number, account_override?: string, counterparty_template_id?: string, dimensions?: Record<string, string>, user_description?: string, inbox_item_id?: string, proposal_id?: string, confirm_no_match?: boolean, confirm_foreign_seller_vat?: boolean, force?: boolean, expected_duplicate_transaction_id?: string, expected_duplicate_journal_entry_id?: string } }[],
  all_or_nothing?: boolean
}
```

Example request:
```json
{
  "items": [
    {
      "transaction_id": "tx_1",
      "categorization": {
        "is_business": true,
        "category": "expense_office"
      }
    }
  ]
}
```

Response `200`:
```ts
{
  data: {
    results: { ok: boolean, request_index: number, transaction_id: string, data?: unknown, error?: { code: string, message: string, details?: unknown } }[],
    summary: { total: number, succeeded: number, failed: number }
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "results": [
      {
        "ok": true,
        "request_index": 0,
        "transaction_id": "tx_1",
        "data": {
          "journal_entry_id": "je_…"
        }
      }
    ],
    "summary": {
      "total": 1,
      "succeeded": 1,
      "failed": 0
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/transactions/bulk-book`

**Book several SEK bank transactions as one samlingsverifikat, or link them to one posted verifikat.**
`scope:transactions:write · risk:high · idempotent · dry-run`

Puts up to 200 transactions on ONE verifikat (samlingsverifikation, BFL 5 kap 6 §), in exactly one of three ways: existing_journal_entry_id links them to an already-posted voucher whose bank net equals their sum (nothing new is posted; the rows may be of several dates, e.g. a month of Stripe fee rows settled by the verifikat of Stripe's monthly fee invoice); template_id + mode + entry_description expands a booking template per row (one_line_per_tx) or on the sum (sum_per_account); manual_lines + entry_description posts caller-built balanced lines. A new verifikat needs rows of one date. SEK only. The dry run answers the lines and the signed sum (tx_sum). Idempotent. Dry-runnable.

**Use when:** Many small same-day rows of one kind (Swish sales, card fees, a daily settlement) should be one verifikat, or one posted verifikat settles rows of several days (a samlingsfaktura of at most a month, such as Stripe's monthly fee invoice).
**Do not use for:** A new verifikat over rows of several dates (a monthly samlingsverifikat is not legal: one per date), foreign-currency rows (book them one by one), or one row against invoices (POST /transactions/{id}/match-batch).

**Pitfalls:**
- All rows must share one direction and currency SEK, and one date unless they are linked to an existing verifikat: BULK_BOOK_DATE_MISMATCH / BULK_BOOK_DIRECTION_MISMATCH / BULK_BOOK_MIXED_CURRENCY / BULK_BOOK_FOREIGN_CURRENCY otherwise.
- A row that looks already booked returns 409 TRANSACTION_BOOK_POSSIBLE_DUPLICATE naming it; resend with force=true only after reviewing the candidate (each dismissal is logged in behandlingshistorik).
- manual_lines accounts must be active in the company's chart (BULK_BOOK_INVALID_ACCOUNT) and balance; amounts are kronor, account numbers strings.
- The lines on 1900-1999 must net to the rows' sum (BULK_BOOK_AMOUNT_MISMATCH), so a transfer between two own cash accounts is refused: categorize the row with account_override set to the other cash account, then link the other row with POST /transactions/{id}/link-journal-entry.
- default_dimensions tag the business lines only: the bank side and the moms lines stay untagged. A line's own dimensions are kept as given.
- A posted samlingsverifikat is permanent: undo with storno (POST /journal-entries/{id}/reverse).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  tx_ids: string[],
  existing_journal_entry_id?: string,
  template_id?: string,
  mode?: "one_line_per_tx" | "sum_per_account",
  entry_description?: string,
  manual_lines?: { account_number: string, debit_amount: number, credit_amount: number, currency?: string, line_description?: string, dimensions?: Record<string, string> }[],
  default_dimensions?: Record<string, string>,
  force?: boolean
}
```

Example request:
```json
{
  "tx_ids": [
    "a8f1…",
    "b9e2…"
  ],
  "template_id": "5e4f…",
  "mode": "sum_per_account",
  "entry_description": "Swish-försäljning 2026-05-12"
}
```

Response `200`:
```ts
{
  data: {
    mode: "link_existing" | "create_new",
    journal_entry_id: string,
    voucher_series: string | null,
    voucher_number: number | null,
    linked_tx_count: number,
    tx_sum: number,
    docs_linked: number
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "mode": "create_new",
    "journal_entry_id": "4d2a…",
    "voucher_series": "A",
    "voucher_number": 57,
    "linked_tx_count": 2,
    "tx_sum": 1250,
    "docs_linked": 0
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/transactions/ingest`

**Bulk-ingest transactions (up to 500 per call).**
`scope:transactions:write · risk:medium · idempotent · dry-run`

Runs the same ingest pipeline as the dashboard CSV importer and the PSD2 bank sync: dedup, insert, invoice match, mapping-rule auto-categorize, auto-JE for high-confidence matches. Idempotent over the whole batch via Idempotency-Key. Dry-runnable.

**Use when:** You're importing transactions from a CSV, a custom bank feed, or an external accounting system. Each item must have a stable external_id: this is the primary dedup key.
**Do not use for:** Single ad-hoc transactions (use the dashboard). Documents/receipts (use the documents endpoint). Manually-created journal entries (Phase 4).

**Pitfalls:**
- external_id is the primary dedup key: make it stable for the same physical transaction across reruns.
- Content-based dedup runs in addition: a row matching a stored transaction (booked, or unbooked from an import feed) by date, amount, currency, account AND description (prefix-containment, to survive PSD2 title enrichment) is skipped even if external_id differs. Each stored row absorbs at most one incoming row per call.
- Identical real movements (a bank that books several identical fees on one day) each need their own external_id. Sent in one call they are all imported; sent in a later call, alone, a new one is absorbed by a stored twin unless you set stable_external_ids=true. Set it only when the id is the bank's own per-booking reference (never for line numbers or content hashes) and keep one import_source per id scheme: if the scheme changes, change the label.
- A skipped row is never only counted: the response lists it in `skipped` with its reason (external_id_match, content_match_booked, content_match_unbooked) and the stored transaction it matched. Treat a content_match on a row you know is new as a missing transaction and alert on it.
- raw_insert_only=true skips ALL post-insert pipeline steps (matching, categorization). Use for viewer-only imports.
- Max 500 items per call. For larger imports, split into pages of 500.
- Dry-run runs the same dedup decision as the commit, row by row, with the same reasons. It differs only if the stored transactions change in between.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  transactions: { date: string, description: string, amount: number, currency: string, external_id: string, mcc_code?: number | null, merchant_name?: string | null, reference?: string | null, import_source?: string }[],
  skip_auto_categorization?: boolean,
  settlement_account?: string,
  raw_insert_only?: boolean,
  stable_external_ids?: boolean
}
```

Example request:
```json
{
  "transactions": [
    {
      "date": "2026-05-12",
      "description": "ICA MAXI",
      "amount": -349.5,
      "currency": "SEK",
      "external_id": "csv-line-42",
      "merchant_name": "ICA MAXI"
    }
  ]
}
```

Response `200`:
```ts
{
  data: {
    imported: number,
    duplicates: number,
    duplicates_by_reason: { external_id_match: number, content_match_booked: number, content_match_unbooked: number },
    skipped: { external_id: string, reason: "external_id_match" | "content_match_booked" | "content_match_unbooked", matched_external_id: string | null, matched_transaction_id: string | null }[],
    reconciled: number,
    auto_categorized: number,
    auto_matched_invoices: number,
    errors: number,
    transaction_ids: string[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "imported": 1,
    "duplicates": 0,
    "duplicates_by_reason": {
      "external_id_match": 0,
      "content_match_booked": 0,
      "content_match_unbooked": 0
    },
    "skipped": [],
    "reconciled": 0,
    "auto_categorized": 0,
    "auto_matched_invoices": 0,
    "errors": 0,
    "transaction_ids": [
      "5b1f6c1e-8a3d-4f0e-9a51-2f6d0c9b7e10"
    ]
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/webshop-orders`

**The order and refund rows synced from the company's webshops, newest first.**
`scope:transactions:read · risk:low · idempotent`

Lists the rows the Shopify, WooCommerce and Zettle syncs store: one per paid order and one per refund (a negative row under its order), with amounts, the VAT split per rate, the country, the payment method and where each row stands (booking_status: to_book, booked, marked_booked, voided, invoiced, in_transactions, cancelled, unpaid). Filter by booked or unbooked, platform, row type, order date and country. Paginated with limit and offset; total is the full count. Read-only.

**Use when:** To find the orders to book, or to see which orders a period holds per country.
**Do not use for:** One order with its line items and suggested booking (GET /webshop-orders/{orderId}).

**Pitfalls:**
- customer_country is ISO 3166-1 alpha-2. Shopify stores the shipping (destination) country, or the billing country when nothing on the order ships (digital products, services); WooCommerce the billing country. It is null for a Shopify local pickup or when the store withholds addresses.
- booked=unbooked also returns unpaid, invoiced and cancelled rows. A to_book row can be booked. A cancelled row (the store cancelled the order, platform_status cancelled) with refunded_total 0 is left out of the day booking and books only one at a time, when the customer paid and kept no refund; otherwise a person voids it on the Orders page.
- voided: marked makulerad on the Orders page after the store cancelled the order. Nothing is booked, and booked=booked leaves it out.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `booked` | query | `"booked" \| "unbooked"` | no | booked: booked here or marked as booked outside; unbooked: neither booked nor marked. A voided row is in neither. |
| `platform` | query | `"woocommerce" \| "shopify" \| "zettle" \| "kustom"` | no |  |
| `row_type` | query | `"order" \| "refund"` | no |  |
| `from` | query | `string` | no | First order date, inclusive. |
| `to` | query | `string` | no | Last order date, inclusive. |
| `country` | query | `string` | no | ISO 3166-1 alpha-2 country, e.g. DK. |
| `limit` | query | `number` | no | Rows per page, default 50. |
| `offset` | query | `number` | no |  |

Response `200`:
```ts
{
  data: {
    orders: { webshop_order_id: string, platform: "woocommerce" | "shopify" | "zettle" | "kustom", store_scope: string, store_label: string | null, row_type: "order" | "refund", parent_webshop_order_id: string | null, order_number: string, platform_status: string, is_paid: boolean, order_date: string, paid_date: string | null, currency: string, total: number, total_tax: number, total_sek: number | null, exchange_rate: number | null, vat_breakdown: { rate: number, net: number, tax: number }[], customer_country: string | null, customer_name: string | null, customer_company: string | null, payment_method: string | null, payment_method_title: string | null, refunded_total: number, booking_status: "booked" | "marked_booked" | "voided" | "invoiced" | "in_transactions" | "cancelled" | "unpaid" | "to_book", journal_entry_id: string | null, invoice_id: string | null, manually_booked_journal_entry_id: string | null, remote_changed_after_freeze: boolean }[],
    total: number
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "orders": [
      {
        "webshop_order_id": "3f2a…",
        "platform": "shopify",
        "store_scope": "exempel.myshopify.com",
        "store_label": "Exempelbutiken",
        "row_type": "order",
        "parent_webshop_order_id": null,
        "order_number": "#1042",
        "platform_status": "paid",
        "is_paid": true,
        "order_date": "2026-10-14",
        "paid_date": "2026-10-14",
        "currency": "SEK",
        "total": 1250,
        "total_tax": 250,
        "total_sek": 1250,
        "exchange_rate": 1,
        "vat_breakdown": [
          {
            "rate": 25,
            "net": 1000,
            "tax": 250
          }
        ],
        "customer_country": "DK",
        "customer_name": null,
        "customer_company": null,
        "payment_method": "shopify_payments",
        "payment_method_title": "shopify_payments",
        "refunded_total": 0,
        "booking_status": "to_book",
        "journal_entry_id": null,
        "invoice_id": null,
        "manually_booked_journal_entry_id": null,
        "remote_changed_after_freeze": false
      }
    ],
    "total": 1
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/webshop-orders/{orderId}`

**One webshop order row with its line items and the booking the Orders page would prefill.**
`scope:transactions:read · risk:low · idempotent`

Everything GET /webshop-orders returns for the row plus its line items and suggestion: the entry date (paid date, else order date), the open fiscal period covering it, the description, the payment account from the store's payment-method mapping (1686 when unmapped), and balanced lines with revenue and VAT per rate: on the store's accounts for the order's destination country when the store has set them, otherwise on the Swedish accounts. warnings lists what the suggestion cannot know, e.g. a country outside Sweden that no store rule covers. A difference above öre rounding between the total and the VAT per rate is never put on 3740: with one VAT rate it is booked at that rate (e.g. shipping without its own tax line), otherwise it is left out, the lines do not balance and warnings has vat_breakdown_gap. Read-only.

**Use when:** Before booking an order, to start from the dialog's lines and change the accounts that the country or VAT rate calls for.
**Do not use for:** Listing orders (GET /webshop-orders) or booking (POST /webshop-orders/{orderId}/book).

**Pitfalls:**
- customer_country is ISO 3166-1 alpha-2. Shopify stores the shipping (destination) country, or the billing country when nothing on the order ships (digital products, services); WooCommerce the billing country. It is null for a Shopify local pickup or when the store withholds addresses.
- For a Shopify order shipped outside Sweden the suggested lines use the store's accounts for that country and VAT rate when the store has set them (Settings > Connections > Shopify), e.g. 3106/2670 for OSS; an order shipped to Sweden uses the store's own sales account for Sweden when it has set one. Otherwise they use Swedish accounts (3001-3004, 2611-2631): for an OSS, export or VOEC sale choose the accounts yourself. The account choice is the caller's.
- suggestion.lines is null while a non-SEK order has no exchange rate; booking resolves the rate once more and refuses with WEBSHOP_ORDER_FX_UNRESOLVED if it still cannot.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `orderId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    webshop_order_id: string,
    platform: "woocommerce" | "shopify" | "zettle" | "kustom",
    store_scope: string,
    store_label: string | null,
    row_type: "order" | "refund",
    parent_webshop_order_id: string | null,
    order_number: string,
    platform_status: string,
    is_paid: boolean,
    order_date: string,
    paid_date: string | null,
    currency: string,
    total: number,
    total_tax: number,
    total_sek: number | null,
    exchange_rate: number | null,
    vat_breakdown: { rate: number, net: number, tax: number }[],
    customer_country: string | null,
    customer_name: string | null,
    customer_company: string | null,
    payment_method: string | null,
    payment_method_title: string | null,
    refunded_total: number,
    booking_status: "booked" | "marked_booked" | "voided" | "invoiced" | "in_transactions" | "cancelled" | "unpaid" | "to_book",
    journal_entry_id: string | null,
    invoice_id: string | null,
    manually_booked_journal_entry_id: string | null,
    remote_changed_after_freeze: boolean,
    line_items: { name: string, quantity: number, total: number, total_tax: number, vat_rate: number | null }[],
    suggestion: { entry_date: string, fiscal_period_id: string | null, description: string, payment_account: string, payment_account_mapped: boolean, lines: { account_number: string, debit_amount: number, credit_amount: number, line_description?: string, currency?: string, amount_in_currency?: number, exchange_rate?: number }[] | null },
    warnings: { code: string, message_sv: string, message_en: string }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "webshop_order_id": "3f2a…",
    "platform": "shopify",
    "store_scope": "exempel.myshopify.com",
    "store_label": "Exempelbutiken",
    "row_type": "order",
    "parent_webshop_order_id": null,
    "order_number": "#1042",
    "platform_status": "paid",
    "is_paid": true,
    "order_date": "2026-10-14",
    "paid_date": "2026-10-14",
    "currency": "SEK",
    "total": 1250,
    "total_tax": 250,
    "total_sek": 1250,
    "exchange_rate": 1,
    "vat_breakdown": [
      {
        "rate": 25,
        "net": 1000,
        "tax": 250
      }
    ],
    "customer_country": "DK",
    "customer_name": null,
    "customer_company": null,
    "payment_method": "shopify_payments",
    "payment_method_title": "shopify_payments",
    "refunded_total": 0,
    "booking_status": "to_book",
    "journal_entry_id": null,
    "invoice_id": null,
    "manually_booked_journal_entry_id": null,
    "remote_changed_after_freeze": false,
    "line_items": [
      {
        "name": "Skidglasögon",
        "quantity": 1,
        "total": 1000,
        "total_tax": 250,
        "vat_rate": 25
      }
    ],
    "suggestion": {
      "entry_date": "2026-10-14",
      "fiscal_period_id": "a8f1…",
      "description": "Order #1042 (shopify_payments)",
      "payment_account": "1686",
      "payment_account_mapped": false,
      "lines": [
        {
          "account_number": "1686",
          "debit_amount": 1250,
          "credit_amount": 0,
          "line_description": "Order #1042 (shopify_payments)"
        },
        {
          "account_number": "3001",
          "debit_amount": 0,
          "credit_amount": 1000,
          "line_description": "Order #1042 (shopify_payments)"
        },
        {
          "account_number": "2611",
          "debit_amount": 0,
          "credit_amount": 250,
          "line_description": "Order #1042 (shopify_payments)"
        }
      ]
    },
    "warnings": [
      {
        "code": "country_outside_sweden",
        "message_sv": "Ordern har ett land utanför Sverige…",
        "message_en": "The order has a country outside Sweden…"
      }
    ]
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/webshop-orders/{orderId}/book`

**Book one webshop order or refund with your own lines, linked to the order with its orderunderlag.**
`scope:bookkeeping:write · risk:high · idempotent · dry-run`

Posts one verifikat for the order row through the bookkeeping engine (source_type webshop_order, linked to the order) with the lines you send, exactly as the Orders page books it: the order stops showing as unbooked, and the orderunderlag (line items, VAT, country, payment method) is archived on the verifikat. entry_date defaults to the paid date (else the order date), fiscal_period_id to the open period covering it, description to the Orders page's. With transaction_id, the bank row that paid the order is linked to the verifikat once it is posted, in the same call. Refused when the order is booked, invoiced, marked as booked, unpaid or already in the transactions feed. Dry-runnable.

**Use when:** An order has booking_status to_book and you know its accounts, e.g. OSS or VOEC accounts picked from its country and VAT rate.
**Do not use for:** Orders that should become a customer invoice, booking a payout from the payment provider (book that against the clearing account from the bank row), or correcting a booked order (storno).

**Pitfalls:**
- Send the complete line set; sum debit = sum credit > 0. Start from suggestion.lines of GET /webshop-orders/{orderId} and change the accounts.
- The account choice is yours: Accounted only checks balance, period, lock and that the accounts exist. Shopify's amounts and VAT are the source; the lines should add up to them.
- customer_country is ISO 3166-1 alpha-2. Shopify stores the shipping (destination) country, or the billing country when nothing on the order ships (digital products, services); WooCommerce the billing country. It is null for a Shopify local pickup or when the store withholds addresses.
- A posted verifikat is permanent: undo it with storno (POST /journal-entries/{id}/reverse), never by editing.
- An order with booking_status cancelled books only when money moved and stayed: the store cancelled it, so ask the person before booking it as a sale. A voided one is refused (WEBSHOP_ORDER_VOIDED), and so is a refund of a voided order (WEBSHOP_ORDER_REFUND_PARENT_VOIDED).
- transaction_id links the bank row that paid the order (a Swish payment on the bank account, a Stripe charge on 1686) to the verifikat in the same approval. Refused before anything is posted unless the row is unbooked and unlinked, its amount is the order total in its currency (negative for a refund) and the lines book exactly that amount on the row's account. A link refused after posting leaves the booking standing: transaction_link.linked is false with the refusal; link the row with POST /transactions/{id}/link-journal-entry.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `orderId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  lines: { account_number: string, debit_amount?: number, credit_amount?: number, line_description?: string, currency?: string, amount_in_currency?: number, exchange_rate?: number, tax_code?: string, dimensions?: Record<string, string>, cost_center?: string, project?: string }[],
  entry_date?: string,
  fiscal_period_id?: string,
  description?: string,
  voucher_series?: string,
  notes?: string,
  transaction_id?: string
}
```

Example request:
```json
{
  "lines": [
    {
      "account_number": "1686",
      "debit_amount": 1250,
      "credit_amount": 0
    },
    {
      "account_number": "3001",
      "debit_amount": 0,
      "credit_amount": 1000
    },
    {
      "account_number": "2611",
      "debit_amount": 0,
      "credit_amount": 250
    }
  ]
}
```

Response `200`:
```ts
{
  data: {
    webshop_order_id: string,
    journal_entry_id: string,
    voucher_series: string | null,
    voucher_number: number | null,
    entry_date: string,
    underlag_archived: boolean,
    transaction_link?: { transaction_id: string, linked: boolean, refusal: { code: string, message_sv: string, message_en: string } | null }
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "webshop_order_id": "3f2a…",
    "journal_entry_id": "9a0b…",
    "voucher_series": "A",
    "voucher_number": 214,
    "entry_date": "2026-10-14",
    "underlag_archived": true
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/webshop-orders/book-day`

**Book a store's orders and refunds of one day and one payment method as one verifikat, with a day summary as underlag.**
`scope:bookkeeping:write · risk:high · idempotent · dry-run`

Posts one verifikat (source_type webshop_order, dated the day) for every unbooked, paid order and refund of the store whose paid date (else order date) is the day and whose payment method is the one given. The lines are the server's, never the caller's: each order's lines are derived exactly as the Orders page's bulk booking derives them (the store's payment-method mapping and country rules), then summed per account and side, so sales and refunds are separate lines. Every order is linked to the verifikat and stops showing as unbooked, and a dagssammanställning listing each order (number, date, country, amount, VAT) is archived on it. An order that cannot be booked without review (no VAT split, a country no store rule covers, an unknown destination, a non-Swedish rate on the Swedish accounts, an invoice-flow payment method, a rounding gap over 1 kr, cancelled in the store with nothing refunded) is left out, listed in skipped with the reason, and stays unbooked. Dry-runnable.

**Use when:** The company books its webshop sales per day and payment method (e.g. one verifikat for Shopify Payments and one for PayPal), not per order.
**Do not use for:** Payouts and fees from the payment provider (book those against the clearing account from the bank row), one order (POST /webshop-orders/{orderId}/book), or correcting a booked day (storno, then book the orders again).

**Pitfalls:**
- Pass order_ids and lines_sha256 from the dry run as expected_order_ids and expected_lines_sha256: an order booked or changed since answers 409 WEBSHOP_DAY_CHANGED instead of booking figures you did not review.
- payment_method is the order's payment_method from GET /webshop-orders, e.g. shopify_payments or paypal. Orders without one cannot be booked per day.
- Orders that sync after the day is booked stay unbooked: booking the day again posts a second verifikat for them.
- skipped orders stay in Att bokföra: book them one by one with POST /webshop-orders/{orderId}/book.
- A posted verifikat is permanent: undo it with storno (POST /journal-entries/{id}/reverse), never by editing.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  platform: "woocommerce" | "shopify" | "zettle" | "kustom",
  store_scope: string,
  date: string,
  payment_method: string,
  expected_order_ids?: string[],
  expected_lines_sha256?: string
}
```

Example request:
```json
{
  "platform": "shopify",
  "store_scope": "exempel.myshopify.com",
  "date": "2026-10-14",
  "payment_method": "shopify_payments"
}
```

Response `200`:
```ts
{
  data: {
    journal_entry_id: string,
    voucher_series: string | null,
    voucher_number: number | null,
    entry_date: string,
    booked: { webshop_order_id: string, order_number: string, row_type: "order" | "refund", total_sek: number }[],
    skipped: { webshop_order_id: string, order_number: string, row_type: "order" | "refund", code: string, message_sv: string, message_en: string, details?: Record<string, unknown> }[],
    underlag_document_id: string | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "journal_entry_id": "9a0b…",
    "voucher_series": "L",
    "voucher_number": 41,
    "entry_date": "2026-10-14",
    "booked": [
      {
        "webshop_order_id": "3f2a…",
        "order_number": "#1042",
        "row_type": "order",
        "total_sek": 1250
      },
      {
        "webshop_order_id": "7c1d…",
        "order_number": "#1043",
        "row_type": "order",
        "total_sek": 499
      }
    ],
    "skipped": [],
    "underlag_document_id": "5d2c…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/webshop-orders/oss-underlag`

**Underlag for the OSS declaration (unionsordningen): a quarter's sales to consumers in other EU countries, per country and VAT rate, in euro.**
`scope:reports:read · risk:low · idempotent`

Adds up what is booked on the OSS accounts (VAT code oss, the OSS output VAT account, accounts a Shopify country rule names for OSS, and 26xx accounts that name an OSS country) in a calendar quarter: per country and VAT rate the sales without VAT and the VAT, in euro at the ECB rate for the last day of the quarter (the next publication day when the ECB published none) and in kronor as booked. A verifikat that books a webshop order takes country and rate from the order. One that books no order takes them from its accounts, when the sales account names a country and a rate (accounts.oss-countries): the VAT follows the sales it is booked with. Refunds of an earlier quarter's orders, and stornos and rättelser of an earlier quarter's verifikat, are corrections of that quarter (country, quarter, VAT). unaccounted lists the verifikat with neither an order nor a country on their accounts: they count in ledger_vat_sek but in no row or total. accounts lists the OSS accounts that name a country, those a verifikat waits for (blocks_vouchers) and what their names suggest. warnings names what is missing or needs a look. Read-only; nothing is filed.

**Use when:** Before filing the quarterly OSS declaration in Skatteverket's e-tjänst, or to check what the OSS accounts hold per country.
**Do not use for:** The Swedish momsdeklaration (OSS sales are outside it), EU sales taxed in Sweden below the distance-selling threshold, or invoices (they carry Swedish VAT only).

**Pitfalls:**
- Only booked orders count, in the quarter of the verifikat that books them: book the quarter's orders first (warnings unbooked_orders).
- Euro amounts are null until the ECB has published the rate for the last day of the quarter (warnings rate_unavailable); the kronor amounts are final.
- The VAT is declared with two decimals, never rounded. A nil_return quarter still needs a declaration.
- nil_return is true only when nothing is left outside the underlag: no unaccounted verifikat, no warning about a missing order, no VAT on the OSS accounts. Empty rows with nil_return false is NOT a nil return: a sale booked as a manual voucher on an account that names no country has nothing to take its country from (warnings vouchers_without_order), so the account is given its country or the sale is declared by hand from the sales records.
- A correction uses the ECB rate of the quarter it corrects, so a full refund takes back exactly what was declared.
- refund_vouchers are refunds booked as verifikat of their own, placed by their accounts: they are taken off the quarter they are booked in (warnings refund_vouchers_netted). One that belongs to an earlier quarter is declared as a correction of that quarter instead.
- rate_mismatch on a row (warnings vat_rate_mismatch): the VAT its verifikat book is not the row's rate of their sales. A wrong rate on the account, a wrong VAT amount, or VAT booked on an account that names no OSS country.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `year` | query | `number` | yes | Calendar year; the OSS scheme started 1 July 2021. |
| `quarter` | query | `number` | yes | Calendar quarter, 1-4. |

Response `200`:
```ts
{
  data: {
    period: { year: number, quarter: number, label: string, start: string, end: string, deadline: string },
    rows: { country: string, vat_rate: number, net_eur: number | null, vat_eur: number | null, net_sek: number, vat_sek: number, order_count: number, voucher_count: number, rate_mismatch: boolean }[],
    corrections: { country: string, period: { year: number, quarter: number, label: string }, vat_eur: number | null, vat_sek: number, refund_count: number, voucher_count: number }[],
    totals: { net_eur: number | null, vat_eur: number | null, corrections_vat_eur: number | null, net_sek: number, vat_sek: number, corrections_vat_sek: number },
    rates: { currency: string, for_date: string, rate: number | null, rate_date: string | null, unavailable: boolean }[],
    ledger_vat_sek: number,
    unaccounted: { journal_entry_id: string, voucher_series: string | null, voucher_number: number, entry_date: string, description: string, net_sek: number, vat_sek: number }[],
    refund_vouchers: { journal_entry_id: string, voucher_series: string | null, voucher_number: number, entry_date: string, description: string, net_sek: number, vat_sek: number }[],
    accounts: { account_number: string, account_name: string, kind: "sales" | "vat", country: string | null, vat_rate: number | null, suggested_country: string | null, suggested_vat_rate: number | null, blocks_vouchers: boolean }[],
    warnings: { code: string, message_sv: string, message_en: string, order_numbers: string[] }[],
    nil_return: boolean
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "period": {
      "year": 2026,
      "quarter": 3,
      "start": "2026-07-01",
      "end": "2026-09-30",
      "label": "Q3 2026",
      "deadline": "2026-10-31"
    },
    "rows": [
      {
        "country": "DE",
        "vat_rate": 19,
        "net_eur": 88.26,
        "vat_eur": 16.77,
        "net_sek": 1000,
        "vat_sek": 190,
        "order_count": 1,
        "voucher_count": 0,
        "rate_mismatch": false
      }
    ],
    "corrections": [],
    "totals": {
      "net_eur": 88.26,
      "vat_eur": 16.77,
      "corrections_vat_eur": 0,
      "net_sek": 1000,
      "vat_sek": 190,
      "corrections_vat_sek": 0
    },
    "rates": [
      {
        "currency": "SEK",
        "for_date": "2026-09-30",
        "rate": 11.331,
        "rate_date": "2026-09-30",
        "unavailable": false
      }
    ],
    "ledger_vat_sek": 190,
    "unaccounted": [],
    "refund_vouchers": [],
    "accounts": [],
    "warnings": [],
    "nil_return": false
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```
