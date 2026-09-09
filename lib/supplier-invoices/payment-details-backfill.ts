import type { SupabaseClient } from '@supabase/supabase-js'
import { formatBankgiroNumber, formatPlusgiroNumber, validateBankgiroNumber, validatePlusgiroNumber } from '@/lib/bankgiro/luhn'
import { normalizeIban } from '@/lib/cash-accounts/service'

/**
 * The payment details a scanned or Peppol-delivered invoice carries for its
 * supplier. The extraction reads them together with everything else on the
 * invoice; until now they were only used when a NEW supplier was created
 * from the document, so an existing supplier without a bankgiro stayed
 * without one and its invoices could never go into a betalfil.
 */
export interface SupplierPaymentDetails {
  bankgiro?: string | null
  plusgiro?: string | null
  iban?: string | null
  bic?: string | null
}

export type SupplierPaymentColumns = Pick<SupplierPaymentDetails, 'bankgiro' | 'plusgiro' | 'iban' | 'bic'>

/** ISO 7064 mod 97-10 over the rearranged IBAN; the cheap check that rejects a misread digit. */
export function isValidIban(raw: string | null | undefined): boolean {
  const iban = normalizeIban(raw)
  if (!iban || !/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false
  const rearranged = iban.slice(4) + iban.slice(0, 4)
  let remainder = 0
  for (const ch of rearranged) {
    const value = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97
  }
  return remainder === 1
}

export function isValidBic(raw: string | null | undefined): boolean {
  const bic = (raw ?? '').replace(/\s+/g, '').toUpperCase()
  return /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic)
}

/**
 * The details worth writing: each one validated on its own, so a misread
 * bankgiro never blocks a correct IBAN, and nothing invalid is ever stored.
 */
export function cleanSupplierPaymentDetails(details: SupplierPaymentDetails | null | undefined): SupplierPaymentColumns {
  const out: SupplierPaymentColumns = {}
  const bg = (details?.bankgiro ?? '').trim()
  if (bg && validateBankgiroNumber(bg)) out.bankgiro = formatBankgiroNumber(bg)
  const pg = (details?.plusgiro ?? '').trim()
  if (pg && validatePlusgiroNumber(pg)) out.plusgiro = formatPlusgiroNumber(pg)
  if (isValidIban(details?.iban)) out.iban = normalizeIban(details?.iban) as string
  if (isValidBic(details?.bic)) out.bic = (details?.bic ?? '').replace(/\s+/g, '').toUpperCase()
  return out
}

/**
 * Which of the cleaned details the supplier row still lacks. Existing values
 * are never overwritten: a person who typed a bankgiro by hand is right
 * over a scan, and a supplier that changed giro is told through the
 * supplier card, not by the next invoice.
 */
export function planSupplierPaymentBackfill(
  existing: SupplierPaymentColumns,
  details: SupplierPaymentDetails | null | undefined,
): SupplierPaymentColumns {
  const clean = cleanSupplierPaymentDetails(details)
  const plan: SupplierPaymentColumns = {}
  for (const key of ['bankgiro', 'plusgiro', 'iban', 'bic'] as const) {
    if (clean[key] && !(existing[key] ?? '').trim()) plan[key] = clean[key]
  }
  return plan
}

/**
 * Write the details the supplier lacks. Returns the columns written, empty
 * when there was nothing to add. Never throws: a failed backfill must not
 * stop the invoice that carried it.
 */
export async function backfillSupplierPaymentDetails(
  supabase: SupabaseClient,
  companyId: string,
  supplierId: string,
  details: SupplierPaymentDetails | null | undefined,
): Promise<SupplierPaymentColumns> {
  const clean = cleanSupplierPaymentDetails(details)
  if (Object.keys(clean).length === 0) return {}
  const { data: existing, error } = await supabase
    .from('suppliers')
    .select('bankgiro, plusgiro, iban, bic')
    .eq('id', supplierId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error || !existing) return {}
  const plan = planSupplierPaymentBackfill(existing as SupplierPaymentColumns, clean)
  if (Object.keys(plan).length === 0) return {}
  const { error: updateError } = await supabase.from('suppliers').update(plan).eq('id', supplierId).eq('company_id', companyId)
  return updateError ? {} : plan
}
