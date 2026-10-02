/**
 * What Enter does in the manual verifikat form (JournalEntryForm).
 *
 * The rule, Fortnox parity: inside the konteringsrader Enter always moves
 * forward (konto, debet, kredit, next row's konto), and Enter in the account
 * field of an EMPTY row is "I am done": it opens the review (Granska & skapa).
 *
 * Deliberately NOT an input: whether the voucher currently balances. A
 * payroll voucher balances several times while it is being keyed (the wage,
 * tax and bank rows balance before the employer contribution rows are
 * entered), so "balanced" never meant "done". Keying navigation off the
 * balance made Enter open the confirm step on a half-keyed voucher. The review itself still validates (balance,
 * description, period) and surfaces the hints when something is missing.
 */

/** The row fields that decide whether a konteringsrad is started. */
export interface VoucherEnterRow {
  account_number: string
  debit_amount: string
  credit_amount: string
}

/** The field Enter was pressed in. */
export type VoucherEnterField =
  | { kind: 'header_description' }
  // `text` is what the account input shows right now: it can differ from the
  // row's committed account_number while the user is typing a search.
  | { kind: 'account'; row: number; text: string }
  | { kind: 'line_description'; row: number }
  | { kind: 'debit'; row: number }
  | { kind: 'credit'; row: number }
  // Any other form control (date, series, currency...): Enter = the button.
  | { kind: 'other' }

export type VoucherEnterAction =
  // Move focus. `appendRow` asks the caller to add one blank row first: only
  // returned when the last row is started, so empty rows never pile up.
  | { kind: 'focus'; field: 'account' | 'debit' | 'credit'; row: number; appendRow: boolean }
  // Run the same action as the Granska & skapa button.
  | { kind: 'review' }
  // Swallow Enter and stay put.
  | { kind: 'none' }

/** A row with no account and no amount: the same test as the trailing-row rule. */
export function isBlankVoucherRow(row: VoucherEnterRow): boolean {
  return row.account_number === '' && row.debit_amount === '' && row.credit_amount === ''
}

function focusAccount(row: number, appendRow = false): VoucherEnterAction {
  return { kind: 'focus', field: 'account', row, appendRow }
}

// Leave row `index` for the next row's account field. Past the last row:
// a blank last row is itself the landing spot (its account field is where the
// next Enter confirms); a started last row gets one blank row appended.
function advancePastRow(rows: readonly VoucherEnterRow[], index: number): VoucherEnterAction {
  if (index + 1 < rows.length) return focusAccount(index + 1)
  const current = rows[index]
  if (!current || isBlankVoucherRow(current)) return focusAccount(index)
  return focusAccount(rows.length, true)
}

export function resolveVoucherEnter(
  field: VoucherEnterField,
  rows: readonly VoucherEnterRow[]
): VoucherEnterAction {
  switch (field.kind) {
    case 'header_description': {
      // Drop into the first row still missing an account, so the top-to-bottom
      // keyboard flow never needs the mouse.
      const idx = rows.findIndex((r) => r.account_number === '')
      if (idx !== -1) return focusAccount(idx)
      return rows.length > 0 ? advancePastRow(rows, rows.length - 1) : focusAccount(0, true)
    }
    case 'account': {
      // Reached only when the account combobox did not consume Enter itself
      // (it selects a picked suggestion and re-commits a full number). An
      // empty field on an empty row confirms; anything else (a search that
      // matched nothing, an account cleared on a row that has amounts) stays.
      const row = rows[field.row]
      if (field.text.trim() === '' && (!row || isBlankVoucherRow(row))) return { kind: 'review' }
      return { kind: 'none' }
    }
    case 'line_description':
      return { kind: 'focus', field: 'debit', row: field.row, appendRow: false }
    case 'debit': {
      // No debit amount means the row books on the credit side: hop across.
      const debit = parseFloat(rows[field.row]?.debit_amount ?? '')
      if (!(debit > 0)) return { kind: 'focus', field: 'credit', row: field.row, appendRow: false }
      return advancePastRow(rows, field.row)
    }
    case 'credit':
      // An amount on either side finishes the row (debit clears credit and
      // vice versa), so credit always moves on.
      return advancePastRow(rows, field.row)
    case 'other':
      return { kind: 'review' }
  }
}
