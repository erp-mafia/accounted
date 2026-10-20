import type { EventPayload } from '@/lib/events/types'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createLogger } from '@/lib/logger'
import { followReceiptsOfSupplierInvoice } from '@/lib/operations/inbox-companion'

const log = createLogger('events/inbox-companion')

/**
 * The receipt follows its invoice onto the payment: a supplier invoice
 * registered from an inbox item that came with its receipt as one purchase
 * (lib/inkorg/pairs.ts) was settled against a bank row, so the receipt, kept
 * as the invoice's companion while it was unpaid, becomes an underlag of the
 * payment's verifikat (lib/operations/inbox-companion.ts). Every settling
 * door emits supplier_invoice.match_confirmed (the dashboard and v1 match,
 * register-and-settle, a signed payment order's debit, a samlingsbetalning),
 * so none of them can leave the receipt in the inbox. Best effort: a failure
 * is logged and never fails the settlement, which is already booked.
 */
export async function followReceiptOnSupplierPayment({
  supplierInvoice,
  companyId,
  userId,
}: EventPayload<'supplier_invoice.match_confirmed'>): Promise<void> {
  if (!companyId || !supplierInvoice?.id) return
  await followReceiptsOfSupplierInvoice(
    { supabase: createServiceClientNoCookies(), companyId, userId, log },
    supplierInvoice.id,
  )
}
