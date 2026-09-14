---
name: create-extension
description: "Generate and implement extensions for Accounted: scaffold files, configure manifests, write event handlers, API routes, services, workspace UIs, settings panels, and testing. Use when creating new extensions, adding surfaces to existing extensions, or understanding the extension architecture. Covers the full lifecycle from scaffolding to registration."
---

# Extension Generator

## Quick Start

**1. Scaffold:**
```bash
npx tsx scripts/create-extension.ts \
  --name my-extension --sector general --category operations \
  --description "Short description"
```
Sector: `general` (`SectorSlug` in `lib/extensions/types.ts` accepts only `general`; the script still offers other sectors, which fail type-checking)
Categories: `import`, `operations`, `reports`, `accounting`

**2. Enable**: add `"my-extension"` to `extensions.config.json`

**3. Regenerate**: `npm run setup:extensions` (auto-runs on `dev`/`build`)

**4. Implement**: edit `index.ts` to add surfaces

---

## Extension Object Template

```typescript
import type { Extension, ExtensionContext } from '@/lib/extensions/types'
import type { EventPayload } from '@/lib/events/types'
import { myExtApiRoutes } from './api-routes'

interface MyExtSettings { featureEnabled: boolean; threshold: number }
const DEFAULT_SETTINGS: MyExtSettings = { featureEnabled: true, threshold: 0.8 }

async function handleSomeEvent(
  payload: EventPayload<'transaction.synced'>, ctx?: ExtensionContext
): Promise<void> {
  const { transactions, userId } = payload
  const log = ctx?.log ?? console
  const settings = ctx
    ? { ...DEFAULT_SETTINGS, ...(await ctx.settings.get<Partial<MyExtSettings>>() || {}) }
    : DEFAULT_SETTINGS
  if (!settings.featureEnabled) return

  try {
    const supabase = ctx?.supabase ?? await (await import('@/lib/supabase/server')).createClient()
    // ... business logic ...
  } catch (error) { log.error('Handler failed:', error) }
}

export const myExtensionExtension: Extension = {
  id: 'my-extension',
  name: 'My Extension',
  version: '1.0.0',
  sector: 'general',
  apiRoutes: myExtApiRoutes,
  eventHandlers: [
    { eventType: 'transaction.synced', handler: handleSomeEvent },
  ],
}
```

Export name convention: `{camelCaseId}Extension` (e.g., `myExtensionExtension`).

---

## Manifest (Minimal)

```json
{
  "id": "my-extension",
  "sector": "general",
  "exportName": "myExtensionExtension",
  "entryPoint": "@/extensions/general/my-extension",
  "workspace": null,
  "requiredEnvVars": [],
  "optionalEnvVars": [],
  "npmDependencies": [],
  "definition": {
    "name": "My Extension",
    "category": "operations",
    "icon": "Box",
    "dataPattern": "core",
    "description": "Short marketplace description",
    "longDescription": "Longer detail page description."
  }
}
```

For a workspace page, set `"workspace": "@/components/extensions/general/MyExtensionWorkspace"`. See **[Manifest Reference](references/manifest-format.md)**.

## Extension Context

```typescript
interface ExtensionContext {
  userId: string; companyId: string; extensionId: string
  supabase: SupabaseClient         // Pre-authenticated
  emit(event: CoreEvent): Promise<void>  // Publish core events
  settings: ExtensionSettings      // get<T>(key?) / set<T>(key, value): extension_data, per company
  storage: ExtensionStorage        // download / upload / getPublicUrl
  log: ExtensionLogger             // info / warn / error (scoped)
  services: ExtensionServices      // Core services (e.g., ingestTransactions)
}
```

## Available Surfaces

| Surface | Reference |
|---------|-----------|
| `eventHandlers`: react to core events | [Event Handlers](references/event-handlers.md) |
| `apiRoutes`: HTTP endpoints | [API Routes](references/api-routes.md) |
| `services`: named functions for core | [Services](references/services-patterns.md) |
| Workspace UI and settings panel (manifest `workspace`, `lib/extensions/settings-panel-registry.tsx`) | [Workspace & UI](references/workspace-ui.md) |
| Other fields on the type (`settingsPanel`, `sidebarItems`, `mappingRuleTypes`, `onInstall`, ...) are declared but not read by core | [Extension Interface](references/extension-interface.md) |

## Common Mistakes

1. **Forgetting `npm run setup:extensions`** after config change: extension won't load
2. **Editing `_generated/` files**: overwritten on next setup
3. **Not handling `ctx = undefined`**: context is undefined in cron jobs; always fallback
4. **Wrong export name**: must match `exportName` in manifest exactly
5. **Importing from other extensions**: only import from core (`@/lib/`, `@/types`)
6. **Lazy imports in module scope**: static imports for extension code; `await import()` only inside handler functions
