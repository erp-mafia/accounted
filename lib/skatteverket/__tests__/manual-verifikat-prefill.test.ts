import { describe, expect, it } from 'vitest'
import {
  buildSkvManualCreateUrl,
  buildSkvPrefillLines,
  parseSkvManualParams,
} from '@/lib/skatteverket/manual-verifikat-prefill'

const ROW = {
  id: '4f9c2b1a-0d3e-4c5b-8a7f-1e2d3c4b5a69',
  transaktionsdatum: '2026-07-13',
  transaktionstext: 'Slutlig skatt',
  belopp_skatteverket: '-2546',
}

function paramsOf(url: string): URLSearchParams {
  return new URL(url, 'http://localhost').searchParams
}

describe('buildSkvManualCreateUrl + parseSkvManualParams', () => {
  it('round-trips a row through the URL', () => {
    const url = buildSkvManualCreateUrl(ROW)
    expect(url.startsWith('/bookkeeping?')).toBe(true)
    const parsed = parseSkvManualParams(paramsOf(url))
    expect(parsed).toEqual({
      transactionId: ROW.id,
      date: '2026-07-13',
      text: 'Slutlig skatt',
      amount: -2546,
    })
  })

  it('survives characters that need URL encoding in the text', () => {
    const url = buildSkvManualCreateUrl({
      ...ROW,
      transaktionstext: 'Omprövningsbeslut & ränta 50%',
    })
    expect(parseSkvManualParams(paramsOf(url))?.text).toBe(
      'Omprövningsbeslut & ränta 50%',
    )
  })

  it('rejects a missing or malformed transaction id', () => {
    expect(parseSkvManualParams(new URLSearchParams())).toBeNull()
    const url = buildSkvManualCreateUrl({ ...ROW, id: 'not-a-uuid' })
    expect(parseSkvManualParams(paramsOf(url))).toBeNull()
  })

  it('rejects a malformed date', () => {
    const url = buildSkvManualCreateUrl({ ...ROW, transaktionsdatum: '13/07/2026' })
    expect(parseSkvManualParams(paramsOf(url))).toBeNull()
  })

  it('rejects a zero or non-numeric amount', () => {
    for (const belopp of ['0', 'abc', '']) {
      const url = buildSkvManualCreateUrl({ ...ROW, belopp_skatteverket: belopp })
      expect(parseSkvManualParams(paramsOf(url))).toBeNull()
    }
  })
})

describe('buildSkvPrefillLines', () => {
  it('credits 1630 and pre-fills a debit counter line for a negative belopp', () => {
    const lines = buildSkvPrefillLines({
      transactionId: ROW.id,
      date: '2026-07-13',
      text: 'Slutlig skatt',
      amount: -2546,
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

  it('debits 1630 for a positive belopp', () => {
    const lines = buildSkvPrefillLines({
      transactionId: ROW.id,
      date: '2026-07-13',
      text: 'Intäktsränta',
      amount: 1.5,
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
    })
    expect(lines[0].credit_amount).toBe('1409.10')
  })
})
