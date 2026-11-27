<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Company registers (Bolaget) endpoints

The aktiebok (share register, ABL 5 kap.) as of any date with its dated history, the share classes and their förbehåll, the board, VD, firmatecknare and revisor over time with the firmateckning, and the verkliga huvudmän derived from the aktiebok. Entries are permanent (a mistake is voided by a rattelse entry); a personnummer is never sent here, it is completed in Accounted. Meetings (corporate-meetings) hold the stämmor and board meetings with their decisions and minutes; an adopted election changes the roles when a person signs the minutes in Accounted. Every endpoint answers 404 BOLAGET_DISABLED outside the rollout.

Conventions (auth, envelope, pagination, dry-run, idempotency, standard errors)
are in SKILL.md and are not repeated per endpoint.

### `GET /api/v1/companies/{companyId}/beneficial-owners`

**Read the verkliga huvudmän: the proposal from the aktiebok, the confirmed set and the record of assessments.**
`scope:companies:read · risk:low · idempotent`

The proposal names every natural person with more than 25 % of the votes (LRVH 1:3) and lists companies above 25 % for investigation. Close family holdings (1:5) and control by agreement are for the company to confirm. differs is true when a new assessment is due.

**Use when:** A bank asks for the company's beneficial owners, or ownership has changed.
**Do not use for:** Filing with Bolagsverket: that is done in Bolagsverket's e-service (filing_url) by an authorised representative.

**Pitfalls:**
- The proposal is not the answer: a person confirms it with accounted_confirm_beneficial_owners.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `as_of` | query | `string` | no | The day the answer is for (YYYY-MM-DD). Default today. |

Response `200`:
```ts
{
  data: {
    proposal: { as_of: string, owners: { party_id: string, name: string, kind: "person" | "company", votes_pct: number, capital_pct: number, extent: string }[], indirect: { party_id: string, name: string, kind: "person" | "company", votes_pct: number, capital_pct: number, extent: string }[], conclusion: "owners_identified" | "no_beneficial_owner" },
    confirmed: { company_role_id: string, party_id: string, name: string, extent: string | null, valid_from: string | null }[],
    assessments: { beneficial_owner_assessment_id: string, assessed_on: string, basis: string, conclusion: "owners_identified" | "no_beneficial_owner", owners: (Record<string, unknown>)[], family_aggregation_checked: boolean, family_note: string | null, control_agreements: boolean, control_note: string | null, changed: boolean, created_at: string }[],
    differs: boolean,
    filing_url: string
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
    "proposal": {
      "owners": [
        {
          "name": "Anna Ek",
          "votes_pct": 60
        }
      ],
      "conclusion": "owners_identified"
    },
    "differs": true
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/beneficial-owners/assessments`

**Record an assessment of the verkliga huvudmän (LRVH 2:1): who they are and why, or that there is none.**
`scope:companies:write · risk:medium · idempotent · dry-run`

Keeps the dated record (basis, conclusion, family holdings checked, control agreements), brings the verklig_huvudman roles in line, and when the set changed adds a deadline to file the change with Bolagsverket without delay (LRVH 2:3). Dry-runnable.

**Use when:** After accounted_get_beneficial_owners, once the person has confirmed the owners.
**Do not use for:** Filing with Bolagsverket: an authorised representative files in Bolagsverket's e-service.

**Pitfalls:**
- A verklig huvudman is always a natural person: a company party is refused.
- owners must be empty for no_beneficial_owner and not empty for owners_identified.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  assessed_on: string,
  conclusion: "owners_identified" | "no_beneficial_owner",
  owners: { party_id: string, extent?: string | null, control?: "votes" | "indirect" | "agreement" | "board_appointment" | "other" | null }[],
  basis?: string | null,
  family_aggregation_checked: boolean,
  family_note?: string | null,
  control_agreements: boolean,
  control_note?: string | null
}
```

Example request:
```json
{
  "assessed_on": "2026-10-29",
  "conclusion": "owners_identified",
  "owners": [
    {
      "party_id": "9c1e…"
    }
  ],
  "family_aggregation_checked": true,
  "control_agreements": false
}
```

Response `200`:
```ts
{
  data: {
    beneficial_owner_assessment_id: string,
    changed: boolean,
    ended_role_ids: string[],
    added_role_ids: string[],
    deadline_source_key: string | null,
    filing_url: string
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
    "beneficial_owner_assessment_id": "3e7f…",
    "changed": true,
    "ended_role_ids": [],
    "added_role_ids": [
      "8d2a…"
    ],
    "deadline_source_key": "bolaget:verklig-huvudman:3e7f…",
    "filing_url": "https://bolagsverket.se/…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/company-roles`

**List the company's roles over time (board, VD, firmatecknare, revisor, verkliga huvudmän) and the firmateckning.**
`scope:companies:read · risk:low · idempotent`

Every role with valid_from and valid_to, and whether it holds on as_of; the firmateckning text in force. The first read for a company without roles seeds them from the registry data Accounted already holds (no registry call).

**Use when:** You need who is on the board, who is VD, who signs for the company or who the beneficial owners are.
**Do not use for:** Shareholdings (GET /share-register).

**Pitfalls:**
- A role with source registry_tic came from the registry snapshot; check it against Bolagsverket before relying on it for a filing.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `as_of` | query | `string` | no | The day the answer is for (YYYY-MM-DD). Default today. |

Response `200`:
```ts
{
  data: {
    as_of: string,
    signatory_rule: string | null,
    roles: { company_role_id: string, party_id: string, name: string, kind: "person" | "company", identity: string | null, role: "styrelseledamot" | "styrelseordforande" | "styrelsesuppleant" | "vd" | "vice_vd" | "sarskild_firmatecknare" | "revisor" | "huvudansvarig_revisor" | "revisorssuppleant" | "verklig_huvudman" | "kontaktperson", role_label: string, valid_from: string | null, valid_to: string | null, active: boolean, source: "registry_tic" | "person" | "decision" | "document", registered_at: string | null, decision_id: string | null, details: Record<string, unknown> }[],
    signatory_rules: { signatory_rule_id: string, rule_text: string, valid_from: string | null, valid_to: string | null, active: boolean, source: "registry_tic" | "person" | "decision" | "document", registered_at: string | null }[]
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
    "as_of": "2026-10-29",
    "signatory_rule": "Firman tecknas av styrelsen",
    "roles": [
      {
        "company_role_id": "1f3c…",
        "name": "Anna Ek",
        "role": "styrelseledamot",
        "active": true
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

### `POST /api/v1/companies/{companyId}/company-roles`

**Add a role from a date: board member, chair, suppleant, VD, vice VD, firmatecknare, revisor or contact person.**
`scope:companies:write · risk:low · idempotent · dry-run`

A role is end-dated, never deleted (POST /company-roles/{id}/end). The same person can hold several roles. A board change takes effect when Bolagsverket has the notice (ABL 8:13): registered_at records when. Dry-runnable.

**Use when:** The stämma elected a board member, the board appointed a VD, or a firmatecknare was added.
**Do not use for:** Verkliga huvudmän (POST /beneficial-owners/assessments records them with the LRVH 2:1 record).

**Pitfalls:**
- COMPANY_ROLE_DUPLICATE: the person already holds that role.
- Filing the change with Bolagsverket is done at verksamt.se.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  party_id?: string | null,
  name?: string | null,
  kind?: "person" | "company" | null,
  org_number?: string | null,
  role: "styrelseledamot" | "styrelseordforande" | "styrelsesuppleant" | "vd" | "vice_vd" | "sarskild_firmatecknare" | "revisor" | "huvudansvarig_revisor" | "revisorssuppleant" | "kontaktperson",
  valid_from: string,
  registered_at?: string | null,
  decision_id?: string | null
}
```

Example request:
```json
{
  "name": "Bo Ek",
  "role": "styrelseledamot",
  "valid_from": "2026-06-15"
}
```

Response `200`:
```ts
{
  data: { company_role_id: string, party_id: string, role: string, valid_from: string | null },
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
    "company_role_id": "1f3c…",
    "party_id": "9c1e…",
    "role": "styrelseledamot",
    "valid_from": "2026-06-15"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/company-roles/{id}/end`

**End a role on a date (the last day in it). The row is kept.**
`scope:companies:write · risk:low · idempotent · dry-run`

An ended role cannot be ended again; the history stays for the records. Dry-runnable.

**Use when:** A board member left, a VD resigned, a revisor was replaced.
**Do not use for:** Removing a wrongly entered role: end it on its start date and add the right one.

**Pitfalls:**
- COMPANY_ROLE_ALREADY_ENDED.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{ valid_to: string, end_reason?: string | null }
```

Example request:
```json
{
  "valid_to": "2026-06-14"
}
```

Response `200`:
```ts
{
  data: { company_role_id: string, valid_to: string },
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
    "company_role_id": "1f3c…",
    "valid_to": "2026-06-14"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/corporate-meetings`

**List the company's bolagsstämmor, styrelsemöten and per capsulam decisions, newest first.**
`scope:companies:read · risk:low · idempotent`

Each meeting with its kind, date, place, status (draft, held, signed) and board minutes number (ABL 8:26). Filter by kind or fiscal year.

**Use when:** You need the company's meetings, the årsstämma for a year, or the latest board minutes.
**Do not use for:** The decisions and minutes of one meeting (GET /corporate-meetings/{id}).

**Pitfalls:**
- A draft is a plan; only held and signed meetings took place.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `kind` | query | `"arsstamma" \| "extra_stamma" \| "styrelsemote" \| "per_capsulam"` | no | arsstamma, extra_stamma, styrelsemote or per_capsulam. |
| `fiscal_period_id` | query | `string` | no | An årsstämma's fiscal year. |

Response `200`:
```ts
{
  data: {
    meetings: { corporate_meeting_id: string, kind: "arsstamma" | "extra_stamma" | "styrelsemote" | "per_capsulam", kind_label: string, organ: "bolagsstamma" | "styrelse", title: string, sequence_number: number | null, meeting_date: string, place: string | null, is_digital: boolean, status: "draft" | "held" | "signed", fiscal_period_id: string | null, signing_pending: boolean, signed_at: string | null }[]
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
    "meetings": [
      {
        "corporate_meeting_id": "4b1e…",
        "kind": "arsstamma",
        "title": "Årsstämma 2027-05-10",
        "status": "signed"
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

### `POST /api/v1/companies/{companyId}/corporate-meetings`

**Plan a meeting: an årsstämma (prefilled from the årsredovisning and the roles), an extra stämma, a styrelsemöte or a per capsulam decision.**
`scope:companies:write · risk:low · idempotent · dry-run`

Creates a draft with its agenda. An årsstämma gets fastställande of the resultat- and balansräkning, the disposition and proposed dividend from the årsredovisning, ansvarsfrihet for the board and VD in office during the year, re-election of the board and revisor, and fees (ABL 7:11). A stämma gets the röstlängd from the aktiebok on the meeting day. Deadlines follow (kallelse, minutes within two weeks). Dry-runnable.

**Use when:** The company is to hold a stämma or a board meeting, or the owners decide per capsulam.
**Do not use for:** Recording a decision on an existing meeting (POST /corporate-meetings/{id}/decisions).

**Pitfalls:**
- CORPORATE_MEETING_FISCAL_PERIOD_REQUIRED: an årsstämma needs fiscal_period_id.
- BOLAGET_PERSONNUMMER_IN_APP_ONLY: a personnummer was sent; name the person.
- A per capsulam stämma decision has no ABL rule; every shareholder signs it.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  kind: "arsstamma" | "extra_stamma" | "styrelsemote" | "per_capsulam",
  organ?: "bolagsstamma" | "styrelse" | null,
  meeting_date: string,
  is_digital?: boolean | null,
  use_template?: boolean | null,
  meeting_time?: string | null,
  place?: string | null,
  chair_party_id?: string | null,
  chair_name?: string | null,
  secretary_party_id?: string | null,
  secretary_name?: string | null,
  adjuster_party_ids?: string[] | null,
  adjuster_names?: string[] | null,
  kallelse_date?: string | null,
  kallelse_method?: string | null,
  fiscal_period_id?: string | null,
  notes?: string | null
}
```

Example request:
```json
{
  "kind": "arsstamma",
  "meeting_date": "2027-05-10",
  "fiscal_period_id": "7c2a…",
  "place": "Bolagets kontor"
}
```

Response `200`:
```ts
{
  data: {
    corporate_meeting_id: string,
    kind: "arsstamma" | "extra_stamma" | "styrelsemote" | "per_capsulam",
    organ: "bolagsstamma" | "styrelse",
    meeting_date: string,
    status: "draft",
    decisions_count: number
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
    "corporate_meeting_id": "4b1e…",
    "kind": "arsstamma",
    "organ": "bolagsstamma",
    "meeting_date": "2027-05-10",
    "status": "draft",
    "decisions_count": 15
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/corporate-meetings/{id}`

**Read one meeting: its minutes paragraph by paragraph, röstlängd, attendance, signers, effects on the roles and warnings.**
`scope:companies:read · risk:low · idempotent`

Each decision with its terms (payload) and the sentence the minutes print; the röstlängd from the aktiebok on the meeting day (ABL 7:48); who signs (protokollförare, ordförande, justerare, or all shareholders per capsulam); the role changes an adopted election makes when the minutes are signed; and what a person should check (warnings).

**Use when:** You need what a stämma or the board decided, the dividend per share and betalningsdag, or what is missing before signing.
**Do not use for:** Signing the minutes: a person signs with BankID or uploads the signed copy in Accounted.

**Pitfalls:**
- Names only: no personnummer, no email addresses.
- register_effects.planned is a preview until the minutes are signed.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    corporate_meeting_id: string,
    kind: "arsstamma" | "extra_stamma" | "styrelsemote" | "per_capsulam",
    kind_label: string,
    organ: "bolagsstamma" | "styrelse",
    title: string,
    sequence_number: number | null,
    meeting_date: string,
    place: string | null,
    is_digital: boolean,
    status: "draft" | "held" | "signed",
    fiscal_period_id: string | null,
    signing_pending: boolean,
    signed_at: string | null,
    meeting_time: string | null,
    chair: { party_id: string, name: string } | null,
    secretary: { party_id: string, name: string } | null,
    adjusters: { party_id: string, name: string }[],
    kallelse_date: string | null,
    kallelse_method: string | null,
    kallelse_window: { earliest: string, latest: string } | null,
    fiscal_period: { period_start: string, period_end: string } | null,
    voting_list: { as_of: string, total_shares: number, total_votes: number, holders: { party_id: string, name: string, kind: "person" | "company", shares: number, votes: number, present: boolean, proxy_name: string | null }[] } | null,
    present: { holders: number, shares: number, votes: number } | null,
    attendees: { party_id: string | null, name: string, capacity: "aktieagare" | "ombud" | "styrelseledamot" | "styrelsesuppleant" | "vd" | "revisor" | "ovrig", present: boolean }[],
    notes: string | null,
    held_at: string | null,
    signature_names: string | null,
    minutes_document_id: string | null,
    signed_document_id: string | null,
    signing_request_id: string | null,
    decisions: { corporate_decision_id: string, item_number: number, kind: "faststallande_rr_br" | "resultatdisposition" | "utdelning" | "ansvarsfrihet" | "val_styrelse" | "val_revisor" | "arvoden" | "andrad_bolagsordning" | "nyemission" | "fondemission" | "minskning" | "optioner" | "aterbetalning_villkorat_tillskott" | "ovrigt", kind_label: string, title: string, text: string | null, text_rendered: string, payload: Record<string, unknown>, outcome: "bifallen" | "avslagen" | "bordlagd", outcome_label: string, votes_for: number | null, votes_against: number | null, votes_abstained: number | null, reservations: string | null }[],
    justering: "named" | "not_needed_holds_all_shares" | "not_needed_single_member_board" | "covered_by_board_signatures" | "not_applicable" | "missing",
    signers: { party_id: string, name: string, role_label: string, has_email: boolean }[],
    register_effects: { planned: { action: "add" | "end" | "keep", decision_id: string, role: string, party_id: string | null, name: string, date: string, company_role_id: string | null }[], kept: { action: "add" | "end" | "keep", decision_id: string, role: string, party_id: string | null, name: string, date: string, company_role_id: string | null }[], applied: { added: { company_role_id: string, decision_id: string, party_id: string, name: string, role: string, role_label: string, date: string | null }[], ended: { company_role_id: string, decision_id: string, party_id: string, name: string, role: string, role_label: string, date: string | null }[] } },
    warnings: { code: string, message_sv: string, message_en: string }[],
    signing: { status: string, expires_at: string, signers: { name: string, role_label: string | null, status: string, signed_at: string | null }[] } | null
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
    "corporate_meeting_id": "4b1e…",
    "kind": "arsstamma",
    "status": "held",
    "decisions": [
      {
        "item_number": 8,
        "kind": "faststallande_rr_br",
        "text_rendered": "Stämman fastställde resultaträkningen och balansräkningen för räkenskapsåret 2026-01-01 till 2026-12-31."
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

### `PATCH /api/v1/companies/{companyId}/corporate-meetings/{id}`

**Change a meeting whose minutes are not signed: date, place, chair, protokollförare, justerare, kallelse, attendance or röstlängd presence.**
`scope:companies:write · risk:low · idempotent · dry-run`

Fields left out keep their value; null clears one. Moving the date takes the röstlängd from the aktiebok again. Signed minutes never change (CORPORATE_MEETING_LOCKED). Dry-runnable.

**Use when:** The kallelse was sent, the chair or justerare were chosen, or attendance is known.
**Do not use for:** Decisions (POST /corporate-meetings/{id}/decisions).

**Pitfalls:**
- CORPORATE_MEETING_SIGNING_PENDING: the minutes are out for BankID signing.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  meeting_date?: string,
  is_digital?: boolean,
  meeting_time?: string | null,
  place?: string | null,
  chair_party_id?: string | null,
  chair_name?: string | null,
  secretary_party_id?: string | null,
  secretary_name?: string | null,
  adjuster_party_ids?: string[] | null,
  adjuster_names?: string[] | null,
  kallelse_date?: string | null,
  kallelse_method?: string | null,
  fiscal_period_id?: string | null,
  notes?: string | null,
  presence?: { party_id: string, present: boolean, proxy_name?: string | null }[] | null,
  attendees?: { party_id?: string | null, name: string, capacity: "aktieagare" | "ombud" | "styrelseledamot" | "styrelsesuppleant" | "vd" | "revisor" | "ovrig", present: boolean }[] | null,
  refresh_voting_list?: boolean | null
}
```

Example request:
```json
{
  "kallelse_date": "2027-04-08",
  "kallelse_method": "e-post"
}
```

Response `200`:
```ts
{
  data: { corporate_meeting_id: string, status: string },
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
    "corporate_meeting_id": "4b1e…",
    "status": "draft"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/corporate-meetings/{id}/decisions`

**Add or change a decision (paragraph) in a meeting's unsigned minutes, with its terms per kind.**
`scope:companies:write · risk:low · idempotent · dry-run`

Kinds: faststallande_rr_br, resultatdisposition, utdelning, ansvarsfrihet, val_styrelse, val_revisor, arvoden, andrad_bolagsordning, nyemission, fondemission, minskning, optioner, aterbetalning_villkorat_tillskott, ovrigt. The payload is validated per kind. An adopted election changes the roles when the minutes are signed; capital decisions are booked separately. Dry-runnable.

**Use when:** The stämma or the board decided something to record in the minutes.
**Do not use for:** Booking a dividend or an emission (a voucher), or registering shares (POST /share-register/events).

**Pitfalls:**
- CORPORATE_DECISION_PAYLOAD_INVALID: the terms do not fit the kind; message names the fields.
- CORPORATE_MEETING_LOCKED: signed minutes never change.
- utdelning needs a payment_date (betalningsdag, ABL 18:3) before the minutes are signed; a warning says so.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  corporate_decision_id?: string | null,
  item_number?: number | null,
  kind?: "faststallande_rr_br" | "resultatdisposition" | "utdelning" | "ansvarsfrihet" | "val_styrelse" | "val_revisor" | "arvoden" | "andrad_bolagsordning" | "nyemission" | "fondemission" | "minskning" | "optioner" | "aterbetalning_villkorat_tillskott" | "ovrigt" | null,
  title?: string | null,
  text?: string | null,
  payload?: Record<string, unknown> | null,
  outcome?: "bifallen" | "avslagen" | "bordlagd" | null,
  votes_for?: number | null,
  votes_against?: number | null,
  votes_abstained?: number | null,
  reservations?: string | null
}
```

Example request:
```json
{
  "kind": "utdelning",
  "payload": {
    "amount_per_share": 50,
    "share_count": 1000,
    "total_amount": 50000,
    "payment_date": "2027-05-31"
  }
}
```

Response `200`:
```ts
{
  data: {
    corporate_decision_id: string,
    corporate_meeting_id: string,
    item_number: number,
    kind: "faststallande_rr_br" | "resultatdisposition" | "utdelning" | "ansvarsfrihet" | "val_styrelse" | "val_revisor" | "arvoden" | "andrad_bolagsordning" | "nyemission" | "fondemission" | "minskning" | "optioner" | "aterbetalning_villkorat_tillskott" | "ovrigt"
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
    "corporate_decision_id": "9f3d…",
    "corporate_meeting_id": "4b1e…",
    "item_number": 10,
    "kind": "utdelning"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/corporate-meetings/{id}/hold`

**Mark a meeting as held: a board meeting takes its minutes number, an årsstämma records its date on the årsredovisning.**
`scope:companies:write · risk:medium · idempotent · dry-run`

Status draft to held, once the meeting day has come. Board minutes are numbered in sequence (ABL 8:26). An årsstämma that adopted the resultat- and balansräkning writes agm_date and the disposition outcome to the årsredovisning (the fastställelseintyg reads them). Deadlines follow: minutes available within two weeks (7:49), a Bolagsverket notice after a board change (8:44). The minutes stay open until signed in Accounted; elections change the roles then. Dry-runnable.

**Use when:** The meeting took place and its decisions are recorded.
**Do not use for:** Signing the minutes (a person, in Accounted).

**Pitfalls:**
- CORPORATE_MEETING_IN_FUTURE: the meeting day has not come.
- CORPORATE_MEETING_ALREADY_HELD.
- A held meeting is never deleted.

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
    corporate_meeting_id: string,
    status: "held",
    sequence_number: number | null,
    agm_recorded: boolean
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
    "corporate_meeting_id": "4b1e…",
    "status": "held",
    "sequence_number": null,
    "agm_recorded": true
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/share-classes`

**Add a share class with its votes per share and the förbehåll of the bolagsordning.**
`scope:companies:write · risk:low · idempotent · dry-run`

A class (aktieslag, ABL 4:2) such as A or B. One class may carry at most ten times the votes of another (4:5): a larger ratio answers a warning. Dry-runnable.

**Use when:** The bolagsordning has more than one class, or förbehåll to note.
**Do not use for:** Issuing shares (POST /share-register/events).

**Pitfalls:**
- SHARE_CLASS_DUPLICATE: the code exists.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  code: string,
  name?: string | null,
  votes_per_share: number,
  forbehall_samtycke?: boolean,
  forbehall_forkop?: boolean,
  forbehall_hembud?: boolean,
  forbehall_omvandling?: boolean,
  forbehall_inlosen?: boolean,
  forbehall_text?: string | null,
  bolagsordning_reference?: string | null
}
```

Example request:
```json
{
  "code": "B",
  "votes_per_share": 1
}
```

Response `200`:
```ts
{
  data: {
    share_class_id: string,
    code: string,
    name: string | null,
    votes_per_share: number,
    forbehall_samtycke: boolean,
    forbehall_forkop: boolean,
    forbehall_hembud: boolean,
    forbehall_omvandling: boolean,
    forbehall_inlosen: boolean,
    forbehall_text: string | null,
    bolagsordning_reference: string | null
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
    "id": "5d1c…",
    "code": "B",
    "votes_per_share": 1
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/share-classes/{id}`

**Change a share class's name, votes per share or förbehåll; its code stays.**
`scope:companies:write · risk:medium · idempotent · dry-run · reversible`

Votes per share decide the votes percent and so the verkliga huvudmän: change them only after the bolagsordning changed. Every change is kept in the audit log. Dry-runnable.

**Use when:** The bolagsordning was amended, or a förbehåll was missing.
**Do not use for:** Converting shares between classes (an omvandling entry).

**Pitfalls:**
- SHARE_CLASS_NOT_FOUND: wrong share_class_id.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  name?: string | null,
  votes_per_share?: number,
  forbehall_samtycke?: boolean,
  forbehall_forkop?: boolean,
  forbehall_hembud?: boolean,
  forbehall_omvandling?: boolean,
  forbehall_inlosen?: boolean,
  forbehall_text?: string | null,
  bolagsordning_reference?: string | null
}
```

Example request:
```json
{
  "share_class_id": "5d1c…",
  "votes_per_share": 10
}
```

Response `200`:
```ts
{
  data: {
    share_class_id: string,
    code: string,
    name: string | null,
    votes_per_share: number,
    forbehall_samtycke: boolean,
    forbehall_forkop: boolean,
    forbehall_hembud: boolean,
    forbehall_omvandling: boolean,
    forbehall_inlosen: boolean,
    forbehall_text: string | null,
    bolagsordning_reference: string | null
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
    "id": "5d1c…",
    "code": "A",
    "votes_per_share": 10
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/share-register`

**Read the aktiebok as of a date: holders with shares, votes and percent, share numbers, classes and notes.**
`scope:companies:read · risk:low · idempotent`

The share register (ABL 5 kap.) replayed to as_of: every holder with masked identity, shares and votes, share of capital and votes, share-number ranges, and whether they are on the board or VD (ABL 8:45); the classes with their förbehåll; open notes (aktiebrev, pant, nyttjanderätt); and a check against company_settings.antal_aktier.

**Use when:** You need who owns the company, how much, or the number range of someone's shares.
**Do not use for:** The dated history of entries (GET /share-register/events) or the board (GET /company-roles).

**Pitfalls:**
- identity is masked; the full personnummer is never answered.
- reconciliation.status mismatch means the register and company_settings.antal_aktier disagree; ask the person which is right.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `as_of` | query | `string` | no | The day the answer is for (YYYY-MM-DD). Default today. |

Response `200`:
```ts
{
  data: {
    as_of: string,
    is_avstamningsbolag: boolean,
    setup_completed_at: string | null,
    total_shares: number,
    total_votes: number,
    next_free_share_number: number,
    classes: { share_class_id: string, code: string, name: string | null, votes_per_share: number, forbehall_samtycke: boolean, forbehall_forkop: boolean, forbehall_hembud: boolean, forbehall_omvandling: boolean, forbehall_inlosen: boolean, forbehall_text: string | null, bolagsordning_reference: string | null, shares: number, votes: number }[],
    holders: { party_id: string, name: string, kind: "person" | "company", identity: string | null, has_address: boolean, shares: number, votes: number, capital_pct: number, votes_pct: number, by_class: { share_class_id: string, code: string, shares: number }[], ranges: { range_start: number, range_end: number, share_class_id: string }[], officer: boolean }[],
    notes: { kind: "aktiebrev" | "pant" | "nyttjanderatt", range_start: number, range_end: number, aktiebrev_number: string | null, counterparty_party_id: string | null, counterparty_name: string | null, event_number: number, event_date: string }[],
    reconciliation: { status: "match" | "mismatch" | "settings_empty" | "register_empty" | "both_empty", register_shares: number, settings_shares: number | null, aktiekapital: number | null, kvotvarde: number | null },
    incomplete: { without_identity: number, without_address: number },
    note_problems: { share_register_event_id: string, event_number: number, event_date: string, kind: "aktiebrev" | "pant" | "nyttjanderatt", message: string }[],
    events_count: number,
    last_event_number: number
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
    "as_of": "2026-10-29",
    "total_shares": 1000,
    "holders": [
      {
        "party_id": "9c1e…",
        "name": "Anna Ek",
        "shares": 1000,
        "capital_pct": 100,
        "votes_pct": 100
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

### `GET /api/v1/companies/{companyId}/share-register/events`

**List every aktiebok entry in entry order, each with a Swedish sentence and whether a rättelse voided it.**
`scope:companies:read · risk:low · idempotent`

The dated history of the share register (ABL 5:9): bildande, emissions, transfers with reason and price, cancellations, conversions, splits, aktiebrev, pledges, usufruct, notes and corrections. Entries are never changed; a rattelse entry voids one.

**Use when:** You need when and how ownership changed, or the entry to correct.
**Do not use for:** Current holdings (GET /share-register).

**Pitfalls:**
- An entry with voided true does not count; its correction is the later rattelse entry.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    events: { share_register_event_id: string, event_number: number, event_date: string, occurred_on: string | null, entered_at: string, kind: "bildande" | "ingaende" | "nyemission" | "fondemission" | "overlatelse" | "indragning" | "omvandling" | "split" | "sammanlaggning" | "aktiebrev" | "pant" | "nyttjanderatt" | "anteckning" | "rattelse", kind_label: string, text: string, voided: boolean, corrects_event_id: string | null, share_class_id: string | null, from_party_id: string | null, to_party_id: string | null, counterparty_party_id: string | null, range_start: number | null, range_end: number | null, transfer_reason: string | null, price_total: number | null, ratio: number | null, aktiebrev_number: string | null, aktiebrev_action: "issued" | "returned" | null, note_status: "open" | "closed" | null, registered_on: string | null, decision_id: string | null, document_id: string | null, journal_entry_id: string | null, note: string | null }[]
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
    "events": [
      {
        "share_register_event_id": "7a2b…",
        "event_number": 1,
        "event_date": "2020-01-10",
        "kind": "bildande",
        "text": "Bildande: aktie 1-1 000 (1 000 st, serie A) till Anna Ek",
        "voided": false
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

### `POST /api/v1/companies/{companyId}/share-register/events`

**Add a dated entry to the aktiebok: an issue, a transfer, a cancellation, a conversion, a split, an aktiebrev, a pledge or a note.**
`scope:companies:write · risk:medium · idempotent · dry-run`

Entries are kept forever (ABL 5:3) and numbered in sequence; a mistake is voided with kind rattelse and entered again. The register refuses an entry its history cannot hold: no share held twice, a transfer only of shares the transferor holds on that date. A register is first set up: the history is entered with the day of each event, or, for a company that kept its aktiebok elsewhere, its holdings as kind ingaende, each dated the day it stood and with the share numbers the earlier register gives. An opening holding keeps those numbers: when the user asks for other numbers, say that the entry then differs from the earlier register, and that an approved entry is never changed, only voided and entered again. One holder with every share is numbered from 1, and share_count is enough. With several holders and no numbers in the earlier register, ask which numbers each holder has before staging. The entry with completes_setup true takes the register into use; from then on an entry carries the day it is made (a shareholder has rights from the day they are entered, ABL 4:37 and 7:2) and the day of the event is kept as occurred_on. A new holder is named by to_name; their personnummer and address are completed in Accounted. Dry-runnable: the preview shows holdings before and after and the day the entry will carry.

**Use when:** Shares were issued, sold, given, inherited, cancelled, split, pledged, or an aktiebrev was issued or returned.
**Do not use for:** Booking the money of an emission or a dividend (a voucher), or changing votes per share (PATCH /share-classes/{id}).

**Pitfalls:**
- SHARE_REGISTER_NOT_HELD: the from-holder does not hold all of the shares on event_date.
- SHARE_REGISTER_RANGE_TAKEN: the numbers are already held. A new issue: omit the range and send share_count. An ingaende keeps its numbers: when an entry holds them by mistake, void that entry with a rattelse, and send the holding again once the rattelse is approved.
- SHARE_REGISTER_STALE: the register got an entry after the one you saw; read it again and retry.
- SHARE_REGISTER_SETUP_COMPLETE: the register is in use; kind ingaende and completes_setup belong to the setup only.
- A company with a history never enters its current holdings as bildande: use ingaende dated the day the holdings stood, or enter the history as it happened.
- A range_start with a share_count names the whole block (range_start to range_start + share_count - 1).
- FORBIDDEN: only the company's owner or an administrator adds to the aktiebok.
- BOLAGET_PERSONNUMMER_IN_APP_ONLY: a personnummer was sent; name the person and complete them in the app.
- A transfer of a class with samtycke, förköp or hembud answers a warning until forbehall_cleared is true.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  kind: "bildande" | "ingaende" | "nyemission" | "fondemission" | "overlatelse" | "indragning" | "omvandling" | "split" | "sammanlaggning" | "aktiebrev" | "pant" | "nyttjanderatt" | "anteckning" | "rattelse",
  event_date?: string | null,
  occurred_on?: string | null,
  completes_setup?: boolean | null,
  share_class_code?: string | null,
  to_share_class_code?: string | null,
  from_party_id?: string | null,
  to_party_id?: string | null,
  to_name?: string | null,
  to_kind?: "person" | "company" | null,
  to_org_number?: string | null,
  range_start?: number | null,
  range_end?: number | null,
  share_count?: number | null,
  transfer_reason?: "kop" | "gava" | "arv" | "testamente" | "bodelning" | "byte" | "apport" | "annat" | null,
  price_total?: number | null,
  ratio?: number | null,
  aktiebrev_number?: string | null,
  aktiebrev_action?: "issued" | "returned" | null,
  counterparty_party_id?: string | null,
  counterparty_name?: string | null,
  counterparty_kind?: "person" | "company" | null,
  counterparty_org_number?: string | null,
  note_status?: "open" | "closed" | null,
  corrects_event_id?: string | null,
  registered_on?: string | null,
  decision_id?: string | null,
  document_id?: string | null,
  note?: string | null,
  forbehall_cleared?: boolean | null,
  to_is_new?: boolean | null,
  counterparty_is_new?: boolean | null,
  expected_last_event_number?: number | null
}
```

Example request:
```json
{
  "kind": "overlatelse",
  "event_date": "2026-10-01",
  "from_party_id": "9c1e…",
  "to_name": "Bo Ek",
  "share_count": 100,
  "transfer_reason": "gava"
}
```

Response `200`:
```ts
{
  data: {
    share_register_event_id: string,
    event_number: number,
    kind: "bildande" | "ingaende" | "nyemission" | "fondemission" | "overlatelse" | "indragning" | "omvandling" | "split" | "sammanlaggning" | "aktiebrev" | "pant" | "nyttjanderatt" | "anteckning" | "rattelse",
    event_date: string,
    occurred_on?: string | null,
    range_start: number | null,
    range_end: number | null,
    share_class_id: string | null,
    from_party_id: string | null,
    to_party_id: string | null,
    setup_completed_at?: string | null
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
    "share_register_event_id": "7a2b…",
    "event_number": 4,
    "kind": "overlatelse",
    "event_date": "2026-10-01",
    "occurred_on": null,
    "range_start": 1,
    "range_end": 100
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/signatory-rules`

**Set the firmateckning from a date; the rule in force ends the day before.**
`scope:companies:write · risk:low · idempotent · dry-run`

The registered text, e.g. "Firman tecknas av styrelsen. Firman tecknas av två ledamöter i förening." (ABL 8:35-37). Dry-runnable.

**Use when:** The board changed who signs for the company.
**Do not use for:** Adding a särskild firmatecknare as a person (POST /company-roles).

**Pitfalls:**
- BOLAGET_DATES_INVALID: a rule already starts on or after valid_from.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  rule_text: string,
  valid_from: string,
  registered_at?: string | null,
  decision_id?: string | null
}
```

Example request:
```json
{
  "rule_text": "Firman tecknas av styrelsen",
  "valid_from": "2026-06-15"
}
```

Response `200`:
```ts
{
  data: { signatory_rule_id: string, rule_text: string, valid_from: string, ended_rule_ids: string[] },
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
    "signatory_rule_id": "2b9d…",
    "rule_text": "Firman tecknas av styrelsen",
    "valid_from": "2026-06-15",
    "ended_rule_ids": []
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```
