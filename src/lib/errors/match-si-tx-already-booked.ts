/**
 * The sentences for a MATCH_SI_TX_ALREADY_BOOKED refusal that names its
 * verifikat (details.voucher), or null when it names none (a failed read).
 * Lives outside structured-errors.ts, whose browser copy
 * (scripts/build/structured-errors-browser-loader.js) carries the registry
 * only; this reads nothing from it (accounted#58).
 */
export function matchSiTxAlreadyBookedMessages(details: unknown): { message_sv: string; message_en: string } | null {
  const d = details as { voucher?: unknown; storno_allowed?: unknown } | null | undefined
  if (typeof d?.voucher !== 'string' || !d.voucher) return null
  const voucher = d.voucher
  return d.storno_allowed === true
    ? {
        message_sv: `Banktransaktionen är redan bokförd på verifikat ${voucher}. Återför ${voucher} (storno) och matcha, så bokförs betalningen bara en gång.`,
        message_en: `The bank transaction is already booked on verifikat ${voucher}, its own categorization. Reverse ${voucher} (storno) and match, so the payment is booked once.`,
      }
    : {
        message_sv: `Banktransaktionen är redan bokförd på verifikat ${voucher}, så betalningen skulle bokföras två gånger. Koppla bort transaktionen från ${voucher} eller rätta verifikatet först.`,
        message_en: `The bank transaction is already booked on verifikat ${voucher} (a samlingsverifikat, a split or a link to an existing verifikat), so matching it would book the payment twice. Unlink or correct that booking first, or link the invoice to ${voucher}.`,
      }
}
