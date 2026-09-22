<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Fixed assets endpoints

The anläggningsregister: register an asset (no voucher, the purchase is already booked), correct it while no depreciation is posted, and dispose it (sale, scrap or business transfer) which posts the avyttring voucher with gain/loss, VAT and jämkning. Depreciation itself is proposed and posted per fiscal period through the year-end flow.

Conventions (auth, envelope, pagination, dry-run, idempotency, standard errors)
are in SKILL.md and are not repeated per endpoint.

### `GET /api/v1/companies/{companyId}/assets`

**List the fixed-asset register (anläggningsregister).**
`scope:reports:read · risk:low · idempotent`

Returns every asset in the register with its category, acquisition basis, useful life, BAS account triple, disposal state and has_posted_depreciation. Pass ?active_only=true to leave out disposed assets.

**Use when:** You need the anläggningsregister: before proposing depreciation, to check which assets are still open, or to find the asset id for an update or disposal.
**Do not use for:** The bookkept balance on 12xx accounts (use the trial balance or balance sheet). Proposing or posting depreciation (fiscal-periods year-end flow).

**Pitfalls:**
- has_posted_depreciation=true locks acquisition_date, acquisition_cost and category: PATCH returns 409 ASSET_CORRECTION_BLOCKED and a correction goes through storno.
- Disposed assets stay in the register with disposed_at set (BFL retention); filter with active_only=true when you want the open ones.
- acquisition_cost is excl. VAT. The purchase voucher is not linked here: the register does not post anything on create.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `active_only` | query | `"true" \| "false"` | no | true returns only assets that have not been disposed. Default: the whole register. |

Response `200`:
```ts
{
  data: {
    assets: { name: string, category: "immaterial" | "building" | "land_improvement" | "machinery" | "equipment" | "vehicle" | "computer" | "other_tangible", acquisition_date: string, acquisition_cost: number, salvage_value: number, useful_life_months: number, depreciation_method: string, bas_asset_account: string, bas_accumulated_account: string, bas_expense_account: string, k3_components: { name: string, cost: number, useful_life_months: number, salvage_value?: number }[] | null, opening_accumulated_depreciation: number, opening_depreciation_date: string | null, notes: string | null, disposed_at: string | null, disposal_type: "sale" | "scrap" | "business_transfer" | null, disposed_proceeds: number | null, disposal_journal_entry_id: string | null, has_posted_depreciation: boolean, deletable: boolean, created_at: string, updated_at: string, id: string }[]
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
    "assets": [
      {
        "id": "0e9c…",
        "name": "MacBook Pro 16\"",
        "category": "computer",
        "acquisition_date": "2026-03-01",
        "acquisition_cost": 32000,
        "salvage_value": 0,
        "useful_life_months": 36,
        "depreciation_method": "linear",
        "bas_asset_account": "1224",
        "bas_accumulated_account": "1229",
        "bas_expense_account": "7832",
        "k3_components": null,
        "notes": null,
        "disposed_at": null,
        "disposal_type": null,
        "disposed_proceeds": null,
        "disposal_journal_entry_id": null,
        "has_posted_depreciation": false,
        "deletable": true,
        "created_at": "2026-03-01T09:12:00.000Z",
        "updated_at": "2026-03-01T09:12:00.000Z"
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

### `POST /api/v1/companies/{companyId}/assets`

**Register a fixed asset (no voucher is posted).**
`scope:bookkeeping:write · risk:low · idempotent · dry-run`

Adds an asset to the anläggningsregister. BAS accounts default per category (framework-aware for intangibles: a K2 company lands on 1090/1099). No journal entry is posted: the acquisition is already in the books via the bank payment or supplier invoice. Dry-runnable: returns the resolved accounts without writing.

**Use when:** A purchase over the förbrukningsinventarie threshold (half a prisbasbelopp) or with a useful life over three years has been booked and must be depreciated over time.
**Do not use for:** Booking the purchase itself (categorize the bank transaction or register the supplier invoice). Small or short-lived items: expense them on 54xx instead of capitalising.

**Pitfalls:**
- k3_components is accepted only when the company applies K3: 422 K3_REQUIRED_FOR_COMPONENTS otherwise. Components must sum to acquisition_cost.
- Account overrides must sit inside the category range (e.g. 1200-1299 for equipment) and may not be flagged Ej K2 for a K2 company (422 K2_EXCLUDED_ACCOUNT).
- useful_life_months drives linear depreciation from acquisition_date, pro-rated in the first fiscal year.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  name: string,
  category: "immaterial" | "building" | "land_improvement" | "machinery" | "equipment" | "vehicle" | "computer" | "other_tangible",
  acquisition_date: string,
  acquisition_cost: number,
  salvage_value?: number,
  useful_life_months: number,
  depreciation_method?: "linear",
  restvarde_target?: unknown,
  bas_asset_account?: string,
  bas_accumulated_account?: string,
  bas_expense_account?: string,
  k3_components?: { name: string, cost: number, useful_life_months: number, salvage_value?: number }[] | null,
  opening_accumulated_depreciation?: number,
  opening_depreciation_date?: string | null,
  notes?: string
}
```

Example request:
```json
{
  "name": "MacBook Pro 16\"",
  "category": "computer",
  "acquisition_date": "2026-03-01",
  "acquisition_cost": 32000,
  "useful_life_months": 36
}
```

Response `200`:
```ts
{
  data: {
    name: string,
    category: "immaterial" | "building" | "land_improvement" | "machinery" | "equipment" | "vehicle" | "computer" | "other_tangible",
    acquisition_date: string,
    acquisition_cost: number,
    salvage_value: number,
    useful_life_months: number,
    depreciation_method: string,
    bas_asset_account: string,
    bas_accumulated_account: string,
    bas_expense_account: string,
    k3_components: { name: string, cost: number, useful_life_months: number, salvage_value?: number }[] | null,
    opening_accumulated_depreciation: number,
    opening_depreciation_date: string | null,
    notes: string | null,
    disposed_at: string | null,
    disposal_type: "sale" | "scrap" | "business_transfer" | null,
    disposed_proceeds: number | null,
    disposal_journal_entry_id: string | null,
    has_posted_depreciation: boolean,
    deletable: boolean,
    created_at: string,
    updated_at: string,
    id: string
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
    "id": "0e9c…",
    "name": "MacBook Pro 16\"",
    "category": "computer",
    "acquisition_date": "2026-03-01",
    "acquisition_cost": 32000,
    "salvage_value": 0,
    "useful_life_months": 36,
    "depreciation_method": "linear",
    "bas_asset_account": "1224",
    "bas_accumulated_account": "1229",
    "bas_expense_account": "7832",
    "k3_components": null,
    "notes": null,
    "disposed_at": null,
    "disposal_type": null,
    "disposed_proceeds": null,
    "disposal_journal_entry_id": null,
    "has_posted_depreciation": false,
    "deletable": true,
    "created_at": "2026-03-01T09:12:00.000Z",
    "updated_at": "2026-03-01T09:12:00.000Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/assets/{id}`

**Get one fixed asset.**
`scope:reports:read · risk:low · idempotent`

Returns the asset with its acquisition basis, BAS account triple, K3 components, disposal state and has_posted_depreciation.

**Use when:** You have an asset id from the listing and need the full row before an update or disposal.
**Do not use for:** Listing the register (GET /assets). The depreciation schedule per period (year-end flow).

**Pitfalls:**
- Returns 404 ASSET_NOT_FOUND for an id in another company: assets are company-scoped.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    name: string,
    category: "immaterial" | "building" | "land_improvement" | "machinery" | "equipment" | "vehicle" | "computer" | "other_tangible",
    acquisition_date: string,
    acquisition_cost: number,
    salvage_value: number,
    useful_life_months: number,
    depreciation_method: string,
    bas_asset_account: string,
    bas_accumulated_account: string,
    bas_expense_account: string,
    k3_components: { name: string, cost: number, useful_life_months: number, salvage_value?: number }[] | null,
    opening_accumulated_depreciation: number,
    opening_depreciation_date: string | null,
    notes: string | null,
    disposed_at: string | null,
    disposal_type: "sale" | "scrap" | "business_transfer" | null,
    disposed_proceeds: number | null,
    disposal_journal_entry_id: string | null,
    has_posted_depreciation: boolean,
    deletable: boolean,
    created_at: string,
    updated_at: string,
    id: string
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
    "id": "0e9c…",
    "name": "MacBook Pro 16\"",
    "category": "computer",
    "acquisition_date": "2026-03-01",
    "acquisition_cost": 32000,
    "salvage_value": 0,
    "useful_life_months": 36,
    "depreciation_method": "linear",
    "bas_asset_account": "1224",
    "bas_accumulated_account": "1229",
    "bas_expense_account": "7832",
    "k3_components": null,
    "notes": "Serienummer C02XY…",
    "disposed_at": null,
    "disposal_type": null,
    "disposed_proceeds": null,
    "disposal_journal_entry_id": null,
    "has_posted_depreciation": false,
    "deletable": true,
    "created_at": "2026-03-01T09:12:00.000Z",
    "updated_at": "2026-03-02T08:00:00.000Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/assets/{id}`

**Partially update a fixed asset.**
`scope:bookkeeping:write · risk:low · idempotent · dry-run · reversible`

Patches the register row. Name, notes, salvage value and useful life are always editable. Acquisition date, cost and category redefine the depreciation basis and are only accepted while the asset is neither disposed nor depreciated (409 ASSET_CORRECTION_BLOCKED otherwise: reverse with storno first). A category change without explicit accounts realigns the BAS triple to the new category default. Dry-runnable.

**Use when:** A data-entry mistake in the register, a renamed asset, or a revised useful life. Use dry-run first to see the merged row.
**Do not use for:** Taking the asset out of the register (POST /assets/{id}/dispose). Changing the basis after depreciation is posted (storno the postings first).

**Pitfalls:**
- k3_components: null clears an existing breakdown; a non-null array is validated against the acquisition_cost that will be in effect after the patch and requires K3.
- An empty body is rejected with 400 VALIDATION_ERROR.
- Account overrides on a K2 company may not land on an Ej K2 account (422 K2_EXCLUDED_ACCOUNT).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  name?: string,
  notes?: string | null,
  category?: "immaterial" | "building" | "land_improvement" | "machinery" | "equipment" | "vehicle" | "computer" | "other_tangible",
  acquisition_date?: string,
  acquisition_cost?: number,
  salvage_value?: number,
  useful_life_months?: number,
  depreciation_method?: "linear",
  restvarde_target?: unknown,
  bas_asset_account?: string,
  bas_accumulated_account?: string,
  bas_expense_account?: string,
  k3_components?: { name: string, cost: number, useful_life_months: number, salvage_value?: number }[] | null,
  opening_accumulated_depreciation?: number,
  opening_depreciation_date?: string | null
}
```

Example request:
```json
{
  "notes": "Serienummer C02XY…",
  "useful_life_months": 48
}
```

Response `200`:
```ts
{
  data: {
    name: string,
    category: "immaterial" | "building" | "land_improvement" | "machinery" | "equipment" | "vehicle" | "computer" | "other_tangible",
    acquisition_date: string,
    acquisition_cost: number,
    salvage_value: number,
    useful_life_months: number,
    depreciation_method: string,
    bas_asset_account: string,
    bas_accumulated_account: string,
    bas_expense_account: string,
    k3_components: { name: string, cost: number, useful_life_months: number, salvage_value?: number }[] | null,
    opening_accumulated_depreciation: number,
    opening_depreciation_date: string | null,
    notes: string | null,
    disposed_at: string | null,
    disposal_type: "sale" | "scrap" | "business_transfer" | null,
    disposed_proceeds: number | null,
    disposal_journal_entry_id: string | null,
    has_posted_depreciation: boolean,
    deletable: boolean,
    created_at: string,
    updated_at: string,
    id: string
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
    "id": "0e9c…",
    "name": "MacBook Pro 16\"",
    "category": "computer",
    "acquisition_date": "2026-03-01",
    "acquisition_cost": 32000,
    "salvage_value": 0,
    "useful_life_months": 48,
    "depreciation_method": "linear",
    "bas_asset_account": "1224",
    "bas_accumulated_account": "1229",
    "bas_expense_account": "7832",
    "k3_components": null,
    "notes": "Serienummer C02XY…",
    "disposed_at": null,
    "disposal_type": null,
    "disposed_proceeds": null,
    "disposal_journal_entry_id": null,
    "has_posted_depreciation": false,
    "deletable": true,
    "created_at": "2026-03-01T09:12:00.000Z",
    "updated_at": "2026-03-02T08:00:00.000Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `DELETE /api/v1/companies/{companyId}/assets/{id}`

**Delete an asset that never reached the books.**
`scope:bookkeeping:write · risk:medium · dry-run`

Removes a register row that has no posted depreciation and is not disposed, together with its own unposted depreciation drafts. No voucher is touched. A row that has reached the books is räkenskapsinformation (BFL 7 kap.) and is refused with 409 ASSET_DELETE_BLOCKED: dispose it, or reverse the posted voucher with storno first. Dry-run answers 204 without deleting, or the same 409.

**Use when:** A row was added by mistake (a typo, a migration test row) and deletable is true on GET. Check deletable first: it is the same rule the delete enforces.
**Do not use for:** Taking a real asset out of the register (POST /assets/{id}/dispose posts the avyttring voucher). Undoing posted depreciation (storno the voucher). Editing a wrong basis (PATCH).

**Pitfalls:**
- Idempotency-Key is mandatory.
- 409 ASSET_DELETE_BLOCKED once any planenlig avskrivning is posted or the asset is disposed: the register row is then accounting information and leaves only through disposal or storno.
- 204 No Content on success: there is no body to parse. A second DELETE answers 404 ASSET_NOT_FOUND.
- Hard delete: the row is not archived. Re-create it with POST /assets if it was removed by mistake.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Response `204`.

---

### `POST /api/v1/companies/{companyId}/assets/{id}/dispose`

**Dispose a fixed asset and post the avyttring voucher.**
`scope:bookkeeping:write · risk:medium · idempotent · dry-run · reversible`

Marks the asset disposed (sale, scrap or business_transfer) and posts one voucher in the given fiscal period: depreciation up to disposed_at, reversal of acquisition cost and accumulated depreciation, proceeds (with output VAT for a taxable sale) and the resulting gain or loss. Investment goods over the ML 15 kap. thresholds get an input-VAT jämkning when the original VAT data is supplied. Dry-run returns the plan (lines, gain_or_loss, jämkning) without writing.

**Use when:** An asset has been sold, scrapped or transferred with the business and the register plus the ledger must reflect it. Run a dry-run first and show the plan to the user.
**Do not use for:** Correcting a register mistake (PATCH the asset). Posting annual depreciation (year-end flow). Reversing a disposal (storno the disposal voucher).

**Pitfalls:**
- scrap requires disposed_proceeds=0; a sale with proceeds requires vat_treatment. disposed_proceeds is gross incl. VAT for a taxable sale.
- 409 ASSET_DISPOSAL_BLOCKED when depreciation is already posted for a later period than the one you dispose in: reverse those postings first.
- 422 ASSET_JAMKNING_DATA_REQUIRED when the asset is an investment good and jamkning_original_input_vat + jamkning_original_deduction_percent are missing. business_transfer additionally needs business_transfer_confirmed=true and, when the obligation transfers, adjustment_document_confirmed=true.
- The fiscal period must be open: closed or locked periods are refused by the ledger triggers.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  disposal_type: "sale" | "scrap" | "business_transfer",
  disposed_at: string,
  disposed_proceeds: number,
  proceeds_account?: string,
  fiscal_period_id: string,
  vat_treatment?: "standard_25" | "reverse_charge" | "export" | "exempt",
  jamkning_original_input_vat?: number,
  jamkning_original_deduction_percent?: number,
  business_transfer_confirmed?: boolean,
  adjustment_document_confirmed?: boolean
}
```

Example request:
```json
{
  "disposal_type": "sale",
  "disposed_at": "2026-09-15",
  "disposed_proceeds": 12500,
  "vat_treatment": "standard_25",
  "fiscal_period_id": "fp_…"
}
```

Response `200`:
```ts
{
  data: {
    asset: { name: string, category: "immaterial" | "building" | "land_improvement" | "machinery" | "equipment" | "vehicle" | "computer" | "other_tangible", acquisition_date: string, acquisition_cost: number, salvage_value: number, useful_life_months: number, depreciation_method: string, bas_asset_account: string, bas_accumulated_account: string, bas_expense_account: string, k3_components: { name: string, cost: number, useful_life_months: number, salvage_value?: number }[] | null, opening_accumulated_depreciation: number, opening_depreciation_date: string | null, notes: string | null, disposed_at: string | null, disposal_type: "sale" | "scrap" | "business_transfer" | null, disposed_proceeds: number | null, disposal_journal_entry_id: string | null, has_posted_depreciation: boolean, deletable: boolean, created_at: string, updated_at: string, id: string },
    disposal_entry: { journal_entry_id: string, voucher_number: number | null } | null,
    gain_or_loss: number
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
    "asset": {
      "id": "0e9c…",
      "name": "MacBook Pro 16\"",
      "category": "computer",
      "acquisition_date": "2026-03-01",
      "acquisition_cost": 32000,
      "salvage_value": 0,
      "useful_life_months": 36,
      "depreciation_method": "linear",
      "bas_asset_account": "1224",
      "bas_accumulated_account": "1229",
      "bas_expense_account": "7832",
      "k3_components": null,
      "notes": null,
      "disposed_at": "2026-09-15",
      "disposal_type": "sale",
      "disposed_proceeds": 12500,
      "disposal_journal_entry_id": "je_…",
      "has_posted_depreciation": true,
      "deletable": false,
      "created_at": "2026-03-01T09:12:00.000Z",
      "updated_at": "2026-09-15T10:00:00.000Z"
    },
    "disposal_entry": {
      "journal_entry_id": "je_…",
      "voucher_number": 118
    },
    "gain_or_loss": -16222.22
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```
