# Extension System: Design Document

## The App

Accounted is a Swedish accounting platform for sole traders (enskild firma) and limited companies (aktiebolag). It handles the legally required bookkeeping and financial management that every Swedish business needs.

## Core Functionality

The core is the standard accounting system. It's what every user gets out of the box: the features that exist in any accounting platform like Fortnox, Visma, or Björn Lundén. Nothing more, nothing less:

- Double-entry bookkeeping (journal entries, BAS chart of accounts, voucher numbering)
- Invoicing (create, send, track, payment matching)
- Supplier invoice management
- Bank transaction reconciliation
- Financial reports (income statement, balance sheet, trial balance, VAT declaration, general ledger)
- Tax compliance (SRU export, NE-bilaga, tax deadline tracking)
- Document archive with 7-year legal retention
- Customer and supplier management

That's the core. It doesn't include receipt scanning, AI categorization, AI chat, push notifications, or PSD2 bank connection. Those are not standard accounting features: they're value-adds.

## Extensions

Extensions are **everything beyond the core accounting system**. They are self-contained tools that a user adds to their dashboard. All compiled extensions are active for all users: the operator decides which extensions to include via `extensions.config.json` at build time.

There are two kinds of extensions:

### General Extensions

General extensions are not tied to any specific business sector. They're useful for any business but they go beyond what a standard accounting system offers.

Examples:
- **Receipt OCR**: Scan receipts and extract data automatically
- **AI Categorization**: AI-powered transaction categorization suggestions
- **AI Chat**: AI assistant for tax and bookkeeping questions
- **Push Notifications**: Event notifications for accounting activities
- **Enable Banking**: PSD2 automatic bank transaction sync

These are configured via `extensions.config.json` and only loaded when explicitly enabled by the operator.

### Sector Extensions

Sector extensions are tied to a specific market sector. They're only relevant to businesses operating in that sector. A restaurant owner wants "Food Cost %" but an IT consultant does not.

Examples:
- **Restaurant:** Food Cost %, Earnings Per Alcohol Liter, POS Z-Report Import, Tip Tracking
- **Construction:** ROT Calculator, Project Cost Tracking
- **Hotel:** RevPAR, Occupancy Tracking
- **IT/Consulting:** Billable Hours Ratio, Project Billing Metrics
- **E-commerce:** Shopify Order Import, Multi-channel Revenue Analytics

### The Unified Model

Both general and sector extensions live in the same system:

```
extensions/
  general/                    ← General extensions (any business)
    receipt-ocr/
    ai-categorization/
    ai-chat/
    push-notifications/
    enable-banking/
    invoice-inbox/
    calendar/
    email/
  restaurant/                 ← Restaurant sector extensions
    food-cost/
    earnings-per-liter/
    pos-import/
    tip-tracking/
  construction/               ← Construction sector extensions
    rot-calculator/
    project-cost/
  hotel/                      ← Hotel sector extensions
    revpar/
    occupancy/
  tech/                       ← IT/Consulting sector extensions
    billable-hours/
    project-billing/
  ecommerce/                  ← E-commerce sector extensions
    shopify-import/
    multichannel-revenue/
  export/                     ← Export & international trade extensions
    eu-sales-list/
    intrastat/
    vat-monitor/
    currency-receivables/
```

Each extension directory contains a `manifest.json` declaring metadata, entry point, workspace component path, required env vars, and npm dependencies.

In the marketplace:
- General extensions are shown to everyone, always visible
- Sector extensions are suggested based on the user's primary sector
- But all extensions are browsable by everyone regardless of sector

In the sidebar under "Your Extensions":
- Both general and sector extensions appear together
- Whatever the user has enabled shows up here

---

## Design Decisions (Confirmed)

### 1. Extensions are self-contained: they do NOT write to the core accounting system

Extensions are **independent tools that live on the dashboard**. They are NOT part of the core accounting system. They have their own world, their own data, their own purpose. They never create journal entries, invoices, or modify any accounting records.

There are two one-way data flows into an extension. Data never flows back:

```
Core Accounting Data ──→ Extension (reads it, displays it, uses it in calculations)
User Manual Input    ──→ Extension (stores it in extension's own data, processes it)
Extension            ──✗──→ Core Accounting (never writes back)
```

An extension may:
- **Be fed core data**: the platform feeds accounting data (journal entries, transactions, invoices) into the extension for it to read and use in calculations
- **Accept user input**: the user submits data directly into the extension for data that doesn't exist in any accounting system (e.g. liters of alcohol sold per day, POS Z-report files, Shopify order exports)
- **Store its own data**: extension-specific data lives in the extension's own storage, separate from core accounting
- **Calculate and display**: combine core data + extension data to produce metrics, reports, insights

An extension may NOT:
- Create journal entries
- Create or modify invoices
- Modify transactions or any core accounting table
- Write back to the core accounting system in any way

This is a critical architectural constraint. Extensions are safe: enabling or disabling one can never corrupt or affect the accounting data. The core bookkeeping is a walled garden that extensions can look into but never modify.

**Important:** Features like POS Z-Report Import and Shopify Order Import are EXTENSIONS. They import data into the extension's own storage and provide analytics on that data. They do not create journal entries from imported data. The bookkeeping of POS data or Shopify orders is a separate activity the user does in the core platform.

### 2. Data source depends on the extension: three patterns

**Pattern A: Fed from core accounting data**
Some extensions are fed existing bookkeeping data. For example, a "Food Cost %" extension reads journal entries for food purchase accounts (4000-series) and food revenue accounts (3000-series), then calculates and displays the metric. The user doesn't enter anything: the data already exists in the bookkeeping. These are extensions for data that Fortnox, Visma, and other accounting systems already have.

**Pattern B: User submits data manually**
Some extensions need data that doesn't exist in any accounting system. No system tracks liters of alcohol sold, or daily staff tips, or room occupancy counts. For these extensions, the user manually submits data into the extension's workspace. The extension stores, processes, and displays this data. This has nothing to do with the core accounting functionality.

**Pattern C: Both**
Some extensions combine core accounting data with user-submitted data. "Earnings Per Alcohol Liter" reads alcohol revenue from the bookkeeping (Pattern A) and takes user-entered liter counts (Pattern B) to calculate revenue per liter.

### 3. Extension marketplace for browsing

Users have a dedicated "Extensions" marketplace page where they can:
- Browse all compiled extensions (general + all sectors)
- Read descriptions and details
- Open extension workspaces

### 4. Primary sector with cross-sector browsing

During onboarding, the user selects a **primary sector** (e.g. "Restaurant & Cafe"). The app then suggests extensions for that sector, plus general extensions. But the user is NOT locked in: they can browse and enable extensions from any sector at any time via the marketplace.

The primary sector serves as a **recommendation filter**, not a restriction.

### 5. First-party now, third-party later

We build all extensions ourselves initially. But the architecture should be clean and well-defined enough that external developers could eventually build extensions too. This means:
- Clear extension interface/contract
- Well-documented data access patterns
- Self-contained extension structure (each extension is a standalone module)

---

## The User Experience

1. User signs up, goes through onboarding
2. On the dashboard, the sidebar shows links to compiled extensions that have a workspace + quickAction
3. Clicking an extension opens its workspace: a dedicated page with the extension's own UI
4. The user interacts with the extension: views data, enters inputs, sees calculations/reports
5. User can browse the marketplace to see all compiled extensions

---

## Extension Definition

### What an Extension Contains

| Part | Required? | Description |
|------|-----------|-------------|
| **Metadata** | Yes | Name, description, sector (or 'general'), category, icon: for marketplace and sidebar |
| **Workspace UI** | Yes | A React component: the main page the user sees when they click the extension |
| **Extension data** | Depends | Storage for user-submitted data and extension state |
| **Configuration** | Optional | Settings panel for customizing the extension's behavior |
| **Core data queries** | Optional | Queries that read from journal entries, transactions, invoices, etc. |

### Marketplace Definition (ExtensionDefinition)

This is the metadata used for the marketplace UI and sector browsing. It comes from each extension's `manifest.json` file and is code-generated into `lib/extensions/_generated/sector-definitions.ts`.

```typescript
interface ExtensionDefinition {
  // Identity
  slug: string                      // URL-safe ID, unique within sector (e.g. 'earnings-per-liter')
  name: string                      // Display name (e.g. 'Earnings Per Alcohol Liter')
  sector: SectorSlug                // 'general' | 'restaurant' | 'construction' | 'hotel' | 'tech' | 'ecommerce' | 'export'
  category: ExtensionCategory       // 'accounting' | 'reports' | 'import' | 'operations'

  // Display (for marketplace and sidebar)
  description: string               // One-line description
  longDescription: string           // Detailed description with features
  icon: string                      // Lucide icon name
  entityTypes?: EntityType[]        // Supported entity types (default: both EF and AB)

  // Data patterns
  dataPattern: 'core' | 'manual' | 'both'  // How the extension gets its data
  readsCoreTables?: string[]        // Which core tables this extension reads (for pattern A/C)
  hasOwnData?: boolean              // Whether users submit data into this extension (for pattern B/C)

  // Optional
  quickAction?: QuickActionDefinition  // Dashboard quick action
  subscriptionNotice?: string          // Notice shown when enabling (e.g. external subscription)
}
```

### Runtime Extension Interface

This is the contract for extension logic at runtime. Extensions are imported and registered by the loader.

```typescript
interface Extension {
  id: string
  name: string
  version: string
  sector?: SectorSlug

  // Surfaces
  routes?: RouteDefinition[]
  apiRoutes?: ApiRouteDefinition[]        // Dispatched by catch-all at /api/extensions/ext/
  sidebarItems?: SidebarItem[]
  eventHandlers?: ExtensionEventHandler[]
  mappingRuleTypes?: MappingRuleTypeDefinition[]
  reportTypes?: ReportDefinition[]
  settingsPanel?: SettingsPanelDefinition
  taxCodes?: TaxCodeDefinition[]
  dimensionTypes?: DimensionDefinition[]

  /** Named services this extension provides to core via registry lookup */
  services?: Record<string, (...args: any[]) => Promise<any>>

  // Lifecycle hooks
  onInstall?(ctx: ExtensionContext): Promise<void>
  onUninstall?(ctx: ExtensionContext): Promise<void>
}
```

### Sector Definition

```typescript
interface Sector {
  slug: SectorSlug                  // 'general' | 'restaurant' | 'construction' | 'hotel' | 'tech' | 'ecommerce' | 'export'
  name: string                      // 'General' | 'Restaurant & Cafe' | etc.
  icon: string                      // Lucide icon name
  description: string               // Short tagline
  extensions: ExtensionDefinition[]
}
```

### Extension Categories

```typescript
type ExtensionCategory = 'accounting' | 'reports' | 'import' | 'operations'
```

| Category | Color | Purpose |
|----------|-------|---------|
| Accounting & Tax | Red | Calculations related to bookkeeping, VAT, deductions |
| Industry Reports | Blue | KPIs, analytics, metrics |
| Smart Import | Green | Parse and import data from external tools |
| Operational Tools | Gray | Day-to-day business tools |

---

## Concrete Examples

| Extension | Sector | Data Pattern | User Input | Reads Core Data | What it Does |
|-----------|--------|--------------|------------|-----------------|--------------|
| Receipt OCR | General | B (manual) | Uploads receipt images | None | Scans receipts, extracts merchant/amount/VAT data |
| AI Categorization | General | A (core) | None | Uncategorized transactions | Suggests BAS account categories using AI |
| Enable Banking | General | B (manual) | Bank connection setup | None | Syncs bank transactions via PSD2 |
| Earnings Per Alcohol Liter | Restaurant | A + B (both) | Liters sold per day/week | Alcohol revenue from BAS 3001 | Calculates revenue/liter, trends over time |
| Food Cost % | Restaurant | A (core) | None | Food purchases (4000-series), food revenue (3000-series) | Calculates food_cost/food_revenue %, trends |
| Tip Tracking | Restaurant | B (manual) | Tip amounts per shift | Optionally reads staff cost accounts | Total tips, tips/employee, tip % of revenue |
| POS Z-Report Import | Restaurant | B (manual) | Uploads Z-report CSV/Excel | None | Parses POS data, stores in extension, shows daily sales analytics |
| Shopify Order Import | E-commerce | B (manual) | Uploads order export | None | Imports orders into extension, shows revenue by product, trends |
| ROT Calculator | Construction | A + B (both) | Labor hours, material costs per job | Invoice data for customer billing | ROT deduction amounts (30% of labor, max 50k/year per customer) |
| RevPAR | Hotel | A + B (both) | Room count and occupancy | Room revenue accounts | Revenue Per Available Room, occupancy rate |
| Billable Hours Ratio | IT/Consulting | A + B (both) | Hours worked per project | Invoice data for billed amounts | Billable/total hours, effective hourly rate |

---

## Architecture

### Where Things Live

```
extensions/                           ← Extension source code (opt-in via config)
  general/                            ← General extensions
    receipt-ocr/
      manifest.json                   ← Metadata, entry point, env vars, workspace path
      index.ts                        ← Extension definition + logic (exports Extension)
      lib/
      __tests__/
    ai-categorization/
      manifest.json
      index.ts
      lib/
    ai-chat/
      manifest.json
      index.ts
      lib/
    push-notifications/
      manifest.json
      index.ts
      lib/
    enable-banking/
      manifest.json
      index.ts
      lib/
    email/                            ← Email service extension (registers Resend impl)
      manifest.json
      index.ts
      lib/
    invoice-inbox/
      manifest.json
      index.ts
    calendar/
      manifest.json
      index.ts
  restaurant/                         ← Restaurant sector
    food-cost/
      manifest.json
    earnings-per-liter/
      manifest.json
    pos-import/
      manifest.json
    tip-tracking/
      manifest.json
  construction/                       ← Construction sector
    rot-calculator/
      manifest.json
    project-cost/
      manifest.json
  hotel/                              ← Hotel sector
    revpar/
      manifest.json
    occupancy/
      manifest.json
  tech/                               ← IT/Consulting sector
    billable-hours/
      manifest.json
    project-billing/
      manifest.json
  ecommerce/                          ← E-commerce sector
    shopify-import/
      manifest.json
    multichannel-revenue/
      manifest.json
  export/                             ← Export & international trade sector
    eu-sales-list/
      manifest.json
      index.ts
    intrastat/
      manifest.json
    vat-monitor/
      manifest.json
    currency-receivables/
      manifest.json

extensions.config.json                ← Which extensions are enabled (empty = core-only)
extensions.schema.json                ← JSON Schema for extensions.config.json

lib/
  extensions/
    types.ts                          ← Extension, ExtensionDefinition, Sector types
    sectors.ts                        ← Sector shells + generated extension definitions
    workspace-registry.tsx            ← Maps sector/slug → lazy-loaded React component
    loader.ts                         ← Imports from _generated, registers extensions
    registry.ts                       ← Runtime extension registry (get, register)
    context-factory.ts                ← Builds ExtensionContext for handlers
    _generated/                       ← AUTO-GENERATED by npm run setup:extensions
      extension-list.ts               ← FIRST_PARTY_EXTENSIONS array (static imports)
      workspace-map.tsx               ← Lazy-loaded workspace components
      sector-definitions.ts           ← ExtensionDefinition[] per sector
      enabled-extensions.ts           ← ENABLED_EXTENSION_IDS set for build-time checks
  email/
    service.ts                        ← EmailService interface + no-op default + getEmailService()
  reports/
    sru-export/                       ← SRU file export (core, not an extension)
    ne-bilaga/                        ← NE tax form attachment (core, not an extension)

scripts/
  generate-extension-registry.ts      ← Reads config + manifests, writes _generated/ files

app/api/extensions/
  ext/[...path]/
    route.ts                          ← Catch-all API dispatcher for extension routes

components/
  extensions/
    ExtensionWorkspaceShell.tsx       ← Shared layout wrapper
    shared/                           ← Shared UI primitives
      KPICard.tsx
      DataEntryForm.tsx
      DateRangeFilter.tsx
      EmptyExtensionState.tsx
      ExtensionLoadingSkeleton.tsx
    general/                          ← General extension workspaces
      ReceiptOcrWorkspace.tsx
      AiCategorizationWorkspace.tsx
      AiChatWorkspace.tsx
    restaurant/                       ← Restaurant extension workspaces
      EarningsPerLiterWorkspace.tsx
      FoodCostWorkspace.tsx
      PosImportWorkspace.tsx
    construction/
      RotCalculatorWorkspace.tsx
    hotel/
      RevparWorkspace.tsx
    tech/
      BillableHoursWorkspace.tsx
    ecommerce/
      ShopifyImportWorkspace.tsx

app/(dashboard)/
  extensions/                         ← Marketplace
    page.tsx                          ← Extension hub (browse sectors + general)
    [sector]/
      page.tsx                        ← Extensions for a specific sector
      [extension]/
        page.tsx                      ← Extension detail + workspace link
  e/                                  ← Extension workspaces
    [sector]/
      [slug]/
        page.tsx                      ← Renders the workspace component
```

### Data Storage

Extensions store their data in the existing `extension_data` table:

```
extension_data:
  user_id:      auth user
  extension_id: 'restaurant/earnings-per-liter'   (sector/slug format)
  key:          'settings' | 'entries' | 'config' | custom keys
  value:        JSONB (flexible)
```

For the "Earnings Per Liter" extension, data might look like:
```
key: 'settings'     → { "defaultUnit": "liter", "currency": "SEK" }
key: 'entries'      → [{ "date": "2025-01-15", "liters": 42.5, "type": "spirits" }, ...]
key: 'config'       → { "revenueAccounts": ["3001"], "trackByType": true }
```

### Extension Enablement

Extensions are enabled at **build time** via `extensions.config.json`. All compiled extensions are active for all users: there is no per-user toggle system. The operator (hosted or self-hosted) decides which extensions to include.

To check if an extension is compiled in at runtime (e.g. for conditional UI), use the build-time constant:

```typescript
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'

if (ENABLED_EXTENSION_IDS.has('receipt-ocr')) {
  // Show OCR UI
}
```

AI extensions (`receipt-ocr`, `ai-categorization`, `ai-chat`) additionally require per-user AI consent before making API calls. This is a separate system using the `extension_data` table, managed by `lib/extensions/ai-consent.ts`.

> **Note:** The `extension_toggles` database table still exists but is no longer queried by any code. It can be dropped in a future migration.

### API Routes for Extensions

Extensions declare their API routes via the `apiRoutes` array on the `Extension` object:

```typescript
export const myExtension: Extension = {
  id: 'my-extension',
  // ...
  apiRoutes: [
    {
      method: 'POST',
      path: '/',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        // Handle POST /api/extensions/ext/my-extension/
        return new Response(JSON.stringify({ ok: true }))
      },
    },
    {
      method: 'GET',
      path: '/:id',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        // :id is extracted and available as ?_id=... search param
        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        return new Response(JSON.stringify({ id }))
      },
    },
  ],
}
```

All extension API routes are served by a single **catch-all dispatcher** at:

```
app/api/extensions/ext/[...path]/route.ts
```

URL scheme: `/api/extensions/ext/{extensionId}/{...routePath}`

The dispatcher handles:
1. **Auth check**: 401 if not logged in
2. **Extension lookup**: 404 if extension not registered or has no apiRoutes
3. **Path matching**: Matches method + path pattern (supports `:param` wildcards)
4. **AI consent check**: 403 if AI extension and user hasn't consented
5. **Param extraction**: Path params like `:id` are added as `_id` search params
6. **Context building**: Creates `ExtensionContext` with supabase, userId, settings, storage, logger
7. **Dispatch**: Calls the matched handler with the request and context

The generic data CRUD routes for `extension_data` still exist alongside:

```
app/api/extensions/[sector]/[slug]/
  data/route.ts       : GET (read entries), POST (submit new entry), DELETE (remove entry)
  settings/route.ts   : GET (read settings), PATCH (update settings)
```

### Sidebar Integration

The sidebar (`DashboardNav.tsx`) has a section for extensions. It shows all compiled extensions that have a workspace and a `quickAction` with an `href`:

```
── Your Extensions ──────────
  📷 Receipt OCR             → /e/general/receipt-ocr
  🤖 AI Categorization       → /e/general/ai-categorization
  📊 Food Cost %             → /e/restaurant/food-cost
  🍷 Earnings Per Liter      → /e/restaurant/earnings-per-liter
```

Each link goes to `/e/{sector}/{slug}` which renders the extension's workspace component.

---

## The Extension Workspace Pattern

Every extension workspace follows the same pattern:

```
┌─────────────────────────────────────────────────┐
│  Extension Workspace Shell                       │
│  ┌─────────────────────────────────────────────┐ │
│  │  Header: Extension name + settings link     │ │
│  ├─────────────────────────────────────────────┤ │
│  │                                             │ │
│  │  Extension-specific UI                      │ │
│  │                                             │ │
│  │  This is where the extension does its thing │ │
│  │  - Data entry forms                         │ │
│  │  - KPI cards and charts                     │ │
│  │  - Tables of submitted data                 │ │
│  │  - Calculation results                      │ │
│  │  - Date range filters                       │ │
│  │                                             │ │
│  └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

The `ExtensionWorkspaceShell` provides consistent chrome (header, breadcrumbs, settings link). The extension fills in the content area with whatever UI it needs.

### Example: Earnings Per Alcohol Liter

When the user clicks this extension, they see:

1. **KPI cards at top**: Current earnings/liter, trend vs last month, total liters this month
2. **Data entry section**: Form to log daily sales (date, liters sold, alcohol type)
3. **History table**: Past entries with edit/delete
4. **Chart**: Earnings per liter over time (line chart)
5. **Revenue breakdown**: Reads from core journal entries: alcohol revenue by account

The extension reads revenue data from journal_entry_lines (BAS 3001 for 25% alcohol revenue) and combines it with user-submitted liter data to calculate the metric.

---

## Migration from Previous Architecture (Completed)

The previous architecture had extensions "always loaded" via hardcoded static imports in `loader.ts`, with SRU export and NE-bilaga treated as extensions. The system was fully decoupled in "Plan B: Full Decoupling":

### What Changed

1. **Extension opt-in system** -- Extensions are configured via `extensions.config.json`. A generator script (`npm run setup:extensions`) reads manifest files and produces `lib/extensions/_generated/` files. Core compiles and runs with an empty config (zero extensions).

2. **Services pattern** -- Extensions can expose named services via `services?: Record<string, (...args: any[]) => Promise<any>>` on the Extension interface. Core code uses `extensionRegistry.get('ext-id')?.services?.methodName` for runtime lookup instead of direct imports. This is how `ai-categorization` provides template embedding functions to core booking logic.

3. **Catch-all API dispatcher** -- Extension API routes are registered via `apiRoutes: ApiRouteDefinition[]` on the Extension object. The catch-all at `/api/extensions/ext/[...path]/route.ts` handles auth, AI consent checks, path param extraction, and dispatches to the handler. URL pattern: `/api/extensions/ext/{extensionId}/{path}`.

4. **SRU/NE-bilaga are core** -- These tax compliance features were moved from `extensions/` into `lib/reports/sru-export/` and `lib/reports/ne-bilaga/`. They are always available regardless of extension configuration.

5. **Email is optional** -- Core defines an `EmailService` interface in `lib/email/service.ts` with a no-op default. The `email` extension registers a Resend implementation at load time. Core callers use `getEmailService()` -- when the email extension is not enabled, email calls silently return `{ success: false }`.

6. **Export sector** -- EU Sales List, Intrastat, VAT Monitor, and Currency Receivables are extensions under `extensions/export/`.

7. **Manifest files** -- Every extension has a `manifest.json` that declares metadata, entry point, workspace component path, required env vars, optional env vars, and npm dependencies.

8. **Generated files** -- Three files in `lib/extensions/_generated/` are produced by the generator:
   - `extension-list.ts` -- Static imports and `FIRST_PARTY_EXTENSIONS` array
   - `workspace-map.tsx` -- `next/dynamic` lazy-loaded workspace components
   - `sector-definitions.ts` -- `ExtensionDefinition[]` per sector for the marketplace UI

---

## Implementation Status

| Item | Status | Notes |
|------|--------|-------|
| Extension types (ExtensionDefinition, Sector, etc.) | Done | `lib/extensions/types.ts` |
| Sector data registry | Done | `lib/extensions/sectors.ts` + generated definitions |
| Database migration (extension_toggles) | Done | Migration 037 (table exists but no longer queried) |
| Build-time extension check | Done | `ENABLED_EXTENSION_IDS` in `_generated/enabled-extensions.ts` |
| Workspace component registry | Done | `lib/extensions/workspace-registry.tsx` + generated map |
| Workspace routing (`/e/[sector]/[slug]`) | Done | `app/(dashboard)/e/[sector]/[slug]/page.tsx` |
| Workspace shell | Done | `components/extensions/ExtensionWorkspaceShell.tsx` |
| Marketplace pages | Done | `app/(dashboard)/extensions/` |
| Sidebar "Your Extensions" | Done | Wired into DashboardNav |
| Onboarding with build-time extension checks | Done | Uses `ENABLED_EXTENSION_IDS` |
| Shared UI components | Done | KPICard, DataEntryForm, DateRangeFilter, etc. |
| Extension API routes (generic CRUD) | Done | `app/api/extensions/[sector]/[slug]/` |
| Catch-all API dispatcher | Done | `app/api/extensions/ext/[...path]/route.ts` |
| Services pattern | Done | Used by ai-categorization for template embeddings |
| Email service interface | Done | `lib/email/service.ts` + email extension |
| SRU/NE-bilaga moved to core | Done | `lib/reports/sru-export/` + `lib/reports/ne-bilaga/` |
| Manifest files for all extensions | Done | 25 manifest.json files |
| Code generator | Done | `scripts/generate-extension-registry.ts` |
| extensions.config.json opt-in | Done | Core runs with empty config |
| General extensions with manifests | Done | All general extensions have manifests |
| Export sector extensions | Done | EU Sales List, Intrastat, VAT Monitor, Currency Receivables |
| Restaurant sector extensions | Done | Food Cost, Earnings Per Liter, POS Import, Tip Tracking |
| Construction sector extensions | Done | ROT Calculator, Project Cost |
| Hotel sector extensions | Done | RevPAR, Occupancy |
| Tech sector extensions | Done | Billable Hours, Project Billing |
| E-commerce sector extensions | Done | Shopify Import, Multichannel Revenue |

---

## Self-Hosting Guide

### Core Setup (No Extensions)

Core runs with zero extensions. This gives you the standard accounting system: bookkeeping, invoicing, bank reconciliation, reports, tax compliance (SRU, NE-bilaga, VAT declaration).

```bash
# 1. Clone and install
git clone <repo-url> && cd Accounted
npm install

# 2. Set environment variables (minimum 4)
export NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
export NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
export SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
export NEXT_PUBLIC_APP_URL=https://your-domain.com

# 3. Run database migrations
# Apply all migrations in supabase/migrations/ to your Supabase project

# 4. Build and run
npm run build    # setup:extensions runs automatically (empty config = no extensions)
npm start
```

### Enabling Extensions

```bash
# 1. See available extensions
npx tsx scripts/generate-extension-registry.ts --list

# 2. Edit extensions.config.json: add extension IDs
{
  "extensions": ["receipt-ocr", "ai-categorization", "email"]
}

# 3. Regenerate (also runs automatically on build/dev)
npm run setup:extensions

# 4. Set extension-specific env vars (check each manifest.json for requiredEnvVars)
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
export RESEND_API_KEY=...
export RESEND_FROM_EMAIL=...

# 5. Rebuild
npm run build
```

The `extensions.config.json` file is validated against `extensions.schema.json`. The generator will error if you reference an unknown extension ID.

---

## Extension Developer Guide

### Creating a New Extension

**Option 1: Manual creation**

1. Create the extension directory: `extensions/<sector>/<name>/`
2. Create `manifest.json`:

```json
{
  "id": "my-extension",
  "sector": "general",
  "exportName": "myExtension",
  "entryPoint": "@/extensions/general/my-extension",
  "workspace": "@/components/extensions/general/MyExtensionWorkspace",
  "requiredEnvVars": [],
  "optionalEnvVars": [],
  "npmDependencies": [],
  "definition": {
    "name": "My Extension",
    "category": "reports",
    "icon": "BarChart",
    "dataPattern": "core",
    "readsCoreTables": ["journal_entry_lines"],
    "description": "Short description",
    "longDescription": "Detailed description with features and use cases."
  }
}
```

3. Create `index.ts` exporting the Extension object:

```typescript
import type { Extension } from '@/lib/extensions/types'

export const myExtension: Extension = {
  id: 'my-extension',
  name: 'My Extension',
  version: '1.0.0',
  sector: 'general',
  // ... surfaces, services, event handlers
}
```

4. Create the workspace component at the path specified in `manifest.workspace`
5. Add the extension ID to `extensions.config.json`
6. Run `npm run setup:extensions`

**Manifest fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique extension ID (matches config and Extension.id) |
| `sector` | Yes | Sector slug |
| `exportName` | No | Named export from entryPoint (null = metadata-only extension) |
| `entryPoint` | No | Import path for the Extension object (null = no runtime logic) |
| `workspace` | No | Import path for the workspace React component (null = no UI) |
| `requiredEnvVars` | Yes | Env vars that must be set for the extension to work |
| `optionalEnvVars` | Yes | Env vars that enhance but are not required |
| `npmDependencies` | Yes | npm packages the extension depends on |
| `definition` | Yes | Marketplace metadata (name, category, icon, description, etc.) |

Extensions with `exportName: null` and `entryPoint: null` are metadata-only -- they appear in the marketplace and have a workspace UI but no server-side runtime logic (e.g. pure frontend calculators like Food Cost %).

### Services Pattern

Extensions can expose named services for cross-boundary calls. This avoids direct imports from extension code into core:

```typescript
// Extension: ai-categorization/index.ts
export const aiCategorizationExtension: Extension = {
  id: 'ai-categorization',
  name: 'AI Categorization',
  version: '1.0.0',
  services: {
    findSimilarTemplates: async (description: string, limit?: number) => {
      // ... embedding search logic
      return matches
    },
  },
}
```

Core code calls the service via registry lookup:

```typescript
// Core code: no direct import from extensions/
const ext = extensionRegistry.get('ai-categorization')
const results = await ext?.services?.findSimilarTemplates(description, 5)
if (results) {
  // Use results
}
// Gracefully degrades if extension is not loaded
```

This pattern is used for:
- `ai-categorization` providing template embedding search to core booking suggestions
- Any extension that needs to provide functionality callable by core without a direct dependency

### Event Bus Usage

Extensions subscribe to events emitted by core. Handlers run concurrently via `Promise.allSettled` -- a failing handler never crashes the emitter.

```typescript
export const myExtension: Extension = {
  id: 'my-extension',
  // ...
  eventHandlers: [
    {
      eventType: 'transaction.categorized',
      handler: async (payload, ctx) => {
        // React to categorized transactions
        // ctx provides supabase, userId, settings, storage, log
      },
    },
  ],
}
```

Events are one-way: core services emit, extensions subscribe. Extensions should never emit events back to core. If an extension is not compiled in (not in `extensions.config.json`), its handlers are never registered.

### Workspace Components

Workspace components are React components rendered at `/e/{sector}/{slug}`. They receive `{ userId: string }` as props and are lazy-loaded via `next/dynamic`.

The workspace path is declared in `manifest.json` under the `workspace` field. The generator creates a dynamic import map in `_generated/workspace-map.tsx`.

All workspace components should use the `ExtensionWorkspaceShell` wrapper for consistent layout (header, breadcrumbs, settings link).

### Email Service Interface Pattern

The email extension demonstrates how to make a core capability optional:

1. **Core defines the interface** (`lib/email/service.ts`):
   - `EmailService` interface with `sendEmail()` and `isConfigured()`
   - `NoopEmailService` as default (returns `{ success: false }`)
   - `getEmailService()` getter and `registerEmailService()` setter

2. **Extension registers the implementation** (`extensions/general/email/index.ts`):
   - Imports `registerEmailService` from core
   - Creates `ResendEmailService` and registers it at load time

3. **Core callers use the getter** -- never import from the extension:
   ```typescript
   const emailService = getEmailService()
   if (emailService.isConfigured()) {
     await emailService.sendEmail({ to, subject, html })
   }
   ```

This pattern can be reused for any capability that should degrade gracefully when its extension is not loaded.

---

## Summary

**The app** is a Swedish accounting platform.

**Core functionality** is the standard accounting system: bookkeeping, invoicing, reports, tax (SRU, NE-bilaga), bank reconciliation. Every user gets this. Core compiles and runs with zero extensions.

**Extensions** are everything beyond core accounting. They come in three kinds:
- **General extensions** (receipt-ocr, ai-categorization, email, etc.) -- useful for any business, not sector-specific
- **Sector extensions** (food cost %, earnings per liter, etc.) -- tied to a specific market sector
- **Export extensions** (EU Sales List, Intrastat, etc.) -- for businesses with international trade

All extensions live in the same system, appear in the same marketplace, and show up in the sidebar when they have a workspace + quickAction. All compiled extensions are active for all users -- the operator chooses which to include in `extensions.config.json` at build time. AI extensions additionally require per-user consent before making API calls.

Extensions are read-only with respect to the core accounting system. They can be fed accounting data, they can accept manual user input, but they never write back to the bookkeeping. They can expose services to core via the registry lookup pattern, and they can register API routes that are dispatched by the catch-all handler.
