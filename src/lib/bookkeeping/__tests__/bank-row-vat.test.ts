/**
 * One bank row, one reading of its moms, whichever of the category and the
 * catalog template decided the booking. Each used to write the moms itself;
 * every case below runs through both.
 */
import { describe, it, expect } from 'vitest'
import { makeTransaction } from '@/tests/helpers'
import { buildMappingResultFromCategory } from '../category-mapping'
import { BOOKING_TEMPLATES, buildMappingResultFromTemplate } from '../booking-templates'
import { buildTransactionEntryLines } from '../transaction-entries'
import { rutorFromTotals } from '@/lib/reports/vat-declaration'
import type { MappingResult, Transaction, VatTreatment } from '@/types'

type Line = [account: string, debit: number, credit: number]

const posted = (tx: Transaction, result: MappingResult): Line[] =>
  buildTransactionEntryLines(tx, result)
    .map((l): Line => [l.account_number, l.debit_amount, l.credit_amount])
    .sort((a, b) => a[0].localeCompare(b[0]))

const row = (amount: number) => makeTransaction({ amount, currency: 'SEK', amount_sek: amount })

const catalogSale = (treatment: VatTreatment) =>
  BOOKING_TEMPLATES.find((t) => t.direction === 'income' && t.vat_treatment === treatment)!

const revenueOf = { standard_25: '3001', reduced_12: '3002', reduced_6: '3003' } as const
const outputOf = { standard_25: '2611', reduced_12: '2621', reduced_6: '2631' } as const

const sales = [
  { treatment: 'standard_25', gross: 1250, net: 1000, vat: 250 },
  { treatment: 'reduced_12', gross: 1120, net: 1000, vat: 120 },
  { treatment: 'reduced_6', gross: 1060, net: 1000, vat: 60 },
] as const

describe.each(sales)('a sale at $treatment from a bank row', ({ treatment, gross, net, vat }) => {
  const revenue = revenueOf[treatment]
  const output = outputOf[treatment]
  const sale: Line[] = [['1930', gross, 0], [output, 0, vat], [revenue, 0, net]]
  const refund: Line[] = [['1930', 0, gross], [output, vat, 0], [revenue, net, 0]]
  const sorted = (lines: Line[]) => [...lines].sort((a, b) => a[0].localeCompare(b[0]))

  it('the category credits net revenue and output VAT', () => {
    const tx = row(gross)
    expect(posted(tx, buildMappingResultFromCategory('income_services', tx, true, 'aktiebolag', treatment))).toEqual(sorted(sale))
  })

  it('the catalog template credits the same', () => {
    const tx = row(gross)
    expect(posted(tx, buildMappingResultFromTemplate(catalogSale(treatment), tx, 'aktiebolag'))).toEqual(sorted(sale))
  })

  it('the category takes it back on a refund', () => {
    const tx = row(-gross)
    expect(posted(tx, buildMappingResultFromCategory('income_services', tx, true, 'aktiebolag', treatment))).toEqual(sorted(refund))
  })
})

describe('a purchase from a bank row', () => {
  const purchase: Line[] = [['1930', 0, 1250], ['2641', 250, 0], ['6110', 1000, 0]]

  it('the category and the catalog template debit the same ingående moms', () => {
    const tx = row(-1250)
    const catalog = BOOKING_TEMPLATES.find((t) => t.id === 'office_supplies_general')!
    expect(posted(tx, buildMappingResultFromCategory('expense_office', tx, true, 'aktiebolag', 'standard_25'))).toEqual(purchase)
    expect(posted(tx, buildMappingResultFromTemplate(catalog, tx, 'aktiebolag'))).toEqual(purchase)
  })
})

describe('the momsdeklaration reads the same sale from either source', () => {
  const rutorOf = (rows: Array<[Transaction, MappingResult]>) => {
    const totals = new Map<string, { debit: number; credit: number }>()
    for (const [tx, result] of rows) {
      for (const [account, debit, credit] of posted(tx, result)) {
        const total = totals.get(account) ?? { debit: 0, credit: 0 }
        totals.set(account, { debit: total.debit + debit, credit: total.credit + credit })
      }
    }
    return rutorFromTotals(totals)
  }
  const onCategory = (amount: number): [Transaction, MappingResult] => {
    const tx = row(amount)
    return [tx, buildMappingResultFromCategory('income_services', tx, true, 'aktiebolag', 'standard_25')]
  }
  const onCatalog = (amount: number): [Transaction, MappingResult] => {
    const tx = row(amount)
    return [tx, buildMappingResultFromTemplate(catalogSale('standard_25'), tx, 'aktiebolag')]
  }

  it('ruta 05 and ruta 10 of a sale', () => {
    const rutor = rutorOf([onCatalog(1250)])
    expect(rutor).toMatchObject({ ruta05: 1000, ruta10: 250, ruta49: 250 })
    expect(rutor).toEqual(rutorOf([onCategory(1250)]))
  })

  it('a refund comes back out of the same boxes', () => {
    expect(rutorOf([onCategory(1250), onCategory(-250)])).toMatchObject({ ruta05: 800, ruta10: 200, ruta49: 200 })
  })
})

describe('no moms where none is due', () => {
  it('a sale under reverse charge books no moms in either direction', () => {
    for (const amount of [1250, -1250]) {
      const tx = row(amount)
      const lines = posted(tx, buildMappingResultFromCategory('income_services', tx, true, 'aktiebolag', 'reverse_charge'))
      expect(lines.map(([account]) => account)).toEqual(['1930', '3308'])
    }
  })

  // The Swedish skills state no posting for this one: holding the set back on
  // a category is the decision of 2026-10-10 (crm#1136).
  it('a supplier refund under reverse charge stays gross on a category', () => {
    const tx = row(1000)
    const category = buildMappingResultFromCategory('expense_software', tx, true, 'aktiebolag', 'reverse_charge')
    expect(posted(tx, category)).toEqual([['1930', 1000, 0], ['5420', 0, 1000]])
  })
})
