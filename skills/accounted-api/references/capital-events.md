<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Capital events (Bolaget) endpoints

Dividends from the stämma decision to the payout, split per holder from the aktiebok and checked against fritt eget kapital (ABL 17:3), the KU31 status per income year, aktieägartillskott (K2 15.5-15.6) and nyemission, fondemission and minskning av aktiekapitalet with their Bolagsverket deadlines. Every booking posts through the bookkeeping engine and is high risk. The KU31 file itself carries personnummer and is downloaded in Accounted only. Every endpoint answers 404 BOLAGET_DISABLED outside the rollout.

Conventions (auth, envelope, pagination, dry-run, idempotency, standard errors)
are in SKILL.md and are not repeated per endpoint.

### `POST /api/v1/companies/{companyId}/capital-changes`

**Record a nyemission, fondemission or minskning av aktiekapitalet, with its allotment and its filing deadlines.**
`scope:companies:write · risk:medium · idempotent · dry-run`

Records the decision and the change of aktiekapital (kvotvärde x shares when omitted). A nyemission's allotment goes into the aktiebok genast (ABL 13:18). Raises the deadlines: nyemission 6 months (13:27), fondemission genast (12:10), minskning 4 months (20:19) and the notice to the holders (20:18). Nothing is booked: POST /capital-changes/{id}/book. Dry-runnable.

**Use when:** The stämma (or the board under an authorisation) decided to change the aktiekapital.
**Do not use for:** A share transfer (POST /share-register/events) or a dividend (POST /dividends).

**Pitfalls:**
- The allotment must add up to share_count.
- Fondemission and minskning shares are entered in the aktiebok after registration.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  kind: "nyemission" | "fondemission" | "minskning",
  decided_on: string,
  decided_by: "arsstamma" | "extra_stamma" | "styrelse",
  decision_id?: string | null,
  document_id?: string | null,
  share_class_id?: string | null,
  share_count: number,
  share_capital_amount?: number | null,
  price_per_share?: number | null,
  subscription_start?: string | null,
  subscription_end?: string | null,
  source_account?: "2085" | "2086" | "2091" | "2097" | null,
  purpose?: "forlusttackning" | "aterbetalning" | "fri_fond" | null,
  allotments?: { party_id?: string | null, name?: string | null, kind?: "person" | "company" | null, org_number?: string | null, share_count: number }[] | null,
  allotted_on?: string | null,
  note?: string | null
}
```

Example request:
```json
{
  "kind": "nyemission",
  "decided_on": "2026-09-01",
  "decided_by": "extra_stamma",
  "share_count": 100,
  "price_per_share": 1000,
  "allotments": [
    {
      "party_id": "9c1e…",
      "share_count": 100
    }
  ]
}
```

Response `200`:
```ts
{
  data: {
    capital_change_id: string,
    kind: "nyemission" | "fondemission" | "minskning",
    share_capital_amount: number,
    premium_amount: number,
    share_register_event_ids: string[]
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
    "capital_change_id": "5e6f…",
    "kind": "nyemission",
    "share_capital_amount": 2500,
    "premium_amount": 97500,
    "share_register_event_ids": [
      "7a2b…"
    ]
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/capital-changes/{id}/book`

**Book a capital change: a nyemission's payment (D bank / K 2082, 2097), or the registration of any change.**
`scope:bookkeeping:write · risk:high · idempotent · dry-run`

step payment (nyemission only): D bank / K 2082 Ej registrerat aktiekapital and 2097 Fri överkursfond. step registration on the Bolagsverket registration day: nyemission D 2082 / K 2081 (13:29; payment must be booked first, 13:28), fondemission D the fund / K 2081 (12:10), minskning D 2081 / K 2091 or 2890 (20:20). Dry-runnable.

**Use when:** The subscription money came in, or Bolagsverket registered the change.
**Do not use for:** Recording the decision (POST /capital-changes).

**Pitfalls:**
- CAPITAL_CHANGE_NOT_PAID: book the payment before the registration.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{ step: "payment" | "registration", date: string, bank_account?: string | null }
```

Example request:
```json
{
  "capital_change_id": "5e6f…",
  "step": "registration",
  "date": "2026-10-01"
}
```

Response `200`:
```ts
{
  data: {
    capital_change_id: string,
    step: "payment" | "registration",
    journal_entry_id: string,
    status: "decided" | "registered" | "cancelled"
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
    "capital_change_id": "5e6f…",
    "step": "registration",
    "journal_entry_id": "7a2b…",
    "status": "registered"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/capital-events`

**Read the capital events: dividends with the split per holder, aktieägartillskott, and nyemission, fondemission and minskning.**
`scope:companies:read · risk:low · idempotent`

Every dividend from the stämma decision to the payout (status decided, booked, paid) with each holder's part from the aktiebok on the decisive day; every aktieägartillskott, villkorat or not, and its repayments; every change of aktiekapital with its registration. Names and masked identities only.

**Use when:** You need what was paid to whom, the dividends of a year, or whether an emission is registered and paid.
**Do not use for:** The aktiebok (GET /share-register) or the KU31 status of a year (GET /ku31/{year}).

**Pitfalls:**
- A dividend with status decided is not booked yet: nothing is in the ledger.
- has_personnummer false means KU31 cannot be made until the personnummer is added in Accounted.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    dividends: { dividend_id: string, decided_on: string, decided_by: "arsstamma" | "extra_stamma", origin: "register" | "ledger", status: "decided" | "booked" | "paid" | "cancelled", amount_per_share: number | null, total_amount: number, record_date: string, record_date_basis: "decision_date" | "payment_date" | "other", payment_date: string, paid_on: string | null, source_account: string | null, prudence_confirmed: boolean, decision_id: string | null, decision_entry_id: string | null, payout_entry_id: string | null, note: string | null, holders: { party_id: string, name: string, kind: "person" | "company", identity: string | null, has_personnummer: boolean | null, share_count: number, amount: number }[] }[],
    contributions: { shareholder_contribution_id: string, kind: "contribution" | "repayment", party_id: string, name: string, holder_kind: "person" | "company", identity: string | null, has_personnummer: boolean | null, promised_on: string, amount: number, conditional: boolean, repays_contribution_id: string | null, decided_on: string | null, decided_by: string | null, decision_id: string | null, counter_account: string, journal_entry_id: string | null, status: "registered" | "booked" | "cancelled", note: string | null }[],
    capital_changes: { capital_change_id: string, kind: "nyemission" | "fondemission" | "minskning", kind_label: string, decided_on: string, decided_by: "arsstamma" | "extra_stamma" | "styrelse", decision_id: string | null, share_count: number, share_capital_amount: number, price_per_share: number | null, premium_amount: number, source_account: string | null, purpose: string | null, target_account: string | null, registered_on: string | null, payment_entry_id: string | null, registration_entry_id: string | null, status: "decided" | "registered" | "cancelled", allotments: { party_id: string | null, name: string, share_count: number, amount: number, share_register_event_id: string | null }[], note: string | null }[]
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
    "dividends": [
      {
        "dividend_id": "4d1e…",
        "decided_on": "2026-05-01",
        "status": "paid",
        "total_amount": 100000,
        "holders": [
          {
            "name": "Anna Ek",
            "amount": 100000
          }
        ]
      }
    ],
    "contributions": [],
    "capital_changes": []
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/dividends`

**Record a dividend decided by the bolagsstämma and split it over the holders of the aktiebok.**
`scope:companies:write · risk:medium · idempotent · dry-run`

Records the decision (amount per share or a total, betalningsdag, which day decides the recipients) and one part per holder from the aktiebok on that day, rounded to the öre (a total is split by largest remainder). Checks it against fritt eget kapital on the last balance sheet less later transfers (ABL 17:3) and warns. Nothing is booked: book it with POST /dividends/{id}/book. Dry-runnable.

**Use when:** The stämma decided a dividend.
**Do not use for:** Booking (POST /dividends/{id}/book) or a dividend already in the ledger before the aktiebok existed (the "who received" step in Accounted).

**Pitfalls:**
- DIVIDEND_NO_HOLDERS: the aktiebok has no holders on the decisive day; register the shares first.
- A warning DIVIDEND_EXCEEDS_FREE_EQUITY means booking will be refused (ABL 17:3).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  decided_on: string,
  decided_by: "arsstamma" | "extra_stamma",
  decision_id?: string | null,
  document_id?: string | null,
  amount_per_share?: number | null,
  total_amount?: number | null,
  share_class_ids?: string[] | null,
  record_date_basis?: "decision_date" | "payment_date" | "other" | null,
  record_date?: string | null,
  payment_date?: string | null,
  prudence_confirmed?: boolean | null,
  note?: string | null
}
```

Example request:
```json
{
  "decided_on": "2026-05-01",
  "decided_by": "arsstamma",
  "amount_per_share": 100,
  "payment_date": "2026-05-15",
  "prudence_confirmed": true
}
```

Response `200`:
```ts
{
  data: {
    dividend_id: string,
    status: "decided" | "booked" | "paid" | "cancelled",
    total_amount: number,
    record_date: string,
    payment_date: string,
    distributions: { party_id: string, share_count: number, amount: number }[]
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
    "dividend_id": "4d1e…",
    "status": "decided",
    "total_amount": 100000,
    "record_date": "2026-05-01",
    "payment_date": "2026-05-15",
    "distributions": [
      {
        "party_id": "9c1e…",
        "share_count": 1000,
        "amount": 100000
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

### `POST /api/v1/companies/{companyId}/dividends/{id}/book`

**Book a decided dividend: D 2098 (or 2091) / K 2898 on the decision day, and freeze the split per holder.**
`scope:bookkeeping:write · risk:high · idempotent · dry-run`

Posts the decision through the bookkeeping engine on the decision day: debit 2098 Vinst eller förlust från föregående år while it holds the amount, else 2091 Balanserat resultat, credit 2898 Outtagen vinstutdelning. The split is refreshed from the aktiebok once more and then frozen. Refused above the fritt eget kapital (ABL 17:3) and in a locked period. Dry-runnable.

**Use when:** A dividend is recorded with status decided.
**Do not use for:** The payout (POST /dividends/{id}/pay).

**Pitfalls:**
- DIVIDEND_EXCEEDS_FREE_EQUITY: lower the dividend; the stämma must decide again.
- A locked or closed period refuses the posting; the decision day decides the period.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{ source_account?: "2091" | "2098" | null, prudence_confirmed?: boolean | null }
```

Example request:
```json
{
  "dividend_id": "4d1e…"
}
```

Response `200`:
```ts
{
  data: {
    dividend_id: string,
    status: "decided" | "booked" | "paid" | "cancelled",
    decision_entry_id: string,
    source_account: "2091" | "2098",
    total_amount: number
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
    "dividend_id": "4d1e…",
    "status": "booked",
    "decision_entry_id": "7a2b…",
    "source_account": "2098",
    "total_amount": 100000
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/dividends/{id}/pay`

**Mark a booked dividend paid: book D 2898 / K bank, or link the payout verifikat already booked from the bank.**
`scope:bookkeeping:write · risk:high · idempotent · dry-run`

Posts the payout through the engine on paid_on (the betalningsdag when omitted), or, with journal_entry_id, links a posted verifikat that debits 2898 instead of booking a second one. The KU31 deadline for the year is raised. Dry-runnable.

**Use when:** The dividend left the bank.
**Do not use for:** A dividend not yet booked (POST /dividends/{id}/book first).

**Pitfalls:**
- DIVIDEND_PAYOUT_ENTRY_INVALID: the linked verifikat is not posted or does not debit 2898.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{ paid_on?: string | null, bank_account?: string | null, journal_entry_id?: string | null }
```

Example request:
```json
{
  "dividend_id": "4d1e…",
  "paid_on": "2026-05-15"
}
```

Response `200`:
```ts
{
  data: {
    dividend_id: string,
    status: "decided" | "booked" | "paid" | "cancelled",
    payout_entry_id: string,
    paid_on: string,
    linked: boolean
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
    "dividend_id": "4d1e…",
    "status": "paid",
    "payout_entry_id": "8c3d…",
    "paid_on": "2026-05-15",
    "linked": false
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/ku31/{year}`

**Read the KU31 status of an inkomstår: who received a dividend, what is reported, what still blocks the file.**
`scope:companies:read · risk:low · idempotent`

The dividends with a betalningsdag in the year (booked or paid), each recipient with the amount and the whole kronor field 574 reports, who is left out (Swedish legal persons), the fåmansföretag answer (field 061 or 062) and the blockers. The file itself is downloaded in Accounted by an owner or administrator: it carries personnummer.

**Use when:** Before 31 January, to see whether KU31 for last year can be filed and what is missing.
**Do not use for:** Getting the file: there is no machine door for it.

**Pitfalls:**
- KU31_PERSONNUMMER_MISSING: the person's personnummer is added in Accounted (Aktiebok), never through the API.

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
    schema_version: string,
    file_supported: boolean,
    dividends: { dividend_id: string, decided_on: string, payment_date: string, status: string, total_amount: number, origin: string }[],
    unbooked_dividends: number,
    recipients: { party_id: string, name: string, kind: "person" | "company", identity: string | null, amount: number, reported_amount: number, reported: boolean, reason: "legal_person" | "personnummer_missing" | null }[],
    famansforetag: boolean | null,
    famansforetag_derivation: { derived: boolean, top_four_votes_pct: number, holders: number },
    contact: { name: string | null, phone: string | null, email: string | null },
    last_generated_at: string | null,
    blockers: { code: string, message_sv: string, party_id?: string }[],
    ready: boolean
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
    "income_year": 2026,
    "deadline": "2027-01-31",
    "ready": false,
    "blockers": [
      {
        "code": "KU31_FAMANS_UNANSWERED",
        "message_sv": "Svara på om bolaget är ett fåmansföretag..."
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

### `POST /api/v1/companies/{companyId}/shareholder-contributions`

**Register and book an aktieägartillskott (villkorat or ovillkorat), or the repayment of a villkorat one.**
`scope:bookkeeping:write · risk:high · idempotent · dry-run`

A tillskott is booked to balanserat resultat when promised (K2 15.5): D bank (or 1685 while only promised) / K 2093 Erhållna aktieägartillskott. A repayment of a villkorat tillskott (K2 15.6) books D 2093 / K bank and warns without a stämma decision or above fritt eget kapital. Name the shareholder by party_id or by name. Dry-runnable.

**Use when:** A shareholder put money into the company without shares or a loan, or a villkorat tillskott is repaid.
**Do not use for:** A loan from the owner (a liability on 2393/2893) or a nyemission (POST /capital-changes).

**Pitfalls:**
- CONTRIBUTION_NOT_CONDITIONAL: only a villkorat tillskott is repaid.
- CONTRIBUTION_REPAYMENT_EXCEEDS: more than what is left of the tillskott.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  kind?: "contribution" | "repayment" | null,
  party_id?: string | null,
  holder_name?: string | null,
  holder_kind?: "person" | "company" | null,
  holder_org_number?: string | null,
  promised_on: string,
  amount: number,
  conditional?: boolean | null,
  repays_contribution_id?: string | null,
  decided_on?: string | null,
  decided_by?: "arsstamma" | "extra_stamma" | "styrelse" | null,
  decision_id?: string | null,
  document_id?: string | null,
  counter_account?: string | null,
  note?: string | null
}
```

Example request:
```json
{
  "party_id": "9c1e…",
  "promised_on": "2026-03-01",
  "amount": 50000,
  "conditional": true
}
```

Response `200`:
```ts
{
  data: {
    shareholder_contribution_id: string,
    kind: "contribution" | "repayment",
    party_id: string,
    amount: number,
    journal_entry_id: string
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
    "shareholder_contribution_id": "2f4a…",
    "kind": "contribution",
    "party_id": "9c1e…",
    "amount": 50000,
    "journal_entry_id": "7a2b…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```
