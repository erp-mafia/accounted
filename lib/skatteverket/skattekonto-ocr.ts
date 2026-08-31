/**
 * OCR-nummer for Skatteverket Skattekonto payments.
 *
 * Companies pay tax (skatt + arbetsgivaravgifter + F-skatt + slutlig skatt etc.)
 * to Bankgiro 5050-1055 with an OCR reference. The reference identifies which
 * Skattekonto receives the credit; Skatteverket applies it to the most recent
 * declared liability.
 *
 * Format (per Skatteverket "Referensnummer (OCR) för inbetalning till
 * skattekonto"):
 *   - The person-, samordnings- or organisationsnummer in its TWELVE-digit
 *     form: an organisationsnummer carries the "16" prefix (5595470021 →
 *     165595470021), a personnummer its century (880225-1234 → 198802251234)
 *   - Followed by a single Luhn check digit
 *   - Total: 13 digits
 *
 * Example: 559547-0021 → "165595470021" + check digit "7" = "1655954700217"
 *
 * The twelve-digit form is the same "redovisare" identity the AGI and moms
 * APIs take, so it is built with the shared `toRedovisare12` converter rather
 * than a second local rule: the payment reference and the declaration it pays
 * must never disagree about who the taxpayer is.
 *
 * Reference: https://www.skatteverket.se/privat/etjansterochblanketter/allaetjanster/tjanster/ocrberakning
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { luhnCheckDigit, luhnValidate } from '@/lib/bankgiro/luhn'
import { toRedovisare12 } from '@/lib/invariants/org-number'

/** Bankgiro number for all payments to Skattekontot. */
export const SKATTEKONTO_BANKGIRO = '5050-1055'

/**
 * The skattekonto extension caches Skatteverket's own saldo response here
 * (same shape the reconciliation engine reads). Core reads the row directly
 * rather than importing the extension: core must never import `@/extensions/*`.
 */
const SKATTEVERKET_EXTENSION_ID = 'skatteverket'
const BALANCE_SNAPSHOT_KEY = 'skattekonto_balance_snapshot'

/**
 * Compute the Skattekontot OCR reference for a company.
 *
 * Accepts org_number/personnummer in any common Swedish format
 * ("556012-3456", "5560123456", "19880225-1234", "198802251234"); a value
 * already in twelve-digit form passes through the century step untouched.
 *
 * @throws when the input is not 10 or 12 digits after separators are stripped.
 */
export function generateSkattekontoOcr(
  orgOrPersonnummer: string,
  entityType: 'enskild_firma' | 'aktiebolag',
): string {
  const redovisare = toRedovisare12(orgOrPersonnummer, entityType)
  return redovisare + luhnCheckDigit(redovisare).toString()
}

/**
 * The OCR to print on a payment file, preferring the one Skatteverket itself
 * reported over the one we derive.
 *
 * `saldo.ocrNummer` comes straight out of the skattekonto API and is the
 * authoritative reference for the account we actually sync, which the derived
 * value can only approximate: it also covers identities our converter has no
 * rule for (samordningsnummer, GD-nummer) and companies whose stored
 * org_number has drifted from the skattekonto they are connected to.
 *
 * Falls back to {@link generateSkattekontoOcr} when no snapshot exists (the
 * Skatteverket extension is off or never synced) or the cached value fails a
 * Luhn check.
 */
export async function resolveSkattekontoOcr(
  supabase: SupabaseClient,
  companyId: string,
  orgOrPersonnummer: string,
  entityType: 'enskild_firma' | 'aktiebolag',
): Promise<string> {
  const reported = await readReportedOcr(supabase, companyId)
  return reported ?? generateSkattekontoOcr(orgOrPersonnummer, entityType)
}

async function readReportedOcr(
  supabase: SupabaseClient,
  companyId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('extension_data')
    .select('value')
    .eq('company_id', companyId)
    .eq('extension_id', SKATTEVERKET_EXTENSION_ID)
    .eq('key', BALANCE_SNAPSHOT_KEY)
    .maybeSingle()

  if (error || !data?.value) return null

  const value = data.value as { saldo?: { ocrNummer?: unknown } }
  const raw = value.saldo?.ocrNummer
  if (typeof raw !== 'string') return null

  // Bankgirot accepts 2-25 digit OCR references; anything else in the cache is
  // not something we can put on a payment file, so fall back to the computed
  // value rather than shipping it.
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 2 || digits.length > 25) return null

  return luhnValidate(digits) ? digits : null
}
