// Pure submit-time checks for supplier invoice line items (issue #863).
// Kept free of React so the rules can be unit-tested and reused.

import { roundOre } from '@/lib/money'
import { normalizeVatRateToFraction } from './vat-rate-unit'

// Only 25/12/6/0 % are legal Swedish VAT rates (ML 2023:200). The supplier
// invoice form stores rates as decimal fractions (0.25 = 25 %); this list is
// also the preset dropdown in the form's VAT rate cell.
// Note on the food rate: livsmedel moved from 12 % to 6 % on 1 April 2026
// (Prop. 2025/26:55, ML 2023:200), and the reduction is currently legislated
// to revert after 31 December 2027; 6 % then remains legal (books, transport)
// but stops being the food rate. This static allow-list cannot express
// per-category temporal validity, so revisit at the reversion date.
export const LEGAL_VAT_RATES: readonly number[] = [0.25, 0.12, 0.06, 0]

export function isLegalVatRate(rate: number): boolean {
  return LEGAL_VAT_RATES.includes(rate)
}

// normalizeVatRateToFraction lives in the import-free leaf module
// vat-rate-unit.ts so extension entry graphs can use it without pulling in
// this file's lib/money dependency; re-exported here so existing callers
// keep their import path.
export { normalizeVatRateToFraction }

/**
 * Normalize a VAT rate that may arrive percent-shaped (25, 12, 6: the AI
 * extraction contract and stale staged pending_operations params) to the
 * decimal-fraction convention used by supplier_invoice_items (0.25, 0.12,
 * 0.06); issue #310. Values above 1 are treated as percent and divided by
 * 100; the result is snapped to the legal Swedish set and anything else
 * (foreign 19/20, non-finite or missing input) maps to 0, mirroring the
 * extraction contract: the strict Swedish allowlist applies when converting
 * to a supplier invoice.
 */
export function normalizeVatRateToDecimal(rate: unknown): number {
  // roundOre is 2-decimal rounding: exactly the snap a decimal fraction of an
  // integer percent needs (25 / 100 must land on the legal-set double).
  const decimal = roundOre(normalizeVatRateToFraction(rate))
  return isLegalVatRate(decimal) ? decimal : 0
}

/**
 * Index of the first line whose VAT rate falls outside the legal Swedish set,
 * or -1 when every line is legal. Reverse charge invoices should skip this
 * check: their line vat_rate is forced to 0 and the self-assessed rate comes
 * from a fixed select that only offers legal rates.
 */
export function findIllegalVatRateRow(
  items: ReadonlyArray<{ vat_rate: number }>,
): number {
  return items.findIndex((item) => !isLegalVatRate(item.vat_rate))
}

/**
 * Indices of lines that look mis-accounted for a reverse charge invoice:
 * omvand skattskyldighet purchases are normally booked on cost accounts
 * (4xxx/5xxx), so a line on a class 1 (assets) or class 6 account is worth a
 * second look. Advisory only, never blocking: class 6 has legitimate reverse
 * charge uses (e.g. 6540 IT-tjanster for EU cloud services).
 *
 * Account numbers are strings (identifiers, not quantities); rows without an
 * account yet are skipped, the separate account-missing check owns those.
 */
export function findReverseChargeAccountWarningRows(
  items: ReadonlyArray<{ account_number: string }>,
): number[] {
  const rows: number[] = []
  items.forEach((item, index) => {
    const account = item.account_number
    if (account && (account.startsWith('1') || account.startsWith('6'))) {
      rows.push(index)
    }
  })
  return rows
}

/** Supplier types whose invoices normally carry no Swedish VAT because the
 *  buyer self-assesses it (omvand skattskyldighet, ML 6 kap). */
const FOREIGN_SUPPLIER_TYPES: readonly string[] = ['eu_business', 'non_eu_business']

/**
 * Indices of 0 %-VAT lines on a FOREIGN supplier invoice where omvand
 * skattskyldighet is switched off (issue #1042).
 *
 * A foreign supplier charging no Swedish VAT is normally a reverse charge
 * purchase: the buyer books both the utgaende and the ingaende moms itself.
 * With the switch off, createSupplierInvoiceRegistrationEntry emits neither
 * the 26x4 output leg nor the 44xx/45xx basis lines, so ruta 20-24, 30-32 and
 * 48 all stay empty and the momsdeklaration takes the shape Skatteverket
 * rejects (a ruta 30 amount with no matching ruta 20 basis). The net moms att
 * betala is usually unchanged for a fully deductible purchase, which is
 * exactly why this goes unnoticed.
 *
 * Advisory only, never blocking, and deliberately silent for
 * swedish_business: a Swedish 0 % invoice (bankavgift, forsakring, hyra) is a
 * genuine exemption that belongs in no box at all, and nagging about it would
 * be pure noise. It is also silent when reverse charge is already on, and for
 * a foreign supplier that legitimately invoiced 0 % without reverse charge
 * (a non-EU goods purchase cleared at customs, or an EU seller charging its
 * own local VAT), which is why the copy asks rather than asserts: pushing
 * such a user into ticking the switch would manufacture a new wrong verifikat.
 */
export function findUnflaggedForeignZeroVatRows(
  items: ReadonlyArray<{ vat_rate: number }>,
  reverseCharge: boolean,
  supplierType: string | undefined | null,
): number[] {
  if (reverseCharge) return []
  if (!supplierType || !FOREIGN_SUPPLIER_TYPES.includes(supplierType)) return []
  const rows: number[] = []
  items.forEach((item, index) => {
    if (item.vat_rate === 0) rows.push(index)
  })
  return rows
}
