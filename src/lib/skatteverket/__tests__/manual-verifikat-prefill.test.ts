import { describe, expect, it } from 'vitest'
import {
  buildSkvPrefillLines,
  stageSkvManualPrefill,
  takeSkvManualPrefill,
  type PrefillStorage,
} from '@/lib/skatteverket/manual-verifikat-prefill'

const ROW = {
  id: '4f9c2b1a-0d3e-4c5b-8a7f-1e2d3c4b5a69',
  transaktionsdatum: '2026-07-13',
  transaktionstext: 'Slutlig skatt',
  belopp_skatteverket: '-2546',
}

function fakeStorage(): PrefillStorage {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

function idOf(url: string): string | null {
  return new URL(url, 'http://localhost').searchParams.get('skv_tx')
}

describe('stageSkvManualPrefill + takeSkvManualPrefill', () => {
  it('round-trips a row through storage and exposes only the id in the URL', () => {
    const storage = fakeStorage()
    const url = stageSkvManualPrefill(ROW, '1630', storage)
    expect(url).toBe(`/bookkeeping?skv_tx=${ROW.id}`)
    for (const leak of ['2546', 'Slutlig', '2026-07-13']) {
      expect(url).not.toContain(leak)
    }
    expect(takeSkvManualPrefill(idOf(url), storage)).toEqual({
      transactionId: ROW.id,
      date: '2026-07-13',
      text: 'Slutlig skatt',
      amount: -2546,
      account: '1630',
    })
  })

  it('is single-use: a second take returns null', () => {
    const storage = fakeStorage()
    const url = stageSkvManualPrefill(ROW, '1630', storage)
    expect(takeSkvManualPrefill(idOf(url), storage)).not.toBeNull()
    expect(takeSkvManualPrefill(idOf(url), storage)).toBeNull()
  })

  it('rejects a missing or malformed transaction id', () => {
    const storage = fakeStorage()
    stageSkvManualPrefill(ROW, '1630', storage)
    expect(takeSkvManualPrefill(null, storage)).toBeNull()
    expect(takeSkvManualPrefill('not-a-uuid', storage)).toBeNull()
  })

  it('rejects a payload staged for a different row id', () => {
    const storage = fakeStorage()
    stageSkvManualPrefill(ROW, '1630', storage)
    const otherId = '9f9c2b1a-0d3e-4c5b-8a7f-1e2d3c4b5a00'
    expect(takeSkvManualPrefill(otherId, storage)).toBeNull()
    // The mismatched attempt consumed the payload: single-use holds.
    expect(takeSkvManualPrefill(ROW.id, storage)).toBeNull()
  })

  it('rejects missing storage, missing payload, and malformed JSON', () => {
    expect(takeSkvManualPrefill(ROW.id, null)).toBeNull()
    expect(takeSkvManualPrefill(ROW.id, fakeStorage())).toBeNull()
    const storage = fakeStorage()
    storage.setItem('accounted.skv-manual-prefill', '{not json')
    expect(takeSkvManualPrefill(ROW.id, storage)).toBeNull()
  })

  it('rejects a malformed date and a zero or non-numeric amount', () => {
    for (const row of [
      { ...ROW, transaktionsdatum: '13/07/2026' },
      { ...ROW, belopp_skatteverket: '0' },
      { ...ROW, belopp_skatteverket: 'abc' },
      { ...ROW, belopp_skatteverket: '' },
    ]) {
      const storage = fakeStorage()
      const url = stageSkvManualPrefill(row, '1630', storage)
      expect(takeSkvManualPrefill(idOf(url), storage)).toBeNull()
    }
  })

  it('preserves text needing no URL encoding since it never enters the URL', () => {
    const storage = fakeStorage()
    const url = stageSkvManualPrefill(
      { ...ROW, transaktionstext: 'Omprövningsbeslut & ränta 50%' },
      '1630',
      storage,
    )
    expect(takeSkvManualPrefill(idOf(url), storage)?.text).toBe(
      'Omprövningsbeslut & ränta 50%',
    )
  })

  it('carries the skattekonto account and refuses a payload without one (PH 175)', () => {
    const storage = fakeStorage()
    const url = stageSkvManualPrefill(ROW, '2012', storage)
    expect(takeSkvManualPrefill(idOf(url), storage)?.account).toBe('2012')

    // A payload staged before the account existed prefills nothing rather
    // than guess 1630 for a firm on 2012.
    const old = fakeStorage()
    old.setItem(
      'accounted.skv-manual-prefill',
      JSON.stringify({ transactionId: ROW.id, date: ROW.transaktionsdatum, text: 'x', amount: -1 }),
    )
    expect(takeSkvManualPrefill(ROW.id, old)).toBeNull()
  })

  it('survives a storage that throws (privacy mode): URL still built, take returns null', () => {
    const throwing: PrefillStorage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    }
    const url = stageSkvManualPrefill(ROW, '1630', throwing)
    expect(idOf(url)).toBe(ROW.id)
    expect(takeSkvManualPrefill(ROW.id, throwing)).toBeNull()
  })
})

describe('buildSkvPrefillLines', () => {
  it('credits 1630 and pre-fills a debit counter line for a negative belopp', () => {
    const lines = buildSkvPrefillLines({
      transactionId: ROW.id,
      date: '2026-07-13',
      text: 'Slutlig skatt',
      amount: -2546,
      account: '1630',
    })
    expect(lines).toEqual([
      {
        account_number: '1630',
        debit_amount: '',
        credit_amount: '2546.00',
        line_description: 'Slutlig skatt',
      },
      {
        account_number: '',
        debit_amount: '2546.00',
        credit_amount: '',
        line_description: '',
      },
    ])
  })

  it('puts the skattekonto line on 2012 for an enskild firma that runs it there', () => {
    const lines = buildSkvPrefillLines({
      transactionId: ROW.id,
      date: '2026-07-13',
      text: 'Debiterad preliminärskatt',
      amount: -2500,
      account: '2012',
    })
    expect(lines[0]).toMatchObject({ account_number: '2012', credit_amount: '2500.00' })
  })

  it('debits 1630 for a positive belopp', () => {
    const lines = buildSkvPrefillLines({
      transactionId: ROW.id,
      date: '2026-07-13',
      text: 'Intäktsränta',
      amount: 1.5,
      account: '1630',
    })
    expect(lines[0].debit_amount).toBe('1.50')
    expect(lines[0].credit_amount).toBe('')
    expect(lines[1].credit_amount).toBe('1.50')
  })

  it('rounds öre drift before formatting', () => {
    const lines = buildSkvPrefillLines({
      transactionId: ROW.id,
      date: '2026-07-13',
      text: 'Ränta',
      // 1409.1 * 100 = 140910.00000000003 territory: the classic float trap
      amount: -1409.1,
      account: '1630',
    })
    expect(lines[0].credit_amount).toBe('1409.10')
  })
})
