# Event Handlers Reference

Extensions subscribe via `eventHandlers`. The bus dispatches with `Promise.allSettled()`: failures are isolated.

## Signature & Registration

```typescript
async function handleSomeEvent(
  payload: EventPayload<'transaction.synced'>, ctx?: ExtensionContext
): Promise<void> { /* ... */ }

export const myExtension: Extension = {
  eventHandlers: [
    { eventType: 'transaction.synced', handler: handleSomeEvent },
  ],
}
```

`ctx.supabase` is the service-role client whichever path emitted the event (dashboard, v1 API key, MCP, webhook, cron): scope every query by `ctx.companyId`. Never open the request's cookie client in a handler: without a session cookie it is the anon role and silently reads nothing. `ctx` can be `undefined` when no context could be built: always provide fallbacks.

## All Event Types

Source: `lib/events/types.ts`. Every payload includes `userId`.

| Event | Payload |
|-------|---------|
| `journal_entry.drafted` | `{ entry: JournalEntry, userId }` |
| `journal_entry.committed` | `{ entry: JournalEntry, userId }` |
| `journal_entry.corrected` | `{ original, storno, corrected: JournalEntry, userId }` |
| `document.uploaded` | `{ document: DocumentAttachment, userId }` |
| `invoice.created` | `{ invoice: Invoice, userId }` |
| `invoice.sent` | `{ invoice: Invoice, userId }` |
| `credit_note.created` | `{ creditNote: CreditNote, userId }` |
| `transaction.synced` | `{ transactions: Transaction[], userId }` |
| `transaction.categorized` | `{ transaction, account, taxCode, userId }` |
| `transaction.reconciled` | `{ transaction, journalEntryId, method, userId }` |
| `period.locked` | `{ period: FiscalPeriod, userId }` |
| `period.year_closed` | `{ period: FiscalPeriod, userId }` |
| `period.lock_date_changed` | `{ previousLockDate, lockDate, direction, via, reopenedFiledVatPeriods, userId }` |
| `customer.created` | `{ customer: Customer, userId }` |
| `receipt.extracted` | `{ receipt, documentId, confidence, userId }` |
| `receipt.matched` | `{ receipt, transaction, confidence, autoMatched, userId }` |
| `supplier_invoice.confirmed` | `{ inboxItem, supplierInvoice, userId }` |

## Standard Handler Pattern

```typescript
async function handleTransactionSynced(
  payload: EventPayload<'transaction.synced'>, ctx?: ExtensionContext
): Promise<void> {
  const { transactions, userId } = payload
  const log = ctx?.log ?? console
  const settings = ctx
    ? { ...DEFAULT_SETTINGS, ...(await ctx.settings.get<Partial<MySettings>>() || {}) }
    : await getSettings(userId)

  if (!settings.featureEnabled) return  // Settings gate

  try {
    // Service role in every emit path (v1, MCP and webhooks carry no session cookie): filter by companyId.
    const supabase = ctx?.supabase ?? createServiceClientNoCookies()
    // Business logic...
    await ctx?.emit({ type: 'receipt.matched', payload: { /* ... */ userId } })
  } catch (error) { log.error('Handler failed:', error) }
}
```

## Key Rules

1. **Handle `ctx = undefined`**: fallback for supabase (`createServiceClientNoCookies()`), logging, settings
2. **Handlers run concurrently**: order undefined, don't depend on other handlers
3. **Use settings gates**: let users control features
4. **Wrap in try/catch**: don't throw unhandled errors
5. **Emit events for cascading pipelines**: e.g., OCR emits `receipt.extracted` → triggers push notifications
