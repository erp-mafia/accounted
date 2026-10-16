# Modules

A module is a named building block of Accounted that the API, AI agents and,
later, a company's own package choice can address as a unit. `manifest.ts`
declares every module; nothing else does. Modules group into packages
(`packages.ts`), the level a person recognises and switches. The resolved
capabilities object (below) says, per package and per module, what one
company can use; the menu, MCP's tools/list and the agent briefing read it.
Today every company resolves to everything it could already use, so nothing
any reader shows has changed.

## What resolves from the manifest

- **Operations** (`lib/operations/registry.ts`): by the operation id prefix
  before the first dot (`invoices.book` is `invoicing`). The module is
  derived, not a field on each operation.
- **v1 REST and OpenAPI** (`lib/api/v1/registry.ts`): every operation in
  `/api/v1/openapi.json` carries `tags: [moduleId]` and `x-module`, and the
  document lists each module as a top-level tag marked `x-experimental`.
  `jurisdictions` is not published until a second country exists.
  Operation-backed endpoints take their operation's module; hand-written
  routes resolve by path (the first segment after `/companies/{companyId}/`,
  or a longer claim such as `fiscal-periods/:id/arsredovisning`).
- **Code ownership**: every folder under `src/lib` belongs to one module
  (`libFolders`, sub-folders like `bokslut/assets` allowed) or is shared
  infrastructure (`INFRA_LIB_FOLDERS`, plus the files directly in `src/lib`).

`resolve.ts` holds the lookups: `moduleForOperationId`, `moduleForV1Path`,
`moduleForLibPath`, `getModule`, `modulesInDependencyOrder`.

## Packages

`packages.ts` groups the modules into the packages of the Profiles and
Suggestions design (2026-10-16): Bokföring (always on: ledger, transactions,
vat, year-end, skatteverket, deadlines, import, parties), Bank (bank-feed),
Kundfakturor (invoicing, collections), Leverantörsfakturor och betalningar
(supplier-invoices, payments), Kvitton och underlag (inbox), Utlägg
(expenses), Lön (payroll), Inventarier (assets) and Kassa och webbshop (pos,
webshop). `platform`, `agent` and `byra` belong to no package. Every module
is in exactly one package or in `NON_PACKAGE_MODULES`
(`__tests__/packages.test.ts`). Ids are internal until the API publishes
packages. A company's choice for a package is the
`company_capability_config` key `package:<id>` (absent: the profile decides;
`enabled = false`: off).

## Capabilities: what one company can use

`capabilities.ts` resolves one object per company:

    capabilities = country pack ∩ plan entitlements ∩ (profile defaults ⊕ company choices) ⊕ open obligations

- `packages[]`: each package's `availability` (`on`, `off`, `winding_down`,
  `not_in_plan`, `not_in_country`) and `reasons` (`unsupported_country`,
  `turned_off_by_company`, `off_in_profile`, `open_obligations`,
  `needs_plan`). A package is in the country when any module in it is (a
  kernel always is), outside the plan only when every module in it needs a
  capability the plan lacks, and Bokföring is never off.
- `modules[]`: each module's `package`, its `availability` (the package's,
  narrowed by the module's own gates; a switch outranks the plan), and the
  published report: `status` (`active`, `needs_plan`, `off`, `unsupported`),
  `reasons` (`unsupported_country`, `unsupported_legal_form`, `needs_plan`,
  `disabled_by_company`, `dependency_unavailable`) and `resolution`.
- `profile`: `standard` ("Standard (allt på)", every package on), implicit
  for every company until profiles are stored.

Inputs that exist today: `companies.jurisdiction`, the plan grants and
`company_capability_config` (through `readCapabilityAxes`, or
`getCompanyEntitlements` where the dashboard already reads it; capability
keys and package switches in one config query), and the payroll offer rule.
Kernels are always on. A capability key turned off, or a country the module
does not cover, makes dependents unavailable; a package switch and a plan or
legal-form gate do not. `winding_down` is reserved: nothing can be switched
off yet, so obligations are not loaded (`openObligations` is the input).

Readers:

- `capabilitySurface()` is what a menu or tool list reads: `hidden` (modules
  whose package is off or not in the country, or that are not in the country
  themselves) and `notForLegalForm`. The menu (`lib/navigation/nav-gates.ts`)
  hides both; MCP's tools/list hides `hidden` on a single-company connection
  (`extensions/general/mcp-server/tool-modules.ts` places every tool in a
  module). A package outside the plan stays visible: the paywall answers at
  the door, as before.
- `capabilityDigest()` is the briefing's list of modules that are not
  active; `publishedCapabilities()` is what
  `GET /api/v1/companies/{companyId}/capabilities` serves, unchanged.
- Every main navigation item declares its module
  (`components/dashboard/__tests__/nav-modules.test.ts`).

## The rules

1. A **kernel** (`platform`, `ledger`) never imports a block, and imports
   another kernel only in its `dependsOn` direction (ledger uses platform).
2. A **block** imports the kernel, infrastructure, and only the blocks it
   names in `dependsOn`. The kernel is implicit; never list it.
3. Ids are published as experimental OpenAPI tags: until the module switch
   settles the boundaries a module may be split or renamed; after that, add
   modules and never rename one.

Rules 1 and 2 are a ratchet, not yet a wall: `__tests__/boundary.test.ts`
scans the runtime imports in `src/lib` (type-only imports are erased at
build and not counted; one edge per importing file and imported path) and
compares the count per `from -> to` pair with `boundary-baseline.json`. A
pair that grows, or a new pair, fails the test with the offending imports.

## Adding a module or a folder

Add the id to `MODULE_IDS` and its definition to `MODULES` in `manifest.ts`,
claiming its folders, operation prefixes and v1 segments. The tests in
`__tests__/` fail until every new operation, v1 endpoint and `src/lib`
folder resolves to exactly one module, until no claim is made twice, and
while `dependsOn` has a cycle. A new top-level `src/lib` folder needs an
owner too: a module's `libFolders`, or `INFRA_LIB_FOLDERS` when it is shared
infrastructure or a composition layer.

## When the ratchet fails

Prefer removing the edge: move the shared code into the kernel or
infrastructure, invert the call through an event or a registry, or, when the
block genuinely needs the other block, add it to `dependsOn`. Only for a
reviewed, deliberate coupling, or after removing edges, rewrite the baseline:

    UPDATE_BOUNDARY_BASELINE=1 npx vitest run --project unit src/lib/modules/__tests__/boundary.test.ts

A shrinking count passes and prints a reminder to lower the baseline.

## Phase 1's exit check

The building-blocks plan closes Phase 1 when "every new posting has an actor
and a receipt; a harness on a service account sees the capabilities, stages an
attest over REST and receives the decision as an event that survives a crash."
That sentence is an automated test against real Postgres:
`tests/pg/phase1-exit-check.pg.test.ts` (`npm run test:pg`). It drives the v1
route handlers as a harness would: the owner creates a service account and
mints its key, the key reads `GET /capabilities`, stages a balanced verifikat
with `?stage=true` and approves it, the posted row carries the actor, the
verified principal and the sponsor, and the decision arrives as
`journal_entry.committed` on `GET /api/events`. Killing the committing
connection before and after COMMIT shows the verifikat and its outbox row are
written together or not at all. Only the HTTP hop to PostgREST is replaced
(`tests/pg/postgrest-over-pg.ts` runs each request as SQL); the file header
lists every seam. The receipt half: the staged and approved posting answers a
decision receipt on `GET /journal-entries/{id}`, which commitPendingOperation
records after the commit (`src/lib/suggestion-log/operation.ts`).
