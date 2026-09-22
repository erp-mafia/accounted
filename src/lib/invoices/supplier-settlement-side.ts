/**
 * Which line of a posted verifikat settles a supplier invoice.
 *
 * The rule is NOT written here. It lives once, in the SQL function
 * `supplier_invoice_settlement_side` (migration 20260921190300), and the
 * `link_supplier_invoice_to_voucher` RPC reads the very same function. The
 * candidate matcher and the pre-stage validator ask it through this module, so
 * what the screen offers and what the RPC accepts cannot drift apart again
 * (issue #2854: the supplier side stayed 244x-only for three months after the
 * customer side learned kontantmetoden, because each copy decided on its own).
 *
 *   ap_debit     the 244x debit. Faktureringsmetoden, and any invoice that
 *                carries a registration verifikat (its skuld sits on 244x).
 *   bank_credit  the 19xx credit. A kontantmetod company's invoice with no
 *                registration verifikat: the voucher that moved the money,
 *                Dr cost, Dr 2641 / Cr 19xx, IS the whole booking.
 *
 * The function takes the invoice id and reads the row itself, on purpose:
 * every caller builds its own narrow invoice projection, and a projection that
 * happened to leave out registration_journal_entry_id must not be able to flip
 * the side.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

const log = createLogger('supplier-settlement-side')

export type SupplierSettlementSideName = 'ap_debit' | 'bank_credit'

export interface SupplierSettlementSide {
  side: SupplierSettlementSideName
  /** BAS account prefix of the settlement line: '244' or '19'. */
  accountPrefix: string
  /** Which ledger column carries the settlement amount. */
  entrySide: 'debit' | 'credit'
}

/** The side every supplier invoice had before 20260921190300. Also the answer
 *  when the function cannot be read: the historical behaviour, never a guess
 *  at the weaker discriminator. */
export const AP_DEBIT_SIDE: SupplierSettlementSide = {
  side: 'ap_debit',
  accountPrefix: '244',
  entrySide: 'debit',
}

interface SettlementSideRow {
  settlement_side?: string | null
  account_prefix?: string | null
  entry_side?: string | null
}

export async function resolveSupplierSettlementSide(
  supabase: SupabaseClient,
  companyId: string,
  supplierInvoiceId: string,
): Promise<SupplierSettlementSide> {
  const { data, error } = await supabase
    .rpc('supplier_invoice_settlement_side', {
      p_supplier_invoice_id: supplierInvoiceId,
      p_company_id: companyId,
    })
    .maybeSingle()

  const row = data as SettlementSideRow | null
  const known =
    (row?.settlement_side === 'ap_debit' || row?.settlement_side === 'bank_credit') &&
    typeof row.account_prefix === 'string' &&
    row.account_prefix.length > 0 &&
    (row.entry_side === 'debit' || row.entry_side === 'credit')

  if (error || !row || !known) {
    // A kontantmetod company would silently get the 244x search and an empty
    // candidate list: make the fallback visible so it is diagnosable.
    log.warn('settlement side unavailable; falling back to the 244x debit', {
      companyId,
      supplierInvoiceId,
      message: error?.message,
    })
    return AP_DEBIT_SIDE
  }

  return {
    side: row.settlement_side as SupplierSettlementSideName,
    accountPrefix: row.account_prefix as string,
    entrySide: row.entry_side as 'debit' | 'credit',
  }
}
