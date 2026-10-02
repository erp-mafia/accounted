import { describe, it, expect } from 'vitest'
import {
  resolveVoucherEnter,
  isBlankVoucherRow,
  type VoucherEnterAction,
  type VoucherEnterField,
  type VoucherEnterRow,
} from '../voucher-enter-key'

const blank = (): VoucherEnterRow => ({ account_number: '', debit_amount: '', credit_amount: '' })
const row = (account_number: string, debit_amount = '', credit_amount = ''): VoucherEnterRow => ({
  account_number,
  debit_amount,
  credit_amount,
})
const focus = (field: 'account' | 'debit' | 'credit', r: number, appendRow = false): VoucherEnterAction => ({
  kind: 'focus',
  field,
  row: r,
  appendRow,
})

describe('isBlankVoucherRow', () => {
  it('is blank only with no account and no amounts', () => {
    expect(isBlankVoucherRow(blank())).toBe(true)
    expect(isBlankVoucherRow(row('1930'))).toBe(false)
    expect(isBlankVoucherRow(row('', '100'))).toBe(false)
    expect(isBlankVoucherRow(row('', '', '100'))).toBe(false)
  })
})

describe('resolveVoucherEnter: amount fields', () => {
  const rows = [row('1930', '', '1000'), row('4000', '800'), blank()]

  it('debit with an amount moves to the next row account', () => {
    expect(resolveVoucherEnter({ kind: 'debit', row: 1 }, rows)).toEqual(focus('account', 2))
  })

  it('empty debit hops across to the same row credit', () => {
    expect(resolveVoucherEnter({ kind: 'debit', row: 0 }, rows)).toEqual(focus('credit', 0))
  })

  it('a zero or unparsable debit counts as empty', () => {
    const r = [row('1930', '0'), row('4000', 'abc'), blank()]
    expect(resolveVoucherEnter({ kind: 'debit', row: 0 }, r)).toEqual(focus('credit', 0))
    expect(resolveVoucherEnter({ kind: 'debit', row: 1 }, r)).toEqual(focus('credit', 1))
  })

  it('credit always moves to the next row account', () => {
    expect(resolveVoucherEnter({ kind: 'credit', row: 0 }, rows)).toEqual(focus('account', 1))
  })

  it('never opens the review, balanced or not', () => {
    const balanced = [row('1930', '', '1000'), row('4000', '1000'), blank()]
    for (const field of [
      { kind: 'debit', row: 0 },
      { kind: 'credit', row: 0 },
      { kind: 'debit', row: 1 },
      { kind: 'credit', row: 1 },
    ] as VoucherEnterField[]) {
      expect(resolveVoucherEnter(field, balanced).kind).toBe('focus')
    }
  })

  it('past a started last row appends exactly one blank row and lands on it', () => {
    const r = [row('1930', '', '1000'), row('4000', '1000')]
    expect(resolveVoucherEnter({ kind: 'credit', row: 1 }, r)).toEqual(focus('account', 2, true))
    expect(resolveVoucherEnter({ kind: 'debit', row: 1 }, r)).toEqual(focus('account', 2, true))
  })

  it('past a blank last row stays on its own account field instead of piling up rows', () => {
    const r = [row('1930', '', '1000'), row('4000', '1000'), blank()]
    expect(resolveVoucherEnter({ kind: 'credit', row: 2 }, r)).toEqual(focus('account', 2))
  })
})

describe('resolveVoucherEnter: row description', () => {
  it('moves to the same row debit, even when the voucher balances', () => {
    const balanced = [row('1930', '', '500'), row('4000', '500'), blank()]
    expect(resolveVoucherEnter({ kind: 'line_description', row: 1 }, balanced)).toEqual(focus('debit', 1))
  })
})

describe('resolveVoucherEnter: account field', () => {
  const rows = [row('1930', '', '1000'), row('4000', '1000'), blank()]

  it('empty field on an empty row opens the review', () => {
    expect(resolveVoucherEnter({ kind: 'account', row: 2, text: '' }, rows)).toEqual({ kind: 'review' })
    expect(resolveVoucherEnter({ kind: 'account', row: 2, text: '   ' }, rows)).toEqual({ kind: 'review' })
  })

  it('a search that matched nothing stays put', () => {
    expect(resolveVoucherEnter({ kind: 'account', row: 2, text: 'xyz' }, rows)).toEqual({ kind: 'none' })
  })

  it('a cleared account on a row that has amounts stays put', () => {
    const r = [row('', '', '1000'), blank()]
    expect(resolveVoucherEnter({ kind: 'account', row: 0, text: '' }, r)).toEqual({ kind: 'none' })
  })

  it('a cleared search over a committed account stays put', () => {
    expect(resolveVoucherEnter({ kind: 'account', row: 0, text: '' }, rows)).toEqual({ kind: 'none' })
  })
})

describe('resolveVoucherEnter: header and other fields', () => {
  it('description drops into the first row missing an account, even when balanced', () => {
    const r = [row('1930', '', '1000'), row('4000', '1000'), blank()]
    expect(resolveVoucherEnter({ kind: 'header_description' }, r)).toEqual(focus('account', 2))
    expect(resolveVoucherEnter({ kind: 'header_description' }, [blank(), blank()])).toEqual(focus('account', 0))
  })

  it('description with every row holding an account appends a row', () => {
    const r = [row('1930', '', '1000'), row('4000', '1000')]
    expect(resolveVoucherEnter({ kind: 'header_description' }, r)).toEqual(focus('account', 2, true))
  })

  it('description with no rows at all lands on a new first row', () => {
    expect(resolveVoucherEnter({ kind: 'header_description' }, [])).toEqual(focus('account', 0, true))
  })

  it('any other control opens the review as the button does', () => {
    expect(resolveVoucherEnter({ kind: 'other' }, [blank(), blank()])).toEqual({ kind: 'review' })
  })
})

// Drives the form the way a person keying by hand does: type into the focused
// field, press Enter, follow the action. Mirrors the two collaborators the
// form relies on: the account combobox consumes Enter on a full 4-digit
// number (advancing to debit), and the trailing-row effect keeps one blank row
// after a started last row.
function simulate(steps: (string | 'Enter')[]) {
  const rows: VoucherEnterRow[] = [blank(), blank()]
  let cursor: { field: 'account' | 'debit' | 'credit'; row: number } = { field: 'account', row: 0 }
  let accountText = ''
  const reviews: number[] = []
  const trailingRow = () => {
    const last = rows[rows.length - 1]
    if (last && !isBlankVoucherRow(last)) rows.push(blank())
  }
  steps.forEach((step, i) => {
    if (step !== 'Enter') {
      if (cursor.field === 'account') {
        accountText = step
        if (/^\d{4}$/.test(step)) rows[cursor.row].account_number = step
      } else if (cursor.field === 'debit') {
        rows[cursor.row].debit_amount = step
        rows[cursor.row].credit_amount = ''
      } else {
        rows[cursor.row].credit_amount = step
        rows[cursor.row].debit_amount = ''
      }
      trailingRow()
      return
    }
    if (cursor.field === 'account' && /^\d{4}$/.test(accountText)) {
      cursor = { field: 'debit', row: cursor.row }
      return
    }
    const field: VoucherEnterField =
      cursor.field === 'account'
        ? { kind: 'account', row: cursor.row, text: accountText }
        : { kind: cursor.field, row: cursor.row }
    const action = resolveVoucherEnter(field, rows)
    if (action.kind === 'review') reviews.push(i)
    if (action.kind === 'focus') {
      if (action.appendRow) rows.push(blank())
      trailingRow()
      cursor = { field: action.field, row: action.row }
      if (action.field === 'account') accountText = rows[action.row].account_number
    }
  })
  return { rows, cursor, reviews }
}

describe('keying a voucher by hand (crm#229)', () => {
  it('Enter on the row that balances moves on; Enter on the empty account confirms', () => {
    const { rows, cursor, reviews } = simulate([
      '1930', 'Enter', 'Enter', '1250', 'Enter', // bank on credit
      '2641', 'Enter', '250', 'Enter', // input VAT on debit
      '4000', 'Enter', '1000', 'Enter', // balances here: must still advance
    ])
    expect(reviews).toEqual([])
    expect(cursor).toEqual({ field: 'account', row: 3 })
    expect(rows[3]).toEqual(blank())
    expect(rows).toHaveLength(4)

    const confirmed = simulate([
      '1930', 'Enter', 'Enter', '1250', 'Enter',
      '2641', 'Enter', '250', 'Enter',
      '4000', 'Enter', '1000', 'Enter',
      'Enter',
    ])
    expect(confirmed.reviews).toEqual([13])
  })

  it('a voucher that balances mid-way keeps accepting rows', () => {
    const { rows, cursor, reviews } = simulate([
      '7010', 'Enter', '1000', 'Enter',
      '1930', 'Enter', 'Enter', '1000', 'Enter', // balanced
      '7510', 'Enter', '300', 'Enter',
      '2730', 'Enter', 'Enter', '300', 'Enter', // balanced again
    ])
    expect(reviews).toEqual([])
    expect(rows.filter((r) => !isBlankVoucherRow(r))).toHaveLength(4)
    expect(cursor).toEqual({ field: 'account', row: 4 })
    expect(rows).toHaveLength(5)
  })
})
