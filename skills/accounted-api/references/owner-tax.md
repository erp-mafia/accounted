<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Owner tax (Bolaget) endpoints

The K10 underlag per owner and income year under the 3:12 rules from 2026 (grundbelopp, lönebaserat utrymme, interest on the omkostnadsbelopp, dividend and sparat utdelningsutrymme, each line with its source), the owner loan register with the loan prohibition check (ABL 21 kap.), the 21:10 special list and the ledger reconciliation, and the KU20 status for interest paid to owners. Nothing books. The KU20 file carries personnummer and is downloaded in Accounted only. Every endpoint answers 404 BOLAGET_DISABLED outside the rollout.

Conventions (auth, envelope, pagination, dry-run, idempotency, standard errors)
are in SKILL.md and are not repeated per endpoint.

### `GET /api/v1/companies/{companyId}/k10/{year}`

**Read the K10 underlag per delägare for an inkomstår: gränsbelopp, lönebaserat utrymme, dividend and sparat utdelningsutrymme.**
`scope:payroll:read · risk:low · idempotent`

For every natural-person holder: shares at the start of the year (aktiebok), the grundbelopp (4 IBB split per share), the lönebaserat utrymme from the payroll's cash pay the year before (50 % of the owner's share above 8 IBB, at most 50 times their own pay), interest on the omkostnadsbelopp above 100 000 kr, the dividend received, and what is carried forward. Each line names its source. The 3:12 rules after SFS 2025:1361; inkomstår 2026 onward.

**Use when:** An owner asks how much dividend is taxed at 20 %, or prepares K10.
**Do not use for:** Deciding a dividend (POST /dividends) or the company's own tax (INK2).

**Pitfalls:**
- The owner files K10; this is the underlag. Figures the books do not hold (sparat utdelningsutrymme, an omkostnadsbelopp from before the aktiebok) are entered with PUT /k10/{year}/owners/{party_id}.
- supported false: the year's inkomstbasbelopp or statslåneränta is not in Accounted yet, or the year is before the 2026 rules.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `year` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    income_year: number,
    supported: boolean,
    supported_years: number[],
    unsupported_reason_sv: string | null,
    start_date: string,
    famansforetag: { value: boolean, confirmed: boolean, top_four_votes_pct: number },
    total_shares_at_start: number,
    payroll: { year: number, total: number, runs: number, opening_balance_amount: number, employees: number },
    owners: { party_id: string, name: string, identity: string | null, shares_at_start: number, dividend_received: number, inputs: { saved_dividend_space: number, cost_basis_override: number | null, payroll_base_override: number | null, own_pay_override: number | null, uses_basic_amount: boolean, note: string | null, updated_at: string | null }, inputs_saved: boolean, cost_basis: { register_amount: number, contributions_amount: number, amount: number, complete: boolean, gaps_sv: string[] }, result: { lines: { key: "ownership_share" | "basic_amount_company" | "basic_amount" | "payroll_base" | "payroll_owner_share" | "payroll_deduction" | "wage_space_before_cap" | "own_pay" | "own_pay_cap" | "wage_space" | "cost_basis" | "cost_basis_threshold" | "interest_rate" | "capital_interest" | "annual_limit" | "saved_space_brought_forward" | "total_limit" | "dividend" | "dividend_within_limit" | "dividend_capital_taxable" | "dividend_service" | "dividend_above_ceiling" | "saved_space_carried_forward", label_sv: string, amount: number, unit: "sek" | "percent", source: "register" | "payroll" | "ledger" | "owner" | "rule" | "computed", detail_sv: string }[], basic_amount: number, wage_space: number, capital_interest: number, annual_limit: number, total_limit: number, dividend: number, dividend_within_limit: number, dividend_service: number, dividend_above_ceiling: number, saved_space_carried_forward: number }, warnings: { code: string, message_sv: string }[] }[],
    company_holders: { party_id: string, name: string, shares: number }[]
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
    "income_year": 2026,
    "supported": true,
    "owners": [
      {
        "party_id": "9c1e…",
        "name": "Anna Ek",
        "result": {
          "total_limit": 750000,
          "saved_space_carried_forward": 650000
        }
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

### `PUT /api/v1/companies/{companyId}/k10/{year}/owners/{partyId}`

**Save what a delägare enters for the K10 underlag of a year: sparat utdelningsutrymme, an omkostnadsbelopp, a löneunderlag or own pay that differs from the payroll.**
`scope:companies:write · risk:low · idempotent · dry-run · reversible`

Upserts the owner's figures for the inkomstår (omitted fields keep their value; null clears an override) and answers the recomputed underlag. Nothing is booked or filed. Dry-runnable.

**Use when:** The owner gives last year's sparat utdelningsutrymme, or the K10 shows a warning that a figure is missing.
**Do not use for:** Changing the aktiebok or the payroll: correct them where they are kept.

**Pitfalls:**
- K10_OWNER_NOT_FOUND: the party held no shares at the start of the year and received no dividend in it.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `year` | path | `string` | yes |  |
| `partyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  saved_dividend_space?: number | null,
  cost_basis_override?: number | null,
  payroll_base_override?: number | null,
  own_pay_override?: number | null,
  uses_basic_amount?: boolean | null,
  note?: string | null
}
```

Example request:
```json
{
  "party_id": "9c1e…",
  "income_year": 2026,
  "saved_dividend_space": 120000
}
```

Response `200`:
```ts
{
  data: {
    party_id: string,
    income_year: number,
    inputs: { saved_dividend_space: number, cost_basis_override: number | null, payroll_base_override: number | null, own_pay_override: number | null, uses_basic_amount: boolean, note: string | null, updated_at: string | null },
    result: { lines: { key: "ownership_share" | "basic_amount_company" | "basic_amount" | "payroll_base" | "payroll_owner_share" | "payroll_deduction" | "wage_space_before_cap" | "own_pay" | "own_pay_cap" | "wage_space" | "cost_basis" | "cost_basis_threshold" | "interest_rate" | "capital_interest" | "annual_limit" | "saved_space_brought_forward" | "total_limit" | "dividend" | "dividend_within_limit" | "dividend_capital_taxable" | "dividend_service" | "dividend_above_ceiling" | "saved_space_carried_forward", label_sv: string, amount: number, unit: "sek" | "percent", source: "register" | "payroll" | "ledger" | "owner" | "rule" | "computed", detail_sv: string }[], basic_amount: number, wage_space: number, capital_interest: number, annual_limit: number, total_limit: number, dividend: number, dividend_within_limit: number, dividend_service: number, dividend_above_ceiling: number, saved_space_carried_forward: number } | null
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
    "party_id": "9c1e…",
    "income_year": 2026,
    "inputs": {
      "saved_dividend_space": 120000
    },
    "result": {
      "total_limit": 870000
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/ku20/{year}`

**Read the KU20 status of an inkomstår: interest the company paid to natural persons on their loans, the tax withheld, and what blocks the file.**
`scope:companies:read · risk:low · idempotent`

Per recipient the year's interest (field 503) and tax withheld (field 001) in whole kronor, whether field 061 is marked, the 30 % a fåmansföretag withholds on interest to a delägare, and the blockers. The file itself is downloaded in Accounted by an owner or administrator: it carries personnummer.

**Use when:** Before 31 January, to see whether KU20 for last year can be filed.
**Do not use for:** Getting the file: there is no machine door for it. KU31 (GET /ku31/{year}) for dividends.

**Pitfalls:**
- KU20_NO_RECIPIENTS: enter the year's interest per loan first (POST /owner-loans/{id}/interest).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `year` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    income_year: number,
    deadline: string,
    file_supported: boolean,
    famansforetag: { value: boolean, confirmed: boolean },
    recipients: { party_id: string, name: string, identity: string | null, interest: number, tax_withheld: number, reported_interest: number, reported_tax: number, delagare: boolean, expected_tax: number | null, reason: "personnummer_missing" | null }[],
    legal_person_interest: number,
    contact: { name: string | null, phone: string | null, email: string | null },
    blockers: { code: string, message_sv: string, party_id?: string }[],
    warnings: { code: string, message_sv: string, party_id?: string }[],
    ready: boolean
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
    "income_year": 2026,
    "deadline": "2027-01-31",
    "ready": false,
    "blockers": [
      {
        "code": "KU20_CONTACT_MISSING",
        "message_sv": "Ange kontaktperson…"
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

### `GET /api/v1/companies/{companyId}/owner-loans`

**Read the owner loan register: loans and security between the company and its owners, board, VD and related persons, with the låneförbud check and the ledger reconciliation.**
`scope:companies:read · risk:low · idempotent`

Every loan with its counterparty (name and masked identity), direction, BAS account, principal and outstanding, terms, the ABL 21 kap. assessment (in the circle, the exception, whether it goes on the 21:10 special list) and the interest per year; and per account, the register against the ledger balance on as_of. Read-only.

**Use when:** Before booking a payment to or from an owner, at year end, or when asked whether a loan to an owner is allowed.
**Do not use for:** Aktieägartillskott (GET /capital-events) or ordinary supplier debts.

**Pitfalls:**
- loan_ban.status prohibited is a warning: the check cannot see every relation; the person decides.
- A reconciliation difference means the register or the ledger needs an update; nothing is corrected automatically.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `as_of` | query | `string \| null` | no | The day to reconcile on (YYYY-MM-DD); today when omitted. |

Response `200`:
```ts
{
  data: {
    as_of: string,
    loans: { owner_loan_id: string, party: { party_id: string, name: string, kind: "person" | "company", identity: string | null }, related_to: { party_id: string, name: string } | null, kind: "loan" | "security", direction: "lends" | "borrows", relation: "none" | "group_insider" | "related_person" | "controlled_entity", relation_detail: string | null, account: string | null, principal: number, outstanding: number, interest_rate: number | null, start_date: string, maturity_date: string | null, terms: string | null, document_id: string | null, exception: "none" | "group_company" | "business_loan" | "dispensation", exception_note: string | null, status: "active" | "repaid" | "cancelled", repaid_on: string | null, note: string | null, loan_ban: { status: "not_applicable" | "outside_circle" | "exception" | "prohibited", circle: ("holder" | "board" | "ceo" | "group_insider" | "related_person" | "controlled_entity")[], exception: "group_company" | "business_loan" | "dispensation" | "small_holding" | null, special_list: boolean, warnings: { code: string, message_sv: string, message_en: string }[] }, interest: { income_year: number, interest_amount: number, tax_withheld: number }[] }[],
    reconciliation: { account: string, register_amount: number, ledger_amount: number | null, difference: number | null, matches: boolean | null, owner_loan_ids: string[] }[],
    flagged: number
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
    "as_of": "2026-12-31",
    "loans": [
      {
        "owner_loan_id": "2f4a…",
        "direction": "borrows",
        "account": "2893",
        "outstanding": 200000
      }
    ],
    "reconciliation": [
      {
        "account": "2893",
        "register_amount": 200000,
        "ledger_amount": 200000,
        "matches": true
      }
    ],
    "flagged": 0
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/owner-loans`

**Register a loan between the company and an owner, board member, VD or related person, or security the company gave for one; checked against the låneförbud (ABL 21 kap.).**
`scope:companies:write · risk:medium · idempotent · dry-run`

Records the counterparty, direction, BAS account (1685 or 2893 when omitted), principal, interest, terms and the exception claimed. A loan from the company to someone in the ABL 21:1 circle without an exception is warned about (LOAN_BAN_PROHIBITED), never refused. Nothing is booked: the payout is booked as any verifikat. Dry-runnable.

**Use when:** An owner lends money to the company, or the company lends to or guarantees for an insider.
**Do not use for:** Aktieägartillskott (POST /shareholder-contributions) or dividends.

**Pitfalls:**
- OWNER_LOAN_ACCOUNT_INVALID: a loan the company gives sits on 1360-1368 or 1680-1689, one it takes on 2390-2399 or 2890-2899.
- A personnummer is never sent: name a new person, and the personnummer is added in Accounted.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  party_id?: string | null,
  party_name?: string | null,
  party_kind?: "person" | "company" | null,
  party_org_number?: string | null,
  kind?: "loan" | "security" | null,
  direction: "lends" | "borrows",
  relation?: "none" | "group_insider" | "related_person" | "controlled_entity" | null,
  related_to_party_id?: string | null,
  relation_detail?: string | null,
  account?: string | null,
  principal: number,
  outstanding?: number | null,
  interest_rate?: number | null,
  start_date: string,
  maturity_date?: string | null,
  terms?: string | null,
  document_id?: string | null,
  exception?: "none" | "group_company" | "business_loan" | "dispensation" | null,
  exception_note?: string | null,
  note?: string | null
}
```

Example request:
```json
{
  "party_id": "9c1e…",
  "direction": "borrows",
  "principal": 200000,
  "interest_rate": 5,
  "start_date": "2026-03-01"
}
```

Response `200`:
```ts
{
  data: {
    owner_loan_id: string,
    party_id: string,
    kind: "loan" | "security",
    direction: "lends" | "borrows",
    account: string | null,
    principal: number,
    outstanding: number,
    loan_ban: { status: "not_applicable" | "outside_circle" | "exception" | "prohibited", exception: "group_company" | "business_loan" | "dispensation" | "small_holding" | null, special_list: boolean }
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
    "owner_loan_id": "2f4a…",
    "party_id": "9c1e…",
    "kind": "loan",
    "direction": "borrows",
    "account": "2893",
    "principal": 200000,
    "outstanding": 200000,
    "loan_ban": {
      "status": "not_applicable",
      "exception": null,
      "special_list": false
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/owner-loans/{id}`

**Update an owner loan: outstanding after a repayment, terms, the exception claimed, or mark it repaid or cancelled.**
`scope:companies:write · risk:medium · idempotent · dry-run`

Changes only what is sent (null clears a field). Status repaid needs repaid_on and sets outstanding to 0; cancelled is for a loan registered by mistake and is final. The låneförbud check runs again and warns. Nothing is booked. Dry-runnable.

**Use when:** An owner loan was partly or fully repaid, or its terms changed.
**Do not use for:** The year's interest (POST /owner-loans/{id}/interest).

**Pitfalls:**
- OWNER_LOAN_STATUS_INVALID: a cancelled loan does not change.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  relation?: "none" | "group_insider" | "related_person" | "controlled_entity" | null,
  related_to_party_id?: string | null,
  relation_detail?: string | null,
  account?: string | null,
  principal?: number | null,
  outstanding?: number | null,
  interest_rate?: number | null,
  maturity_date?: string | null,
  terms?: string | null,
  document_id?: string | null,
  exception?: "none" | "group_company" | "business_loan" | "dispensation" | null,
  exception_note?: string | null,
  status?: "active" | "repaid" | "cancelled" | null,
  repaid_on?: string | null,
  note?: string | null
}
```

Example request:
```json
{
  "owner_loan_id": "2f4a…",
  "status": "repaid",
  "repaid_on": "2026-11-30"
}
```

Response `200`:
```ts
{
  data: {
    owner_loan_id: string,
    status: "active" | "repaid" | "cancelled",
    outstanding: number,
    loan_ban: { status: "not_applicable" | "outside_circle" | "exception" | "prohibited", exception: "group_company" | "business_loan" | "dispensation" | "small_holding" | null, special_list: boolean }
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
    "owner_loan_id": "2f4a…",
    "status": "repaid",
    "outstanding": 0,
    "loan_ban": {
      "status": "not_applicable",
      "exception": null,
      "special_list": false
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/owner-loans/{id}/interest`

**Record the interest on an owner loan for an inkomstår and the tax withheld: the figures KU20 reports.**
`scope:companies:write · risk:low · idempotent · dry-run · reversible`

Upserts the year's interest paid (company borrows) or received (company lends) and the preliminary tax withheld. Warns when a fåmansföretag did not withhold 30 % on interest to a delägare (SFL 10:15). Nothing is booked. Dry-runnable.

**Use when:** At year end, before KU20, or when the interest was paid.
**Do not use for:** Booking the interest (a verifikat on 8400-8499 or 8300-8399).

**Pitfalls:**
- The tax withheld cannot exceed the interest.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{ income_year: number, interest_amount: number, tax_withheld?: number | null, note?: string | null }
```

Example request:
```json
{
  "owner_loan_id": "2f4a…",
  "income_year": 2026,
  "interest_amount": 8000,
  "tax_withheld": 2400
}
```

Response `200`:
```ts
{
  data: { owner_loan_id: string, income_year: number, interest_amount: number, tax_withheld: number },
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
    "owner_loan_id": "2f4a…",
    "income_year": 2026,
    "interest_amount": 8000,
    "tax_withheld": 2400
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```
