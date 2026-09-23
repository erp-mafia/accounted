import { describe, it, expect } from 'vitest'
import { plantedRowTouched, snapshotPlantedRow } from '@/lib/supplier-invoices/planted-rows'
import type { SupplierInvoiceLineItem } from '@/lib/supplier-invoices/form-payload'

function plantedRow(overrides: Partial<SupplierInvoiceLineItem> = {}): SupplierInvoiceLineItem {
  return {
    description: 'Programvaror',
    amount: 0,
    account_number: '5420',
    vat_rate: 0.25,
    reverse_charge_rate: 0.25,
    ...overrides,
  }
}

describe('plantedRowTouched', () => {
  it('is false for a row identical to its snapshot', () => {
    const snapshot = snapshotPlantedRow(plantedRow())
    expect(plantedRowTouched(plantedRow(), snapshot)).toBe(false)
  })

  it('is true when the user typed an amount', () => {
    const snapshot = snapshotPlantedRow(plantedRow())
    expect(plantedRowTouched(plantedRow({ amount: 1250 }), snapshot)).toBe(true)
  })

  // The review finding: description/moms/dimensions edits on a 0-amount
  // planted row were treated as untouched and the row was deleted on a
  // supplier switch.
  it('is true when the user edited the description with amount still 0', () => {
    const snapshot = snapshotPlantedRow(plantedRow())
    expect(plantedRowTouched(plantedRow({ description: 'Licens Q3' }), snapshot)).toBe(true)
  })

  it('is true when the user changed the moms rate with amount still 0', () => {
    const snapshot = snapshotPlantedRow(plantedRow())
    expect(plantedRowTouched(plantedRow({ vat_rate: 0.12 }), snapshot)).toBe(true)
  })

  it('is true when the user set dimensions with amount still 0', () => {
    const snapshot = snapshotPlantedRow(plantedRow())
    expect(plantedRowTouched(plantedRow({ dimensions: { '1': 'STO' } }), snapshot)).toBe(true)
  })

  it('is true when the user opened periodisering with amount still 0', () => {
    const snapshot = snapshotPlantedRow(plantedRow())
    expect(
      plantedRowTouched(
        plantedRow({
          accrual_period_start: '2026-08-01',
          accrual_period_end: '2026-10-31',
          accrual_balance_account: '1790',
        }),
        snapshot,
      ),
    ).toBe(true)
  })

  it('is true when the user opted into SLP with amount still 0', () => {
    const snapshot = snapshotPlantedRow(plantedRow({ account_number: '7410' }))
    expect(
      plantedRowTouched(plantedRow({ account_number: '7410', apply_slp: true }), snapshot),
    ).toBe(true)
  })

  it('treats an open-but-empty dimensions bag as untouched', () => {
    const snapshot = snapshotPlantedRow(plantedRow())
    expect(plantedRowTouched(plantedRow({ dimensions: {} }), snapshot)).toBe(false)
  })

  it('ignores account_number: the caller keys on it separately', () => {
    const snapshot = snapshotPlantedRow(plantedRow())
    expect(plantedRowTouched(plantedRow({ account_number: '4010' }), snapshot)).toBe(false)
  })
})

describe('snapshotPlantedRow', () => {
  it('does not alias the live row or its dimensions bag', () => {
    const row = plantedRow({ dimensions: { '1': 'STO' } })
    const snapshot = snapshotPlantedRow(row)
    row.description = 'edited'
    row.dimensions!['1'] = 'GBG'
    expect(snapshot.description).toBe('Programvaror')
    expect(snapshot.dimensions).toEqual({ '1': 'STO' })
  })
})
