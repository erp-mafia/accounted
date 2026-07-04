/**
 * OCR-nummer for Skatteverket Skattekonto payments.
 *
 * Companies pay tax (skatt + arbetsgivaravgifter + F-skatt + slutlig skatt etc.)
 * to Bankgiro 5050-1055 with an OCR reference. The reference identifies which
 * Skattekonto receives the credit; Skatteverket applies it to the most recent
 * declared liability.
 *
 * Format (per Skatteverket "OCR-nummer för inbetalning till skattekontot"):
 *   - 10-digit organisationsnummer (AB) or 10-digit personnummer (EF)
 *     stripped of dashes/spaces
 *   - Followed by a single Luhn check digit
 *   - Total: 11 digits
 *
 * Examples:
 *   556012-3456 → "5560123456" + check digit "6" = "55601234566"
 *   880225-1234 → "8802251234" + check digit  → 11 digits
 *
 * Reference: https://www.skatteverket.se/foretag/skatterochavdrag/skattekonto/betalainochavskattekonto/sabetalardupaskattekontot.4.18e1b10334ebe8bc80004499.html
 */

import { luhnCheckDigit } from '@/lib/bankgiro/luhn'

/** Bankgiro number for all payments to Skattekontot. */
export const SKATTEKONTO_BANKGIRO = '5050-1055'

/**
 * Generate the standard Skattekontot OCR reference for a company.
 *
 * Accepts org_number/personnummer in any common Swedish format
 * ("556012-3456", "5560123456", "19880225-1234", "198802251234").
 *
 * For 12-digit personnummer (with century prefix), the leading century digits
 * are stripped: Skatteverket's Skattekonto-OCR uses the 10-digit form.
 */
export function generateSkattekontoOcr(orgOrPersonnummer: string): string {
  const digits = orgOrPersonnummer.replace(/\D/g, '')

  let base: string
  if (digits.length === 10) {
    base = digits
  } else if (digits.length === 12) {
    // Strip century prefix (1900s = "19", 2000s = "20")
    base = digits.slice(2)
  } else {
    throw new Error(
      `Ogiltigt org/personnummer för Skattekonto-OCR: "${orgOrPersonnummer}" (förväntat 10 eller 12 siffror)`
    )
  }

  const checkDigit = luhnCheckDigit(base)
  return base + checkDigit.toString()
}
