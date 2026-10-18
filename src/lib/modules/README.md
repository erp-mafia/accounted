# Modules

A module is a named building block of Accounted that the API, AI agents and,
later, a company's own package choice can address as a unit. `manifest.ts`
declares every module; nothing else does. Modules group into packages
(`packages.ts`), the level a person recognises and switches. The resolved
capabilities object (below) says, per package and per module, what one
company can use; the menu, MCP's tools/list and the agent briefing read it.
A company without a stored profile, which is every company that existed
before profiles, resolves to everything it could already use, so nothing any
reader shows has changed for it.

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
`enabled = false`: off; `enabled = true`: on, over the profile).

## Profiles

`profiles.ts` holds the profiles of the design's proposed table as versioned
data over the packages: Enskild firma (`sole-trader`), Aktiebolag utan
anställda (`limited-company-no-employees`), Aktiebolag med anställda
(`limited-company-with-employees`), Handel med kassa eller webbshop
(`retail`), Förening (`association`) and Standard (allt på) (`standard`,
every package on). Each states every switchable package as on or off
(`__tests__/profiles.test.ts`). Every published version stays in the file;
a change appends the next version, and a company resolves the version it
stored, so a new version never takes a package from a company that has it.
The ids are country-neutral; the country pack still decides which packages
exist. The list is a proposal until Jakob confirms it.

A company stores its profile in `companies.profile_id` and
`profile_version` (migration `20261016190000`; a CHECK holds the ids, so a
new profile widens it). NULL is Standard, so no existing company changed.
`readStoredProfile()` reads it in a query of its own that resolves to
Standard on failure. How a company gets one:

- **Public signup**: no extra step. Company creation derives the profile
  from the legal form (`deriveSignupProfile`) and records it in
  `companies.suggested_profile_id` and version, which switches nothing. It
  becomes the company's profile only while the instance sets
  `PROFILES_APPLY_ON_SIGNUP` (`signup-profile.ts`, off by default; Jakob
  flips it after confirming the lists). The MCP and v1 creation paths record
  the suggestion and never apply it.
- **Byrå invitation**: the byrå picks the client's profile in the invite
  form (Inställningar, Medlemmar) of a client company on its team; the form
  preselects the stored profile, else the recorded suggestion, else
  Standard. The invited client sees "Din byrå har förberett: <profil>" on
  `/invite/[token]` (`lib/company/client-profile.ts`).
- **Existing companies**: Standard, unless their byrå picks a profile.

Nothing writes a profile through the API or MCP yet. `GET
/api/v1/companies/{companyId}/capabilities` and the briefing
(`capabilities_profile`) name it.

## Suggestions: package switches a person approves

Step 3 of the design (`src/lib/suggestions`). A company's package choice is
written only by the staged operations `enable_package` and `disable_package`,
through `set_company_package_choice` (migration `20261016200400`): an owner
or admin approves, the row records the source (`suggestion` or `company`),
the approver, the credential and the operation, switching off is never
refused for what is still open (the package winds down, below; migration
`20261016230000`), and every change is an `audit_log` row that
behandlingshistorik shows as a dated settings line.

A detector is an event type (or a schedule), a condition and a proposed
operation with a plain Swedish title and reason (`types.ts`), the shape a
user flow's trigger shares. It only proposes: `stage_company_suggestion`
(migration `20261016200600`) stages one pending operation as the system
(actor `system`, label "Accounted") per company and key while it is open.
The answer comes through the doors every staged operation has (Att göra,
/pending, v1, MCP), and a trigger on `pending_operations` keeps
`company_suggestions` in step: approved is accepted, a rejection with the
reason "Visa aldrig" declines for good, any other rejection or the expiry
snoozes the key for 30 days. At most three open suggestions are shown,
ranked, as Förslag cards in Att göra and as `suggestions` in the agent
briefing.

- `first-employee`: `employee.created` while Lön is off: "Slå på Lön?".
- `sales-channel-connected`: `pos.connected` or a webshop connection while
  Kassa och webbshop is off: "Slå på Kassa och webbshop?".
- `hide-unused`: daily, behind `SUGGESTIONS_HIDE_UNUSED` (off): a package
  unused for six months with nothing open: "Dölj <paket>?". Jakob turns it
  on.

A package is off only where a profile or the company left it off, so the
event detectors reach byrå-profiled companies only: a Standard company sees
nothing new. The event detectors run on the event bus beside the event_log
and webhook handlers (lib/init); staging logs and skips when the database
does not have the operation types yet, so an early deploy never breaks the
write that emitted.

## Grants: rules for automatic booking, suggested and reviewed after

Step 4 of the design (`src/lib/grants`, migrations `20261017100000` to
`20261017100500`). A grant is a dated, versioned company rule
(`company_grants`): one counterparty, as `grant_counterparty_key` keys it,
booked by category exactly one way (direction, category, VAT treatment, the
business account and every account the posting touches), up to a limit per
posting (and optionally per month), by any key credential of the company or
one named API key or service account. It is created only by an approved
`create_grant` (risk high and web-only: an owner or admin accepts it in the
app, never an agent or a key; the executor and `create_company_grant` both
require actor `user`) and revoked only by an approved `revoke_grant` (any
approver), each with a receipt, an `audit_log` row and a dated line in
behandlingshistorik.

When an agent stages `gnubok_categorize_transaction` with a key, the MCP
dispatcher's door (`grant-door.ts`) asks `claim_company_grant`, which matches
the staged row field by field and refuses anything else: another account or
VAT treatment, an amount above the grant's limit or the key's own unattended
ceiling (the stricter wins), a monthly limit reached, a locked period, an
unknown counterparty, a duplicate override, dimensions, another credential,
the company's kill switch. A match is committed through
`commitPendingOperation` as that key, with the grant on `result_data` and on
the decision receipt (policy `grant.1;grant_id=...;grant_version=...`, band
direct); anything else waits for a person as before. Att göra lists what rules
let through under "Bokfört enligt regel" (Ångra is the bank line's storno
undo, Återkalla stages `revoke_grant`, Markera som granskat, Pausa alla
regler), and the briefing's `grants` block lists the same.

- `grant-candidate`: `transaction.categorized`, behind `GRANT_SUGGESTIONS`
  (off): the latest five approved stagings of the counterparty, all the same
  way: "Godkänn <motpart> automatiskt nästa gång, upp till X kr?". Also
  `supplier_invoice.registered` (slice 2): the latest five approved inbox
  invoices of the supplier, still posted, never credited, all the same way:
  "Godkänn <leverantör> automatiskt nästa gång, upp till X kr?".

Slice 2 (migrations `20261018100000` to `20261018100300`) adds the second
operation type, `create_supplier_invoice_from_inbox`: a known supplier's
invoice from the inbox, registered and booked in one commit. The rule is keyed
by the supplier's id and pins the VAT treatment, the reverse-charge kind and
every line's account and VAT rate (`item_lines`, '6212:25'), with the
verifikat's accounts checked after the commit. Only a plain registration
qualifies: SEK, the underlag in the archive, no dimensions, no SLP, no credit
or negative line, no new bank details, no staging warning, a company that
books invoices when they are registered; everything else, a new supplier
included, waits for a person. In Att göra such a posting opens its invoice
(corrected or credited there) instead of Ångra.

`GRANT_SUGGESTIONS` (`src/lib/grants/flag.ts`) is Jakob's master switch for
the whole feature: off, the detector does not run, `create_grant` is refused
(`GRANTS_SWITCHED_OFF`) and the staging door never asks the claim gate, so
grants that exist stop applying. Revoking and pausing stay possible.

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
- `profile`: the stored profile (`source: 'stored'`), or `standard`
  ("Standard (allt på)", every package on, `source: 'implicit'`) when none
  is stored. Its package defaults sit beneath the company's own package
  choices, which win both ways.

Inputs: `companies.jurisdiction`, the stored profile, the plan grants and
`company_capability_config` (through `readCapabilityAxes`, or
`getCompanyEntitlements` where the dashboard already reads it; capability
keys and package switches in one config query), and the payroll offer rule.
Kernels are always on. A capability key turned off, or a country the module
does not cover, makes dependents unavailable; a package switch and a plan or
legal-form gate do not. A package that is switched off (by the company or its
profile) with open obligations is `winding_down` (`open_obligations` names
them); `loadCompanyCapabilities` and the dashboard layout probe them only for
the packages that are switched off, so a company with every package on reads
nothing more.

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
  `GET /api/v1/companies/{companyId}/capabilities` serves: the module report
  unchanged, plus `profile`.
- Every main navigation item declares its module
  (`components/dashboard/__tests__/nav-modules.test.ts`).

## Winding down and the start doors

"Off" closes the doors that start new work and keeps the obligations
running (the founder's rule). Three pieces:

- `obligations.ts`: one small read-only probe per obligation, per switchable
  package: Bank (a live connection), Kundfakturor (unpaid invoices, active
  recurring invoices, open collection cases, a ROT/RUT begäran whose payout
  is not booked yet), Leverantörsfakturor och
  betalningar (unpaid supplier invoices, payments on their way), Kvitton och
  underlag (unhandled underlag, the Att göra predicate), Utlägg (claims not
  paid out, trips not booked), Lön (runs not paid and booked, an AGI not filed
  for a recent payout month, a booked payout not matched to the bank),
  Inventarier (assets with depreciation left to post) and Kassa och webbshop
  (live till or webshop connections, unbooked days and orders). A failed read
  counts as open. While any is open a switched-off package is `winding_down`:
  the menu, tools/list and the assistant's UI map keep it, and the briefing
  lists it under `capabilities_profile.packages_winding_down`. Once settled it
  is `off` and disappears.
- `package-doors.ts`: every write door of every switchable package (dashboard
  and extension routes, v1 endpoints, operations, hand-written MCP tools and
  the pending types they stage) classified once as `start` or `continue`. A
  start creates a new root record (an invoice, quote, order, recurring
  schedule, supplier invoice, salary run, expense claim, trip, asset, or a
  bank, till, webshop or mail connection); registers, settling, correcting
  and reading are not starts. `__tests__/package-doors.test.ts` and the MCP
  server's own test fail on an unclassified door, a stale entry, a start no
  gate reaches, or a continue door a start pattern would catch.
- `package-gate.ts`: what the doors ask before a start. `withRouteContext`,
  the extension dispatcher, `withApiV1`, the MCP dispatch and
  `commitPendingOperation` (an approval staged before the switch) refuse a
  start of a package that is off or winding down with `PACKAGE_OFF`, in
  Swedish, naming the package and "Slå på <paket> under Anpassa". Two small
  reads, only on a start door; a failed read lets the start through.
  Unit tests model every package on (`tests/unit/setup.ts`).
- `packages-off.ts`: which packages are fully off (switched off with nothing
  open), for background work that skips a package's passes. The bank ingest
  reads it once per batch behind `INGEST_PACKAGE_GATING` (off) and skips the
  matchers, and their pools, of a fully-off package
  (`lib/transactions/ingest-package-gate.ts`); a winding-down package keeps
  them, and a failed read skips nothing.

The switch itself: Inställningar, Företag, Anpassa (`/settings/anpassa`), and
`packages.list`, `packages.enable` and `packages.disable` over v1
(`/api/v1/companies/{companyId}/packages`) and MCP (`gnubok_list_packages`,
`gnubok_enable_package`, `gnubok_disable_package`, search-only). A switch is
always staged (`enable_package`, `disable_package`) and approved by an owner
or admin; switching on refuses only for plan, country or legal form, and
switching off previews what stays open.

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

`src/lib/composition` is infrastructure, so those counts never see what a
kernel reaches through it. The same test pins it by name instead
(`compositionSeams` in the baseline): only the recorded files may import a
composition module (today `bookkeeping/engine.ts`, for the reversal hooks),
a composition file may import only the recorded hook leaf modules, and none
may import `lib/init`, `lib/initialized` or the event bus.

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

## Phase 2: the posting port (step 1, shadow foundation)

Every new posting is to record what happened in business terms (a
`business_events` row: kind, category, subject, party type and id, amounts,
evidence, the rule version that produced the lines) linked to the verifikat it
produced (`business_event_entries`). `src/lib/posting` (ledger kernel) holds
the port, its only adapter (the ledger, which hands the producer's
`CreateJournalEntryInput` to the engine unchanged), the closed lists of kinds
and category keys, and `projectBusinessEvent` for history, which is never
backfilled. The switch is `POSTING_EVENTS`: `off` (default) changes nothing,
`shadow` records and never blocks, `strict` stops a posting before a voucher
number is drawn when its event cannot be written, and waits for step 2. The
pilot producer is bank-line booking (`createTransactionJournalEntry`).
`tests/pg/posting-parity.pg.test.ts` proves booking output against a fixture
taken from main before the port existed; each block that moves onto the port
in step 2 extends it or adds a sibling with its own fixture taken first.

Step 2a moves utlägg and milersättning (`registerExpenseClaim`,
`deleteExpenseClaim`, `bookMileagePeriod`) and kassa and webbshop
(`bookPosSalesDay`, `bookOrderThroughEngine`, which draft and commit through
the port so their claim on the draft still decides the race before a number
is drawn); their proof is `tests/pg/posting-parity-blocks.pg.test.ts` and the
producers' `*.engine-input.test.ts`. The utlägg payout batch waits until
`create_expense_payout_batch` takes an event id.

Step 2b moves the VAT and Skatteverket block and the asset block: the
momsredovisning (`bookVatSettlement`, kind `vat.settled`), the skattekonto
booking of the skatteverket extension (`bokforSkattekontoTransaction` and its
batch, kind `se.tax_account.booked`), the skattekonto account transfer
(`createSkattekontoTransferDraft`, a draft only, `ledger.manual`), the
planenlig avskrivning (`commitAnnualPostings`, `asset.depreciated`) and the
disposal (`disposeAsset`, `asset.disposed`). The asset doors draft through
the port and commit with `commit_asset_depreciation` and
`commit_asset_disposal` as before, so the event is linked to the draft before
either RPC draws the number; their proof is
`tests/pg/posting-parity-tax-assets.pg.test.ts` and the producers'
`*.engine-input.test.ts`.

Step 2c moves payroll. A salary run (`createSalaryRunEntries`, 1 to 4
verifikat) posts through `postJournalEntrySet`, the design's postSet: one
`payroll.salary_paid` event per run, subject the run, its link handed to every
draft inside `createJournalEntries`, so the set keeps its order and its
all-or-nothing checks and every link lands before the first number is drawn
(a link refused under strict on any voucher stops the whole run). The run's
idempotency key ties a resumed booking to the event its first attempt
recorded. A run's correction (`correctSalaryRun`) records one `ledger.storno`
event linked to every storno, and the semesterårsavslut's adjustment
(`commitVacationYearClose`) records `payroll.vacation_liability_adjusted`.
Payroll has no SQL posting function, so nothing waits on an event id; their
proof is `tests/pg/posting-parity-payroll.pg.test.ts` and the producers'
`*.engine-input.test.ts`.

Step 2d moves supplier invoice registration, booking and crediting. The two
generators every door shares post through `postJournalEntry`:
`createSupplierInvoiceRegistrationEntry` (the registration, the deferred
Bokför step, the inbox conversion and its staged approval) records
`purchase.registered`, one per invoice through its idempotency key, and
`createSupplierCreditNoteEntry` records `purchase.credited` with the credit
note as subject; each door hands down its link basis and inbox item. The
stornos the doors make of their own verifikat (a registration whose invoice
link failed, a credit taken back after a failed link or a lost race, and
Ångra kreditering) go through `reverseJournalEntry` as `ledger.storno`.
`link_supplier_invoice_to_voucher` waits for an event id, like the other SQL
posting functions, and the supplier payments (mark-paid, bank match, voucher
matching) and the inbox book-direct follow in their own merge request; their
proof is `tests/pg/posting-parity-supplier-invoices.pg.test.ts` and the
producers' `*.engine-input.test.ts`.

Step 2f moves customer invoice issue, booking and crediting. The two
generators every door shares post through `postJournalEntry`:
`createInvoiceJournalEntry` (the issue step `markInvoiceSentAndBook` behind
Markera som skickad, the email and Peppol sends, bulk Bokför, the recurring
auto-send and the staged operations; the deferred Bokför step
`bookInvoiceDeferred`; the received självfaktura) records `sale.invoiced`,
and `createCreditNoteJournalEntry` (`issueCreditNote`) records
`sale.credited` with the credit note as subject, one event per invoice and
per credit note through their idempotency keys; each door hands down its
link basis. The send dialog's user-edited lines name no mapping version. The
doors make no storno of their own verifikat (a lost Bokför race cancels its
verifikat through `cancel_orphaned_entry`, which posts nothing).
`link_invoice_to_voucher` waits for an event id, like the other SQL posting
functions, and the invoice payments (mark-paid, the kontantfaktura at issue,
bank match, voucher matching) and ROT/RUT (payout, reclaim, the migrated
deduction's reclassification) follow in their own merge request; their proof
is `tests/pg/posting-parity-invoices.pg.test.ts`, which also runs the payment
sync and RUT reclaim reversal hooks on invoices booked through the port, and
`invoice-entries.engine-input.test.ts`.

Step 2e moves the supplier payments, the supplier bank matches, the single
bank-line booking and the inbox book-direct. The payment generators
(`createSupplierInvoicePaymentEntry`, the 2440 clearing, and
`createSupplierInvoiceCashEntry`, kontantmetoden) post through
`postJournalEntry` and record `purchase.paid`: the invoice as subject, the
supplier as party, the debt settled in the invoice's currency and the kronor
that left the payment account, kontantmetoden's moms. Every door hands down
its link basis and the debt settled: both mark-paid routes,
`createSupplierBankMatchEntry` (the dashboard bank match through
`bookSupplierBankMatch`, the debit of a signed payment order, the v1 bank
match), and the person's own rows on each of them, which record no rule
source. The book route (`POST /api/transactions/[id]/book`) records
`bank.categorized`, the inbox book-direct the kind its source type names
(`bank.categorized` of the bank line, else `purchase.document_booked` of the
inbox item), both without category or rule source. Both uncategorize routes,
the v1 mark-paid storno of its own payment, the v1 match's storno of a row's
earlier booking and the stornos of a booking that could not be linked
(`reverseOrphanedJournalEntry` and `claimInboxItemOrReverseEntry`, given the
door's event) go through `reverseJournalEntry` as `ledger.storno`. Still on
SQL, waiting for an event id: `link_supplier_invoice_to_voucher` (supplier
voucher matching's kursdifferens verifikat), `bulk_book_transactions` and
`match_batch_allocate`. Their proof is
`tests/pg/posting-parity-supplier-payments.pg.test.ts` and the producers'
`*.engine-input.test.ts`.
