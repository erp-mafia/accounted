import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { askAboutBankHeldPayments } from '../bank-held-payments-client'

/**
 * What a dialog asks before its confirm (GET /api/supplier-invoices/bank-held-payments):
 * in slices the route takes, never longer than its timeout, and a check that did not
 * run is said as one, never as "nothing held".
 */

const SIGNED = {
  code: 'SI_SIGNED_BANK_PAYMENT',
  message_sv: 'Leverantörsfaktura F-1 har en betalning via banken som är signerad eller signeras just nu.',
  message_en: 'Supplier invoice F-1 has a bank payment that is signed or being signed.',
  payment_order_id: 'order-1',
  supplier_invoice_id: 'si-1',
}
const CHECK_FAILED = { code: 'SI_BANK_PAYMENT_CHECK_FAILED', message_sv: 'x', message_en: 'x' }

const fetchMock = vi.fn()

function answer(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data }), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('askAboutBankHeldPayments', () => {
  it('asks the route for the invoices and how they are settled, and answers its warnings', async () => {
    fetchMock.mockResolvedValueOnce(answer({ warnings: [SIGNED], failed: false }))

    expect(await askAboutBankHeldPayments(['si-1', 'si-2'], 'bank_row')).toEqual({ warnings: [SIGNED], failed: false })

    const url = new URL(String(fetchMock.mock.calls[0]![0]), 'http://app.test')
    expect(url.pathname).toBe('/api/supplier-invoices/bank-held-payments')
    expect(url.searchParams.get('ids')).toBe('si-1,si-2')
    expect(url.searchParams.get('via')).toBe('bank_row')
  })

  it('asks in slices of 100 invoices, the most a request takes, and merges the answers in order', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `si-${i}`)
    fetchMock
      .mockResolvedValueOnce(answer({ warnings: [SIGNED], failed: false }))
      .mockResolvedValueOnce(answer({ warnings: [{ ...SIGNED, payment_order_id: 'order-2', supplier_invoice_id: 'si-100' }], failed: false }))

    const result = await askAboutBankHeldPayments(ids, 'other')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const asked = fetchMock.mock.calls.map(([url]) => new URL(String(url), 'http://app.test').searchParams.get('ids')!.split(',').length)
    expect(asked).toEqual([100, 1])
    expect(result.warnings.map((w) => w.payment_order_id)).toEqual(['order-1', 'order-2'])
    expect(result.failed).toBe(false)
  })

  it('a check the server could not run is failed: the dialog says it in its own words', async () => {
    fetchMock.mockResolvedValueOnce(answer({ warnings: [CHECK_FAILED], failed: true }))

    expect(await askAboutBankHeldPayments(['si-1'], 'bank_row')).toEqual({ warnings: [], failed: true })
  })

  it('an answer that is not 200 is failed', async () => {
    fetchMock.mockResolvedValueOnce(answer({ error: 'nope' }, 503))

    expect(await askAboutBankHeldPayments(['si-1'], 'bank_row')).toEqual({ warnings: [], failed: true })
  })

  it('no answer at all is failed', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    expect(await askAboutBankHeldPayments(['si-1'], 'bank_row')).toEqual({ warnings: [], failed: true })
  })

  it('no answer in time is failed, and the request is given up: a confirm waits no longer', async () => {
    let signal: AbortSignal | undefined
    fetchMock.mockImplementationOnce(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          signal = init.signal
          init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )

    expect(await askAboutBankHeldPayments(['si-1'], 'bank_row', 20)).toEqual({ warnings: [], failed: true })
    expect(signal?.aborted).toBe(true)
  })
})
