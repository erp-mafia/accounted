<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Core endpoints

Connectivity, the calling key's own grant, company discovery, which modules a company can use (capabilities), its packages with their status and the staged switch (packages), async-operation polling, company settings, and service accounts (an integration's own principal, with a human sponsor). Every session starts with GET /companies to resolve the companyId that all other URLs need.

Conventions (auth, envelope, pagination, dry-run, idempotency, standard errors)
are in SKILL.md and are not repeated per endpoint.

### `GET /api/v1/api-key`

**Show what the calling API key may do: mode, scopes and company access.**
`risk:low · idempotent`

Returns the grant of the key that makes the request: `mode` (`live` or `test`), its `scopes`, whether it reaches every company its user is a member of (`all_memberships`) or only an allowlist (`allowlist`), and every company it reaches with the role and whether writes are let through there. `access` is `read_only` when the membership is a viewer (`read_only_code` `ROLE_READ_ONLY`) or the key was given read-only access to the company (`CONNECTION_READ_ONLY`): the same codes a refused write answers with. Any valid key may call this, whatever its scopes, and it works the same for keys issued through MCP OAuth. A key can write to company X with scope S when `scopes` contains S, X is in `companies` with `access` `read_write`, and `mode` is `live` or the endpoint supports dry-run. For document uploads: `documents:write`, `read_write`, and `mode` `live`. `service_account` names the service account the key belongs to (`id`, `name`, `handle`), or is null for a key that belongs to a person.

**Use when:** You connect a customer key and want to check, before the first real call, that it carries the scopes you need and can write to the company you will use, so the customer can fix the key while still on your connect screen.
**Do not use for:** Company names, org numbers or settings: use GET /api/v1/companies (scope companies:read). Testing a single write end to end: send it with `?dry_run=true` where the endpoint supports dry-run.

**Pitfalls:**
- A test key (`mode` `test`) forces every write into dry-run, and an endpoint without dry-run support refuses it with 403 TEST_KEY_WRITE_BLOCKED. POST /companies/{companyId}/documents is one: uploads need a live key.
- The grant can change after you read it: the customer can edit the key's scopes or company access, or remove the user from a company. Keep handling 403 INSUFFICIENT_SCOPE, ROLE_READ_ONLY and CONNECTION_READ_ONLY on real calls.
- With `company_access` `all_memberships`, companies the user joins later become reachable too; an `allowlist` key never reaches a company outside its list, including one it creates with POST /companies.
- A non-owner membership in a company whose multi-user plan has lapsed is refused on every call (403 with reason `multi_user_frozen`); this response does not show that state.
- Archived companies are not listed, the same as GET /api/v1/companies.
- A service account's key reaches only the account's company, and every write it makes is recorded under the account's name. When the sponsor stops being an owner or admin, the key is refused with 403 SERVICE_ACCOUNT_SUSPENDED, here too.
- While the person responsible for the agent has paused it, every key of the agent is refused with 403 AGENT_PAUSED, here too. Tell the user; only that person can resume it, under Settings.

Response `200`:
```ts
{
  data: {
    mode: "live" | "test",
    scopes: string[],
    company_access: "all_memberships" | "allowlist",
    companies: { id: string, handle?: string, role: "owner" | "admin" | "member" | "viewer" | "invoicer", access: "read_write" | "read_only", read_only_code: "ROLE_READ_ONLY" | "CONNECTION_READ_ONLY" | null }[],
    service_account: { id: string, name: string, handle: string } | null
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
    "mode": "live",
    "scopes": [
      "companies:read",
      "documents:read",
      "documents:write"
    ],
    "company_access": "allowlist",
    "companies": [
      {
        "id": "8fd5b1f4-0000-4000-8000-000000000001",
        "role": "owner",
        "access": "read_write",
        "read_only_code": null
      },
      {
        "id": "8fd5b1f4-0000-4000-8000-000000000002",
        "role": "admin",
        "access": "read_only",
        "read_only_code": "CONNECTION_READ_ONLY"
      }
    ],
    "service_account": null
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies`

**List companies the API key can access.**
`scope:companies:read · risk:low · idempotent`

Returns every non-archived company the API key user is a member of, together with their role. Use the returned `id` as `{companyId}` in subsequent endpoints.

**Use when:** You need to discover which company IDs an API key has access to before calling company-scoped endpoints.
**Do not use for:** Reading one company's settings: GET /api/v1/companies/{companyId}/settings. There is no single-company GET: this list already carries each company's name, org number, form and role.

**Pitfalls:**
- Multi-company keys (e.g. consultants) will see >1 result. Always pass the correct companyId in subsequent paths.
- Archived companies are excluded; if a company disappears the user has been removed from it or it was archived.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `cursor` | query | `string` | no | Opaque cursor from the previous page's meta.next_cursor. Omit for the first page. |
| `limit` | query | `number` | no | Page size, 1-100 (default 50). Larger values are clamped to 100. |

Response `200`:
```ts
{
  data: { id: string, handle?: string, name: string, org_number: string | null, entity_type: string, role: "owner" | "admin" | "member" | "viewer" | "invoicer", created_at: string }[],
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
      "id": "8fd5b1f4-…",
      "name": "Acme AB",
      "org_number": "556677-8899",
      "entity_type": "aktiebolag",
      "role": "owner",
      "created_at": "2025-01-04T08:00:00Z"
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

### `POST /api/v1/companies`

**Create a company and set it up for bookkeeping.**
`scope:companies:write · risk:medium · dry-run`

Creates a new company owned by the API key user (or attached to one of their teams) and sets it up in one call: owner membership, BAS chart of accounts for the company form, compliance settings, the first fiscal period and the automatic tax deadlines. A 30-day trial with every paid capability starts immediately. Intended for partner platforms provisioning client companies (byrå/vertical SaaS) and for agents onboarding a user.

**Use when:** A platform or agent needs to provision a company that does not exist in Accounted yet. The caller becomes its owner. Members and invitations have no API: the owner invites people in the app under Settings > Members (/settings/members).
**Do not use for:** Companies that already exist (list them with GET /api/v1/companies), or changing settings on an existing company (PATCH /api/v1/companies/{companyId}/settings).

**Pitfalls:**
- A VAT-registered company MUST send moms_period (monthly / quarterly / yearly); the request is refused otherwise, because a missing period silently produces zero VAT deadlines.
- Bookkeeping duty under BFL starts when the company exists with a fiscal period: do not create companies to try things out. Use a test-mode key (dry run) for that.
- Enskild firma always runs on the calendar year; fiscal_year_start_month is ignored for it.
- first_fiscal_year is only for a company in its first year (BFL 3 kap.: up to 18 months). Omit it for an established company.
- Send an Idempotency-Key. With one, a retry with the same key and body returns the company the first call created (200, Idempotent-Replayed: true), never a second one; the same key with another body answers 409 IDEMPOTENCY_KEY_REUSE. Keep the key for the whole provisioning attempt (24 h). The header is optional for compatibility: without it, a retry after a network failure creates a second company.
- org_number is required for a VAT-registered company (the invoice momsregistreringsnummer derives from it), and f_skatt must be stated explicitly: F-skatt approval is never assumed.
- accounting_method may be omitted: it then defaults by form (aktiebolag accrual, enskild firma cash) and the response shows the resolved value. The cash default is only legal when turnover normally stays under 3 MSEK (BFL 4 kap 4 §): send accrual explicitly for a larger enskild firma.
- ideell_forening, ekonomisk_forening and bostadsrattsforening are rolled out per installation behind the server-side flags NEXT_PUBLIC_IDEELL_FORENING_ENABLED, NEXT_PUBLIC_EKONOMISK_FORENING_ENABLED and NEXT_PUBLIC_BOSTADSRATTSFORENING_ENABLED. Until the flag is on, a request with that entity_type is refused with VALIDATION_ERROR on entity_type; enskild_firma and aktiebolag are always creatable.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  name: string,
  entity_type: "enskild_firma" | "aktiebolag" | "ideell_forening" | "ekonomisk_forening" | "bostadsrattsforening",
  org_number?: string,
  vat_registered: boolean,
  moms_period?: "monthly" | "quarterly" | "yearly" | null,
  accounting_method?: "accrual" | "cash",
  f_skatt: boolean,
  fiscal_year_start_month?: number,
  first_fiscal_year?: { start: string, end: string },
  address_line1?: string,
  postal_code?: string,
  city?: string,
  team_id?: string
}
```

Example request:
```json
{
  "name": "Acme AB",
  "entity_type": "aktiebolag",
  "org_number": "5566778899",
  "vat_registered": true,
  "moms_period": "quarterly",
  "accounting_method": "accrual",
  "f_skatt": true
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    handle?: string,
    name: string,
    entity_type: "enskild_firma" | "aktiebolag" | "ideell_forening" | "ekonomisk_forening" | "bostadsrattsforening",
    org_number: string | null,
    vat_registered: boolean,
    moms_period: "monthly" | "quarterly" | "yearly" | null,
    accounting_method: "accrual" | "cash",
    fiscal_period: { start_date: string, end_date: string, name: string },
    team_id: string | null
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
    "id": "8fd5b1f4-…",
    "name": "Acme AB",
    "entity_type": "aktiebolag",
    "org_number": "5566778899",
    "vat_registered": true,
    "moms_period": "quarterly",
    "accounting_method": "accrual",
    "fiscal_period": {
      "start_date": "2026-01-01",
      "end_date": "2026-12-31",
      "name": "Räkenskapsår 2026"
    },
    "team_id": null
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/capabilities`

**Which building blocks this company can use, and why not.**
`scope:companies:read · risk:low · idempotent`

Lists every module (the OpenAPI tags) for the company with a status, the reasons behind it and a resolution sentence, like Stripe account capabilities. Statuses: active (usable now); needs_plan (the paid plan does not include it: upgrade, or on a self-hosted instance add a connector key); off (turned off for this company); unsupported (not offered for this company: its country, or its legal form, such as payroll for an enskild firma that has not said it pays salaries). Reasons, the deciding one first: unsupported_country, unsupported_legal_form, needs_plan, disabled_by_company, dependency_unavailable (a module it needs is unsupported or off; it then takes that status). Kernels (platform, ledger) are always active. profile names the company profile (sole-trader, limited-company-no-employees, limited-company-with-employees, retail, association, or standard, every package on): the starting point for which packages the app menu and the MCP tool list show. A module in a package the profile leaves off is hidden there but keeps its status and still answers when called. A company without a stored profile has standard (source implicit). This is a read-only report: nothing here changes a profile or a module.

**Use when:** At the start of an integration or agent session, before calling endpoints of an optional module (bank feed, payroll, Skatteverket filing, collections, the AI agent), or to explain to a user why something is unavailable.
**Do not use for:** Turning a module on or off, or changing the profile: nothing here writes. API key scopes are a separate axis (GET /api/v1/api-key); a module can be active while the key lacks the scope for its endpoints.

**Pitfalls:**
- A status is a snapshot: a plan change or a settings change moves it. Re-read it rather than caching it for a session.
- needs_plan only covers the paid parts of a module; the module's free endpoints keep answering. The resolution says what unlocks it.
- Modules, statuses and reasons may gain values as the product grows (module ids are experimental, like the OpenAPI tags): treat an unknown status as not active.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    jurisdiction: string,
    ledger_currency: string,
    profile: { id: "sole-trader" | "limited-company-no-employees" | "limited-company-with-employees" | "retail" | "association" | "standard", version: number, name: string, name_sv: string, source: "stored" | "implicit" },
    modules: { id: string, kind: "kernel" | "block", name: string, name_sv: string, summary: string, depends_on: string[], status: "active" | "off" | "needs_plan" | "unsupported", reasons: ("unsupported_country" | "unsupported_legal_form" | "needs_plan" | "disabled_by_company" | "dependency_unavailable")[], resolution: string | null }[]
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
    "jurisdiction": "SE",
    "ledger_currency": "SEK",
    "profile": {
      "id": "standard",
      "version": 1,
      "name": "Standard (everything on)",
      "name_sv": "Standard (allt på)",
      "source": "implicit"
    },
    "modules": [
      {
        "id": "ledger",
        "kind": "kernel",
        "name": "Ledger",
        "name_sv": "Bokföring",
        "summary": "Double-entry bookkeeping under Bokföringslagen: journal entries and corrections, ...",
        "depends_on": [
          "platform"
        ],
        "status": "active",
        "reasons": [],
        "resolution": null
      },
      {
        "id": "bank-feed",
        "kind": "block",
        "name": "Bank feed",
        "name_sv": "Bankkoppling",
        "summary": "Reading the company bank through PSD2 aggregators and Open Payments, ...",
        "depends_on": [
          "transactions"
        ],
        "status": "needs_plan",
        "reasons": [
          "needs_plan"
        ],
        "resolution": "Upgrade the plan to use Bank feed."
      },
      {
        "id": "payroll",
        "kind": "block",
        "name": "Payroll",
        "name_sv": "Lön",
        "summary": "Swedish payroll: the employee register, salary runs from calculation to booking, ...",
        "depends_on": [],
        "status": "unsupported",
        "reasons": [
          "unsupported_legal_form"
        ],
        "resolution": "Payroll is on for every legal person; an enskild firma turns it on by setting pays_salaries in the company tax profile."
      }
    ]
  },
  "meta": {
    "request_id": "req_...",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/packages`

**List the company packages with their status and what keeps a switched-off one winding down.**
`scope:companies:read · risk:low · idempotent`

Every package (Bokföring, Bank, Kundfakturor, Leverantörsfakturor och betalningar, Kvitton och underlag, Utlägg, Lön, Inventarier, Kassa och webbshop) with its availability: on, off, winding_down, not_in_plan or not_in_country. A package switched off while something is still open in it (an unbooked salary run, an unfiled AGI, an unpaid invoice) is winding_down: its pages and tools stay, no new work starts in it (start doors answer PACKAGE_OFF), and open_obligations names what keeps it there. Also the profile the company started from.

**Use when:** A call answered PACKAGE_OFF, or before proposing to switch a package on or off.
**Do not use for:** The module report and resolutions (GET /capabilities).

**Pitfalls:**
- A package outside the plan stays visible; its paid features answer at the call.
- open_obligations is read only for packages that are switched off.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    profile: { profile_id: string, name_sv: string, source: "stored" | "implicit" },
    packages: { package_id: string, name: string, name_sv: string, switchable: boolean, availability: "on" | "off" | "winding_down" | "not_in_plan" | "not_in_country", reasons: string[], open_obligations: { code: "active_bank_connection" | "unpaid_customer_invoices" | "active_recurring_invoices" | "open_collection_cases" | "open_rot_rut_payout_requests" | "unpaid_supplier_invoices" | "payments_in_flight" | "unhandled_documents" | "unpaid_expense_claims" | "unbooked_mileage" | "open_salary_runs" | "unfiled_agi" | "unmatched_salary_payments" | "active_assets" | "active_pos_connection" | "unbooked_pos_days" | "active_webshop_connection" | "unbooked_webshop_orders", label_sv: string, label_en: string }[], modules: { module_id: string, name_sv: string }[] }[]
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
    "profile": {
      "profile_id": "standard",
      "name_sv": "Standard (allt på)",
      "source": "implicit"
    },
    "packages": [
      {
        "package_id": "payroll",
        "name": "Payroll",
        "name_sv": "Lön",
        "switchable": true,
        "availability": "winding_down",
        "reasons": [
          "turned_off_by_company",
          "open_obligations"
        ],
        "open_obligations": [
          {
            "code": "unfiled_agi",
            "label_sv": "arbetsgivardeklarationer som inte är inlämnade",
            "label_en": "employer declarations (AGI) not yet filed"
          }
        ],
        "modules": [
          {
            "module_id": "payroll",
            "name_sv": "Lön"
          }
        ]
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

### `POST /api/v1/companies/{companyId}/packages/{packageId}/disable`

**Stage switching a package off, for an owner or admin to approve.**
`scope:companies:write · risk:low · idempotent · dry-run · reversible`

Proposes switching a package off (disable_package): its start doors close (no new invoice, salary run, asset, ...), while everything still open in it keeps working. With obligations open the package winds down: it stays visible until they are settled, then disappears. The preview names those obligations. Never refused for what is open. Send it with ?stage=true.

**Use when:** The user no longer uses a package (another payroll provider, no more till) and wants it out of the menu.
**Do not use for:** Pausing one recurring invoice or disconnecting one connection: use their own endpoints.

**Pitfalls:**
- Only ?stage=true: a direct call answers PACKAGE_SWITCH_STAGE_ONLY.
- Nothing is deleted; switching the package on again brings everything back.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `packageId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Response `200`:
```ts
{
  data: {
    package_id: string,
    package_name: string,
    enabled: boolean,
    changed: boolean,
    winding_down: boolean,
    open_obligations: string[]
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
    "package_id": "payroll",
    "package_name": "Lön",
    "enabled": false,
    "changed": true,
    "winding_down": true,
    "open_obligations": [
      "unfiled_agi"
    ]
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/packages/{packageId}/enable`

**Stage switching a package on, for an owner or admin to approve.**
`scope:companies:write · risk:low · idempotent · dry-run · reversible`

Proposes switching a package on (enable_package). Nothing changes until an owner or admin approves it, in Accounted or through the approve endpoint; the approval writes the choice with who decided and a dated line in behandlingshistorik. Refused when the plan, the country or the legal form does not offer the package. Send it with ?stage=true.

**Use when:** A call answered PACKAGE_OFF and the user wants to start that work, or the user asks to switch a package on.
**Do not use for:** Switching a package off (POST /packages/{packageId}/disable).

**Pitfalls:**
- Only ?stage=true: a direct call answers PACKAGE_SWITCH_STAGE_ONLY.
- A service account's key cannot approve it: a person approves.
- PACKAGE_NOT_FOR_LEGAL_FORM for Lön in an enskild firma that has not said it pays salaries.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `packageId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Response `200`:
```ts
{
  data: {
    package_id: string,
    package_name: string,
    enabled: boolean,
    changed: boolean,
    winding_down: boolean,
    open_obligations: string[]
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
    "package_id": "payroll",
    "package_name": "Lön",
    "enabled": true,
    "changed": true,
    "winding_down": false,
    "open_obligations": []
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/peppol/access-request`

**Ask the operators to switch on Peppol for the company (sending, optionally receiving).**
`scope:companies:write · risk:medium · idempotent · dry-run`

Peppol is locked per company until the operators grant it (every transmission is billed per document and every receiving id uses a contracted slot). This records the request and notifies the operators by e-mail; they enable it with a sending cap and, when wants_receiving is true, a receiving slot. Idempotent: a second request keeps the first. Dry-runnable.

**Use when:** GET /invoices/{id}/peppol or GET /peppol/registration reports PEPPOL_ACCESS_REQUIRED and the user wants Peppol.
**Do not use for:** Registering the participant id once access is granted (POST /peppol/registration).

**Pitfalls:**
- A company that already has access answers 409 PEPPOL_ACCESS_ALREADY_ENABLED; ask support for a higher cap or a receiving slot instead.
- A company that cannot be a Peppol participant answers 422 with the code GET /peppol/registration reports in participant.code (PEPPOL_REGISTRATION_PERSONAL_NUMBER for a sole trader identified by personnummer); nothing is recorded.
- Nothing is enabled immediately: poll GET /peppol/registration for access.status=enabled.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{ note?: string, wants_receiving?: boolean }
```

Example request:
```json
{
  "wants_receiving": true,
  "note": "Vi fakturerar kommuner."
}
```

Response `200`:
```ts
{
  data: {
    access: { status: "none" | "requested" | "enabled" | "disabled", send_enabled: boolean, receive_enabled?: boolean, max_sends: number | null, sent_count: number, remaining_sends: number | null },
    created: boolean
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
    "access": {
      "status": "requested",
      "send_enabled": false,
      "receive_enabled": false,
      "max_sends": null,
      "sent_count": 0,
      "remaining_sends": null
    },
    "created": true
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/peppol/registration`

**Read the company's Peppol receiving status: access grant, eligibility and registration.**
`scope:companies:read · risk:low · idempotent`

Whether this environment has an access point and whether it supports receiving, the company's Peppol access grant (sending cap, receiving slot), whether the company can be registered at all (a 10-digit organisation number that is not a personnummer, a company name), and the registration of its participant id (0007 + org number) with its status and last error.

**Use when:** Before POST /peppol/registration, or to explain why the company does not receive e-invoices.
**Do not use for:** Sending (GET /invoices/{id}/peppol checks an invoice) or reading received e-invoices (they arrive in the invoice inbox).

**Pitfalls:**
- participant.ok=false with PEPPOL_REGISTRATION_PERSONAL_NUMBER means a sole trader identified by personnummer: it cannot be published in the Peppol directory.
- registration.can_retry says whether registering again can help; a permanent verdict (e.g. CONNECTOR_PEPPOL_PARTICIPANT_TAKEN) needs support.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    transport: { available: boolean, provider: string | null, reason: string | null },
    receiving_supported: boolean,
    access: { status: "none" | "requested" | "enabled" | "disabled", send_enabled: boolean, receive_enabled?: boolean, max_sends: number | null, sent_count: number, remaining_sends: number | null },
    participant: { ok: boolean, code: string | null },
    registration: { registration_id: string, provider: string, participant_scheme: string, participant_identifier: string, status: "pending" | "registered" | "failed" | "deregistered", registered_at: string | null, deregistered_at: string | null, last_error_code: string | null, stale_pending: boolean, can_retry: boolean, updated_at: string } | null
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
    "transport": {
      "available": true,
      "provider": "qvalia",
      "reason": null
    },
    "receiving_supported": true,
    "access": {
      "status": "enabled",
      "send_enabled": true,
      "receive_enabled": true,
      "max_sends": 50,
      "sent_count": 3,
      "remaining_sends": 47
    },
    "participant": {
      "ok": true,
      "code": null
    },
    "registration": {
      "registration_id": "4c2d…",
      "provider": "qvalia",
      "participant_scheme": "0007",
      "participant_identifier": "5595386219",
      "status": "registered",
      "registered_at": "2026-09-26T10:00:00Z",
      "deregistered_at": null,
      "last_error_code": null,
      "stale_pending": false,
      "can_retry": false,
      "updated_at": "2026-09-26T10:00:00Z"
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/peppol/registration`

**Register the company as a Peppol participant so it can receive e-invoices.**
`scope:companies:write · risk:high · idempotent · dry-run`

Publishes the company's participant id (scheme 0007 + organisation number) with a business card (name, country, city, VAT number) at the access point, for BIS Billing 3 invoices and credit notes. Received e-invoices then arrive in the invoice inbox. Needs the operators' receiving grant. A pending attempt older than five minutes is retired and retried. Owner/admin only. The dry run checks everything as reads and contacts no network.

**Use when:** The company wants suppliers to send it e-invoices over Peppol and GET /peppol/registration shows receive_enabled.
**Do not use for:** Sending e-invoices (that needs no registration of the buyer side here) or asking for access (POST /peppol/access-request).

**Pitfalls:**
- Without the grant: 403 PEPPOL_ACCESS_REQUIRED; with sending but no receiving slot: 403 PEPPOL_RECEIVING_NOT_ENABLED.
- A personnummer-based sole trader answers 422 PEPPOL_REGISTRATION_PERSONAL_NUMBER: it would publish personal data in the directory.
- 502 PEPPOL_REGISTRATION_FAILED is operational and retryable; 422 PEPPOL_REGISTRATION_REJECTED is a verdict on the identifier (details.code says which), do not retry it.
- 409 PEPPOL_REGISTRATION_CAP_REACHED: every contracted receiving slot is taken; sending still works.
- Owner or admin only: a member key gets 403 FORBIDDEN.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Response `200`:
```ts
{
  data: {
    registration: { registration_id: string, provider: string, participant_scheme: string, participant_identifier: string, status: "pending" | "registered" | "failed" | "deregistered", registered_at: string | null, deregistered_at: string | null, last_error_code: string | null, stale_pending: boolean, can_retry: boolean, updated_at: string }
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
    "registration": {
      "registration_id": "4c2d…",
      "provider": "qvalia",
      "participant_scheme": "0007",
      "participant_identifier": "5595386219",
      "status": "registered",
      "registered_at": "2026-09-26T10:00:00Z",
      "deregistered_at": null,
      "last_error_code": null,
      "stale_pending": false,
      "can_retry": false,
      "updated_at": "2026-09-26T10:00:00Z"
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/service-accounts`

**List the company's service accounts.**
`scope:service_accounts:manage · risk:low · idempotent`

Returns every service account of the company, live ones first, then the revoked ones, each with its sponsor and status. Keys are listed per account on GET /service-accounts/{id}.

**Use when:** You manage the non-human principals of a company: to find the account an integration runs as, or to check that none is suspended.
**Do not use for:** Listing the API keys of people (not exposed over the API). Reading a key's secret: it is returned once, when the key is minted.

**Pitfalls:**
- Needs a person's key with service_accounts:manage, held by an owner or admin of the company. A service account's own key is refused (403 SERVICE_ACCOUNT_KEY_NOT_PERMITTED).
- status suspended means the sponsor is no longer an owner or admin: the account's keys answer 403 SERVICE_ACCOUNT_SUSPENDED until the role is restored.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    service_accounts: { id: string, handle?: string, company_id: string, name: string, sponsor_user_id: string, status: "active" | "suspended" | "revoked", created_by: string, created_at: string, revoked_at: string | null, revoked_by: string | null }[]
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
    "service_accounts": [
      {
        "id": "5b6c1d2e-0000-4000-8000-0000000000a1",
        "company_id": "8fd5b1f4-0000-4000-8000-000000000001",
        "name": "Nattlig fakturasynk",
        "sponsor_user_id": "3f2a9c10-0000-4000-8000-000000000002",
        "status": "active",
        "created_by": "3f2a9c10-0000-4000-8000-000000000002",
        "created_at": "2026-10-16T08:00:00Z",
        "revoked_at": null,
        "revoked_by": null
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

### `POST /api/v1/companies/{companyId}/service-accounts`

**Create a service account with a human sponsor.**
`scope:service_accounts:manage · risk:medium · idempotent · reversible`

Creates a service account in the company: a non-human principal for an integration or agent, with a sponsor who answers for it. The sponsor must be an owner or admin member of the company and defaults to the user of the calling key. The account has no key yet: mint one with POST /service-accounts/{id}/keys. Everything its keys write is recorded with the actor service_account (the account's name), acting for the sponsor.

**Use when:** You connect an integration or agent that should act under its own name in the books rather than as the person who set it up.
**Do not use for:** Giving a person access (invite them to the company instead). Changing the sponsor or the name: revoke the account and create a new one.

**Pitfalls:**
- A service account can never do more than its sponsor: when the sponsor stops being an owner or admin, every key of the account is refused (403 SERVICE_ACCOUNT_SUSPENDED) until the role is restored.
- Names are unique among the company's live accounts (409 SERVICE_ACCOUNT_NAME_TAKEN); a revoked account frees its name.
- At most 25 live service accounts per company (409 SERVICE_ACCOUNT_LIMIT).
- Not available with a test key (403 TEST_KEY_WRITE_BLOCKED): there is no dry-run.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Request body:
```ts
{ name: string, sponsor_user_id?: string }
```

Example request:
```json
{
  "name": "Nattlig fakturasynk"
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    handle?: string,
    company_id: string,
    name: string,
    sponsor_user_id: string,
    status: "active" | "suspended" | "revoked",
    created_by: string,
    created_at: string,
    revoked_at: string | null,
    revoked_by: string | null
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
    "id": "5b6c1d2e-0000-4000-8000-0000000000a1",
    "company_id": "8fd5b1f4-0000-4000-8000-000000000001",
    "name": "Nattlig fakturasynk",
    "sponsor_user_id": "3f2a9c10-0000-4000-8000-000000000002",
    "status": "active",
    "created_by": "3f2a9c10-0000-4000-8000-000000000002",
    "created_at": "2026-10-16T08:00:00Z",
    "revoked_at": null,
    "revoked_by": null
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/service-accounts/{id}`

**Show one service account with its keys.**
`scope:service_accounts:manage · risk:low · idempotent`

Returns the service account, its sponsor and status, and every key it has (live and revoked, newest first) with prefix, scopes, mode, access and last use. A key's secret is never returned after it was minted.

**Use when:** You check which keys an integration's service account has before rotating or revoking one.
**Do not use for:** Recovering a lost key: mint a new one and revoke the old one.

**Pitfalls:**
- An id that is not one of this company's service accounts answers 404 SERVICE_ACCOUNT_NOT_FOUND.
- Needs a person's key with service_accounts:manage, held by an owner or admin of the company.

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
    company_id: string,
    name: string,
    sponsor_user_id: string,
    status: "active" | "suspended" | "revoked",
    created_by: string,
    created_at: string,
    revoked_at: string | null,
    revoked_by: string | null,
    keys: { id: string, name: string, key_prefix: string, scopes: string[], mode: "live" | "test", access: "read_write" | "read_only", created_at: string, last_used_at: string | null, revoked_at: string | null }[]
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
    "id": "5b6c1d2e-0000-4000-8000-0000000000a1",
    "company_id": "8fd5b1f4-0000-4000-8000-000000000001",
    "name": "Nattlig fakturasynk",
    "sponsor_user_id": "3f2a9c10-0000-4000-8000-000000000002",
    "status": "active",
    "created_by": "3f2a9c10-0000-4000-8000-000000000002",
    "created_at": "2026-10-16T08:00:00Z",
    "revoked_at": null,
    "revoked_by": null,
    "keys": [
      {
        "id": "7a1e0c55-0000-4000-8000-0000000000b1",
        "name": "Nattlig fakturasynk",
        "key_prefix": "gnubok_sk_Xb3kQ9aZ",
        "scopes": [
          "invoices:read",
          "invoices:write"
        ],
        "mode": "live",
        "access": "read_write",
        "created_at": "2026-10-16T08:01:00Z",
        "last_used_at": null,
        "revoked_at": null
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

### `POST /api/v1/companies/{companyId}/service-accounts/{id}/keys`

**Mint an API key for a service account; the secret is shown once.**
`scope:service_accounts:manage · risk:high · reversible`

Creates a gnubok_sk_ key that acts as the service account: it reaches only the account's company, acts with the access of the account's sponsor, and everything it writes is recorded with the actor service_account (the account's name), acting for the sponsor. The response carries the secret in key, exactly once. Its scopes must be ones the calling key holds itself; service_accounts:manage is never granted, so a service account cannot mint keys or create accounts.

**Use when:** You set up the integration that runs as the service account, or rotate its key (mint the new one, switch, revoke the old one).
**Do not use for:** A key for a person (create it in Settings > API & MCP). Recovering a lost secret: mint a new key and revoke the old one.

**Pitfalls:**
- The secret is returned exactly once. Idempotency-Key is not honoured: a repeated call mints a second key, so check GET /service-accounts/{id} and revoke any extra.
- Each requested scope must be held by the calling key (403 SERVICE_ACCOUNT_SCOPE_NOT_HELD, details.not_held lists the rest).
- A staging write scope together with pending_operations:approve needs acknowledge_sod: true (409 API_KEY_SOD_CONFLICT otherwise).
- At most 5 live keys per account (409 SERVICE_ACCOUNT_KEY_LIMIT). A revoked account takes no new key (409 SERVICE_ACCOUNT_REVOKED); a suspended one neither (403 SERVICE_ACCOUNT_SUSPENDED).
- When the sponsor stops being an owner or admin, the key is refused at every call with 403 SERVICE_ACCOUNT_SUSPENDED until the role is restored.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{
  name?: string,
  scopes: ("transactions:read" | "transactions:write" | "customers:read" | "customers:write" | "articles:read" | "articles:write" | "invoices:read" | "invoices:draft" | "invoices:write" | "suppliers:read" | "suppliers:register" | "suppliers:write" | "reports:read" | "dimensions:read" | "bookkeeping:write" | "payroll:read" | "payroll:write" | "companies:read" | "companies:write" | "events:read" | "webhooks:manage" | "operations:read" | "documents:read" | "documents:write" | "compliance:read" | "skatteverket:write" | "agent:read" | "agent:write" | "pending_operations:read" | "pending_operations:approve" | "reconciliation:read" | "reconciliation:write" | "reconciliation:signoff" | "forecast:write")[],
  mode?: "live" | "test",
  read_only?: boolean,
  acknowledge_sod?: boolean
}
```

Example request:
```json
{
  "scopes": [
    "invoices:read",
    "invoices:write"
  ]
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    handle?: string,
    name: string,
    key_prefix: string,
    scopes: string[],
    mode: "live" | "test",
    access: "read_write" | "read_only",
    created_at: string,
    last_used_at: string | null,
    revoked_at: string | null,
    service_account_id: string,
    key: string
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
    "id": "7a1e0c55-0000-4000-8000-0000000000b1",
    "name": "Nattlig fakturasynk",
    "key_prefix": "gnubok_sk_Xb3kQ9aZ",
    "scopes": [
      "invoices:read",
      "invoices:write"
    ],
    "mode": "live",
    "access": "read_write",
    "created_at": "2026-10-16T08:01:00Z",
    "last_used_at": null,
    "revoked_at": null,
    "service_account_id": "5b6c1d2e-0000-4000-8000-0000000000a1",
    "key": "gnubok_sk_Xb3kQ9aZ…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/service-accounts/{id}/keys/{keyId}/revoke`

**Revoke one key of a service account.**
`scope:service_accounts:manage · risk:medium · idempotent`

Revokes the key: the next request with it is refused. The account and its other keys are untouched. Revoking a revoked key answers it unchanged.

**Use when:** You rotate a service account's key (after switching the integration to the new one) or a single key may have leaked.
**Do not use for:** Stopping the whole integration at once: revoke the account (POST /service-accounts/{id}/revoke).

**Pitfalls:**
- Final: a revoked key cannot be restored. Mint a new one.
- A key that is not one of this account's keys in this company answers 404 SERVICE_ACCOUNT_KEY_NOT_FOUND.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `keyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    id: string,
    handle?: string,
    name: string,
    key_prefix: string,
    scopes: string[],
    mode: "live" | "test",
    access: "read_write" | "read_only",
    created_at: string,
    last_used_at: string | null,
    revoked_at: string | null
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
    "id": "7a1e0c55-0000-4000-8000-0000000000b1",
    "name": "Nattlig fakturasynk",
    "key_prefix": "gnubok_sk_Xb3kQ9aZ",
    "scopes": [
      "invoices:read",
      "invoices:write"
    ],
    "mode": "live",
    "access": "read_write",
    "created_at": "2026-10-16T08:01:00Z",
    "last_used_at": null,
    "revoked_at": "2026-11-02T09:30:00Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/service-accounts/{id}/revoke`

**Revoke a service account and all its keys.**
`scope:service_accounts:manage · risk:high · idempotent`

Revokes the service account and, in the same transaction, every key it has: the next request with any of them is refused. The account is never deleted: it stays listed with status revoked, so the processing history keeps naming it. Revoking a revoked account answers it unchanged.

**Use when:** An integration is retired, or a key may have leaked and you want everything the account can do stopped at once.
**Do not use for:** Rotating one key: mint a new key, then revoke the old one with POST /service-accounts/{id}/keys/{keyId}/revoke.

**Pitfalls:**
- Final: a revoked account cannot get new keys or be restored. Create a new account (the name is free again).
- Writes the account made stay as they are; they keep naming the account and its sponsor.

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
    company_id: string,
    name: string,
    sponsor_user_id: string,
    status: "active" | "suspended" | "revoked",
    created_by: string,
    created_at: string,
    revoked_at: string | null,
    revoked_by: string | null
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
    "id": "5b6c1d2e-0000-4000-8000-0000000000a1",
    "company_id": "8fd5b1f4-0000-4000-8000-000000000001",
    "name": "Nattlig fakturasynk",
    "sponsor_user_id": "3f2a9c10-0000-4000-8000-000000000002",
    "status": "revoked",
    "created_by": "3f2a9c10-0000-4000-8000-000000000002",
    "created_at": "2026-10-16T08:00:00Z",
    "revoked_at": "2026-11-02T09:30:00Z",
    "revoked_by": "3f2a9c10-0000-4000-8000-000000000002"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/settings`

**Read the company settings.**
`scope:companies:read · risk:low · idempotent`

Returns every company setting the API can write: contact and address, invoice payment details and layout, invoice email texts and recipients, reminders, voucher series, feature toggles, the tax profile (VAT/moms, F-skatt, employer registration, fiscal year, accounting method, share capital) and the bookkeeping lock, plus the fixed legal identity (entity_type, org_number). contact_person is the default "Vår referens" on new invoices.

**Use when:** Before creating invoices (payment details must exist), before any settings change, or to learn how the books are kept (accounting_method: accrual = faktureringsmetoden, cash = kontantmetoden; moms_period).
**Do not use for:** Payroll settings (GET /salary/settings) or fiscal periods and their locks (GET /fiscal-periods).

**Pitfalls:**
- Fields that were never set read null, not a default.
- bookkeeping_locked_through is the company-wide lock: nothing on or before that date can be booked or changed.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    company_id: string,
    entity_type: string | null,
    org_number: string | null,
    onboarding_complete: boolean | null,
    contact_person: string | null,
    invoice_qr_mode: "auto" | "bank_app" | "swish" | "payment_link" | "none" | null,
    company_name: string | null,
    address_line1: string | null,
    address_line2: string | null,
    postal_code: string | null,
    city: string | null,
    registered_office: string | null,
    country: string | null,
    phone: string | null,
    email: string | null,
    website: string | null,
    tax_contact_name: string | null,
    tax_contact_phone: string | null,
    tax_contact_email: string | null,
    bank_name: string | null,
    clearing_number: string | null,
    account_number: string | null,
    bankgiro: string | null,
    plusgiro: string | null,
    swish: string | null,
    iban: string | null,
    bic: string | null,
    swedbank_signer_id: string | null,
    swedbank_corporate_pay_id: string | null,
    nordea_signer_id: string | null,
    invoice_prefix: string | null,
    invoice_default_notes: string | null,
    invoice_company_name_position: string | null,
    invoice_late_fee_text: string | null,
    invoice_credit_terms_text: string | null,
    invoice_email_reply_to: string | null,
    invoice_primary_color: string | null,
    invoice_accent_color: string | null,
    invoice_font_family: string | null,
    invoice_header_text: string | null,
    invoice_footer_text: string | null,
    default_voucher_series: string | null,
    sector_slug: string | null,
    self_billing_prefix: string | null,
    self_billing_acceptance_text: string | null,
    salary_vacation_year_basis: string | null,
    vat_number: string | null,
    moms_period: string | null,
    vat_filing_method: string | null,
    periodisk_sammanstallning_period: string | null,
    periodisk_sammanstallning_filing_method: string | null,
    accounting_method: string | null,
    bookkeeping_locked_through: string | null,
    ore_rounding: boolean | null,
    invoice_show_ocr: boolean | null,
    invoice_show_bankgiro: boolean | null,
    invoice_show_plusgiro: boolean | null,
    invoice_show_swish: boolean | null,
    invoice_show_payment_qr: boolean | null,
    invoice_show_logo: boolean | null,
    invoice_show_article_number: boolean | null,
    invoice_show_company_name: boolean | null,
    invoice_payment_links_enabled: boolean | null,
    send_invoice_reminders: boolean | null,
    reminder_fee_enabled: boolean | null,
    dimensions_enabled: boolean | null,
    mileage_enabled: boolean | null,
    sales_orders_enabled: boolean | null,
    quotes_enabled: boolean | null,
    proforma_enabled: boolean | null,
    recurring_invoices_enabled: boolean | null,
    self_billing_enabled: boolean | null,
    f_skatt: boolean | null,
    vat_registered: boolean | null,
    vat_taxable_base_over_40m: boolean | null,
    vat_has_eu_trade: boolean | null,
    periodisk_sammanstallning_enabled: boolean | null,
    kontrolluppgifter_enabled: boolean | null,
    rot_rut_enabled: boolean | null,
    oss_enabled: boolean | null,
    ioss_enabled: boolean | null,
    intrastat_enabled: boolean | null,
    punktskatt_enabled: boolean | null,
    fyllnadsinbetalning_enabled: boolean | null,
    pays_salaries: boolean | null,
    employer_registered: boolean | null,
    employer_seasonal: boolean | null,
    defer_invoice_booking: boolean | null,
    next_invoice_number: number | null,
    next_arrival_number: number | null,
    invoice_default_days: number | null,
    reminder_days_level_1: number | null,
    reminder_days_level_2: number | null,
    reminder_days_level_3: number | null,
    reminder_fee_amount: number | null,
    reminder_interest_rate_override: number | null,
    fiscal_year_start_month: number | null,
    preliminary_tax_monthly: number | null,
    aktiekapital: number | null,
    antal_aktier: number | null,
    auto_lock_period_days: number | null,
    next_self_billing_number: number | null,
    invoice_payment_accounts?: unknown,
    invoice_email_texts?: unknown,
    invoice_email_cc_addresses?: unknown,
    invoice_email_bcc_addresses?: unknown,
    reminder_text_overrides?: unknown,
    default_voucher_series_per_source_type?: unknown,
    voucher_series_labels?: unknown
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
    "company_id": "aaaa1111-2222-4333-8444-555566667777",
    "entity_type": "aktiebolag",
    "company_name": "Acme AB",
    "contact_person": "Anna Andersson",
    "bankgiro": "991-2346",
    "vat_registered": true,
    "moms_period": "quarterly",
    "accounting_method": "accrual",
    "bookkeeping_locked_through": "2026-06-30"
  },
  "meta": {
    "request_id": "req_...",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/settings`

**Partially update company settings (contact, invoicing, reminders, voucher series, toggles).**
`scope:companies:write · risk:medium · idempotent · dry-run · reversible`

Patches any subset of the non-legal company settings: contact and address, invoice payment details (bank account, Bankgiro, Plusgiro, Swish, IBAN/BIC, per-currency payment accounts), the Swedbank SignerID and Corporate Pay id for payment files, invoice numbering, layout and branding, invoice email texts and fixed copy recipients, reminders, voucher series, feature toggles and the vacation-year basis. Same rules as the settings page. Owner or admin only. Idempotent (mandatory Idempotency-Key). Dry-runnable.

**Use when:** The payment or contact details on invoices change, invoice texts or reminders should be adjusted, or a feature should be switched on or off.
**Do not use for:** VAT, F-skatt, fiscal year, accounting method or share capital (PATCH /settings/tax-profile), the bookkeeping lock (PATCH /settings/bookkeeping-lock), payroll settings (PATCH /salary/settings). entity_type and org_number are fixed.

**Pitfalls:**
- Only an owner or admin of the company may change settings: other members get 403 FORBIDDEN.
- contact_person is stored as default_our_reference: the default "Vår referens" on new invoices.
- bankgiro and plusgiro must carry a valid Luhn check digit; null or empty string clears them.
- iban and bic are what SEK invoices print. The salary, supplier and tax payment files pay from the account the salary is booked on (the primary bank account) with that account's own IBAN; they use iban and bic from here only when that account has no IBAN and is the company's only SEK bank account, or the company has no bank accounts. The bankgiro here is the sender of a Bankgirot LB file.
- invoice_email_texts only accepts the placeholders {fakturanummer} {kundnamn} {förnamn} {företag} {förfallodatum} {belopp}.
- reminder_days_level_1 < _2 < _3 must hold after the change (stored values fill in the ones not sent).
- The booking engine reads default_voucher_series_per_source_type, not default_voucher_series: send the map to move bookings to another series.
- salary_vacation_year_basis cannot change while open vacation balances exist.
- Turning dimensions_enabled on also registers the dimension codes already on journal lines as archived registry values, as the settings page does; the warning DIMENSION_CODES_IMPORTED says how many.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  company_name?: string,
  address_line1?: string,
  address_line2?: string,
  postal_code?: string,
  city?: string,
  registered_office?: string | null,
  country?: string,
  phone?: string,
  email?: string | "",
  website?: string | "",
  tax_contact_name?: string | null,
  tax_contact_phone?: string | null,
  tax_contact_email?: string | null | "",
  bank_name?: string | null,
  clearing_number?: string | null | "",
  account_number?: string | null | "",
  bankgiro?: string | null | "",
  plusgiro?: string | null | "",
  swish?: string | null,
  iban?: string | null | "",
  bic?: string | null | "",
  swedbank_signer_id?: string | null,
  swedbank_corporate_pay_id?: string | null,
  nordea_signer_id?: string | null,
  invoice_payment_accounts?: Record<string, { bank_name?: string | null, clearing_number?: string | null | "", account_number?: string | null | "", bankgiro?: string | null | "", plusgiro?: string | null | "", swish?: string | null, iban?: string | null | "", bic?: string | null | "", bank_code?: string | null | "", foreign_account_number?: string | null | "" }>,
  invoice_prefix?: string | null,
  next_invoice_number?: number,
  next_arrival_number?: number,
  invoice_default_days?: number,
  invoice_default_notes?: string | null,
  ore_rounding?: boolean,
  invoice_show_ocr?: boolean,
  invoice_show_bankgiro?: boolean,
  invoice_show_plusgiro?: boolean,
  invoice_show_swish?: boolean,
  invoice_show_payment_qr?: boolean,
  invoice_qr_mode?: "auto" | "bank_app" | "swish" | "payment_link" | "none",
  invoice_show_logo?: boolean,
  invoice_show_article_number?: boolean,
  invoice_show_company_name?: boolean,
  invoice_company_name_position?: "header" | "footer",
  invoice_late_fee_text?: string | null,
  invoice_credit_terms_text?: string | null,
  invoice_payment_links_enabled?: boolean,
  invoice_email_texts?: {
    sv?: { subject?: string, greeting?: string, body?: string, signoff?: string },
    en?: { subject?: string, greeting?: string, body?: string, signoff?: string }
  } | null,
  invoice_email_cc_addresses?: string[] | null,
  invoice_email_bcc_addresses?: string[] | null,
  invoice_email_reply_to?: string | null,
  invoice_primary_color?: string,
  invoice_accent_color?: string,
  invoice_font_family?: "Helvetica" | "Times-Roman" | "Courier" | "Source Sans 3" | "Source Serif 4" | "Custom",
  invoice_header_text?: string | null,
  invoice_footer_text?: string | null,
  send_invoice_reminders?: boolean,
  reminder_days_level_1?: number,
  reminder_days_level_2?: number,
  reminder_days_level_3?: number,
  reminder_text_overrides?: {
    level_1?: { subject?: string, body?: string },
    level_2?: { subject?: string, body?: string },
    level_3?: { subject?: string, body?: string }
  } | null,
  reminder_fee_enabled?: boolean,
  reminder_fee_amount?: number,
  reminder_interest_rate_override?: number | null,
  default_voucher_series?: string,
  default_voucher_series_per_source_type?: Record<string, string>,
  voucher_series_labels?: Record<string, string>,
  sector_slug?: string | null,
  dimensions_enabled?: boolean,
  mileage_enabled?: boolean,
  sales_orders_enabled?: boolean,
  quotes_enabled?: boolean,
  proforma_enabled?: boolean,
  recurring_invoices_enabled?: boolean,
  self_billing_enabled?: boolean,
  self_billing_prefix?: string,
  next_self_billing_number?: number,
  self_billing_acceptance_text?: string | null,
  salary_vacation_year_basis?: "calendar" | "statutory_apr_mar",
  contact_person?: string | null
}
```

Example request:
```json
{
  "bankgiro": "991-2346",
  "contact_person": "Anna Andersson"
}
```

Response `200`:
```ts
{
  data: {
    company_id: string,
    entity_type: string | null,
    org_number: string | null,
    onboarding_complete: boolean | null,
    contact_person: string | null,
    invoice_qr_mode: "auto" | "bank_app" | "swish" | "payment_link" | "none" | null,
    company_name: string | null,
    address_line1: string | null,
    address_line2: string | null,
    postal_code: string | null,
    city: string | null,
    registered_office: string | null,
    country: string | null,
    phone: string | null,
    email: string | null,
    website: string | null,
    tax_contact_name: string | null,
    tax_contact_phone: string | null,
    tax_contact_email: string | null,
    bank_name: string | null,
    clearing_number: string | null,
    account_number: string | null,
    bankgiro: string | null,
    plusgiro: string | null,
    swish: string | null,
    iban: string | null,
    bic: string | null,
    swedbank_signer_id: string | null,
    swedbank_corporate_pay_id: string | null,
    nordea_signer_id: string | null,
    invoice_prefix: string | null,
    invoice_default_notes: string | null,
    invoice_company_name_position: string | null,
    invoice_late_fee_text: string | null,
    invoice_credit_terms_text: string | null,
    invoice_email_reply_to: string | null,
    invoice_primary_color: string | null,
    invoice_accent_color: string | null,
    invoice_font_family: string | null,
    invoice_header_text: string | null,
    invoice_footer_text: string | null,
    default_voucher_series: string | null,
    sector_slug: string | null,
    self_billing_prefix: string | null,
    self_billing_acceptance_text: string | null,
    salary_vacation_year_basis: string | null,
    vat_number: string | null,
    moms_period: string | null,
    vat_filing_method: string | null,
    periodisk_sammanstallning_period: string | null,
    periodisk_sammanstallning_filing_method: string | null,
    accounting_method: string | null,
    bookkeeping_locked_through: string | null,
    ore_rounding: boolean | null,
    invoice_show_ocr: boolean | null,
    invoice_show_bankgiro: boolean | null,
    invoice_show_plusgiro: boolean | null,
    invoice_show_swish: boolean | null,
    invoice_show_payment_qr: boolean | null,
    invoice_show_logo: boolean | null,
    invoice_show_article_number: boolean | null,
    invoice_show_company_name: boolean | null,
    invoice_payment_links_enabled: boolean | null,
    send_invoice_reminders: boolean | null,
    reminder_fee_enabled: boolean | null,
    dimensions_enabled: boolean | null,
    mileage_enabled: boolean | null,
    sales_orders_enabled: boolean | null,
    quotes_enabled: boolean | null,
    proforma_enabled: boolean | null,
    recurring_invoices_enabled: boolean | null,
    self_billing_enabled: boolean | null,
    f_skatt: boolean | null,
    vat_registered: boolean | null,
    vat_taxable_base_over_40m: boolean | null,
    vat_has_eu_trade: boolean | null,
    periodisk_sammanstallning_enabled: boolean | null,
    kontrolluppgifter_enabled: boolean | null,
    rot_rut_enabled: boolean | null,
    oss_enabled: boolean | null,
    ioss_enabled: boolean | null,
    intrastat_enabled: boolean | null,
    punktskatt_enabled: boolean | null,
    fyllnadsinbetalning_enabled: boolean | null,
    pays_salaries: boolean | null,
    employer_registered: boolean | null,
    employer_seasonal: boolean | null,
    defer_invoice_booking: boolean | null,
    next_invoice_number: number | null,
    next_arrival_number: number | null,
    invoice_default_days: number | null,
    reminder_days_level_1: number | null,
    reminder_days_level_2: number | null,
    reminder_days_level_3: number | null,
    reminder_fee_amount: number | null,
    reminder_interest_rate_override: number | null,
    fiscal_year_start_month: number | null,
    preliminary_tax_monthly: number | null,
    aktiekapital: number | null,
    antal_aktier: number | null,
    auto_lock_period_days: number | null,
    next_self_billing_number: number | null,
    invoice_payment_accounts?: unknown,
    invoice_email_texts?: unknown,
    invoice_email_cc_addresses?: unknown,
    invoice_email_bcc_addresses?: unknown,
    reminder_text_overrides?: unknown,
    default_voucher_series_per_source_type?: unknown,
    voucher_series_labels?: unknown
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
    "company_id": "aaaa1111-2222-4333-8444-555566667777",
    "bankgiro": "991-2346",
    "contact_person": "Anna Andersson",
    "email": "faktura@acme.example"
  },
  "meta": {
    "request_id": "req_...",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/settings/bookkeeping-lock`

**Set, move or remove the company-wide bookkeeping lock date.**
`scope:companies:write · risk:high · idempotent · dry-run · reversible`

Sets bookkeeping_locked_through (nothing dated on or before it can be booked, corrected or attached) and auto_lock_period_days. Moving the date back or clearing it reopens those dates, exactly as the settings page allows; the response then carries the warning BOOKKEEPING_LOCK_MOVED_BACKWARDS. A change of the stored date emits the period.lock_date_changed webhook. Owner or admin only. Idempotent (mandatory Idempotency-Key). Dry-runnable.

**Use when:** A period is reconciled and filed and should be protected, or a locked date must be reopened for a correction.
**Do not use for:** Locking or closing a single fiscal period (POST /fiscal-periods/{id}/lock, /close), or correcting a posted verifikat (storno or rättelse).

**Pitfalls:**
- Only an owner or admin of the company may change settings: other members get 403 FORBIDDEN.
- Locking more (a first lock date, or a later one) is refused while an SIE import is still holding a fiscal period (finish the import first). Moving the date back or removing it is always allowed: that is how an SIE undo stopped by the lock date continues.
- A backwards move is allowed but high risk. When it reopens a filed momsdeklaration period it is refused with 409 BOOKKEEPING_LOCK_REOPENS_FILED_VAT (details.filed_periods) unless acknowledge_filed_vat_periods is true: reopen a filed period only to book a correction and file a corrected declaration for it.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  bookkeeping_locked_through?: string | null,
  auto_lock_period_days?: number | null,
  acknowledge_filed_vat_periods?: boolean
}
```

Example request:
```json
{
  "bookkeeping_locked_through": "2026-06-30"
}
```

Response `200`:
```ts
{
  data: {
    company_id: string,
    entity_type: string | null,
    org_number: string | null,
    onboarding_complete: boolean | null,
    contact_person: string | null,
    invoice_qr_mode: "auto" | "bank_app" | "swish" | "payment_link" | "none" | null,
    company_name: string | null,
    address_line1: string | null,
    address_line2: string | null,
    postal_code: string | null,
    city: string | null,
    registered_office: string | null,
    country: string | null,
    phone: string | null,
    email: string | null,
    website: string | null,
    tax_contact_name: string | null,
    tax_contact_phone: string | null,
    tax_contact_email: string | null,
    bank_name: string | null,
    clearing_number: string | null,
    account_number: string | null,
    bankgiro: string | null,
    plusgiro: string | null,
    swish: string | null,
    iban: string | null,
    bic: string | null,
    swedbank_signer_id: string | null,
    swedbank_corporate_pay_id: string | null,
    nordea_signer_id: string | null,
    invoice_prefix: string | null,
    invoice_default_notes: string | null,
    invoice_company_name_position: string | null,
    invoice_late_fee_text: string | null,
    invoice_credit_terms_text: string | null,
    invoice_email_reply_to: string | null,
    invoice_primary_color: string | null,
    invoice_accent_color: string | null,
    invoice_font_family: string | null,
    invoice_header_text: string | null,
    invoice_footer_text: string | null,
    default_voucher_series: string | null,
    sector_slug: string | null,
    self_billing_prefix: string | null,
    self_billing_acceptance_text: string | null,
    salary_vacation_year_basis: string | null,
    vat_number: string | null,
    moms_period: string | null,
    vat_filing_method: string | null,
    periodisk_sammanstallning_period: string | null,
    periodisk_sammanstallning_filing_method: string | null,
    accounting_method: string | null,
    bookkeeping_locked_through: string | null,
    ore_rounding: boolean | null,
    invoice_show_ocr: boolean | null,
    invoice_show_bankgiro: boolean | null,
    invoice_show_plusgiro: boolean | null,
    invoice_show_swish: boolean | null,
    invoice_show_payment_qr: boolean | null,
    invoice_show_logo: boolean | null,
    invoice_show_article_number: boolean | null,
    invoice_show_company_name: boolean | null,
    invoice_payment_links_enabled: boolean | null,
    send_invoice_reminders: boolean | null,
    reminder_fee_enabled: boolean | null,
    dimensions_enabled: boolean | null,
    mileage_enabled: boolean | null,
    sales_orders_enabled: boolean | null,
    quotes_enabled: boolean | null,
    proforma_enabled: boolean | null,
    recurring_invoices_enabled: boolean | null,
    self_billing_enabled: boolean | null,
    f_skatt: boolean | null,
    vat_registered: boolean | null,
    vat_taxable_base_over_40m: boolean | null,
    vat_has_eu_trade: boolean | null,
    periodisk_sammanstallning_enabled: boolean | null,
    kontrolluppgifter_enabled: boolean | null,
    rot_rut_enabled: boolean | null,
    oss_enabled: boolean | null,
    ioss_enabled: boolean | null,
    intrastat_enabled: boolean | null,
    punktskatt_enabled: boolean | null,
    fyllnadsinbetalning_enabled: boolean | null,
    pays_salaries: boolean | null,
    employer_registered: boolean | null,
    employer_seasonal: boolean | null,
    defer_invoice_booking: boolean | null,
    next_invoice_number: number | null,
    next_arrival_number: number | null,
    invoice_default_days: number | null,
    reminder_days_level_1: number | null,
    reminder_days_level_2: number | null,
    reminder_days_level_3: number | null,
    reminder_fee_amount: number | null,
    reminder_interest_rate_override: number | null,
    fiscal_year_start_month: number | null,
    preliminary_tax_monthly: number | null,
    aktiekapital: number | null,
    antal_aktier: number | null,
    auto_lock_period_days: number | null,
    next_self_billing_number: number | null,
    invoice_payment_accounts?: unknown,
    invoice_email_texts?: unknown,
    invoice_email_cc_addresses?: unknown,
    invoice_email_bcc_addresses?: unknown,
    reminder_text_overrides?: unknown,
    default_voucher_series_per_source_type?: unknown,
    voucher_series_labels?: unknown
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
    "company_id": "aaaa1111-2222-4333-8444-555566667777",
    "bookkeeping_locked_through": "2026-06-30",
    "auto_lock_period_days": null
  },
  "meta": {
    "request_id": "req_...",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/settings/skattekonto-account`

**Read which ledger account the skattekonto runs on (1630, or 2012 for an enskild firma).**
`scope:companies:read · risk:low · idempotent`

Returns the account every skattekonto reader uses now (booking skattekonto rows, matching them to verifikat, the skattekonto reconciliation), the stored choice, the accounts the legal form may choose, what the books suggest and the balance on each choosable account.

**Use when:** Before booking skattekonto rows or a payment to Skatteverket by hand, or before changing the account.
**Do not use for:** The skattekonto events themselves (the reconciliation and skattekonto sync endpoints).

**Pitfalls:**
- chosen is null for a company that never chose: it runs 1630.
- balances read the ledger through as_of; a change of account moves none of it.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    entity_type: string,
    account: "1630" | "2012",
    chosen: "1630" | "2012" | null,
    choices: ("1630" | "2012")[],
    books_suggest: "1630" | "2012" | null,
    as_of: string,
    balances: { account: "1630" | "2012", balance: number }[]
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
    "entity_type": "enskild_firma",
    "account": "1630",
    "chosen": null,
    "choices": [
      "1630",
      "2012"
    ],
    "books_suggest": "1630",
    "as_of": "2026-10-26",
    "balances": [
      {
        "account": "1630",
        "balance": 1250
      },
      {
        "account": "2012",
        "balance": 0
      }
    ]
  },
  "meta": {
    "request_id": "req_...",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/settings/skattekonto-account`

**Choose the ledger account the skattekonto runs on: 1630, or 2012 in equity for an enskild firma.**
`scope:companies:write · risk:high · idempotent · dry-run · reversible`

Stores the choice. From then on booking skattekonto rows, matching them to verifikat and the skattekonto reconciliation use the new account; 2012 is added to the chart (BAS K1 name, eget kapital) when missing. Nothing in the ledger moves: posted verifikat stay on the account they were booked on, and the response says what is left on the previous account (left_on_previous) for a transfer verifikat the user books. Owner or admin only. Idempotent (mandatory Idempotency-Key). Dry-runnable.

**Use when:** An enskild firma keeps its skattekonto in eget kapital on 2012 (the firm shares the skattekonto with the owner), or a company moves back to 1630.
**Do not use for:** Moving the balance itself (book the transfer with POST /journal-entries: debit the new account and credit the old one, or the reverse), or the tax profile (PATCH /settings/tax-profile).

**Pitfalls:**
- Only an owner or admin of the company may change settings: other members get 403 FORBIDDEN.
- 2012 is allowed for an enskild firma only; any other account, or 2012 for another legal form, is 400 SKATTEKONTO_ACCOUNT_NOT_ALLOWED with details.allowed.
- Company-authored booking templates and mapping rules that name 1630 keep 1630: review them after a change.
- left_on_previous is the old account's balance when it is not zero: the skattekonto reconciliation reads only the new account, so book the transfer.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ account: "1630" | "2012" }
```

Example request:
```json
{
  "account": "2012"
}
```

Response `200`:
```ts
{
  data: {
    state: { entity_type: string, account: "1630" | "2012", chosen: "1630" | "2012" | null, choices: ("1630" | "2012")[], books_suggest: "1630" | "2012" | null, as_of: string, balances: { account: "1630" | "2012", balance: number }[] },
    previous_account: "1630" | "2012",
    left_on_previous: number | null
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
    "state": {
      "entity_type": "enskild_firma",
      "account": "2012",
      "chosen": "2012",
      "choices": [
        "1630",
        "2012"
      ],
      "books_suggest": "1630",
      "as_of": "2026-10-26",
      "balances": [
        {
          "account": "1630",
          "balance": 1250
        },
        {
          "account": "2012",
          "balance": 0
        }
      ]
    },
    "previous_account": "1630",
    "left_on_previous": 1250
  },
  "meta": {
    "request_id": "req_...",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/settings/tax-profile`

**Change the tax and legal profile: VAT, F-skatt, employer registration, fiscal year, accounting method.**
`scope:companies:write · risk:high · idempotent · dry-run · reversible`

Patches the settings that decide how the books are kept and declared: VAT registration, VAT number and moms period, EU trade and periodisk sammanställning, F-skatt, preliminary tax, employer registration, fiscal year start month, accounting method (faktureringsmetoden/kontantmetoden), deferred invoice booking, share capital and the optional deadline reminders. Runs the settings page rules and, like it, regenerates the tax deadlines. Owner or admin only. Idempotent (mandatory Idempotency-Key). Dry-runnable.

**Use when:** The company registered or deregistered for VAT or as an employer, Skatteverket changed its moms period, the fiscal year or accounting method was changed with the authorities, or an accounting method set wrong at onboarding is corrected.
**Do not use for:** Invoice, contact or payment details (PATCH /settings), the bookkeeping lock (PATCH /settings/bookkeeping-lock), entity type or org number (fixed).

**Pitfalls:**
- Only an owner or admin of the company may change settings: other members get 403 FORBIDDEN.
- Saving regenerates the system tax deadlines for this year and next; completed deadlines keep their status.
- vat_registered=true needs vat_number (SE + 12 digits) and moms_period, stored or sent.
- vat_registered=false also turns off vat_taxable_base_over_40m, vat_has_eu_trade and periodisk_sammanstallning_enabled.
- vat_taxable_base_over_40m requires moms_period=monthly; periodisk sammanställning requires VAT registration and EU trade.
- An enskild firma must keep fiscal_year_start_month=1 (BFL 3 kap.).
- aktiekapital and antal_aktier are set or cleared together.
- accounting_method=cash turns defer_invoice_booking off (deferred booking is accrual only).
- defer_invoice_booking=true: sent customer invoices and registered supplier invoices get no verifikat until they are booked with POST /invoices/{id}/book (or /invoices/bulk-book) and POST /supplier-invoices/{id}/book.
- accounting_method never changes while an open invoice has no verifikat of its own (409 ACCOUNTING_METHOD_CHANGE_OPEN_INVOICES). Otherwise it changes freely only while the current fiscal year has no posted verifikat; later it is a correction of a wrong setting: send accounting_method_correction_reason (else 409 ACCOUNTING_METHOD_CHANGE_MID_YEAR). The method governs the whole year (BFL 5 kap 2 §); a real move to bokslutsmetoden needs Skatteverket first (ML 7 kap 17 §).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  f_skatt?: boolean,
  vat_registered?: boolean,
  vat_number?: string | null,
  moms_period?: "monthly" | "quarterly" | "yearly" | null,
  vat_taxable_base_over_40m?: boolean,
  vat_has_eu_trade?: boolean,
  vat_filing_method?: "electronic" | "paper",
  periodisk_sammanstallning_enabled?: boolean,
  periodisk_sammanstallning_period?: "monthly" | "quarterly",
  periodisk_sammanstallning_filing_method?: "electronic" | "paper",
  kontrolluppgifter_enabled?: boolean,
  rot_rut_enabled?: boolean,
  oss_enabled?: boolean,
  ioss_enabled?: boolean,
  intrastat_enabled?: boolean,
  punktskatt_enabled?: boolean,
  fyllnadsinbetalning_enabled?: boolean,
  fiscal_year_start_month?: number,
  preliminary_tax_monthly?: number | null,
  pays_salaries?: boolean,
  employer_registered?: boolean | null,
  employer_seasonal?: boolean,
  accounting_method?: "accrual" | "cash",
  defer_invoice_booking?: boolean,
  aktiekapital?: number | null,
  antal_aktier?: number | null,
  accounting_method_correction_reason?: string
}
```

Example request:
```json
{
  "vat_registered": true,
  "vat_number": "SE556677889901",
  "moms_period": "quarterly"
}
```

Response `200`:
```ts
{
  data: {
    company_id: string,
    entity_type: string | null,
    org_number: string | null,
    onboarding_complete: boolean | null,
    contact_person: string | null,
    invoice_qr_mode: "auto" | "bank_app" | "swish" | "payment_link" | "none" | null,
    company_name: string | null,
    address_line1: string | null,
    address_line2: string | null,
    postal_code: string | null,
    city: string | null,
    registered_office: string | null,
    country: string | null,
    phone: string | null,
    email: string | null,
    website: string | null,
    tax_contact_name: string | null,
    tax_contact_phone: string | null,
    tax_contact_email: string | null,
    bank_name: string | null,
    clearing_number: string | null,
    account_number: string | null,
    bankgiro: string | null,
    plusgiro: string | null,
    swish: string | null,
    iban: string | null,
    bic: string | null,
    swedbank_signer_id: string | null,
    swedbank_corporate_pay_id: string | null,
    nordea_signer_id: string | null,
    invoice_prefix: string | null,
    invoice_default_notes: string | null,
    invoice_company_name_position: string | null,
    invoice_late_fee_text: string | null,
    invoice_credit_terms_text: string | null,
    invoice_email_reply_to: string | null,
    invoice_primary_color: string | null,
    invoice_accent_color: string | null,
    invoice_font_family: string | null,
    invoice_header_text: string | null,
    invoice_footer_text: string | null,
    default_voucher_series: string | null,
    sector_slug: string | null,
    self_billing_prefix: string | null,
    self_billing_acceptance_text: string | null,
    salary_vacation_year_basis: string | null,
    vat_number: string | null,
    moms_period: string | null,
    vat_filing_method: string | null,
    periodisk_sammanstallning_period: string | null,
    periodisk_sammanstallning_filing_method: string | null,
    accounting_method: string | null,
    bookkeeping_locked_through: string | null,
    ore_rounding: boolean | null,
    invoice_show_ocr: boolean | null,
    invoice_show_bankgiro: boolean | null,
    invoice_show_plusgiro: boolean | null,
    invoice_show_swish: boolean | null,
    invoice_show_payment_qr: boolean | null,
    invoice_show_logo: boolean | null,
    invoice_show_article_number: boolean | null,
    invoice_show_company_name: boolean | null,
    invoice_payment_links_enabled: boolean | null,
    send_invoice_reminders: boolean | null,
    reminder_fee_enabled: boolean | null,
    dimensions_enabled: boolean | null,
    mileage_enabled: boolean | null,
    sales_orders_enabled: boolean | null,
    quotes_enabled: boolean | null,
    proforma_enabled: boolean | null,
    recurring_invoices_enabled: boolean | null,
    self_billing_enabled: boolean | null,
    f_skatt: boolean | null,
    vat_registered: boolean | null,
    vat_taxable_base_over_40m: boolean | null,
    vat_has_eu_trade: boolean | null,
    periodisk_sammanstallning_enabled: boolean | null,
    kontrolluppgifter_enabled: boolean | null,
    rot_rut_enabled: boolean | null,
    oss_enabled: boolean | null,
    ioss_enabled: boolean | null,
    intrastat_enabled: boolean | null,
    punktskatt_enabled: boolean | null,
    fyllnadsinbetalning_enabled: boolean | null,
    pays_salaries: boolean | null,
    employer_registered: boolean | null,
    employer_seasonal: boolean | null,
    defer_invoice_booking: boolean | null,
    next_invoice_number: number | null,
    next_arrival_number: number | null,
    invoice_default_days: number | null,
    reminder_days_level_1: number | null,
    reminder_days_level_2: number | null,
    reminder_days_level_3: number | null,
    reminder_fee_amount: number | null,
    reminder_interest_rate_override: number | null,
    fiscal_year_start_month: number | null,
    preliminary_tax_monthly: number | null,
    aktiekapital: number | null,
    antal_aktier: number | null,
    auto_lock_period_days: number | null,
    next_self_billing_number: number | null,
    invoice_payment_accounts?: unknown,
    invoice_email_texts?: unknown,
    invoice_email_cc_addresses?: unknown,
    invoice_email_bcc_addresses?: unknown,
    reminder_text_overrides?: unknown,
    default_voucher_series_per_source_type?: unknown,
    voucher_series_labels?: unknown,
    deadlines_regenerated: boolean
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
    "company_id": "aaaa1111-2222-4333-8444-555566667777",
    "vat_registered": true,
    "vat_number": "SE556677889901",
    "moms_period": "quarterly",
    "deadlines_regenerated": true
  },
  "meta": {
    "request_id": "req_...",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/health`

**Health check.**
`risk:low · idempotent`

Reports the API is reachable and what version is currently served. Public; no auth required.

**Use when:** You want to verify connectivity, latency, or which API version is live before issuing other requests.
**Do not use for:** Anything that needs authenticated data. This endpoint returns no company-specific information.

**Pitfalls:**
- A 200 here only means the API process responds: downstream Postgres/Supabase may still be degraded.

Response `200`:
```ts
{
  data: { status: "ok" | "degraded", service: "gnubok", api_version: string, timestamp: string },
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
    "status": "ok",
    "service": "gnubok",
    "api_version": "2026-05-12",
    "timestamp": "2026-05-12T16:25:06Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/operations/{id}`

**Poll a long-running operation by id.**
`scope:operations:read · risk:low · idempotent`

Returns the current snapshot of a v1 async operation: status (queued / running / succeeded / failed / cancelled), progress (jsonb, free-form), result (on success), and error (on failure). The operation_id is returned by the POST endpoints that initiate async work (period close, year-end, currency revaluation, SIE import).

**Use when:** You started an async operation and need to know whether it has finished. Poll every 5-30 seconds until a terminal status. (The 202 response names `operation.completed` in webhook_event as the eventual push signal, but that webhook event is not deliverable yet: polling is the only supported completion signal today.)
**Do not use for:** Fetching the resource the operation produced: once status=succeeded, read the result field or call the resource-specific GET endpoint. Cancelling a running operation (no cancel endpoint exists in v1).

**Pitfalls:**
- Terminal statuses (`succeeded`, `failed`, `cancelled`) are final; the row never transitions out of them.
- progress is free-form jsonb; agents should treat it as opaque except for the documented fields `phase` (string), `current` / `total` (numbers for percent calculation).
- started_at is null while status=queued (the work has not begun yet); completed_at is null until a terminal status is reached.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    operation_id: string,
    handle?: string,
    type: string,
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled",
    progress?: Record<string, unknown>,
    result?: unknown,
    error: { code?: string, message?: string, details?: unknown } | null,
    started_at: string | null,
    completed_at: string | null,
    poll_url: string,
    webhook_event: "operation.completed"
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
    "operation_id": "0e9c-…",
    "type": "fiscal_periods.year_end",
    "status": "succeeded",
    "progress": {
      "phase": "committed",
      "current": 142,
      "total": 142
    },
    "result": {
      "journal_entries_created": 4,
      "opening_balances_set": 138
    },
    "error": null,
    "started_at": "2026-05-12T10:01:23Z",
    "completed_at": "2026-05-12T10:01:48Z",
    "poll_url": "/api/v1/operations/0e9c-…",
    "webhook_event": "operation.completed"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```
