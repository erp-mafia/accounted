# Extension Development Guide

An extension is an opt-in module under `extensions/general/<id>/` that is compiled into a deployment when its id is listed in `extensions.config.json`. Once compiled in, it is active for every company on that deployment (paid capabilities can still gate it, see [API routes](#api-routes)). An extension can:

- subscribe to core events (`eventHandlers`)
- serve HTTP routes through one dispatcher (`apiRoutes`)
- hand named functions to core (`services`)
- ship a workspace page and settings UI

Run `npx tsx scripts/generate-extension-registry.ts --list` to print every available extension and the env vars it requires.

Licensing: the project is AGPL-3.0 with an extension exception. An extension that interacts only through the documented Extension API (`lib/extensions/types.ts`, `lib/events/types.ts` and `app/api/extensions/ext/[...path]/route.ts`) may be licensed on any terms, under the conditions stated in [LICENSE](../LICENSE).

## The core boundary

These rules are enforced by CI:

- **Core never imports from `@/extensions/`.** The "Check no core imports from extensions" step in `.github/workflows/core-build.yml` greps `lib/`, `app/api/` and `components/` for `from '@/extensions/`. The exempt paths are `app/api/extensions/`, `components/extensions/`, `lib/extensions/_generated/` and `lib/extensions/loader.ts`. `lib/extensions/__tests__/type-decoupling.test.ts` applies the same rule to `types/index.ts`.
- **Core must build and run with zero extensions.** The shared CI setup (`.github/actions/setup-core/action.yml`) writes `{"extensions":[]}` to the config before building and testing. Core reaches extension functionality only through the registry, and it must behave correctly when the lookup finds nothing.
- **Extension code is loaded through static imports.** The generator writes a plain `import { ... } from '<entryPoint>'` for each enabled extension. Never load extension modules with a module-scope dynamic `import()`. An `await import()` of a core module inside a handler body is fine.

Extensions can write core data (for example, bank sync ingests transactions through `ctx.services.ingestTransactions`). Anything they write follows the same accounting rules as core code: journal writes go through `lib/bookkeeping/engine.ts`, and period locks are respected. See the Hard Rules in `CLAUDE.md`.

## Layout

```
extensions/general/<id>/
  manifest.json      metadata read by the generator
  index.ts           exports the Extension object
  api-routes.ts      optional: ApiRouteDefinition[]
  lib/, components/  optional
  __tests__/         Vitest tests
components/extensions/general/<Name>Workspace.tsx   optional workspace page
lib/extensions/_generated/                         written by npm run setup:extensions
```

## Enabling extensions

1. Add the id to `extensions.config.json`: `{ "$schema": "./extensions.schema.json", "extensions": ["email", "calendar"] }`.
2. Run `npm run setup:extensions`. `npm run dev` and `npm run build` also run it first, through `predev` and `prebuild`.
3. Set the env vars listed in each enabled `manifest.json` under `requiredEnvVars`.

`scripts/generate-extension-registry.ts` finds every `manifest.json` under `extensions/`. It exits with an error if two manifests share an id, or if the config lists an id that has no manifest. It then writes four files to `lib/extensions/_generated/`:

| File | Export | Content |
|------|--------|---------|
| `extension-list.ts` | `FIRST_PARTY_EXTENSIONS` | Static imports of every enabled manifest with a non-null `exportName` and `entryPoint`. `loadExtensions()` registers these. |
| `workspace-map.tsx` | `WORKSPACES` | A `next/dynamic` import for each manifest with a `workspace`, keyed `<sector>/<id>`. |
| `sector-definitions.ts` | `EXTENSION_DEFINITIONS` | Marketplace metadata from each manifest's `definition`, grouped by sector. |
| `enabled-extensions.ts` | `ENABLED_EXTENSION_IDS` | The set of enabled ids, for conditional UI such as `ENABLED_EXTENSION_IDS.has('skatteverket')`. |

Validation is limited to what the generator itself checks:

- **Env vars:** a missing `requiredEnvVars` entry only prints a warning, and the extension still loads. `optionalEnvVars` and `npmDependencies` are documentation; the generator ignores them. Any real dependency goes in `package.json`.
- **The schema:** the generator never reads `extensions.schema.json`. The `$schema` key only gives editors autocompletion and validation, and the schema's enum is maintained by hand (plus `scripts/create-extension.ts`), so it can drift from the manifests.

Enablement is per deployment, decided at build time. There is no per-company toggle. The Docker image copies `docker/extensions.<EXTENSIONS_PRESET>.json` over the config before building (default preset `self-hosted`). For everything else about self-hosting, see [SELF-HOSTING.md](SELF-HOSTING.md) and [DOCKER.md](DOCKER.md).

## Creating an extension

```bash
npx tsx scripts/create-extension.ts \
  --name my-extension --sector general --category operations \
  --description "Short description"
```

All four flags are required. `--name` must be kebab-case. `--category` is one of `import`, `operations`, `reports` or `accounting`. The script refuses to overwrite an existing directory. It writes:

- `extensions/<sector>/<name>/manifest.json`, with `workspace: null`, icon `Box` and `dataPattern: "core"`
- `index.ts`, exporting `<camelCaseName>Extension` (for example `myExtensionExtension`) with `apiRoutes` wired up
- an empty `api-routes.ts`

It also appends the id to the enum in `extensions.schema.json`. Then add the id to `extensions.config.json` and run `npm run setup:extensions`.

The script lags the code in three places:

- **Sector:** always pass `--sector general`. The script also accepts `restaurant`, `construction`, `hotel`, `tech`, `ecommerce` and `export`, but `SectorSlug` in `lib/extensions/types.ts` is only `'general'`, and `lib/extensions/sectors.ts` defines only the `general` sector. An extension scaffolded with another sector fails type-checking and never shows up in the marketplace or under `/e/`.
- **Printed next steps:** skip steps 4 and 5, which say to edit `lib/extensions/loader.ts` and `lib/extensions/sectors.ts`. The generator handles both.
- **Route URL:** the comment in the generated `api-routes.ts` gives the wrong URL. The real one is `/api/extensions/ext/<id>/<path>`.

## Manifest

Abridged from `extensions/general/enable-banking/manifest.json`:

```json
{
  "id": "enable-banking",
  "sector": "general",
  "exportName": "enableBankingExtension",
  "entryPoint": "@/extensions/general/enable-banking",
  "workspace": "@/components/extensions/general/EnableBankingWorkspace",
  "requiredEnvVars": ["ENABLE_BANKING_APP_ID", "ENABLE_BANKING_PRIVATE_KEY"],
  "optionalEnvVars": ["ENABLE_BANKING_API_URL", "ENABLE_BANKING_PSU_TYPE"],
  "npmDependencies": [],
  "definition": {
    "name": "Bankintegration (PSD2)",
    "category": "import",
    "icon": "Landmark",
    "dataPattern": "manual",
    "hasOwnData": true,
    "description": "Automatisk banktransaktionssynk via PSD2",
    "longDescription": "Koppla ditt bankkonto direkt och synka transaktioner automatiskt ..."
  }
}
```

| Field | Meaning |
|-------|---------|
| `id` | Must equal `Extension.id`. It is the registry key and the first path segment under `/api/extensions/ext/`. By convention it matches the directory name. |
| `sector` | `"general"` |
| `exportName`, `entryPoint` | Named export and import path of the Extension object. If either is `null`, nothing is registered at runtime; the manifest still feeds the marketplace and workspace map. |
| `workspace` | Import path of a default-exported React component, or `null` |
| `requiredEnvVars`, `optionalEnvVars`, `npmDependencies` | See [Enabling extensions](#enabling-extensions) |
| `definition` | Marketplace metadata. Required: `name`, `category`, `icon` (a Lucide name), `dataPattern` (`core`, `manual` or `both`), `description`, `longDescription`. Optional: `readsCoreTables`, `hasOwnData`, `quickAction` (`{ label, description, icon, href?, event?, order? }`), `subscriptionNotice`. |

## The Extension object

`Extension` in `lib/extensions/types.ts` has `id`, `name`, `version` and optional `sector`, plus optional surfaces. Only some surfaces are read by core today:

| Surface | Read by |
|---------|---------|
| `eventHandlers` | `extensionRegistry.register()`, which subscribes each handler to the event bus |
| `apiRoutes` | The dispatcher at `app/api/extensions/ext/[...path]/route.ts` |
| `services` | Core callers through `extensionRegistry.get(id)?.services` or `extensionRegistry.getAll()` |
| `settingsPanel`, `sidebarItems`, `routes`, `reportTypes`, `taxCodes`, `dimensionTypes`, `mappingRuleTypes`, `onInstall`, `onUninstall` | Declared in the type, but no core code reads them. Settings UI is wired separately, see [UI](#ui). |

A minimal event-handler extension, abridged from `extensions/general/example-logger/index.ts`:

```ts
import type { Extension } from '@/lib/extensions/types'
import type { EventPayload } from '@/lib/events/types'

export const exampleLoggerExtension: Extension = {
  id: 'example-logger',
  name: 'Example Logger',
  version: '0.1.0',
  eventHandlers: [
    {
      eventType: 'journal_entry.committed',
      handler: async (payload: EventPayload<'journal_entry.committed'>) => {
        console.log(`[example-logger] committed ${payload.entry.voucher_series}${payload.entry.voucher_number}`)
      },
    },
  ],
}
```

`example-logger` has no `manifest.json`, so it cannot be enabled as-is. Add a manifest before listing it in the config.

## ExtensionContext

Built by `createExtensionContext()` in `lib/extensions/context-factory.ts`:

```ts
interface ExtensionContext {
  userId: string
  companyId: string
  extensionId: string
  requestId?: string          // req_<uuid>, set by the API dispatcher only
  supabase: SupabaseClient    // the request's user-scoped client, RLS applies
  emit(event: CoreEvent): Promise<void>
  settings: ExtensionSettings // get<T>(key?), set<T>(key, value), clear(key)
  storage: ExtensionStorage   // download, upload, getPublicUrl (Supabase Storage)
  log: ExtensionLogger        // info, warn, error; logger ext:<id> bound to user/company/request ids
  services: ExtensionServices // core services, see below
}
```

**Settings storage.** `ctx.settings` reads and writes the `extension_data` table. There is one row per `(company_id, extension_id, key)`, which is the table's unique constraint, and `extension_id` is the bare extension id. `get()` with no key reads the key `settings`. `set()` upserts and throws on error. To remove a value, call `clear(key)`: `set(key, null)` fails against the NOT NULL `value` column.

**Core services (core to extension).** `ctx.services` exposes `ingestTransactions`, `getCashAccounts` and `getPrimaryCashAccount`. Use them instead of reaching into core internals that another extension may also depend on.

## Event handlers

- **Delivery:** the bus (`lib/events/bus.ts`) runs all handlers for an event concurrently with `Promise.allSettled`. A rejected handler is logged and never fails the emitter.
- **Payload types:** event names and payloads live in `lib/events/types.ts`. Type payloads with `EventPayload<'<event>'>`.
- **ctx may be missing:** the registry builds `ctx` when the event fires, from `createClient()` and the payload's `userId` and `companyId`. When that fails (no `userId`, or no request scope), the handler receives `ctx === undefined`, so always handle that case. An event emitted from a cron job or webhook may also carry a client without a signed-in user.
- **Initialization:** handlers are subscribed only after `ensureInitialized()` (`lib/init.ts`) has run in the process, since that function calls `loadExtensions()`. Any route that emits events, or that looks up extensions in the registry, must call `ensureInitialized()` at module level. Otherwise events go nowhere and `extensionRegistry.get()` returns `undefined`.

## API routes

Routes declared in `apiRoutes` are served at `/api/extensions/ext/<id>/<routePath>`. A pattern segment `:name` matches one path segment and reaches the handler as the query param `_name`. Segment counts must match exactly, and the first route with a matching method and pattern wins.

```ts
import { NextResponse } from 'next/server'
import type { ApiRouteDefinition } from '@/lib/extensions/types'

export const myExtensionApiRoutes: ApiRouteDefinition[] = [
  {
    method: 'GET',
    path: '/items/:id',
    handler: async (request, ctx) => {
      const id = new URL(request.url).searchParams.get('_id')
      const { data } = await ctx!.supabase
        .from('my_table') // placeholder
        .select('*')
        .eq('company_id', ctx!.companyId)
        .eq('id', id)
        .maybeSingle()
      if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      return NextResponse.json({ data })
    },
  },
]
```

The dispatcher processes a request in this order:

1. 404 if the extension is not registered or has no `apiRoutes`.
2. Per-extension runtime flag: `skatteverket` answers 503 with `code: 'EXTENSION_DISABLED'` unless `SKATTEVERKET_ENABLED=true`.
3. 404 if no route matches. A route that sets both `skipAuth` and `skipCompanyContext` gets a 500 (misconfiguration).
4. `skipAuth: true`: the handler is called immediately, with no auth and no `ctx`. Used for OAuth callbacks and inbound webhooks.
5. `requireAuth()`, which also enforces MFA on hosted.
6. `skipCompanyContext: true`: the handler is called without `ctx`. Used for onboarding routes that run before a company exists.
7. The company is resolved, then the paid-capability gate runs from `EXTENSION_REQUIRED_CAPABILITY` in `lib/entitlements/keys.ts`.
8. `ctx` is built and the handler is called.

Every response gets an `X-Request-Id` header. JSON error bodies shaped `{ error: { code } }` also get `error.requestId` injected. The route sets `maxDuration = 300`.

**Physical route files.** Vercel cron targets (`vercel.json`) and some OAuth callbacks are concrete files under `app/api/extensions/<id>/`. That directory may import only its own extension. Its files compile into every build, even when the extension is disabled, so a new route must check `extensionRegistry.get('<id>')` after `ensureInitialized()` and refuse when the extension is absent. `npm run check:guards` enforces both rules through `scripts/checks/extension-route-guards.mjs`.

**Generic data routes.** `app/api/extensions/[sector]/[slug]/data/route.ts` (GET, POST, DELETE) and `.../settings/route.ts` (GET, PATCH) store rows under `extension_id` `<sector>/<slug>` (for example `general/tic`). That is a different row set from `ctx.settings`, which uses the bare id. The client hook `lib/extensions/use-extension-data.ts` calls the data route. For new work, prefer `ctx.settings` behind your own `apiRoutes`.

## Services (extension to core)

Core cannot import extension code, so an extension exposes functions on `services` and core looks them up at runtime. The contract type lives in core, so both sides agree on the signature without core importing the extension. The real example is agent-triggered bank sync:

```ts
// lib/bank-sync/trigger-sync-contract.ts (core): the shared contract
export interface EnableBankingServices {
  triggerConnectionSync: (supabase: SupabaseClient, input: TriggerSyncInput) => Promise<TriggerSyncResult>
}

// extensions/general/enable-banking/index.ts (extension): the provider
export const enableBankingExtension: Extension = {
  id: 'enable-banking',
  // ...
  services: { triggerConnectionSync },
}

// app/api/v1/companies/[companyId]/bank-connections/[connectionId]/sync/route.ts (core): the caller
const services = extensionRegistry.get('enable-banking')?.services as
  | Partial<EnableBankingServices>
  | undefined
if (!services?.triggerConnectionSync) {
  return v1ErrorResponseFromCode('EXTENSION_DISABLED', ctx.log, { requestId: ctx.requestId })
}
const result = await services.triggerConnectionSync(ctx.supabase, { companyId, userId, connectionId, log })
```

Other callers follow the same pattern:

- `lib/extensions/payment-links.ts` scans `extensionRegistry.getAll()` for a `createInvoicePaymentLink` service (provided by `stripe`).
- `lib/skatteverket/declaration-status.ts` resolves a `skatteverket` service.

A related variant is to register an implementation into a core registry when the module loads. The `email` extension calls `registerEmailService()` from `lib/email/service.ts`, whose default is a no-op service; `_example-branding` calls `registerBrandingService()` from `lib/branding/service.ts`.

## UI

**Workspace page.** The component named in the manifest's `workspace` is rendered at `/e/general/<id>` by `app/(dashboard)/e/[sector]/[slug]/page.tsx`:

1. The page checks authentication, then the extension definition (404 if missing).
2. It applies the sandbox and paid-capability gates.
3. `components/extensions/ExtensionWorkspaceLoader.tsx` renders the component inside `ExtensionWorkspaceShell`, with props `{ userId }` (`WorkspaceComponentProps` in `lib/extensions/workspace-registry.tsx`).

An extension without a workspace shows a placeholder instead.

**Marketplace.** The pages are `app/(dashboard)/extensions/page.tsx`, `[sector]/page.tsx` and `[sector]/[extension]/page.tsx`. The sidebar lists an extension only when it has both a workspace and `definition.quickAction.href`, ordered by `quickAction.order` (`getExtensionNavItems()` in `lib/extensions/sectors.ts`).

**Settings panels.** Register the component by hand in `lib/extensions/settings-panel-registry.tsx`, as a `next/dynamic` import keyed by extension id. Core pages render it with `getSettingsPanel('<id>')`, for example `app/(dashboard)/import/page.tsx` and `components/settings/sections/BankingSettingsContent.tsx`. The panel usually loads and saves through the extension's own `apiRoutes`.

**Strings.** Manifest names and descriptions are Swedish. Translated names come from `lib/extensions/i18n.ts`, which maps slugs to keys in the `extensions` namespace of `messages/sv.json` and `messages/en.json`, falling back to the manifest. Put new UI strings in both message files.

## Whitelabel forks

`extensions/general/_example-branding/` is a starter for forks:

1. Copy it to a new directory.
2. Set the id, `exportName` and `entryPoint` in its manifest, and the brand values in `index.ts`.
3. Add the new id string to the `extensions` array in `extensions.config.json`.

See [WHITELABEL.md](WHITELABEL.md) for the full checklist.

## Testing

Tests live in `extensions/general/<id>/__tests__/`. Run them with `npx vitest run extensions/general/<id>`. Helpers come from `tests/helpers.ts` (`createMockSupabase()`, `createQueuedMockSupabase()`, `createMockRequest()`, fixture factories).

- **Event handlers.** Import the Extension object and take the handler from `eventHandlers`. Mock the modules it touches, typically `@/lib/supabase/server`, then call it with a payload. Example: `extensions/general/document-extraction/__tests__/handler.test.ts`.
- **API routes.** Find the route in `apiRoutes`, build a `Request` and a hand-made `ExtensionContext`, and call `route.handler(request, ctx)`. Example: `extensions/general/enable-banking/__tests__/capability-gate.test.ts`.
- **Registry and dispatcher.** These are covered by `lib/extensions/__tests__/registry.test.ts` and `app/api/extensions/ext/[...path]/__tests__/route.test.ts`.
- **Suite hygiene.** Tests that go through the bus should call `vi.clearAllMocks()` and `eventBus.clear()` in `beforeEach`.

## Common mistakes

1. **Editing `lib/extensions/_generated/` by hand.** The next `setup:extensions` run overwrites it.
2. **Changing a manifest or the config without regenerating.** Run `npm run setup:extensions` after the change, otherwise the registry is stale.
3. **Importing `@/extensions/` from core.** This includes `lib/`, `app/api/` outside `app/api/extensions/`, `components/` outside `components/extensions/`, and `types/index.ts`.
4. **Assuming `ctx` exists.** It can be undefined in event handlers, and it is always undefined for `skipAuth` and `skipCompanyContext` routes.
5. **Calling `settings.set(key, null)`.** Use `settings.clear(key)`.
6. **Forgetting `ensureInitialized()`.** Routes that emit events or read the registry need it at module level.
7. **Scaffolding with a sector other than `general`**, or following steps 4 and 5 of the `create-extension` output.
8. **Adding a file under `app/api/extensions/<id>/` without the registry gate**, or importing another extension from it.
9. **Writing journal entries directly** instead of through `lib/bookkeeping/engine.ts`.
