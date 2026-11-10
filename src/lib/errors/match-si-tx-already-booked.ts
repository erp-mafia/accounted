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

/**
 * The codes a booking door answers the bank-row gate's "already booked" with
 * (lib/transactions/is-booked.ts), on the doors that pass the gate's `via`
 * along in details.
 */
const BANK_ROW_BOOKED_CODES = new Set([
  'TRANSACTION_ALREADY_CATEGORIZED',
  'MATCH_INVOICE_TX_ALREADY_BOOKED',
  'MATCH_SI_TX_ALREADY_BOOKED',
  'BATCH_TX_ALREADY_BOOKED',
  'BULK_BOOK_TX_ALREADY_BOOKED',
])

/**
 * A row only a posted verifikat names (details.via 'named', #203): the
 * verifikat was booked from the row, but the write that links the two never
 * landed, so the row still reads as unbooked. The sentence names what books
 * it and both ways on: link the two, or reverse the verifikat and book again.
 */
function namedBankRowMessages(details: unknown): { message_sv: string; message_en: string } | null {
  const d = details as { via?: unknown; voucher?: unknown; journal_entry_id?: unknown } | null | undefined
  if (d?.via !== 'named') return null
  const voucher = typeof d.voucher === 'string' && d.voucher ? d.voucher : null
  const id = typeof d.journal_entry_id === 'string' ? d.journal_entry_id : null
  const sv = voucher ? `verifikat ${voucher}` : 'ett verifikat'
  const en = voucher ? `verifikat ${voucher}` : id ? `verifikat ${id}` : 'a posted verifikat'
  return {
    message_sv: `Banktransaktionen är redan bokförd på ${sv}, som bokfördes från den men aldrig kopplades till den, så den skulle bokföras två gånger. Är verifikatet rätt bokföring: koppla det till transaktionen under Avstämning, Matcha manuellt. Annars: återför verifikatet (storno) och bokför transaktionen igen.`,
    message_en: `The bank transaction is already booked on ${en}, which was booked from it but never linked to it, so booking it again would count it twice. If that verifikat is this transaction's booking, link the two (gnubok_link_transaction_to_journal_entry, or POST /transactions/{id}/link-journal-entry). Otherwise reverse it (gnubok_reverse_journal_entry) and book the transaction again.`,
  }
}

/** The sentences a refused booking of a booked bank row answers with, on every door that carries its code. */
export function bankRowAlreadyBookedMessages(code: string, details: unknown): { message_sv: string; message_en: string } | null {
  if (BANK_ROW_BOOKED_CODES.has(code)) {
    const named = namedBankRowMessages(details)
    if (named) return named
  }
  if (code === 'MATCH_SI_TX_ALREADY_BOOKED') return matchSiTxAlreadyBookedMessages(details)
  if (code === 'MATCH_INVOICE_TX_ALREADY_BOOKED') return matchInvoiceTxAlreadyBookedMessages(details)
  return null
}
