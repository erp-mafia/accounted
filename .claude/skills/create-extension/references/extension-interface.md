# Extension Interface Reference

Source: `lib/extensions/types.ts`

## Extension Interface

```typescript
interface Extension {
  id: string; name: string; version: string; sector?: SectorSlug
  routes?: RouteDefinition[]
  apiRoutes?: ApiRouteDefinition[]
  sidebarItems?: SidebarItem[]
  eventHandlers?: ExtensionEventHandler[]
  mappingRuleTypes?: MappingRuleTypeDefinition[]
  reportTypes?: ReportDefinition[]
  settingsPanel?: SettingsPanelDefinition
  taxCodes?: TaxCodeDefinition[]
  dimensionTypes?: DimensionDefinition[]
  services?: Record<string, (...args: any[]) => Promise<any>>
  onInstall?(ctx: ExtensionContext): Promise<void>
  onUninstall?(ctx: ExtensionContext): Promise<void>
}
```

All surfaces are optional. An extension can provide any combination.

## Key Supporting Types

```typescript
interface ApiRouteDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  path: string  // e.g., "/:id/confirm"
  handler: (request: Request, ctx?: ExtensionContext) => Promise<Response>
}

interface ExtensionEventHandler {
  eventType: CoreEventType
  handler: (payload: any, ctx?: ExtensionContext) => Promise<void> | void
}

interface SidebarItem { label: string; icon?: string; path: string; order?: number }
interface SettingsPanelDefinition { label: string; path: string }
interface MappingRuleTypeDefinition { id: string; name: string; description: string }
interface RouteDefinition { path: string; label: string }
```

## ExtensionContext

```typescript
interface ExtensionContext {
  userId: string; extensionId: string; supabase: SupabaseClient
  emit(event: CoreEvent): Promise<void>
  settings: { get<T>(key?: string): Promise<T | null>; set<T>(key: string, value: T): Promise<void> }
  storage: { download(bucket, path); upload(bucket, path, data, options?); getPublicUrl(bucket, path) }
  log: { info(msg, ...args); warn(msg, ...args); error(msg, ...args) }  // Prefixed ext:{id}
  services: { ingestTransactions(supabase, userId, raw): Promise<IngestResult> }
}
```

Settings stored in `extension_data` table with composite key `(user_id, extension_id, key)`.

## Complexity Spectrum

**Level 1: Pure UI** (no surfaces, workspace reads core data):
```typescript
export const calendarExtension: Extension = { id: 'calendar', name: 'Kalender', version: '1.0.0' }
```

**Level 2: Event handler only:**
```typescript
export const loggerExtension: Extension = {
  id: 'example-logger', name: 'Logger', version: '1.0.0',
  eventHandlers: [{ eventType: 'journal_entry.committed', handler: handleCommitted }],
}
```

**Level 3: Service provider** (registers at module load):
```typescript
registerEmailService(new ResendEmailService())
export const emailExtension: Extension = { id: 'email', name: 'Email', version: '1.0.0' }
```

**Level 4: Full extension** (events + API + settings + mappingRules + onInstall):
```typescript
export const receiptOcrExtension: Extension = {
  id: 'receipt-ocr', name: 'Receipt OCR', version: '1.0.0', sector: 'general',
  apiRoutes: receiptOcrApiRoutes,
  eventHandlers: [
    { eventType: 'document.uploaded', handler: handleDocumentUploaded },
    { eventType: 'transaction.synced', handler: handleTransactionSynced },
  ],
  mappingRuleTypes: [{ id: 'receipt-ocr-merchant', name: 'OCR Merchant Match', description: '...' }],
  settingsPanel: { label: 'Receipt OCR', path: '/settings/extensions/receipt-ocr' },
  async onInstall(ctx) { await ctx.settings.set('settings', DEFAULT_SETTINGS) },
}
```
