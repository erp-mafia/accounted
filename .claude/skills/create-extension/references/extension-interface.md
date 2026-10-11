# Extension Interface Reference

Source: `lib/extensions/types.ts`

## Extension Interface

```typescript
interface Extension {
  id: string; name: string; version: string; sector?: SectorSlug
  apiRoutes?: ApiRouteDefinition[]
  eventHandlers?: ExtensionEventHandler[]
  services?: Record<string, (...args: any[]) => Promise<any>>
}
```

All three surfaces are optional, and core reads each of them. There is no install or uninstall hook. Settings panels are registered in `lib/extensions/settings-panel-registry.tsx`, not on the extension object.

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
```

## ExtensionContext

```typescript
interface ExtensionContext {
  userId: string; companyId: string; extensionId: string; requestId?: string
  supabase: SupabaseClient
  emit(event: CoreEvent): Promise<void>
  settings: { get<T>(key?: string): Promise<T | null>; set<T>(key: string, value: T): Promise<void> }
  log: { info(msg, ...args); warn(msg, ...args); error(msg, ...args) }  // Prefixed ext:{id}
  services: {
    ingestTransactions(supabase, companyId, userId, raw, options?): Promise<IngestResult>
  }
}
```

Settings are stored in the `extension_data` table, scoped per company: upsert key `(company_id, extension_id, key)`.

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

**Level 3: Service provider** (registers a core interface at module load, or exposes named functions core resolves through the registry; see [Services](services-patterns.md)):
```typescript
registerEmailService(createEmailService())  // extensions/general/email/index.ts

export const myExtensionExtension: Extension = {
  id: 'my-extension', name: 'My Extension', version: '1.0.0',
  services: { triggerSomething },
}
```

**Level 4: Full extension** (events + API + settings; illustrative, no `receipt-ocr` extension ships):
```typescript
export const receiptOcrExtension: Extension = {
  id: 'receipt-ocr', name: 'Receipt OCR', version: '1.0.0', sector: 'general',
  apiRoutes: receiptOcrApiRoutes,
  eventHandlers: [
    { eventType: 'document.uploaded', handler: handleDocumentUploaded },
    { eventType: 'transaction.synced', handler: handleTransactionSynced },
  ],
}
```
