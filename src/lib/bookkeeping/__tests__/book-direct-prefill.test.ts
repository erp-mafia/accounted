import { describe, expect, it } from 'vitest'
import type { InvoiceExtractionResult } from '@/types'
import { roundOre } from '@/lib/money'
import {
  applyCostAccountSuggestion,
  buildBookDirectPrefillLines,
  manualBookDirectLines,
  reconcileBookDirectLines,
  toBookDirectPayloadLine,
  withExplicitAccountEdit,
  type BookDirectFormLine,
  type BookDirectLineRole,
} from '@/lib/bookkeeping/book-direct-prefill'

function receipt(input: {
  total?: number | null
  vat?: number | null
  currency?: string
} = {}): InvoiceExtractionResult {
  return {
    supplier: {
      name: 'Cafe Example',
      orgNumber: null,
      vatNumber: null,
      address: null,
      bankgiro: null,
      plusgiro: null,
    },
    invoice: {
      invoiceNumber: '100',
      invoiceDate: '2026-09-29',
      dueDate: null,
      paymentReference: null,
      currency: input.currency ?? 'SEK',
    },
    lineItems: [],
    totals: {
      subtotal: null,
      vatAmount: input.vat === undefined ? 250 : input.vat,
      total: input.total === undefined ? 1250 : input.total,
    },
    vatBreakdown: [],
    confidence: 1,
  }
}

function pairs(lines: BookDirectFormLine[]) {
  return lines.map((line) => ({
    role: line.role ?? null,
    account: line.account_number,
    debit: line.debit_amount,
    credit: line.credit_amount,
  }))
}

function sums(lines: BookDirectFormLine[]) {
  const debit = roundOre(lines.reduce((sum, line) => sum + (parseFloat(line.debit_amount) || 0), 0))
  const credit = roundOre(lines.reduce((sum, line) => sum + (parseFloat(line.credit_amount) || 0), 0))
  return { debit, credit, balanced: debit === credit && debit > 0 }
}

function chooseCost(lines: BookDirectFormLine[], account: string): BookDirectFormLine[] {
  return lines.map((line) => (
    line.role === 'cost' ? withExplicitAccountEdit(line, { account_number: account }) : line
  ))
}

/** The dialog's delete button on a generated row: the row goes and its role is suppressed. */
function deleteRole(
  lines: BookDirectFormLine[],
  role: BookDirectLineRole,
  suppressed: Set<BookDirectLineRole>,
): BookDirectFormLine[] {
  suppressed.add(role)
  return lines.filter((line) => line.role !== role)
}

/** The dialog's double-click fill on the cost debit: the amount that balances the other rows. */
function fillCostBalance(lines: BookDirectFormLine[]): BookDirectFormLine[] {
  const others = sums(lines.filter((line) => line.role !== 'cost'))
  const fill = roundOre(others.credit - others.debit)
  return lines.map((line) => (
    line.role === 'cost' ? withExplicitAccountEdit(line, { debit_amount: String(fill), credit_amount: '' }) : line
  ))
}

function roleLine(
  role: BookDirectLineRole,
  account: string,
  debit: string,
  credit: string,
  extra?: Partial<BookDirectFormLine>,
): BookDirectFormLine {
  return {
    debit_amount: debit,
    credit_amount: credit,
    generated_account: account,
    ...extra,
    role,
    account_number: extra?.account_number ?? account,
  }
}

const SEK_RECEIPT = receipt({ total: 1250, vat: 250, currency: 'SEK' })

describe('buildBookDirectPrefillLines', () => {
  it('splits a SEK receipt into cost, extracted VAT and settlement', () => {
    const lines = buildBookDirectPrefillLines(SEK_RECEIPT, null, '1930')

    expect(pairs(lines)).toEqual([
      { role: 'cost', account: '', debit: '1000', credit: '' },
      { role: 'vat', account: '2641', debit: '250', credit: '' },
      { role: 'settlement', account: '1930', debit: '', credit: '1250' },
    ])
    expect(sums(lines).balanced).toBe(true)
  })

  it('keeps extracted VAT when the transaction supplies the canonical SEK total', () => {
    const lines = buildBookDirectPrefillLines(SEK_RECEIPT, -1250, '1940')

    expect(pairs(lines)).toEqual([
      { role: 'cost', account: '', debit: '1000', credit: '' },
      { role: 'vat', account: '2641', debit: '250', credit: '' },
      { role: 'settlement', account: '1940', debit: '', credit: '1250' },
    ])
  })

  it('does not scale extracted VAT or invent a rate when the transaction amount differs', () => {
    // 100 on 1250 is not 25%. Doubling the bank amount must not double the VAT,
    // and it must not replace 100 with a derived 25% of 2500.
    const extracted = receipt({ total: 1250, vat: 100, currency: 'SEK' })
    const lines = buildBookDirectPrefillLines(extracted, -2500, '1930')

    expect(pairs(lines)).toEqual([
      { role: 'cost', account: '', debit: '2400', credit: '' },
      { role: 'vat', account: '2641', debit: '100', credit: '' },
      { role: 'settlement', account: '1930', debit: '', credit: '2500' },
    ])
  })

  it('treats lower-case and missing currency as SEK', () => {
    const lower = buildBookDirectPrefillLines(receipt({ currency: 'sek' }), -1250, '1930')
    expect(pairs(lower).map((line) => line.role)).toEqual(['cost', 'vat', 'settlement'])
    expect(lower.find((line) => line.role === 'vat')?.debit_amount).toBe('250')

    const base = receipt()
    const missing = {
      ...base,
      invoice: { ...base.invoice, currency: undefined },
    } as unknown as InvoiceExtractionResult
    const lines = buildBookDirectPrefillLines(missing, null, '1930')
    expect(lines).toHaveLength(3)
    expect(lines[1]?.account_number).toBe('2641')
  })

  it('omits the VAT row when extracted VAT is missing, zero, negative or non-finite', () => {
    for (const vat of [null, 0, -20, Number.NaN, Number.POSITIVE_INFINITY]) {
      const lines = buildBookDirectPrefillLines(receipt({ total: 1250, vat }), null, '1930')
      expect(pairs(lines)).toEqual([
        { role: 'cost', account: '', debit: '1250', credit: '' },
        { role: 'settlement', account: '1930', debit: '', credit: '1250' },
      ])
    }
  })

  it('books a foreign document without automatic VAT, at the transaction SEK amount', () => {
    const extracted = receipt({ total: 100, vat: 20, currency: 'usd' })

    expect(pairs(buildBookDirectPrefillLines(extracted, 2109.5, '1930'))).toEqual([
      { role: 'cost', account: '', debit: '2109.5', credit: '' },
      { role: 'settlement', account: '1930', debit: '', credit: '2109.5' },
    ])
    // No transaction yet: the document face amount is the figure, still with no VAT row.
    expect(pairs(buildBookDirectPrefillLines(extracted, null, '1930'))).toEqual([
      { role: 'cost', account: '', debit: '100', credit: '' },
      { role: 'settlement', account: '1930', debit: '', credit: '100' },
    ])
  })

  it('leaves missing, zero and non-finite totals unresolved instead of emitting NaN or a negative cost', () => {
    const badTotals = [null, 0, -1250, Number.NaN, Number.POSITIVE_INFINITY, 0.004]
    for (const total of badTotals) {
      const lines = buildBookDirectPrefillLines(receipt({ total, vat: 250 }), null, '1940')
      expect(pairs(lines)).toEqual([
        { role: 'cost', account: '', debit: '', credit: '' },
        { role: 'settlement', account: '', debit: '', credit: '' },
      ])
      expect(lines.some((line) => line.debit_amount.includes('-') || line.credit_amount.includes('-'))).toBe(false)
    }

    const badTransactions = [0, -0, Number.NaN, Number.POSITIVE_INFINITY]
    for (const amount of badTransactions) {
      const lines = buildBookDirectPrefillLines(SEK_RECEIPT, amount, '1930')
      expect(lines.map((line) => line.debit_amount + line.credit_amount).join('')).toBe('')
      expect(lines.some((line) => /nan|infinity/i.test(line.debit_amount + line.credit_amount))).toBe(false)
    }
  })

  it('leaves cost unresolved when extracted VAT exceeds the canonical total', () => {
    const lines = buildBookDirectPrefillLines(receipt({ total: 200, vat: 250 }), null, '1930')

    expect(pairs(lines)).toEqual([
      { role: 'cost', account: '', debit: '', credit: '' },
      { role: 'vat', account: '2641', debit: '250', credit: '' },
      { role: 'settlement', account: '1930', debit: '', credit: '200' },
    ])
    expect(sums(lines).balanced).toBe(false)
    expect(lines.some((line) => line.debit_amount.startsWith('-') || line.credit_amount.startsWith('-'))).toBe(false)

    const smallerBank = buildBookDirectPrefillLines(SEK_RECEIPT, -100, '1930')
    expect(smallerBank.find((line) => line.role === 'cost')?.debit_amount).toBe('')
    expect(smallerBank.find((line) => line.role === 'vat')?.debit_amount).toBe('250')
    expect(smallerBank.find((line) => line.role === 'settlement')?.credit_amount).toBe('100')
    expect(sums(smallerBank).balanced).toBe(false)
  })

  it('rounds each money figure to öre and derives cost as total minus extracted VAT', () => {
    // 1.005 is the case where Math.round(x * 100) / 100 yields 1 instead of 1.01.
    expect(pairs(buildBookDirectPrefillLines(receipt({ total: 1.005, vat: null }), null, '1930'))).toEqual([
      { role: 'cost', account: '', debit: '1.01', credit: '' },
      { role: 'settlement', account: '1930', debit: '', credit: '1.01' },
    ])

    const lines = buildBookDirectPrefillLines(receipt({ total: 10.075, vat: 2.005 }), null, '1930')
    expect(pairs(lines)).toEqual([
      { role: 'cost', account: '', debit: '8.07', credit: '' },
      { role: 'vat', account: '2641', debit: '2.01', credit: '' },
      { role: 'settlement', account: '1930', debit: '', credit: '10.08' },
    ])
    expect(sums(lines)).toEqual({ debit: 10.08, credit: 10.08, balanced: true })
  })

  it('leaves suppressed roles out, and a suppressed VAT role keeps the VAT on cost', () => {
    expect(pairs(buildBookDirectPrefillLines(SEK_RECEIPT, -1250, '1930', { suppressedRoles: ['vat'] }))).toEqual([
      { role: 'cost', account: '', debit: '1250', credit: '' },
      { role: 'settlement', account: '1930', debit: '', credit: '1250' },
    ])
    expect(pairs(buildBookDirectPrefillLines(SEK_RECEIPT, null, '1930', { suppressedRoles: ['settlement'] }))).toEqual([
      { role: 'cost', account: '', debit: '1000', credit: '' },
      { role: 'vat', account: '2641', debit: '250', credit: '' },
    ])
    expect(pairs(buildBookDirectPrefillLines(SEK_RECEIPT, null, '1930', { suppressedRoles: ['cost'] }))).toEqual([
      { role: 'vat', account: '2641', debit: '250', credit: '' },
      { role: 'settlement', account: '1930', debit: '', credit: '1250' },
    ])
  })
})

describe('VAT registration', () => {
  it('puts the whole total on cost and generates no 2641 row for a company that is not VAT-registered', () => {
    const noTransaction = buildBookDirectPrefillLines(SEK_RECEIPT, null, '1930', { vatRegistered: false })
    expect(pairs(noTransaction)).toEqual([
      { role: 'cost', account: '', debit: '1250', credit: '' },
      { role: 'settlement', account: '1930', debit: '', credit: '1250' },
    ])
    expect(sums(noTransaction).balanced).toBe(true)

    const withTransaction = buildBookDirectPrefillLines(SEK_RECEIPT, -1250, '1940', { vatRegistered: false })
    expect(pairs(withTransaction)).toEqual([
      { role: 'cost', account: '', debit: '1250', credit: '' },
      { role: 'settlement', account: '1940', debit: '', credit: '1250' },
    ])
    expect(sums(withTransaction).balanced).toBe(true)

    // A bank amount that differs from the document still lands on cost in full.
    expect(pairs(buildBookDirectPrefillLines(SEK_RECEIPT, -1300, '1930', { vatRegistered: false }))).toEqual([
      { role: 'cost', account: '', debit: '1300', credit: '' },
      { role: 'settlement', account: '1930', debit: '', credit: '1300' },
    ])
    // No VAT row to exceed the total: the cost is the total.
    expect(pairs(buildBookDirectPrefillLines(receipt({ total: 200, vat: 250 }), null, '1930', { vatRegistered: false }))).toEqual([
      { role: 'cost', account: '', debit: '200', credit: '' },
      { role: 'settlement', account: '1930', debit: '', credit: '200' },
    ])
  })

  it('changes nothing unless vat_registered is explicitly false', () => {
    for (const vatRegistered of [true, null, undefined]) {
      for (const amount of [null, -1250]) {
        const lines = buildBookDirectPrefillLines(SEK_RECEIPT, amount, '1930', { vatRegistered })
        expect(pairs(lines)).toEqual(pairs(buildBookDirectPrefillLines(SEK_RECEIPT, amount, '1930')))
        expect(lines.find((line) => line.role === 'vat')?.debit_amount).toBe('250')
      }
    }
  })

  it('drops a VAT row prefilled while settings loaded once vat_registered resolves to false', () => {
    // Settings unknown at open: the receipt prefills as for a registered company.
    const seeded = chooseCost(buildBookDirectPrefillLines(SEK_RECEIPT, null, '1930'), '5410')
    expect(seeded.some((line) => line.role === 'vat')).toBe(true)

    const resolved = reconcileBookDirectLines(
      seeded,
      buildBookDirectPrefillLines(SEK_RECEIPT, null, '1930', { vatRegistered: false }),
    )
    expect(pairs(resolved)).toEqual([
      { role: 'cost', account: '5410', debit: '1250', credit: '' },
      { role: 'settlement', account: '1930', debit: '', credit: '1250' },
    ])

    const picked = reconcileBookDirectLines(
      resolved,
      buildBookDirectPrefillLines(SEK_RECEIPT, -1250, '1940', { vatRegistered: false }),
    )
    expect(pairs(picked)).toEqual([
      { role: 'cost', account: '5410', debit: '1250', credit: '' },
      { role: 'settlement', account: '1940', debit: '', credit: '1250' },
    ])
    expect(sums(picked).balanced).toBe(true)
    expect(JSON.stringify(picked)).not.toContain('2641')
  })
})

describe('reconcileBookDirectLines', () => {
  it('keeps the chosen cost account when a -1250 transaction arrives', () => {
    const current = chooseCost(buildBookDirectPrefillLines(SEK_RECEIPT, null, '1930'), '5410')
    const lines = reconcileBookDirectLines(current, buildBookDirectPrefillLines(SEK_RECEIPT, -1250, '1940'))

    expect(pairs(lines)).toEqual([
      { role: 'cost', account: '5410', debit: '1000', credit: '' },
      { role: 'vat', account: '2641', debit: '250', credit: '' },
      { role: 'settlement', account: '1940', debit: '', credit: '1250' },
    ])
    expect(sums(lines).balanced).toBe(true)
    expect(lines.find((line) => line.role === 'settlement')?.account_number).not.toBe('2641')
  })

  it('keeps VAT at 250 across match, repeat, a different amount and clearing the selection', () => {
    let lines = chooseCost(buildBookDirectPrefillLines(SEK_RECEIPT, null, '1930'), '5410')

    lines = reconcileBookDirectLines(lines, buildBookDirectPrefillLines(SEK_RECEIPT, -1250, '1930'))
    expect(lines.find((line) => line.role === 'vat')?.debit_amount).toBe('250')
    expect(lines.find((line) => line.role === 'settlement')?.credit_amount).toBe('1250')
    expect(lines.find((line) => line.role === 'cost')).toMatchObject({ account_number: '5410', debit_amount: '1000' })

    lines = reconcileBookDirectLines(lines, buildBookDirectPrefillLines(SEK_RECEIPT, -1250, '1930'))
    expect(lines.find((line) => line.role === 'vat')?.debit_amount).toBe('250')
    expect(lines.find((line) => line.role === 'settlement')?.credit_amount).toBe('1250')

    lines = reconcileBookDirectLines(lines, buildBookDirectPrefillLines(SEK_RECEIPT, -1300, '1930'))
    expect(pairs(lines)).toEqual([
      { role: 'cost', account: '5410', debit: '1050', credit: '' },
      { role: 'vat', account: '2641', debit: '250', credit: '' },
      { role: 'settlement', account: '1930', debit: '', credit: '1300' },
    ])

    lines = reconcileBookDirectLines(lines, buildBookDirectPrefillLines(SEK_RECEIPT, null, '1930'))
    expect(lines.find((line) => line.role === 'vat')?.debit_amount).toBe('250')
    expect(lines.find((line) => line.role === 'settlement')?.credit_amount).toBe('1250')
    expect(lines.find((line) => line.role === 'cost')?.debit_amount).toBe('1000')
  })

  it('drops VAT without moving its account or dimensions onto settlement', () => {
    const current: BookDirectFormLine[] = [
      roleLine('cost', '5410', '1000', '', { account_edited: true, dimensions: { '1': 'COST' } }),
      roleLine('vat', '2645', '250', '', { account_edited: true, dimensions: { '1': 'VAT' } }),
      roleLine('settlement', '1931', '', '1250', { account_edited: true, generated_account: '1930', dimensions: { '1': 'BANK' } }),
    ]
    const next = [
      roleLine('cost', '', '1250', ''),
      roleLine('settlement', '1940', '', '1250'),
    ]

    const lines = reconcileBookDirectLines(current, next)

    expect(pairs(lines)).toEqual([
      { role: 'cost', account: '5410', debit: '1250', credit: '' },
      { role: 'settlement', account: '1931', debit: '', credit: '1250' },
    ])
    expect(lines[0]?.dimensions).toEqual({ '1': 'COST' })
    expect(lines[1]?.dimensions).toEqual({ '1': 'BANK' })
    expect(JSON.stringify(lines)).not.toContain('2645')
    expect(JSON.stringify(lines)).not.toContain('VAT')
  })

  it('gives a newly introduced VAT row its own default, including after a blank document', () => {
    const current: BookDirectFormLine[] = [
      roleLine('cost', '5410', '1000', '', { account_edited: true, dimensions: { '1': 'COST' } }),
      roleLine('settlement', '1931', '', '1000', { account_edited: true, generated_account: '1930', dimensions: { '1': 'BANK' } }),
    ]
    const next = buildBookDirectPrefillLines(SEK_RECEIPT, null, '1940')
    const lines = reconcileBookDirectLines(current, next)

    expect(pairs(lines)).toEqual([
      { role: 'cost', account: '5410', debit: '1000', credit: '' },
      { role: 'vat', account: '2641', debit: '250', credit: '' },
      { role: 'settlement', account: '1931', debit: '', credit: '1250' },
    ])
    expect(lines.find((line) => line.role === 'vat')?.dimensions).toBeUndefined()
    expect(lines.find((line) => line.role === 'cost')?.dimensions).toEqual({ '1': 'COST' })
    expect(lines.find((line) => line.role === 'settlement')?.dimensions).toEqual({ '1': 'BANK' })

    let blank = buildBookDirectPrefillLines(receipt({ total: null, vat: null }), null, '1930')
    blank = blank.map((line) => {
      if (line.role === 'cost') {
        return { ...withExplicitAccountEdit(line, { account_number: '5460' }), dimensions: { '6': 'P1' } }
      }
      if (line.role === 'settlement') return { ...line, dimensions: { '1': 'S' } }
      return line
    })
    const filled = reconcileBookDirectLines(blank, buildBookDirectPrefillLines(SEK_RECEIPT, null, '1940'))
    expect(filled.find((line) => line.role === 'cost')).toMatchObject({
      account_number: '5460',
      dimensions: { '6': 'P1' },
    })
    expect(filled.find((line) => line.role === 'vat')).toMatchObject({
      account_number: '2641',
      debit_amount: '250',
    })
    expect(filled.find((line) => line.role === 'vat')?.dimensions).toBeUndefined()
    expect(filled.find((line) => line.role === 'settlement')).toMatchObject({
      account_number: '1940',
      dimensions: { '1': 'S' },
    })
  })

  it('follows 1930 with the resolved cash account unless the user committed an account', () => {
    const seeded = buildBookDirectPrefillLines(SEK_RECEIPT, -1250, '1930').map((line) => {
      if (line.role === 'cost') {
        return { ...withExplicitAccountEdit(line, { account_number: '5410' }), dimensions: { '1': 'COST' } }
      }
      if (line.role === 'vat') {
        return { ...withExplicitAccountEdit(line, { account_number: '2640' }), dimensions: { '1': 'VAT' } }
      }
      return line
    })

    const followed = reconcileBookDirectLines(seeded, buildBookDirectPrefillLines(SEK_RECEIPT, -1250, '1940'))
    expect(followed.find((line) => line.role === 'settlement')).toMatchObject({
      account_number: '1940',
      generated_account: '1940',
      credit_amount: '1250',
    })
    expect(followed.find((line) => line.role === 'settlement')?.account_edited).toBeUndefined()
    expect(followed.find((line) => line.role === 'cost')).toMatchObject({
      account_number: '5410',
      dimensions: { '1': 'COST' },
    })
    expect(followed.find((line) => line.role === 'vat')).toMatchObject({
      account_number: '2640',
      dimensions: { '1': 'VAT' },
    })

    const committed = seeded.map((line) => (
      line.role === 'settlement' ? withExplicitAccountEdit(line, { account_number: '1930' }) : line
    ))
    const kept = reconcileBookDirectLines(committed, buildBookDirectPrefillLines(SEK_RECEIPT, -1250, '1940'))
    expect(kept.find((line) => line.role === 'settlement')?.account_number).toBe('1930')
    expect(kept.find((line) => line.role === 'cost')?.account_number).toBe('5410')
    expect(kept.find((line) => line.role === 'vat')?.account_number).toBe('2640')
  })

  it('preserves manual rows and does not give them a role from 2641 or a 19-prefix', () => {
    const manual = { account_number: '2641', debit_amount: '40', credit_amount: '' }
    const current = [
      ...chooseCost(buildBookDirectPrefillLines(SEK_RECEIPT, null, '1930'), '5410'),
      manual,
    ]
    const lines = reconcileBookDirectLines(current, buildBookDirectPrefillLines(SEK_RECEIPT, -1250, '1940'))

    expect(lines.filter((line) => line.role == null)).toEqual([manual])
    expect(lines.at(-1)).toEqual(manual)
    expect(lines.find((line) => line.role === 'settlement')?.account_number).toBe('1940')
    expect(lines.find((line) => line.role === 'vat')?.account_number).toBe('2641')
    expect(lines.find((line) => line.role === 'vat')?.debit_amount).toBe('250')
  })

  it('does not bring back a deleted VAT row: delete VAT, fill balance, pick -1250 gives cost 1250, bank 1250, no 2641', () => {
    const suppressed = new Set<BookDirectLineRole>()
    let lines = chooseCost(buildBookDirectPrefillLines(SEK_RECEIPT, null, '1930'), '5410')
    lines = deleteRole(lines, 'vat', suppressed)
    lines = fillCostBalance(lines)
    expect(sums(lines)).toEqual({ debit: 1250, credit: 1250, balanced: true })

    lines = reconcileBookDirectLines(
      lines,
      buildBookDirectPrefillLines(SEK_RECEIPT, -1250, '1930', { suppressedRoles: suppressed }),
    )
    expect(pairs(lines)).toEqual([
      { role: 'cost', account: '5410', debit: '1250', credit: '' },
      { role: 'settlement', account: '1930', debit: '', credit: '1250' },
    ])
    expect(sums(lines).balanced).toBe(true)
    expect(JSON.stringify(lines)).not.toContain('2641')

    // The cash account resolving, a different amount and clearing the
    // selection all re-run the prefill; none of them brings the row back.
    lines = reconcileBookDirectLines(
      lines,
      buildBookDirectPrefillLines(SEK_RECEIPT, -1300, '1940', { suppressedRoles: suppressed }),
    )
    expect(pairs(lines)).toEqual([
      { role: 'cost', account: '5410', debit: '1300', credit: '' },
      { role: 'settlement', account: '1940', debit: '', credit: '1300' },
    ])
    lines = reconcileBookDirectLines(
      lines,
      buildBookDirectPrefillLines(SEK_RECEIPT, null, '1940', { suppressedRoles: suppressed }),
    )
    expect(pairs(lines)).toEqual([
      { role: 'cost', account: '5410', debit: '1250', credit: '' },
      { role: 'settlement', account: '1940', debit: '', credit: '1250' },
    ])
  })

  it('does not move a deleted VAT row onto settlement, and keeps committed accounts, dimensions and manual rows', () => {
    const manual = { account_number: '6071', debit_amount: '15', credit_amount: '' }
    const current: BookDirectFormLine[] = [
      roleLine('cost', '5410', '1000', '', { account_edited: true, dimensions: { '1': 'COST' } }),
      roleLine('settlement', '1931', '', '1250', {
        account_edited: true,
        generated_account: '1930',
        dimensions: { '1': 'BANK' },
      }),
      manual,
    ]

    const lines = reconcileBookDirectLines(
      current,
      buildBookDirectPrefillLines(SEK_RECEIPT, -1250, '1940', { suppressedRoles: ['vat'] }),
    )

    expect(pairs(lines)).toEqual([
      { role: 'cost', account: '5410', debit: '1250', credit: '' },
      { role: 'settlement', account: '1931', debit: '', credit: '1250' },
      { role: null, account: '6071', debit: '15', credit: '' },
    ])
    expect(lines[0]?.dimensions).toEqual({ '1': 'COST' })
    expect(lines[1]?.dimensions).toEqual({ '1': 'BANK' })
    expect(lines.filter((line) => line.role == null)).toEqual([manual])
  })

  it('does not regenerate a deleted cost or settlement row; the remaining generated rows follow the transaction', () => {
    const costSuppressed = new Set<BookDirectLineRole>()
    let split: BookDirectFormLine[] = [
      ...buildBookDirectPrefillLines(SEK_RECEIPT, null, '1930'),
      { account_number: '5410', debit_amount: '600', credit_amount: '' },
      { account_number: '5460', debit_amount: '400', credit_amount: '' },
    ]
    split = deleteRole(split, 'cost', costSuppressed)
    split = reconcileBookDirectLines(
      split,
      buildBookDirectPrefillLines(SEK_RECEIPT, -1250, '1940', { suppressedRoles: costSuppressed }),
    )
    expect(pairs(split)).toEqual([
      { role: 'vat', account: '2641', debit: '250', credit: '' },
      { role: 'settlement', account: '1940', debit: '', credit: '1250' },
      { role: null, account: '5410', debit: '600', credit: '' },
      { role: null, account: '5460', debit: '400', credit: '' },
    ])
    expect(sums(split).balanced).toBe(true)

    const settlementSuppressed = new Set<BookDirectLineRole>()
    let own: BookDirectFormLine[] = [
      ...chooseCost(buildBookDirectPrefillLines(SEK_RECEIPT, null, '1930'), '5410'),
      { account_number: '2893', debit_amount: '', credit_amount: '1250' },
    ]
    own = deleteRole(own, 'settlement', settlementSuppressed)
    own = reconcileBookDirectLines(
      own,
      buildBookDirectPrefillLines(SEK_RECEIPT, -1250, '1940', { suppressedRoles: settlementSuppressed }),
    )
    expect(pairs(own)).toEqual([
      { role: 'cost', account: '5410', debit: '1000', credit: '' },
      { role: 'vat', account: '2641', debit: '250', credit: '' },
      { role: null, account: '2893', debit: '', credit: '1250' },
    ])
    expect(own.some((line) => line.account_number === '1940')).toBe(false)
  })

  it('does not replace a template, or a line set whose generated rows are gone, with a receipt prefill', () => {
    const template = manualBookDirectLines([
      { account_number: '5410', debit_amount: '800', credit_amount: '' },
      { account_number: '2641', debit_amount: '200', credit_amount: '' },
      { account_number: '1930', debit_amount: '', credit_amount: '1000' },
    ])
    const next = buildBookDirectPrefillLines(SEK_RECEIPT, -1250, '1940')

    expect(template.every((line) => line.role == null && line.generated_account == null)).toBe(true)
    expect(reconcileBookDirectLines(template, next)).toBe(template)

    const deletedDownToManual = [
      { account_number: '4010', debit_amount: '10', credit_amount: '' },
      { account_number: '1930', debit_amount: '', credit_amount: '10' },
    ]
    expect(reconcileBookDirectLines(deletedDownToManual, next)).toBe(deletedDownToManual)
  })
})

describe('applyCostAccountSuggestion', () => {
  it('fills only a present, empty, unedited generated cost row', () => {
    const suggested = applyCostAccountSuggestion(buildBookDirectPrefillLines(SEK_RECEIPT), '5410')
    expect(suggested.find((line) => line.role === 'cost')?.account_number).toBe('5410')
    expect(suggested.find((line) => line.role === 'vat')?.account_number).toBe('2641')

    const kept = reconcileBookDirectLines(suggested, buildBookDirectPrefillLines(SEK_RECEIPT, -1250, '1940'))
    expect(kept.find((line) => line.role === 'cost')?.account_number).toBe('5410')
    expect(kept.find((line) => line.role === 'settlement')?.account_number).toBe('1940')
  })

  it('does not write a manual, template or already-filled cost row, even when it is not first', () => {
    const manualFirst: BookDirectFormLine[] = [
      { account_number: '', debit_amount: '', credit_amount: '' },
      ...buildBookDirectPrefillLines(SEK_RECEIPT),
    ]
    const filled = applyCostAccountSuggestion(manualFirst, '5410')
    expect(filled[0]?.account_number).toBe('')
    expect(filled.find((line) => line.role === 'cost')?.account_number).toBe('5410')

    const template = manualBookDirectLines([
      { account_number: '', debit_amount: '100', credit_amount: '' },
      { account_number: '1930', debit_amount: '', credit_amount: '100' },
    ])
    expect(applyCostAccountSuggestion(template, '5410')).toBe(template)

    const chosen = chooseCost(buildBookDirectPrefillLines(SEK_RECEIPT), '5420')
    expect(applyCostAccountSuggestion(chosen, '5410')).toBe(chosen)

    const cleared = buildBookDirectPrefillLines(SEK_RECEIPT).map((line) => (
      line.role === 'cost' ? withExplicitAccountEdit(line, { account_number: '' }) : line
    ))
    expect(applyCostAccountSuggestion(cleared, '5410')).toBe(cleared)

    const seeded = buildBookDirectPrefillLines(SEK_RECEIPT)
    expect(applyCostAccountSuggestion(seeded, '  ')).toBe(seeded)
  })
})

describe('withExplicitAccountEdit', () => {
  it('records an account commit even when the value equals the generated default', () => {
    const [settlement] = buildBookDirectPrefillLines(SEK_RECEIPT).filter((line) => line.role === 'settlement')
    expect(settlement?.account_number).toBe('1930')

    const edited = withExplicitAccountEdit(settlement!, { account_number: '1930' })
    expect(edited.account_edited).toBe(true)
    expect(edited.account_number).toBe('1930')

    const amountOnly = withExplicitAccountEdit(settlement!, { credit_amount: '1' })
    expect(amountOnly.account_edited).toBeUndefined()
    expect(amountOnly.credit_amount).toBe('1')
  })
})

describe('manualBookDirectLines and toBookDirectPayloadLine', () => {
  it('serializes account, amounts and dimensions and drops role and provenance', () => {
    const line: BookDirectFormLine = {
      role: 'vat',
      account_number: ' 2641 ',
      debit_amount: '250',
      credit_amount: '',
      dimensions: { '1': 'A' },
      generated_account: '2641',
      account_edited: true,
    }
    const payload = toBookDirectPayloadLine(line)

    expect(payload).toEqual({
      account_number: '2641',
      debit_amount: 250,
      credit_amount: 0,
      dimensions: { '1': 'A' },
    })
    expect('role' in payload).toBe(false)
    expect('generated_account' in payload).toBe(false)
    expect('account_edited' in payload).toBe(false)
    expect(toBookDirectPayloadLine({ ...line, dimensions: {} }).dimensions).toBeUndefined()
  })

  it('tags neither 2641 nor a 19-account when a template is applied', () => {
    const lines = manualBookDirectLines([
      { account_number: '2641', debit_amount: '250', credit_amount: '' },
      { account_number: '1930', debit_amount: '', credit_amount: '1250' },
    ])
    expect(lines).toEqual([
      { account_number: '2641', debit_amount: '250', credit_amount: '' },
      { account_number: '1930', debit_amount: '', credit_amount: '1250' },
    ])
  })
})
