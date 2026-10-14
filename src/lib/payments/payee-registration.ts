/**
 * The payee check at registration (lib/payments/payee-alerts.ts): what a new
 * supplier invoice states, compared with the supplier card before any create
 * path touches the card. Its own module because it validates the document's
 * details with the supplier backfill's rules, which the client-reachable
 * worklist must not import.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { statedPayeeColumns, type StatedPayeeColumns, type SupplierPaymentDetails } from '@/lib/supplier-invoices/payment-details-backfill'
import { CARD_PAYEE_COLUMNS, loadPaidSuppliers } from './payee-alerts'
import { classifyPayeeChange, payeeAlertFor, type CardPayeeSource, type PayeeAlert } from './payee-change'

export interface RegisteredPayeeAssessment {
  /** The supplier_invoices.payee_* columns: what the document states, validated. */
  stated: StatedPayeeColumns
  /** Set when the invoice alerts; the caller then leaves the supplier card alone. */
  alert: PayeeAlert | null
  /** Whether the card may take the document's details the card lacks (the backfill). */
  backfill: boolean
}

/**
 * What a new invoice states, compared with the supplier card BEFORE the
 * card is touched. A decision already on file for the account does not
 * reopen the backfill: a person who confirmed an account without putting it
 * on the card chose to keep the card as it is.
 */
export async function assessRegisteredPayee(
  supabase: SupabaseClient,
  companyId: string,
  supplierId: string,
  details: SupplierPaymentDetails | null | undefined,
): Promise<RegisteredPayeeAssessment> {
  const stated = statedPayeeColumns(details)
  const statedAny = Boolean(stated.payee_bankgiro || stated.payee_plusgiro || stated.payee_iban)
  if (!statedAny) return { stated, alert: null, backfill: true }
  const { data: card, error } = await supabase
    .from('suppliers')
    .select(CARD_PAYEE_COLUMNS)
    .eq('id', supplierId)
    .eq('company_id', companyId)
    .maybeSingle()
  // Never stops a registration: without the card nothing can be compared, and
  // the payment paths compare again before any money moves.
  if (error || !card) return { stated, alert: null, backfill: true }
  const change = classifyPayeeChange({ invoice: stated, card: card as CardPayeeSource })
  if (change.kind !== 'changed' && change.kind !== 'new_supplier_account') return { stated, alert: null, backfill: true }
  let paid = false
  if (change.kind === 'new_supplier_account') {
    try {
      paid = (await loadPaidSuppliers(supabase, companyId, [supplierId], new Set())).has(supplierId)
    } catch {
      paid = false
    }
  }
  const alert = payeeAlertFor(change.kind, paid)
  return { stated, alert, backfill: alert === null }
}

/** The warning a registration that alerts carries, for the person booking the invoice. */
export function payeeAlertWarning(alert: PayeeAlert): { code: string; message_sv: string; message_en: string } {
  return alert === 'changed'
    ? {
        code: 'SUPPLIER_PAYEE_CHANGED',
        message_sv:
          'Fakturan anger andra bankuppgifter än leverantörskortet. Betalningen är spärrad tills någon har godkänt de nya uppgifterna under Att göra.',
        message_en:
          'The invoice states different bank details than the supplier card. Payment is held until someone approves the new details under Att göra.',
      }
    : {
        code: 'SUPPLIER_PAYEE_NEW',
        message_sv:
          'Fakturan anger bankuppgifter för en leverantör ni redan har betalat utan sådana på kortet. Betalningen är spärrad tills någon har godkänt dem under Att göra.',
        message_en:
          'The invoice states bank details for a supplier you have paid before without any on its card. Payment is held until someone approves them under Att göra.',
      }
}
