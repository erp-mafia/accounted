/**
 * Actuals replace forecasts: an arriving bank row that pays an open forecast
 * row realises it, by Arkiv's rule (same amount to the öre, SEK, within ten
 * days, the right sign; a name proves it, one amount hit is taken alone, two
 * are nobody's). The pure pairing runs on its own; the loader runs against
 * the queued mock to pin what it reads and writes.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { pickRealisations, realiseForecastRows, type ArrivedBankRow, type RealisableForecastRow } from '../realise'

function row(over: Partial<RealisableForecastRow> = {}): RealisableForecastRow {
  return {
    id: 'row-1',
    expected_date: '2026-11-20',
    amount: 48000,
    direction: 'in',
    currency: 'SEK',
    note: null,
    external_source: null,
    ...over,
  }
}

function bank(over: Partial<ArrivedBankRow> = {}): ArrivedBankRow {
  return {
    id: 'tx-1',
    date: '2026-11-18',
    amount: 48000,
    currency: 'SEK',
    description: 'INSATTNING',
    original_description: null,
    merchant_name: null,
    is_ignored: false,
    ...over,
  }
}

describe('pickRealisations', () => {
  it('takes the only bank row with the amount, within the tolerance, as a guess', () => {
    expect(pickRealisations([row()], [bank()])).toEqual([{ cashForecastRowId: 'row-1', transactionId: 'tx-1', basis: 'guessed' }])
  })

  it('is proven when the bank text names the row\'s note', () => {
    const picks = pickRealisations([row({ direction: 'out', amount: 18750, note: 'Kvarnen' })], [bank({ amount: -18750, description: 'KVARNEN FASTIGHETS AB' })])
    expect(picks).toEqual([{ cashForecastRowId: 'row-1', transactionId: 'tx-1', basis: 'proven' }])
  })

  it('lets a name decide between two bank rows of the same amount', () => {
    const picks = pickRealisations(
      [row({ note: 'Boom' })],
      [bank({ id: 'tx-a', description: 'SWISH OKAND' }), bank({ id: 'tx-b', description: 'BOOM PAYOUT' })],
    )
    expect(picks).toEqual([{ cashForecastRowId: 'row-1', transactionId: 'tx-b', basis: 'proven' }])
  })

  it('takes nothing when two bank rows fit and neither is named', () => {
    expect(pickRealisations([row()], [bank({ id: 'tx-a' }), bank({ id: 'tx-b' })])).toEqual([])
  })

  it('needs the amount to the öre, the right sign, SEK and the date within ten days', () => {
    expect(pickRealisations([row()], [bank({ amount: 48000.01 })])).toEqual([])
    expect(pickRealisations([row()], [bank({ amount: -48000 })])).toEqual([])
    expect(pickRealisations([row({ direction: 'out' })], [bank({ amount: 48000 })])).toEqual([])
    expect(pickRealisations([row()], [bank({ currency: 'EUR' })])).toEqual([])
    expect(pickRealisations([row()], [bank({ date: '2026-11-09' })])).toEqual([])
    expect(pickRealisations([row()], [bank({ date: '2026-12-01' })])).toEqual([])
    // Ten days either side is inside.
    expect(pickRealisations([row()], [bank({ date: '2026-11-10' })])).toHaveLength(1)
    expect(pickRealisations([row()], [bank({ date: '2026-11-30' })])).toHaveLength(1)
    // A bank row without a currency is SEK.
    expect(pickRealisations([row()], [bank({ currency: null })])).toHaveLength(1)
  })

  it('reads a numeric string amount as the database sends it', () => {
    expect(pickRealisations([row({ amount: '48000.00' })], [bank({ amount: '48000.00' })])).toHaveLength(1)
  })

  it('never uses an ignored bank row or one that realised a row already', () => {
    expect(pickRealisations([row()], [bank({ is_ignored: true })])).toEqual([])
    expect(pickRealisations([row()], [bank()], new Set(['tx-1']))).toEqual([])
  })

  it('gives one bank row to one forecast row, the earliest first', () => {
    const picks = pickRealisations(
      [row({ id: 'row-late', expected_date: '2026-11-24' }), row({ id: 'row-early', expected_date: '2026-11-16' })],
      [bank()],
    )
    expect(picks).toEqual([{ cashForecastRowId: 'row-early', transactionId: 'tx-1', basis: 'guessed' }])
  })

  it('pairs each of two rows with its own bank row', () => {
    const picks = pickRealisations(
      [row({ id: 'rent', direction: 'out', amount: 18750, expected_date: '2026-11-01' }), row({ id: 'booking', amount: 9200 })],
      [bank({ id: 'tx-rent', amount: -18750, date: '2026-10-31' }), bank({ id: 'tx-booking', amount: 9200 })],
    )
    expect(picks).toEqual([
      { cashForecastRowId: 'rent', transactionId: 'tx-rent', basis: 'guessed' },
      { cashForecastRowId: 'booking', transactionId: 'tx-booking', basis: 'guessed' },
    ])
  })
})

describe('realiseForecastRows', () => {
  const { supabase, enqueue, findCall, findCalls, reset } = createQueuedMockSupabase()

  beforeEach(() => reset())

  it('reads open unlinked rows around the arrivals and marks the paid one realised', async () => {
    enqueue({ data: [row()] }) // open rows in the window
    enqueue({ data: [] }) // arrivals that realised a row already
    enqueue({ data: [{ id: 'row-1' }] }) // the update

    const summary = await realiseForecastRows(supabase as never, 'company-1', [bank()])

    expect(summary).toEqual({ checked: 1, realised: 1 })
    const eqs = findCalls('cash_forecast_rows', 'eq')
    expect(eqs).toContainEqual(['company_id', 'company-1'])
    expect(eqs).toContainEqual(['status', 'open'])
    expect(findCalls('cash_forecast_rows', 'is')).toEqual([
      ['invoice_id', null],
      ['supplier_invoice_id', null],
    ])
    // The arrival on 2026-11-18, ten days either way.
    expect(findCall('cash_forecast_rows', 'gte')).toEqual(['expected_date', '2026-11-08'])
    expect(findCall('cash_forecast_rows', 'lte')).toEqual(['expected_date', '2026-11-28'])
    expect(findCall('cash_forecast_rows', 'in')).toEqual(['matched_transaction_id', ['tx-1']])
    expect(findCall('cash_forecast_rows', 'update')).toEqual([{ status: 'realised', matched_transaction_id: 'tx-1' }])
    // Compare-and-set: a row cancelled meanwhile stays cancelled.
    expect(eqs).toContainEqual(['id', 'row-1'])
    expect(eqs.filter(([column]) => column === 'status')).toHaveLength(2)
  })

  it('does not count a row another writer closed first', async () => {
    enqueue({ data: [row()] })
    enqueue({ data: [] })
    enqueue({ data: [] }) // the compare-and-set matched nothing

    expect(await realiseForecastRows(supabase as never, 'company-1', [bank()])).toEqual({ checked: 1, realised: 0 })
  })

  it('leaves a bank row alone that realised a row on an earlier delivery', async () => {
    enqueue({ data: [row({ id: 'row-2' })] })
    enqueue({ data: [{ matched_transaction_id: 'tx-1' }] })

    expect(await realiseForecastRows(supabase as never, 'company-1', [bank()])).toEqual({ checked: 1, realised: 0 })
    expect(findCall('cash_forecast_rows', 'update')).toBeUndefined()
  })

  it('reads nothing for an arrival of ignored rows only', async () => {
    expect(await realiseForecastRows(supabase as never, 'company-1', [bank({ is_ignored: true })])).toEqual({ checked: 0, realised: 0 })
    expect(findCall('cash_forecast_rows', 'select')).toBeUndefined()
  })

  it('throws on a failed write so an outbox delivery is retried', async () => {
    enqueue({ data: [row()] })
    enqueue({ data: [] })
    enqueue({ error: { message: 'boom' } })

    await expect(realiseForecastRows(supabase as never, 'company-1', [bank()])).rejects.toThrow('forecast row update failed: boom')
  })
})
