# Service Integration Patterns

Three ways extension code and core call each other without core importing from `@/extensions/` (CI builds core with zero extensions enabled).

## Pattern A: Interface registration (extension replaces a core default)

Core owns the interface and a default implementation; the extension registers its implementation at module load. Best for single-implementation services.

```typescript
// Core: src/lib/email/service.ts
export function registerEmailService(svc: EmailService): void

// Extension, module scope: src/extensions/general/email/index.ts
registerEmailService(createEmailService())
```

Branding works the same way: `registerBrandingService(partial)` in `src/lib/branding/service.ts`, read through `getBranding()` (see `src/extensions/general/_example-branding/index.ts`).

## Pattern B: Services record (extension to core)

The extension exposes named functions on `services`; core resolves them through the registry at runtime and treats a missing registration as "this deployment does not offer the feature". The contract type lives in core so both sides agree on the signature.

```typescript
// Extension: src/extensions/general/enable-banking/index.ts
services: {
  // Contract: src/lib/bank-sync/trigger-sync-contract.ts
  triggerConnectionSync,
},

// Core caller: src/app/api/v1/companies/[companyId]/bank-connections/[connectionId]/sync/route.ts
const services = extensionRegistry.get('enable-banking')?.services as
  | Partial<EnableBankingServices>
  | undefined
if (!services?.triggerConnectionSync) {
  return v1ErrorResponseFromCode('EXTENSION_DISABLED', ctx.log, { requestId: ctx.requestId })
}
const result = await services.triggerConnectionSync(ctx.supabase, { companyId, userId, connectionId, log })
```

Lazy `await import()` belongs inside service functions only, never at module scope.

## Pattern C: Core services for extensions (core to extension)

Extensions consume core services through `ctx.services` instead of importing core internals directly:

```typescript
const ingestFn = ctx?.services.ingestTransactions
```
