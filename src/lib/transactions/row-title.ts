/**
 * The title a bank row is shown under in the transaction list and its
 * drawer: the bank's text, with the counterparty name the bank sent put
 * first when that text names no one (crm#1399).
 *
 * Some banks put only numbers in the text and the name in a field of its
 * own (stored as merchant_name): a Swish payment as the payer's phone
 * number and the Swish id ("Anna Andersson" beside "+46701234567
 * 1234567890123456"), and a bill payment as its OCR number ("Skatteverket"
 * beside "16501234567890"). The list showed only the digits. A text with
 * any letter in it is shown as it came: the bank already worded it.
 *
 * Display only, derived and never stored: the description stays as the
 * bank sent it, so search, the duplicate checks and the Swish phone
 * matcher (crm#1248, which reads the number from the stored text) are
 * unchanged, and a title the user typed (title_edited_at) is theirs.
 * Pure and client-safe.
 */

export interface RowTitleInput {
  description?: string | null
  merchant_name?: string | null
  title_edited_at?: string | null
}

const LETTER = /\p{L}/u

/** "Name (bank text)" when the bank text has no letters and the bank sent a name; else the bank text. */
export function bankRowTitle(row: RowTitleInput): string {
  const text = (row.description ?? '').trim()
  if (row.title_edited_at) return row.description ?? ''
  const name = (row.merchant_name ?? '').trim()
  if (!name || !LETTER.test(name) || LETTER.test(text)) return row.description ?? ''
  return text ? `${name} (${text})` : name
}
