<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Banking endpoints

Bank transactions (ingest, categorize, match against invoices), cash accounts with the bank-reported balance, PSD2 connection health (sync freshness, consent expiry), bank reconciliation runs, and file imports (SIE, bank statements).

Conventions (auth, envelope, pagination, dry-run, idempotency, standard errors)
are in SKILL.md and are not repeated per endpoint.

### `GET /api/v1/companies/{companyId}/bank-connections`

**List PSD2 bank connections with sync freshness and consent expiry.**
`scope:companies:read · risk:low · idempotent`

Returns every bank connection for the company with its status, last successful sync (last_synced_at), consent expiry (consent_expires) and any user-facing error message. Connections sync automatically once a day server-side; this endpoint tells you whether that is still happening.

**Use when:** You need to verify bank data is current before building on it (liquidity, reconciliation, reports), or to detect a dead connection that needs BankID re-authorisation.
**Do not use for:** Fetching transactions (use /transactions) or account balances (use /cash-accounts). Triggering a sync: not available on this surface; syncing is automatic.

**Pitfalls:**
- last_synced_at is null until the first sync completes (about a minute after connecting); it does NOT mean the connection is broken.
- A connection can hold status=active with a stale last_synced_at (older than ~36 hours): treat the data as suspect, but do NOT assume re-authorisation fixes it. Common causes are a lapsed subscription (this endpoint then answers with a capability error) or every account deselected in settings.
- status=expired means the PSD2 consent is dead: only the user can fix it, with BankID in a browser.
- error_message is Swedish and user-facing: show it verbatim rather than translating.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    bank_connections: { connection_id: string, bank: string | null, status: "pending" | "pending_selection" | "active" | "expired" | "error", since: string, last_synced_at: string | null, consent_expires: string | null, error_message: string | null }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
`scope:transactions:write · risk:low`

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
    last_synced_at: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
    cash_accounts: { cash_account_id: string, ledger_account: string, name: string | null, currency: string, iban: string | null, is_primary: boolean, enabled: boolean, source: "enable_banking" | "manual" | "sie_import", balance: number | null, available_balance: number | null, balance_updated_at: string | null }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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

**Create a bank account by hand (no bank connection), with the payee details invoices print.**
`scope:companies:write · risk:low · idempotent · dry-run`

Adds a manual bank account (cash_accounts, source manual) in a currency, on the next free BAS 19xx ledger account for that currency unless ledger_account (1920-1999) is given, and adds that account to the chart if missing. payee holds what customer invoices print (bankgiro, IBAN, ...); invoice_payee defaults to true. A later bank connection with the same IBAN takes this row over in place. Owner/admin only. Idempotent. Dry-runnable.

**Use when:** The company has a bank account that is not connected through the bank integration (a savings account, a currency account, a bank without PSD2) and it should appear in Konton, the booking flows or on invoices.
**Do not use for:** Connecting a bank (the bank connection flow creates its own accounts), changing an existing account (PATCH /cash-accounts/{id}) or choosing which account invoices print by default (PUT /cash-accounts/payee-defaults).

**Pitfalls:**
- An IBAN another account of the company already carries returns 409 CASH_ACCOUNT_IBAN_DUPLICATE: one physical account must exist once.
- A ledger_account another cash account holds returns 409 CASH_ACCOUNT_LEDGER_TAKEN; omit it to get the next free one.
- ledger_account is a STRING in 1920-1999 ("1931"), never a number, and never a till (1910-1919) or a PSP clearing account.
- Owner or admin only: a member key gets 403 FORBIDDEN.
- Creating an account does not make it the default payee: set that with PUT /cash-accounts/payee-defaults.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  name: string,
  currency: "SEK" | "EUR" | "USD" | "GBP" | "NOK" | "DKK" | "CHF",
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
  }
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
    ledger_account: string,
    name: string | null,
    currency: string,
    iban: string | null,
    source: "enable_banking" | "manual" | "sie_import",
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
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
    "ledger_account": "1931",
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

Sparse update of one cash account. voucher_series (one letter A-Z, null clears) sets the verifikationsserie for entries booked from the account. The payee fields (bank_name, clearing_number, account_number, bankgiro, plusgiro, swish, iban, bic, bank_code, foreign_account_number), name and invoice_payee decide what customer invoices print; "" or null clears a field. enabled=false hides an account no bank connection holds from Konton and the booking flows. The ledger account and the primary flag are not editable here. Idempotent. Dry-runnable.

**Use when:** The company changes bank details customers pay to, wants its own voucher series per bank account, or stops using a manually added account.
**Do not use for:** Making an account the primary (POST /cash-accounts/{id}/set-primary), choosing the default payee per currency (PUT /cash-accounts/payee-defaults) or moving a transaction to another account.

**Pitfalls:**
- Payee fields, name, invoice_payee and enabled are owner/admin only (403 FORBIDDEN); voucher_series alone is open to any writer.
- Payee fields on a PSP clearing account or a till return 400 INVOICE_PAYEE_ACCOUNT_INVALID: only 1920-1999 bank accounts print on invoices.
- enabled on an account a bank connection holds returns 409 CASH_ACCOUNT_ENABLED_BANK_MANAGED; disabling the primary returns 400 CASH_ACCOUNT_DISABLE_PRIMARY, and one with unbooked transactions 400 CASH_ACCOUNT_DISABLE_UNRESOLVED.
- An iban another account already carries returns 409 CASH_ACCOUNT_IBAN_DUPLICATE.
- Changing voucher_series only affects entries booked afterwards; nothing posted is renumbered.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

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
    ledger_account: string,
    name: string | null,
    currency: string,
    iban: string | null,
    source: "enable_banking" | "manual" | "sie_import",
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
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
    "ledger_account": "1931",
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

Response `200`:
```ts
{
  data: {
    cash_account_id: string,
    ledger_account: string,
    name: string | null,
    currency: string,
    iban: string | null,
    source: "enable_banking" | "manual" | "sie_import",
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
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
    "ledger_account": "1931",
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

Request body:
```ts
{ currency: "SEK" | "EUR" | "USD" | "GBP" | "NOK" | "DKK" | "CHF", cash_account_id: string | null }
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
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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

**Import a bank-file (CSV / XML / CAMT053).**
`scope:transactions:write · risk:medium · idempotent`

Accepts a bank statement file (UTF-8 / UTF-16 / Windows-1252, up to 10 MB) as multipart/form-data. Auto-detects the bank format (SEB, Swedbank, Handelsbanken, Nordea, Nordea Business, Lansforsakringar, Lunar, ICA Banken, Skandia, Wise transaction history, Wise balance statement, CAMT053, generic CSV) or honors a `format` override. Parses transactions, ingests them into the `transactions` table (NOT into journal entries: see BFL note in pitfalls), and emits `transaction.synced` events. Returns operation_id for polling.

**Use when:** Importing a bank statement export for a period. Common with PSD2 bank connections that don't auto-sync, or for legacy bank accounts.
**Do not use for:** SIE bookkeeping import (use /imports/sie). Auto-bank sync (use the enable-banking extension). Single-transaction creation (use POST /transactions/ingest with a 1-element array).

**Pitfalls:**
- File size cap: 10 MB. Larger files require splitting client-side.
- `format` query parameter is optional; auto-detection works for all supported banks. Pass `format` only to force a specific format. Accepted values: seb, swedbank, handelsbanken, nordea, nordea_business, lansforsakringar, ica_banken, skandia, lunar, northmill, wise, wise_statement, generic_csv, camt053.
- Wise transaction-history rows with refunded or unknown statuses, unknown directions, or different source and target currencies are rejected instead of guessed. Import the matching per-currency Wise balance statements.
- Duplicate detection is by external_id (composed from format + date + description + amount + row index, or the camt.053 entry reference / Wise transfer id where the file carries one); a re-import of the same file typically deduplicates rather than creating doubles.
- BFL 5 kap 6-7 §§ note: this endpoint creates `transactions` rows (the underlag for a verifikation), NOT verifikationer themselves. The verifikation content requirements are in BFL 5 kap 6-7 §§; until each transaction is matched to an invoice/supplier-invoice (POST /transactions/{id}/match-*) or categorised (POST /transactions/{id}/categorize), the bookkeeping obligation isn't discharged. A successful import here means the data is ingested: not booked.
- A successful import returns operation_id; poll /operations/{id} for the final ingested/duplicates/errors counts.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `format` | query | `"nordea" \| "nordea_business" \| "seb" \| "swedbank" \| "handelsbanken" \| "lansforsakringar" \| "ica_banken" \| "skandia" \| "lunar" \| "northmill" \| "wise" \| "wise_statement" \| "generic_csv" \| "camt053"` | no | Force this bank file format instead of auto-detection. Omit to auto-detect. |

Response `200`:
```ts
{
  data: { operation_id: string, type: "import.bank", status: "queued", poll_url: string },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

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
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
- The operation can take 1-5 minutes for multi-year files. The HTTP response returns immediately with operation_id; poll /operations/{id} every ~2s for status.
- Chunks are visible while importing. Filing and export are held until completion. Undo uses batch storno and retains accounting history.
- Account mappings are generated server-side from the file's #KONTO records (plus stored per-company overrides). By default the file's account names are carried into the chart, renaming existing accounts whose names differ: pass options.updateAccountNames=false to keep BAS default names.

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
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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

Queues a batch storno of the import: each verifikat the import posted gets a reversing entry (BFL 5 kap 5 §) and the originals stay in the ledger. Asynchronous: the answer carries state "undoing" and the worker finishes in the background (state "undone"). Refused while another SIE run is active, while a reversal of an imported voucher is already in progress, while an imported voucher has a live correction, or when the period is closed or locked. Owner/admin only. Idempotent. Dry-runnable (the dry run counts the entries that would be reversed).

**Use when:** An SIE file was imported into the wrong company or year, or with a wrong mapping, and its entries must be cancelled before a corrected import.
**Do not use for:** Removing single vouchers (POST /journal-entries/{id}/reverse), bank file imports (POST /imports/bank/{id}/undo), or legacy imports made before durable jobs (409 SIE_IMPORT_LEGACY_REVIEW_REQUIRED: review them in the app).

**Pitfalls:**
- Nothing is deleted: the ledger keeps both the imported entries and their reversals, and voucher numbers are never reused.
- A closed or locked period, another active run or a live correction returns 409 SIE_IMPORT_ACTION_CONFLICT with details.reason.
- Owner or admin only: a member key gets 403 FORBIDDEN.
- Undoing an already undone import answers its state unchanged.

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
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
    accounts: { account_key: string, kind: "bank" | "skattekonto" | "manual", account_number: string, name: string, currency: string, logo_url: string | null, source: { type: "psd2" | "bank_file" | "skatteverket_api" | "skatteverket_file" | "manual", synced_at: string | null, stale: boolean }, status: { state: "reconciled" | "open" | "stale" | "not_configured", as_of: string, unexplained_difference: number | null, open_counts: { proposed: number, unmatched_external: number, unmatched_ledger: number } } | null, superseded_by: string | null, signed_off_through?: string | null }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
        "logo_url": "/logos/skatteverket_color.svg",
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
- Bank accounts carry the legacy field set in the bank block (bank_transaction_total, gl_1930_period_movement, …) unchanged from /reconciliation/bank/status.

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
    skattekonto: { saldo_skatteverket: number | null, fetched_at: string | null, history_start: string | null, opening_difference: number | null, upcoming_count: number, upcoming_total: number, ledger_balance_before_start: number | null } | null,
    bank: Record<string, unknown> | null,
    manual?: { period_id: string, period_start: string, period_end: string, opening_balance: number, movement: number, closing_balance: number, specification: { provider: "ar" | "ap" | "vacation", label_sv: string, label_en: string, amount: number, unconverted_fx_count: number } | null } | null,
    signoff?: { id: string, account_key: string, through_date: string, external_balance: number | null, ledger_balance: number | null, unexplained_difference: number | null, note: string | null, signed_by: string, signed_at: string, reopened_at: string | null, reopened_by: string | null, reopen_reason: string | null } | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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

Returns reconciliation items for one account. ?bucket selects one of proposed | unmatched_external | unmatched_ledger | matched | ignored | upcoming (default: all open buckets first, then matched). Each item carries its side (external | ledger), a qualified item_id (skattekonto_transaction / transaction / journal_entry), date, description, signed amount, the proposal when one exists (journal_entry_id, voucher, confidence, reasons[]), link_problem when a link points at a reversed or draft entry, awaiting_external for fresh ledger lines, and the actions the row allows. ?date_from / ?date_to scope the lists; rows outside the window are never hidden from the counts (older_unmatched_count).

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
| `bucket` | query | `"proposed" \| "unmatched_external" \| "unmatched_ledger" \| "matched" \| "ignored" \| "upcoming"` | no | Only this bucket. Default: every open bucket first, then matched. |
| `date_from` | query | `string` | no | YYYY-MM-DD. Scopes the lists; rows before it still count in older_unmatched_count. |
| `date_to` | query | `string` | no | YYYY-MM-DD. Scopes the lists. |
| `limit` | query | `number` | no | Page size, 1-200 (default 50). |
| `cursor` | query | `string` | no | Opaque cursor from the previous page's next_cursor. Omit for the first page. |

Response `200`:
```ts
{
  data: {
    items: { item_id: string, item_type: "skattekonto_transaction" | "transaction" | "journal_entry", side: "external" | "ledger", bucket: "proposed" | "unmatched_external" | "unmatched_ledger" | "matched" | "ignored" | "upcoming", date: string, description: string, amount: number, currency: string, voucher_number?: number | null, voucher_series?: string | null, entry_status?: "draft" | "posted" | "reversed", linked_journal_entry_id?: string | null, linked_entry?: { entry_date: string, voucher_series: string | null, voucher_number: number | null, description: string } | null, link_problem?: "entry_reversed" | "entry_draft" | "entry_missing" | null, proposal?: { journal_entry_id: string, voucher_number: number | null, voucher_series: string | null, entry_date: string, description: string, entry_status: "draft" | "posted" | "reversed", confidence: number, reasons: string[], vouchers?: { journal_entry_id: string, voucher_number: number | null, voucher_series: string | null, entry_date: string, description: string, amount: number }[] } | null, awaiting_external?: boolean, actions: ("match" | "unmatch" | "book" | "ignore" | "unignore" | "review")[] }[],
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
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
`scope:reconciliation:write · risk:medium · dry-run · reversible`

Body: { pairs: [{ external_ids: [id], journal_entry_ids: [id], allocations? }] } and/or { use_proposals: true, confidence_threshold? }. Each pair is validated as the single-link paths validate (row open and not ignored, entry posted and not reversed, the entry's account lines settle the amount, entry not already linked) and applied independently: the response lists applied[] and skipped[{pair, code, message}] so partial success is explicit. On a bank account a pair may also be ONE transaction against SEVERAL verifikat (1:N): allocations[{journal_entry_id, amount}] gives the signed slice per verifikat (omitted: each slice defaults to the voucher's line on the account); the slices must sum to the transaction amount, and each applied link then carries allocated_amount. Codes: UNSUPPORTED_PAIR_SHAPE, ALREADY_LINKED, ENTRY_NOT_FOUND, PAIR_NOT_CLOSED, ROW_IGNORED, NOT_FOUND, LINK_RACE. ?dry_run=true returns the pairs that would be attempted without writing (a 1:N dry run resolves the slices).

**Use when:** An agent or integration has decided which rows explain each other, or wants to apply the proposals the sync already computed.
**Do not use for:** Booking new verifikat for rows that have no counterpart (use the transactions or skattekonto booking endpoints); reconciling across accounts.

**Pitfalls:**
- A pair is one OR MANY outside rows against exactly one verifikat (bank: independent links per transaction; skattekonto: all-or-nothing, the rows must sum to what the verifikat settles), or, on a bank account only, ONE transaction against SEVERAL verifikat (all-or-nothing, the slices must sum to the transaction). Several rows against several verifikat, and a skattekonto row against several verifikat, are UNSUPPORTED_PAIR_SHAPE, never silently reduced.
- A pair must close to the row's amount on the expected side (a single matching line, or the entry's lines on the account netting to it); a fee or rounding difference is PAIR_NOT_CLOSED here and needs a residual booking first.
- Links never touch the ledger, so they succeed in locked periods; unlink with DELETE .../links/{linkId} (linkId = the outside row id).
- Idempotency-Key is required; repeating the same key replays the first response.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `accountKey` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  pairs?: { external_ids: string[], journal_entry_ids: string[], allocations?: { journal_entry_id: string, amount: number }[] }[],
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
    applied: { external_id: string, journal_entry_id: string, via?: "line" | "entry_total", allocated_amount?: number }[],
    skipped: { pair: { external_ids: string[], journal_entry_ids: string[], allocations?: { journal_entry_id: string, amount: number }[] }, code: string, message: string }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
- linkId is the outside row id, not a separate link entity.
- Unlinking a row whose verifikat was stornoed is the expected fix for a link_problem = entry_reversed item; the row then shows under unmatched_external again.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `accountKey` | path | `string` | yes |  |
| `linkId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Response `200`:
```ts
{
  data: { external_id: string, previous_journal_entry_id: string | null },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
`scope:transactions:write · risk:medium · dry-run`

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
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
    signoffs: { id: string, account_key: string, through_date: string, external_balance: number | null, ledger_balance: number | null, unexplained_difference: number | null, note: string | null, signed_by: string, signed_at: string, reopened_at: string | null, reopened_by: string | null, reopen_reason: string | null }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
`scope:reconciliation:signoff · risk:medium · dry-run · reversible`

Body: { through_date: "YYYY-MM-DD", note?, force?, external_balance? }. Recomputes the bridge through the date and refuses unless unexplained_difference is zero; with force: true and a note it signs anyway and records the difference. Refuses dates in the future, dates past the skattekonto snapshot (NOT_FETCHED_THROUGH), and dates at or before an existing active sign-off (ALREADY_SIGNED_OFF: reopen that one first). For a manual:NNNN account without a system specification (anything but 1510/2440/2920/2940), external_balance is the balance per the signer's underlag in ledger sign (liabilities negative); the difference against the booked balance is recorded, and a non-zero one still needs force + note. On bank, skattekonto and specification accounts external_balance is refused (EXTERNAL_BALANCE_NOT_ALLOWED). ?dry_run=true returns would_sign without writing. Undo with POST .../signoff/{signoffId}/reopen.

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
    signoff?: { id: string, account_key: string, through_date: string, external_balance: number | null, ledger_balance: number | null, unexplained_difference: number | null, note: string | null, signed_by: string, signed_at: string, reopened_at: string | null, reopened_by: string | null, reopen_reason: string | null },
    would_sign?: { account_key: string, through_date: string, external_balance: number | null, ledger_balance: number | null, unexplained_difference: number | null, is_reconciled: boolean, forced: boolean, previous_through_date: string | null }
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
    }
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
    signoff: { id: string, account_key: string, through_date: string, external_balance: number | null, ledger_balance: number | null, unexplained_difference: number | null, note: string | null, signed_by: string, signed_at: string, reopened_at: string | null, reopened_by: string | null, reopen_reason: string | null }
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
- Without confidence_threshold, a non-dry run applies EVERY match found, including fuzzy ones at confidence 0.75. Pass confidence_threshold (0.9 recommended, matching gnubok_auto_match_period) for unattended runs, or dry-run first and review matches.confidence before applying. Matches below the threshold are returned but not applied (skipped_below_threshold counts them).
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
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
- Judge health on unexplained_difference, NOT on difference. difference is just the gap between the two sides and is expected to be large mid-year; it is fully explained while every krona of it sits in unmatched_transaction_total or unmatched_gl_line_total. A non-zero unexplained_difference is the real finding: a matched pair disagreeing in amount, a voucher with several lines on the account, or a storno/correction line the candidate list hides.
- Ignored transactions are excluded from bank_transaction_total and difference (they never get a ledger counterpart); their count and sum are reported separately.

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
    gl_1930_balance: number,
    gl_1930_period_movement: number,
    gl_1930_opening_balance: number,
    gl_1930_correction_adjustment: number,
    difference: number,
    is_reconciled: boolean,
    matched_count: number,
    unmatched_transaction_count: number,
    unmatched_transaction_total: number,
    unmatched_gl_line_count: number,
    unmatched_gl_line_total: number | null,
    unexplained_difference: number | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
- A booked transaction has a non-null journal_entry_id. is_business / category live on the transaction row even before booking.
- reverse-charge or storno entries can leave a transaction with journal_entry_id pointing at a cancelled JE: check status on the JE separately.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `status` | query | `"booked" \| "unbooked"` | no | booked: linked to a verifikat (journal_entry_id set). unbooked: not yet booked. Default: both. |
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
  data: { id: string, date: string, description: string | null, amount: number, currency: string, reference: string | null, merchant_name: string | null, journal_entry_id: string | null, invoice_id: string | null, supplier_invoice_id: string | null, is_business: boolean | null, category: string | null, import_source: string | null, cash_account_id: string | null, created_at: string }[],
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    id: string,
    date: string,
    description: string | null,
    amount: number,
    currency: string,
    amount_sek: number | null,
    reference: string | null,
    merchant_name: string | null,
    counterparty_account: string | null,
    journal_entry_id: string | null,
    invoice_id: string | null,
    supplier_invoice_id: string | null,
    potential_invoice_id: string | null,
    is_business: boolean | null,
    category: string | null,
    receipt_id: string | null,
    document_id: string | null,
    external_id: string | null,
    import_source: string | null,
    reconciliation_method: string | null,
    cash_account_id: string | null,
    created_at: string,
    updated_at: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
    description: string | null,
    title_edited_at: string | null,
    cash_account_id: string | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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

Pins the document to the transaction. On an unbooked transaction the pin rides along when it is categorized; on a booked one the document becomes the verifikat's underlag at once (BFL 5 kap 6 §). The inbox item the document came from is marked matched. Attaching another document replaces the pin and is logged as a rättelse. Idempotent. Dry-runnable.

**Use when:** A receipt or invoice in the archive belongs to a bank transaction (same date, amount, counterparty).
**Do not use for:** Linking a document to a verifikat with no bank transaction (POST /documents/{id}/link) or uploading a file (POST /documents).

**Pitfalls:**
- A document already underlag of ANOTHER verifikat returns 409 DOC_ATTACH_OTHER_VERIFIKAT.
- Replacing a pinned document that is already linked to a verifikat returns 409 DOC_ATTACH_REPLACES_POSTED: reverse the entry first.
- On a booked transaction in a locked period the pin is saved but the verifikat link is refused: 409 DOC_ATTACH_PERIOD_LOCKED.
- Check date, amount and counterparty on both sides first: once the transaction is booked the link is immutable.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ document_id: string }
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
    journal_entry_id: string | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
    "journal_entry_id": null
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
**Do not use for:** Matching a payment to an invoice: use `:match-invoice` or `:match-supplier-invoice`, which storno any conflicting JE first. Uncategorizing: `:uncategorize`.

**Pitfalls:**
- A bank payment that looks like an invoice payment will be flagged via TX_CATEGORIZE_SUGGEST_SI_MATCH: pass `confirm_no_match: true` to override and force-categorize as direct expense (e.g. when the supplier invoice was already booked).
- Already-categorized fast path: if the transaction already has a journal_entry_id, only flags get updated. The JE is immutable post-commit.
- account_override must exist in the chart of accounts; an unknown account returns TX_CATEGORIZE_INVALID_ACCOUNT.

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
  vat_amount?: number,
  account_override?: string,
  counterparty_template_id?: string,
  dimensions?: Record<string, string>,
  user_description?: string,
  inbox_item_id?: string,
  confirm_no_match?: boolean,
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
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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

Response `200`:
```ts
{
  data: { transaction_id: string, document_id: unknown, detached_document_id: string | null },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

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
    remaining_amount: number | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
`scope:transactions:write · risk:medium · idempotent · dry-run`

Allocates the transaction across N invoices of one kind: one samlingsverifikation (bank against 1510 or 2440, kursdifferens on 3960/7960 for foreign invoices, öresavrundning on 3740) and one payment row per invoice, atomically. The allocations must sum to the transaction amount. The dry run answers the exact lines (expected_lines) the verifikat would carry. Idempotent. Dry-runnable.

**Use when:** One incoming payment covers several customer invoices, or one outgoing transfer pays several supplier invoices.
**Do not use for:** One invoice (POST /transactions/{id}/match-invoice or match-supplier-invoice), mixing customer and supplier invoices, or invoices never booked under kontantmetoden.

**Pitfalls:**
- The allocation amounts must sum to |amount| of the transaction: BATCH_AMOUNT_EXCEEDS_TX / BATCH_AMOUNT_BELOW_TX otherwise.
- A row that posted vouchers already explain (each invoice marked paid by hand) returns 409 BATCH_TX_POSSIBLE_DUPLICATE with the vouchers: link the row to them instead. force=true needs expected_journal_entry_ids naming exactly that set.
- Under kontantmetoden an invoice with no booking yet returns 400 BATCH_CASH_METHOD_UNBOOKED_INVOICE.
- Proformas and quotes return 400 MATCH_INVOICE_NOT_INVOICE_TYPE.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  allocations: { kind: "customer_invoice", invoice_id: string, amount: number } | { kind: "supplier_invoice", supplier_invoice_id: string, amount: number }[],
  force?: boolean,
  expected_journal_entry_ids?: string[]
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
    leftover: number
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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

Confirms an invoice match for a transaction. Storno any conflicting auto-categorization JE, create the payment journal entry, update the invoice status (paid / partially_paid), insert into invoice_payments, and link the transaction. Idempotent.

**Use when:** You have a bank receipt and a known open invoice it pays. The transaction must be positive (income) and unlinked.
**Do not use for:** Categorizing a transaction without an invoice: use `:categorize`. Matching to a supplier invoice: use `:match-supplier-invoice`. Bulk auto-match: use `POST /reconciliation/bank/run`.

**Pitfalls:**
- Proforma + delivery notes are rejected (MATCH_INVOICE_NOT_INVOICE_TYPE): only document_type='invoice' can be matched.
- Transaction must be positive (amount > 0): negative transactions return MATCH_INVOICE_NOT_INCOME.
- Invoice must be in sent / overdue / partially_paid status: paid or draft invoices return MATCH_INVOICE_NOT_OPEN.
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
  lines?: { account_number: string, debit_amount?: number, credit_amount?: number, line_description?: string }[],
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
    category: string | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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

Confirms a supplier invoice payment match. Creates the payment journal entry (accrual: 2440 debit, credit on the transaction's own settlement account, 1930 when unlinked; cash-method: collapsed registration+payment), updates supplier_invoices, inserts a supplier_invoice_payments row, and links the transaction. Handles FX differences for cross-currency payments (7960 gain / 3960 loss).

**Use when:** You have a bank payment and a known open supplier invoice. The transaction must be negative (expense) and unlinked.
**Do not use for:** Categorizing a direct supplier expense without an invoice: use `:categorize`. Matching to a customer invoice: use `:match-invoice`. Bulk auto-match: `POST /reconciliation/bank/run`.

**Pitfalls:**
- Cash-method companies can settle a foreign invoice in full (booked at the payment-date rate); only a PARTIAL cash-method payment across currencies is rejected (MATCH_SI_CASH_FX_UNSUPPORTED): pay in full, switch to accrual, or book manually.
- Cash-method öresavrundning: a SEK bank row less than 1 kr off a never-booked SEK invoice (a whole-krona payment of an öre total) settles it in full. The payment account is credited with the bank amount and the residual is booked on 3740 (no VAT); paid_amount records the debt settled, not the cash moved. A difference of 1 kr or more is a partial and still returns SI_CASH_PARTIAL_UNSUPPORTED.
- Transaction must be negative (amount < 0). Positive returns MATCH_SI_NOT_EXPENSE.
- Supplier invoice must NOT be paid/credited already. paid/credited returns MATCH_SI_ALREADY_PAID; registered/approved/partially_paid/overdue are matchable.
- Idempotency-Key is mandatory.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{
  supplier_invoice_id: string,
  lines?: { account_number: string, debit_amount?: number, credit_amount?: number, line_description?: string }[]
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
    journal_entry_id: string | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
    "journal_entry_id": "je_…"
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
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  items: { transaction_id: string, categorization: { is_business: boolean, category?: "income_services" | "income_products" | "income_other" | "expense_equipment" | "expense_software" | "expense_travel" | "expense_office" | "expense_marketing" | "expense_professional_services" | "expense_education" | "expense_representation" | "expense_consumables" | "expense_vehicle" | "expense_telecom" | "expense_bank_fees" | "expense_card_fees" | "expense_currency_exchange" | "expense_other" | "private" | "uncategorized", template_id?: string, vat_treatment?: "standard_25" | "reduced_12" | "reduced_6" | "reverse_charge" | "export" | "exempt", vat_amount?: number, account_override?: string, counterparty_template_id?: string, dimensions?: Record<string, string>, user_description?: string, inbox_item_id?: string, confirm_no_match?: boolean, force?: boolean, expected_duplicate_transaction_id?: string, expected_duplicate_journal_entry_id?: string } }[],
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
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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

**Book several same-day SEK bank transactions as one samlingsverifikat.**
`scope:transactions:write · risk:high · idempotent · dry-run`

Books up to 200 transactions of the same date into ONE verifikat (samlingsverifikation, BFL 5 kap 6 §), in exactly one of three ways: existing_journal_entry_id links them to an already-posted voucher whose bank net equals their sum (nothing new is posted); template_id + mode + entry_description expands a booking template per row (one_line_per_tx) or on the sum (sum_per_account); manual_lines + entry_description posts caller-built balanced lines. SEK only. The dry run answers the lines and the signed sum (tx_sum). Idempotent. Dry-runnable.

**Use when:** Many small same-day rows of one kind (Swish sales, card fees, a daily settlement) should be one verifikat.
**Do not use for:** Rows on different dates, foreign-currency rows (book them one by one), or one row against invoices (POST /transactions/{id}/match-batch).

**Pitfalls:**
- All rows must share one date and direction, and currency SEK: BULK_BOOK_MIXED_CURRENCY / BULK_BOOK_FOREIGN_CURRENCY otherwise.
- A row that looks already booked returns 409 TRANSACTION_BOOK_POSSIBLE_DUPLICATE naming it; resend with force=true only after reviewing the candidate (each dismissal is logged in behandlingshistorik).
- manual_lines accounts must be active in the company's chart (BULK_BOOK_INVALID_ACCOUNT) and balance; amounts are kronor, account numbers strings.
- A posted samlingsverifikat is permanent: undo with storno (POST /journal-entries/{id}/reverse).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

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
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
- Content-based dedup runs in addition: a row matching an already-booked transaction by date, amount AND description (prefix-containment, to survive PSD2 title enrichment) is skipped even if external_id differs.
- raw_insert_only=true skips ALL post-insert pipeline steps (matching, categorization). Use for viewer-only imports.
- Max 500 items per call. For larger imports, split into pages of 500.
- Dry-run previews external_id + content dedup against BOOKED rows only; the live pipeline also dedups against unbooked bank-synced rows, so preview skips are a lower bound on the live skip count.

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
  raw_insert_only?: boolean
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
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
    "skipped_duplicates": 0
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```
