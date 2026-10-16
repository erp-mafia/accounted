# Testing Extensions

Vitest, same patterns as core. Tests colocated in `__tests__/` next to extension files.

## Setup

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

beforeEach(() => { vi.clearAllMocks(); eventBus.clear() })
```

`lib/init` is stubbed for every unit test (`tests/unit/setup.ts`, which also registers the init loader that `src/instrumentation.ts` registers in the app), so the first `eventBus.emit()` or registry read loads no real extension: a test sees only the handlers it registers. The bus and the registries are process-wide (`src/lib/global-singleton.ts`): a test that calls `vi.resetModules()` for fresh state calls `resetGlobalSingletons()` too.

## Mock Context

```typescript
const mockCtx: ExtensionContext = {
  userId: 'user-123', companyId: 'company-123', extensionId: 'my-extension',
  supabase: createMockSupabase() as any,
  emit: vi.fn().mockResolvedValue(undefined),
  settings: { get: vi.fn().mockResolvedValue({ featureEnabled: true }), set: vi.fn(), clear: vi.fn() },
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  services: { ingestTransactions: vi.fn() },
}
```

## Testing Event Handlers

```typescript
it('should process events', async () => {
  const handler = myExt.eventHandlers!.find(h => h.eventType === 'transaction.synced')!.handler
  await handler({ transactions: [makeTransaction()], userId: 'user-123', companyId: 'company-123' }, mockCtx)
  expect(mockCtx.supabase.from).toHaveBeenCalled()
})

it('should skip when disabled', async () => {
  mockCtx.settings.get = vi.fn().mockResolvedValue({ featureEnabled: false })
  const handler = myExt.eventHandlers!.find(h => h.eventType === 'transaction.synced')!.handler
  await handler({ transactions: [], userId: 'user-123', companyId: 'company-123' }, mockCtx)
  expect(mockCtx.supabase.from).not.toHaveBeenCalled()
})
```

## Testing API Routes

```typescript
const handler = myExtApiRoutes.find(r => r.method === 'GET' && r.path === '/')!.handler
const request = createMockRequest('GET', '/api/extensions/ext/my-extension/')
const response = await handler(request, mockCtx)
expect(response.status).toBe(200)
```

## Test Helpers (`tests/helpers.ts`)

`createMockSupabase()`, `createQueuedMockSupabase()`, `createMockRequest(method, url, body?)`, `parseJsonResponse(response)`, `makeTransaction()`, `makeJournalEntry()`, `makeInvoice()`, `makeCustomer()`, `makeSupplier()`, `makeReceipt()`, `makeDocumentAttachment()`, `makeCompanySettings()`

## Running

```bash
npm test                                          # All tests
npx vitest run extensions/general/my-extension    # Specific extension
```
