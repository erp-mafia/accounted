/**
 * Invoice-inbox (Underlag) pairing operations: pick the supplier for an
 * inbox item, and pair an item with a bank transaction. Rules live in
 * lib/documents/inbox-match.ts, shared with the invoice-inbox extension's
 * dashboard routes. Releasing a transaction match is
 * inbox-items.unmatch-transaction (./inbox-items.ts).
 *
 * MCP: both stay v1 only, because existing tools already cover what an
 * agent does with them: gnubok_create_supplier_invoice_from_inbox takes the
 * supplier_id to use directly, and gnubok_attach_document_to_transaction
 * pins the item's document (document_id from gnubok_get_inbox_item) on the
 * transaction and marks the item matched.
 */
import { z } from 'zod'
import { matchInboxItemSupplier, matchInboxItemTransaction } from '@/lib/documents/inbox-match'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const INBOX_ITEM_ID = z.string().uuid().describe('The inbox item id (inbox_item_id from GET /inbox-items).')

export const inboxItemsMatchSupplier = defineOperation({
  id: 'inbox-items.match-supplier',
  kind: 'write',
  scope: 'documents:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Set which supplier an inbox item comes from.',
    description:
      'Sets the item\'s matched supplier, the supplier the conversion to a supplier invoice (POST /inbox-items/{id}/convert) uses when the request names none. A hint only: nothing is registered or booked. Picking another supplier later replaces it. Idempotent. Dry-runnable.',
    useWhen:
      'The reading named the supplier ambiguously or not at all, and the right supplier exists in the register (GET /suppliers).',
    doNotUseFor:
      'Creating a supplier (POST /suppliers) or registering the invoice (POST /inbox-items/{id}/convert, which also accepts supplier_id directly).',
    pitfalls: [
      'The supplier must belong to the same company: otherwise 404 SUPPLIER_NOT_FOUND.',
      'An item already converted keeps the supplier its supplier invoice has; this only changes the item\'s hint.',
    ],
    example: {
      request: { supplier_id: '8a9b…' },
      response: { data: { inbox_item_id: '1b2c…', matched_supplier_id: '8a9b…' }, meta: META },
    },
  },
  input: z.object({
    inbox_item_id: INBOX_ITEM_ID,
    supplier_id: z.string().uuid().describe('The supplier id (from GET /suppliers).'),
  }),
  output: z.object({ inbox_item_id: z.string().uuid(), matched_supplier_id: z.string().uuid() }),
  errorCodes: ['INBOX_ITEM_NOT_FOUND', 'SUPPLIER_NOT_FOUND'],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/inbox-items/:id/match-supplier',
    pathParams: { id: 'inbox_item_id' },
  },
  run: async (ctx, { inbox_item_id, supplier_id }, { dryRun }) => {
    const outcome = await matchInboxItemSupplier(ctx, inbox_item_id, supplier_id, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    return { ok: true, data: { inbox_item_id: outcome.data.id, matched_supplier_id: outcome.data.matched_supplier_id } }
  },
})

export const inboxItemsMatchTransaction = defineOperation({
  id: 'inbox-items.match-transaction',
  kind: 'write',
  scope: 'documents:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Pair an inbox item with the bank transaction it documents.',
    description:
      'Sets the item\'s matched transaction and, when the transaction has no document yet, pins the item\'s document on it (an existing pin is never replaced). When the transaction is already booked, the item is completed against that verifikat: the document becomes its underlag. Release with POST /inbox-items/{id}/unmatch-transaction. Idempotent. Dry-runnable.',
    useWhen: 'A receipt or invoice in the inbox belongs to a bank transaction (typically a card purchase) and should travel with it to booking.',
    doNotUseFor:
      'Registering a supplier invoice from the item (POST /inbox-items/{id}/convert) or attaching an arbitrary document to a transaction (POST /transactions/{id}/attach-document).',
    pitfalls: [
      'The transaction must belong to the same company: otherwise 404 TX_CATEGORIZE_TX_NOT_FOUND.',
      'A transaction that already carries another document keeps it (details in the dry run: transaction_has_other_document).',
      'Matching a booked transaction in a locked period links the document best-effort; check the verifikat afterwards.',
    ],
    example: {
      request: { transaction_id: '1f2e…' },
      response: { data: { inbox_item_id: '1b2c…', matched_transaction_id: '1f2e…' }, meta: META },
    },
  },
  input: z.object({
    inbox_item_id: INBOX_ITEM_ID,
    transaction_id: z.string().uuid().describe('The bank transaction id (from GET /transactions).'),
  }),
  output: z.object({ inbox_item_id: z.string().uuid(), matched_transaction_id: z.string().uuid() }),
  errorCodes: ['INBOX_ITEM_NOT_FOUND', 'TX_CATEGORIZE_TX_NOT_FOUND'],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/inbox-items/:id/match-transaction',
    pathParams: { id: 'inbox_item_id' },
  },
  run: async (ctx, { inbox_item_id, transaction_id }, { dryRun }) => {
    const outcome = await matchInboxItemTransaction(ctx, inbox_item_id, transaction_id, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    return {
      ok: true,
      data: { inbox_item_id: outcome.data.id, matched_transaction_id: outcome.data.matched_transaction_id },
    }
  },
})
