/**
 * The purchase category of an invoice-inbox item, set by a person through the
 * v1 door, or proposed over MCP (gnubok_set_inbox_purchase_category) and set
 * when a person approves it. The rules live in
 * lib/documents/inbox-purchase-category.ts, shared with the dashboard route;
 * the read side (purchase_category on GET /inbox-items/{id}) is
 * lib/categories/inbox-purchase-category.ts.
 *
 * Over MCP the write stages a pending operation of type
 * set_inbox_purchase_category (migration 20261017030000 adds it to the
 * pending_operations CHECK); the approval runs this run(), the same service
 * call the v1 PUT makes, and a rejection runs nothing. A staged every_time
 * pins the matched supplier (expected_supplier_id): the approval writes the
 * instruction to the supplier the card named, or nothing. The stored choice
 * says set_via 'approval'. The tool is search-only, so it costs nothing in
 * tools/list.
 */
import { z } from 'zod'
import { InboxPurchaseCategorySchema } from '@/lib/categories/inbox-purchase-category'
import {
  setInboxItemPurchaseCategory,
  SetInboxPurchaseCategorySchema,
} from '@/lib/documents/inbox-purchase-category'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

/**
 * The params a staged every_time is approved with: the input plus the
 * supplier its dry run would instruct (preview.supplier_id), so the commit
 * refuses when the item has been matched to another one since. Without
 * every_time the supplier is not written, so nothing is pinned. Pure.
 */
export function pinMatchedSupplier(input: Record<string, unknown>, preview: Record<string, unknown>): Record<string, unknown> {
  if (input.every_time !== true || typeof preview.supplier_id !== 'string') return input
  return { ...input, expected_supplier_id: preview.supplier_id }
}

/**
 * The approver's one-line title, in Swedish: what changes, on which underlag
 * (by the supplier its reading names, from the dry run's preview) and whether
 * it holds every time. The category itself is named on the card, in the
 * approver's language.
 */
export function setPurchaseCategoryTitle(input: Record<string, unknown>, preview?: Record<string, unknown>): string {
  const change = input.code === null ? 'Ta bort vald kategori' : 'Ändra kategori'
  const supplier = typeof preview?.supplier_name === 'string' && preview.supplier_name ? preview.supplier_name : null
  const target = supplier ? `för underlag från ${supplier}` : 'för inkorgspost'
  return input.every_time === true ? `${change} ${target}, varje gång` : `${change} ${target}`
}

export const inboxItemsSetPurchaseCategory = defineOperation({
  id: 'inbox-items.set-purchase-category',
  kind: 'write',
  scope: 'documents:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Set, or clear, what an inbox item bought (its purchase category).',
    description:
      'Stores the given purchase-category code on the item as a person\'s choice, which the item then reads as purchase_category with source person and level "Ditt val". code null clears the choice, and the item reads the computed proposal again. every_time true also makes it the instruction for the item\'s matched supplier: later items from that supplier read it as source instruction, level "Ditt val", under any choice made on a single item and over the learned proposal (with code null it removes the instruction). Answers what the item reads after the write. Books nothing: the account stays the booking\'s. Idempotent. Dry-runnable.',
    useWhen:
      'The proposed purchase category is wrong or missing, and the person says what was bought; with every_time, when they say it holds for everything from that supplier.',
    doNotUseFor:
      'Choosing the account a purchase is booked on (that is the booking), or correcting the reading\'s fields (PATCH /inbox-items/{id}).',
    pitfalls: [
      'An item already converted to a supplier invoice returns 409 INBOX_ITEM_EDIT_LOCKED.',
      'An item with no reading of its own yet returns 409 INBOX_ITEM_NO_READING.',
      'every_time on an item without a matched supplier returns 409 INBOX_ITEM_NO_SUPPLIER and writes nothing.',
      'A concurrent edit returns 409 INBOX_ITEM_EDIT_CONFLICT: read the item again and retry.',
      'expected_supplier_id given and the item now matched to another supplier (or none) returns 409 INBOX_ITEM_SUPPLIER_CHANGED and writes nothing.',
      'Codes are the purchase-category taxonomy\'s (e.g. "expense.software.saas", "expense.equipment.furniture"); anything else is 400.',
    ],
    example: {
      request: { code: 'expense.equipment.furniture', every_time: true },
      response: {
        data: {
          inbox_item_id: '1b2c…',
          purchase_category: { code: 'expense.equipment.furniture', source: 'person', level: 'Ditt val', version: 'pc-2026-10' },
        },
        meta: META,
      },
    },
  },
  input: SetInboxPurchaseCategorySchema.extend({
    inbox_item_id: z.string().uuid().describe('The inbox item id (inbox_item_id from the list).'),
    expected_supplier_id: z
      .string()
      .uuid()
      .optional()
      .describe(
        'Precondition: the supplier the item must still be matched to (matched_supplier_id). Any other match refuses with INBOX_ITEM_SUPPLIER_CHANGED and writes nothing. A staged every_time pins it.',
      ),
  }),
  output: z.object({
    inbox_item_id: z.string().uuid(),
    purchase_category: InboxPurchaseCategorySchema.nullable(),
  }),
  errorCodes: [
    'INBOX_ITEM_NOT_FOUND',
    'INBOX_ITEM_EDIT_LOCKED',
    'INBOX_ITEM_NO_READING',
    'INBOX_ITEM_NO_SUPPLIER',
    'INBOX_ITEM_SUPPLIER_CHANGED',
    'INBOX_ITEM_EDIT_CONFLICT',
  ],
  http: {
    method: 'PUT',
    path: '/api/v1/companies/:companyId/inbox-items/:id/purchase-category',
    pathParams: { id: 'inbox_item_id' },
  },
  mcp: {
    name: 'gnubok_set_inbox_purchase_category',
    title: 'Set Inbox Purchase Category',
    description:
      'Stage what an inbox item bought: a purchase-category code (gnubok_list_purchase_categories), or null to clear the choice. every_time also makes it the matched supplier\'s instruction for later items. Books nothing: the account stays the booking\'s.',
    keywords: ['inköpskategori', 'ändra kategori', 'vad köptes', 'kategori underlag', 'varje gång', 'purchase category'],
    hints: { idempotent: true },
    stage: {
      pendingType: 'set_inbox_purchase_category',
      title: setPurchaseCategoryTitle,
      // The card names the supplier the instruction lands on: the approval
      // writes to that supplier or nothing.
      pinParams: pinMatchedSupplier,
    },
  },
  run: async (ctx, { inbox_item_id, code, every_time, expected_supplier_id }, { dryRun }) => {
    const outcome = await setInboxItemPurchaseCategory(ctx, inbox_item_id, code, {
      // An approved proposal says so on the stored choice; v1 is the api door.
      via: ctx.pendingOperationId ? 'approval' : 'api',
      everyTime: every_time,
      expectedSupplierId: expected_supplier_id,
      dryRun,
    })
    if (!outcome.ok || outcome.dryRun) return outcome
    return { ok: true, data: { inbox_item_id: outcome.data.id, purchase_category: outcome.data.purchase_category } }
  },
})
