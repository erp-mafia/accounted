/**
 * The sentences for a refused match of a booked bank row that names its
 * verifikat (details.voucher), or null when it names none (a concurrent
 * booking).
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

/**
 * MATCH_INVOICE_TX_ALREADY_BOOKED: the customer door reverses nothing, so the
 * sentence says how the row opens again, one way per shape (details.undo,
 * BankRowUndo in lib/transactions/is-booked.ts). The English names the API
 * and the tool, for the agent that reads it.
 */
export function matchInvoiceTxAlreadyBookedMessages(details: unknown): { message_sv: string; message_en: string } | null {
  const d = details as { voucher?: unknown; undo?: unknown } | null | undefined
  if (typeof d?.voucher !== 'string' || !d.voucher) return null
  const voucher = d.voucher
  if (d.undo === 'unlink') {
    return {
      message_sv: `Banktransaktionen är kopplad till verifikat ${voucher}, så betalningen skulle bokföras två gånger. Koppla bort den från ${voucher} först. Verifikatet ligger kvar. Om ${voucher} redan är betalningen: koppla fakturan till ${voucher} i stället.`,
      message_en: `The bank transaction is linked to verifikat ${voucher}, so matching it would book the payment twice. Unlink it first (gnubok_reconcile_unmatch): the verifikat stays posted. If ${voucher} already is this payment, link the invoice to it instead (gnubok_link_invoice_to_voucher).`,
    }
  }
  if (d.undo === 'reverse_voucher') {
    return {
      message_sv: `Banktransaktionen ingår i verifikat ${voucher}, så betalningen skulle bokföras två gånger. Återför ${voucher} (storno) först: då kommer alla transaktioner på verifikatet tillbaka till Att bokföra. Om ${voucher} redan är betalningen: koppla fakturan till ${voucher} i stället.`,
      message_en: `The bank transaction is booked inside verifikat ${voucher}, so matching it would book the payment twice. Reverse ${voucher} first (gnubok_reverse_journal_entry): every transaction on it returns to the worklist. If ${voucher} already is this payment, link the invoice to it instead (gnubok_link_invoice_to_voucher).`,
    }
  }
  return {
    message_sv: `Banktransaktionen är redan bokförd på verifikat ${voucher}, så betalningen skulle bokföras två gånger. Ångra bokföringen först: återför ${voucher} (storno), så kommer transaktionen tillbaka till Att bokföra. Matcha den sedan mot fakturan.`,
    message_en: `The bank transaction is already booked on verifikat ${voucher}, so matching it would book the payment twice. Undo that booking first (gnubok_uncategorize_transaction, or POST /transactions/{id}/uncategorize), then match it again. If ${voucher} already is this payment, link the invoice to it instead (gnubok_link_invoice_to_voucher).`,
  }
}

/** The sentences a refused match of a booked bank row answers with, on every door that carries its code. */
export function bankRowAlreadyBookedMessages(code: string, details: unknown): { message_sv: string; message_en: string } | null {
  if (code === 'MATCH_SI_TX_ALREADY_BOOKED') return matchSiTxAlreadyBookedMessages(details)
  if (code === 'MATCH_INVOICE_TX_ALREADY_BOOKED') return matchInvoiceTxAlreadyBookedMessages(details)
  return null
}
