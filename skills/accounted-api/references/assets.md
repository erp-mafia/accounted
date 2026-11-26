<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Fixed assets endpoints

The anläggningsregister: register an asset (no voucher, the purchase is already booked), correct it while no depreciation is posted, and dispose it (sale, scrap or business transfer) which posts the avyttring voucher with gain/loss, VAT and jämkning. Depreciation itself is proposed and posted per fiscal period through the year-end flow. Also: a nedskrivning or its reversal on a balansdag, a K3 component replaced, a building's tax depreciation plan (INK2S 4.9), and the split on components at the transition to K3.

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
    assets: { name: string, category: "immaterial" | "building" | "land" | "land_improvement" | "machinery" | "equipment" | "vehicle" | "computer" | "other_tangible", acquisition_date: string, acquisition_type: "purchase" | "business_acquisition" | "merger" | "reclassification", acquisition_cost: number, salvage_value: number, useful_life_months: number, depreciation_start_date: string | null, depreciation_method: string, bas_asset_account: string, bas_accumulated_account: string, bas_expense_account: string, k3_components: { component_id?: string, name: string, cost: number, useful_life_months: number | null, salvage_value?: number, acquisition_date?: string | null, depreciation_start_date?: string | null, opening_accumulated_depreciation?: number, opening_depreciation_date?: string | null }[] | null, components: { component_id: string, name: string, cost: number, useful_life_months: number | null, salvage_value: number, acquisition_date: string, depreciation_start_date: string, opening_accumulated_depreciation: number, opening_depreciation_date: string | null, replaces_component_id: string | null, derecognised_at: string | null, derecognition_journal_entry_id: string | null }[], opening_accumulated_depreciation: number, opening_depreciation_date: string | null, notes: string | null, disposed_at: string | null, disposal_type: "sale" | "scrap" | "business_transfer" | null, disposed_proceeds: number | null, disposal_journal_entry_id: string | null, has_posted_depreciation: boolean, deletable: boolean, created_at: string, updated_at: string, id: string, handle?: string }[]
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
        "opening_accumulated_depreciation": 0,
        "opening_depreciation_date": null,
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
- k3_components is accepted only when the company applies K3: 422 K3_REQUIRED_FOR_COMPONENTS otherwise. Components must sum to acquisition_cost to the öre; useful_life_months null is a component that is not depreciated (mark), depreciation_start_date (K3 17.18) and an opening per component are optional.
- opening_accumulated_depreciation must be between 0 and acquisition_cost - salvage_value. A positive amount requires opening_depreciation_date between acquisition_date and today (Europe/Stockholm). Zero clears the opening date.
- Opening depreciation registers an amount already in the imported ledger and posts no voucher. Enter the amount for this asset from the previous asset register and manually reconcile the register totals with the imported ledger before depreciation or disposal; no automatic reconciliation is performed.
- Opening fields lock after depreciation posted through Accounted's asset register or disposal. Manual ledger postings do not lock them.
- With k3_components the opening amount is the components' total: it is split over components that state no opening of their own (by how much of each one's life had passed), or must equal the sum of theirs.
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
  category: "immaterial" | "building" | "land" | "land_improvement" | "machinery" | "equipment" | "vehicle" | "computer" | "other_tangible",
  acquisition_date: string,
  acquisition_type?: "purchase" | "business_acquisition" | "merger" | "reclassification",
  acquisition_cost: number,
  salvage_value?: number,
  useful_life_months: number,
  depreciation_start_date?: string | null,
  internally_generated?: boolean,
  depreciation_method?: "linear",
  restvarde_target?: unknown,
  bas_asset_account?: string,
  bas_accumulated_account?: string,
  bas_expense_account?: string,
  k3_components?: { component_id?: string, name: string, cost: number, useful_life_months: number | null, salvage_value?: number, acquisition_date?: string | null, depreciation_start_date?: string | null, opening_accumulated_depreciation?: number, opening_depreciation_date?: string | null }[] | null,
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
    category: "immaterial" | "building" | "land" | "land_improvement" | "machinery" | "equipment" | "vehicle" | "computer" | "other_tangible",
    acquisition_date: string,
    acquisition_type: "purchase" | "business_acquisition" | "merger" | "reclassification",
    acquisition_cost: number,
    salvage_value: number,
    useful_life_months: number,
    depreciation_start_date: string | null,
    depreciation_method: string,
    bas_asset_account: string,
    bas_accumulated_account: string,
    bas_expense_account: string,
    k3_components: { component_id?: string, name: string, cost: number, useful_life_months: number | null, salvage_value?: number, acquisition_date?: string | null, depreciation_start_date?: string | null, opening_accumulated_depreciation?: number, opening_depreciation_date?: string | null }[] | null,
    components: { component_id: string, name: string, cost: number, useful_life_months: number | null, salvage_value: number, acquisition_date: string, depreciation_start_date: string, opening_accumulated_depreciation: number, opening_depreciation_date: string | null, replaces_component_id: string | null, derecognised_at: string | null, derecognition_journal_entry_id: string | null }[],
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
    id: string,
    handle?: string
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
    "opening_accumulated_depreciation": 0,
    "opening_depreciation_date": null,
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
    category: "immaterial" | "building" | "land" | "land_improvement" | "machinery" | "equipment" | "vehicle" | "computer" | "other_tangible",
    acquisition_date: string,
    acquisition_type: "purchase" | "business_acquisition" | "merger" | "reclassification",
    acquisition_cost: number,
    salvage_value: number,
    useful_life_months: number,
    depreciation_start_date: string | null,
    depreciation_method: string,
    bas_asset_account: string,
    bas_accumulated_account: string,
    bas_expense_account: string,
    k3_components: { component_id?: string, name: string, cost: number, useful_life_months: number | null, salvage_value?: number, acquisition_date?: string | null, depreciation_start_date?: string | null, opening_accumulated_depreciation?: number, opening_depreciation_date?: string | null }[] | null,
    components: { component_id: string, name: string, cost: number, useful_life_months: number | null, salvage_value: number, acquisition_date: string, depreciation_start_date: string, opening_accumulated_depreciation: number, opening_depreciation_date: string | null, replaces_component_id: string | null, derecognised_at: string | null, derecognition_journal_entry_id: string | null }[],
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
    id: string,
    handle?: string
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
    "opening_accumulated_depreciation": 0,
    "opening_depreciation_date": null,
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
- k3_components is the full component list after the patch (requires K3): an element with component_id changes that component, one without registers a new one, an active component left out is removed (refused once posted), null clears a breakdown that never posted. A component asset's acquisition_cost, salvage_value and opening are the components' sum.
- Opening depreciation is validated against the merged row: 0 <= opening_accumulated_depreciation <= acquisition_cost - salvage_value; a positive amount needs opening_depreciation_date between acquisition_date and today (Europe/Stockholm). Zero clears the date. With components it is their total: split over components that state none, or set per component.
- Opening edits post no voucher and perform no automatic reconciliation. Manually reconcile the register totals with the imported ledger before depreciation or disposal. Opening fields lock after depreciation posted through Accounted's asset register or disposal (409 ASSET_CORRECTION_BLOCKED); manual ledger postings do not lock them.
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
  acquisition_type?: "purchase" | "business_acquisition" | "merger" | "reclassification",
  category?: "immaterial" | "building" | "land" | "land_improvement" | "machinery" | "equipment" | "vehicle" | "computer" | "other_tangible",
  acquisition_date?: string,
  acquisition_cost?: number,
  salvage_value?: number,
  useful_life_months?: number,
  depreciation_start_date?: string | null,
  depreciation_method?: "linear",
  restvarde_target?: unknown,
  bas_asset_account?: string,
  bas_accumulated_account?: string,
  bas_expense_account?: string,
  k3_components?: { component_id?: string, name: string, cost: number, useful_life_months: number | null, salvage_value?: number, acquisition_date?: string | null, depreciation_start_date?: string | null, opening_accumulated_depreciation?: number, opening_depreciation_date?: string | null }[] | null,
  opening_accumulated_depreciation?: number,
  opening_depreciation_date?: string | null,
  own_development?: boolean
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
    category: "immaterial" | "building" | "land" | "land_improvement" | "machinery" | "equipment" | "vehicle" | "computer" | "other_tangible",
    acquisition_date: string,
    acquisition_type: "purchase" | "business_acquisition" | "merger" | "reclassification",
    acquisition_cost: number,
    salvage_value: number,
    useful_life_months: number,
    depreciation_start_date: string | null,
    depreciation_method: string,
    bas_asset_account: string,
    bas_accumulated_account: string,
    bas_expense_account: string,
    k3_components: { component_id?: string, name: string, cost: number, useful_life_months: number | null, salvage_value?: number, acquisition_date?: string | null, depreciation_start_date?: string | null, opening_accumulated_depreciation?: number, opening_depreciation_date?: string | null }[] | null,
    components: { component_id: string, name: string, cost: number, useful_life_months: number | null, salvage_value: number, acquisition_date: string, depreciation_start_date: string, opening_accumulated_depreciation: number, opening_depreciation_date: string | null, replaces_component_id: string | null, derecognised_at: string | null, derecognition_journal_entry_id: string | null }[],
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
    id: string,
    handle?: string
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
    "opening_accumulated_depreciation": 0,
    "opening_depreciation_date": null,
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
`scope:bookkeeping:write · risk:medium · idempotent · dry-run`

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

### `POST /api/v1/companies/{companyId}/assets/{id}/components/{componentId}/replace`

**Replace a K3 component: take the replaced part off the books and register the replacing one.**
`scope:bookkeeping:write · risk:high · idempotent · dry-run · reversible`

K3 17.5 and 17.21A. One voucher charges the replaced component's depreciation to the replacement date, clears its accumulated depreciation and cost, and books what is left as a loss; the replacing component is registered with no voucher (its expenditure is already on the asset account). Omit new_component to derecognise only (a part scrapped without a replacement). Dry-runnable.

**Use when:** A significant part of a K3 component asset is replaced (a new roof, an engine) or scrapped.
**Do not use for:** A repair (expense it), a new part added without anything replaced (add a component), or a K2 asset.

**Pitfalls:**
- The component must be active, with no write-down outstanding, and no depreciation posted after the replacement year.
- Earlier years' depreciation must be posted: 409 ASSET_COMPONENT_REPLACEMENT_BLOCKED (earlier_year_unposted).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `componentId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  replaced_at: string,
  fiscal_period_id: string,
  new_component?: {
    name: string,
    cost: number,
    useful_life_months: number | null,
    salvage_value?: number,
    acquisition_date?: string | null,
    depreciation_start_date?: string | null,
    opening_accumulated_depreciation?: number,
    opening_depreciation_date?: string | null
  } | null
}
```

Example request:
```json
{
  "replaced_at": "2026-06-30",
  "fiscal_period_id": "0c1e…",
  "new_component": {
    "name": "Nytt tak",
    "cost": 400000,
    "useful_life_months": 360
  }
}
```

Response `200`:
```ts
{
  data: { asset_id: string, journal_entry_id: string, new_component_id: string | null },
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
    "asset_id": "7d1e…",
    "journal_entry_id": "c41d…",
    "new_component_id": "5a2c…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

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
    asset: { name: string, category: "immaterial" | "building" | "land" | "land_improvement" | "machinery" | "equipment" | "vehicle" | "computer" | "other_tangible", acquisition_date: string, acquisition_type: "purchase" | "business_acquisition" | "merger" | "reclassification", acquisition_cost: number, salvage_value: number, useful_life_months: number, depreciation_start_date: string | null, depreciation_method: string, bas_asset_account: string, bas_accumulated_account: string, bas_expense_account: string, k3_components: { component_id?: string, name: string, cost: number, useful_life_months: number | null, salvage_value?: number, acquisition_date?: string | null, depreciation_start_date?: string | null, opening_accumulated_depreciation?: number, opening_depreciation_date?: string | null }[] | null, components: { component_id: string, name: string, cost: number, useful_life_months: number | null, salvage_value: number, acquisition_date: string, depreciation_start_date: string, opening_accumulated_depreciation: number, opening_depreciation_date: string | null, replaces_component_id: string | null, derecognised_at: string | null, derecognition_journal_entry_id: string | null }[], opening_accumulated_depreciation: number, opening_depreciation_date: string | null, notes: string | null, disposed_at: string | null, disposal_type: "sale" | "scrap" | "business_transfer" | null, disposed_proceeds: number | null, disposal_journal_entry_id: string | null, has_posted_depreciation: boolean, deletable: boolean, created_at: string, updated_at: string, id: string, handle?: string },
    disposal_entry: { journal_entry_id: string, voucher_number: number | null } | null,
    gain_or_loss: number
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
      "opening_accumulated_depreciation": 0,
      "opening_depreciation_date": null,
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

---

### `PUT /api/v1/companies/{companyId}/assets/{id}/tax-plan`

**State the tax depreciation plan of a building or markanläggning: percent a year, the day it starts, the primäravdrag.**
`scope:bookkeeping:write · risk:low · idempotent · dry-run · reversible`

IL 19 kap. 5 § (buildings: a percentage a year of the acquisition value set by the economic life, from completion or acquisition), 5 a § (primäravdrag, two percentage points a year for six years on a new, extended or rebuilt hyreshus) and 20 kap. 5 § (markanläggningar: at most 5 %, 10 % for täckdiken and skogsvägar). The plan drives INK2S punkt 4.9 (the book depreciation added back, the tax plan deducted) and, under K3, the deferred tax on the building, for the fiscal years still open when it is stated. A null rate clears it. No verifikat. Dry-runnable.

**Use when:** A building or markanläggning is registered, or its tax depreciation rate is known or changes.
**Do not use for:** Machinery and equipment (räkenskapsenlig avskrivning, IL 18 kap.) or the book depreciation plan (update the asset).

**Pitfalls:**
- Only buildings and markanläggningar; mark is never depreciated: 400 INVALID_TAX_PLAN.
- A markanläggning takes at most 10 %, the primäravdrag only a building.
- The plan reaches only fiscal years still open when it is stated, so a declared INK2 never moves; once a year it reached is closed or locked, it cannot be changed or cleared: 409 TAX_PLAN_USED_BY_CLOSED_YEAR.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  tax_depreciation_rate: number | null,
  tax_depreciation_from?: string | null,
  tax_primary_allowance?: boolean
}
```

Example request:
```json
{
  "tax_depreciation_rate": 2,
  "tax_depreciation_from": "2020-01-01",
  "tax_primary_allowance": false
}
```

Response `200`:
```ts
{
  data: {
    asset_id: string,
    tax_depreciation_rate: number | null,
    tax_depreciation_from: string | null,
    tax_primary_allowance: boolean
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
    "asset_id": "7d1e…",
    "tax_depreciation_rate": 2,
    "tax_depreciation_from": "2020-01-01",
    "tax_primary_allowance": false
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PUT /api/v1/companies/{companyId}/assets/{id}/transition-split`

**Split an asset on significant components at the transition to K3 (35.18), or undo the split.**
`scope:bookkeeping:write · risk:medium · idempotent · dry-run · reversible`

K3 punkt 35.18: the carrying amount of a tangible asset at the transition date is divided on its significant components; earlier years are not restated. Give each component its carrying amount at the transition and its total useful life counted from when the asset was first used (null for mark). The accumulated depreciation at the transition is carried into the component openings, so nothing is booked and the components continue prospectively. An empty list undoes the split while nothing is posted per component. Needs the transition started (k3-transition.start). Dry-runnable.

**Use when:** In the first K3 year after K2, for each asset whose significant parts have materially different useful lives (a building's stomme, tak, installationer).
**Do not use for:** An asset acquired under K3 (register its components when creating it) or replacing a part later (assets.components.replace).

**Pitfalls:**
- The carrying amounts must add up to the asset's carrying amount at the transition: 400 INVALID_K3_COMPONENTS.
- Depreciation posted from the transition date blocks the split: reverse it first (409 K3_TRANSITION_BLOCKED).
- Each useful life is the total life from first use and must be longer than the months already used.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  components: { name: string, carrying_amount: number, useful_life_months: number | null, salvage_value?: number }[]
}
```

Example request:
```json
{
  "components": [
    {
      "name": "Stomme",
      "carrying_amount": 600000,
      "useful_life_months": 1200
    },
    {
      "name": "Tak",
      "carrying_amount": 280000,
      "useful_life_months": 480
    }
  ]
}
```

Response `200`:
```ts
{
  data: {
    asset_id: string,
    transition_date: string,
    components: { name: string, cost: number, useful_life_months: number | null, salvage_value: number, opening_accumulated_depreciation: number }[]
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
    "asset_id": "7d1e…",
    "transition_date": "2026-01-01",
    "components": []
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/assets/{id}/value-adjustments`

**Write an asset down to its recoverable amount (nedskrivning), or reverse an earlier write-down, on a balansdag.**
`scope:bookkeeping:write · risk:high · idempotent · dry-run · reversible`

ÅRL 4 kap. 5 §, K3 kapitel 27 (K2 10.25-10.27 for a K2 company). The test is made on the fiscal year's last day after the year's planenlig avskrivning: the write-down is the carrying amount less the recoverable amount (the higher of fair value less costs to sell and value in use, K3 27.5); a reversal brings the carrying amount back up, at most to what an unimpaired plan would show (27.15), never for goodwill. One voucher (77xx against the accumulated impairment account 12x8) and the register rows in one transaction; a K3 component asset spreads it over its components by carrying amount. Later years plan from the written-down value. Dry-runnable.

**Use when:** An asset's value has fallen materially and lastingly below its carrying amount (K3 27.4 indications), or a write-down made earlier no longer holds.
**Do not use for:** Planenlig avskrivning (post the annual depreciation), a disposal or scrapping (dispose the asset), or uppskrivning (not supported).

**Pitfalls:**
- The year's depreciation must be posted first: 409 ASSET_VALUE_ADJUSTMENT_BLOCKED (year_not_depreciated).
- Only on the balansdag of an open year, and never behind later depreciation or a later write-down.
- A goodwill write-down is never reversed (ÅRL 4:5).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  kind: "impairment" | "impairment_reversal",
  fiscal_period_id: string,
  recoverable_amount: number,
  reason: string
}
```

Example request:
```json
{
  "kind": "impairment",
  "fiscal_period_id": "0c1e…",
  "recoverable_amount": 400000,
  "reason": "Marknadsvärdet har fallit (K3 27.4)."
}
```

Response `200`:
```ts
{
  data: { asset_id: string, journal_entry_id: string, amount: number },
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
    "asset_id": "7d1e…",
    "journal_entry_id": "c41d…",
    "amount": 120000
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```
