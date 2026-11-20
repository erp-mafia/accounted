import { describe, it, expect, vi } from 'vitest'
import { continueInvoiceSeries, readNextNumberPreview } from '../next-number-preview'

describe('readNextNumberPreview', () => {
  it('reads the number the next invoice gets', () => {
    expect(readNextNumberPreview({ data: { preview: 'F-012', behind: false } })).toEqual({
      preview: 'F-012',
      continuation: null,
    })
  })

  it('reads the continuation when the series is behind', () => {
    expect(
      readNextNumberPreview({
        data: { preview: null, behind: true, highest_number: '114647', first_allowed: 114648, continue_number: '114648' },
      }),
    ).toEqual({
      preview: null,
      continuation: { number: '114648', highest: '114647', nextInvoiceNumber: 114648 },
    })
  })

  it('never shows free-form text or a malformed continuation', () => {
    expect(readNextNumberPreview({ data: { preview: '<script>' } }).preview).toBeNull()
    expect(
      readNextNumberPreview({
        data: { behind: true, highest_number: '114647', first_allowed: '114648', continue_number: '114648' },
      }).continuation,
    ).toBeNull()
    expect(readNextNumberPreview(null)).toEqual({ preview: null, continuation: null })
    expect(readNextNumberPreview({})).toEqual({ preview: null, continuation: null })
  })
})

describe('continueInvoiceSeries', () => {
  const continuation = { number: '669', highest: '668', nextInvoiceNumber: 669 }

  it('saves the continuing number as next_invoice_number', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))

    await expect(continueInvoiceSeries(continuation, fetchImpl)).resolves.toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledWith('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ next_invoice_number: 669 }),
    })
  })

  it("hands back a refused save's body for the error message", async () => {
    const body = { error: { code: 'FORBIDDEN', message: 'Bara ägare eller administratör.' } }
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 403 }))

    await expect(continueInvoiceSeries(continuation, fetchImpl)).resolves.toEqual({ ok: false, error: body })
  })

  it('reports a request that never got an answer', async () => {
    const offline = new TypeError('Failed to fetch')
    const fetchImpl = vi.fn().mockRejectedValue(offline)

    await expect(continueInvoiceSeries(continuation, fetchImpl)).resolves.toEqual({ ok: false, error: offline })
  })
})
