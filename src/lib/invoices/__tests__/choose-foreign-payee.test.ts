import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chooseForeignInvoicePayee } from '@/lib/invoices/choose-foreign-payee'
import { getErrorMessage } from '@/lib/errors/get-error-message'

const IBAN = 'SE4550000000058398257466'

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

describe('chooseForeignInvoicePayee (PH 181, crm#1273)', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('an account that prints its IBAN: only chooses it as the default for the currency', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: {} }))

    await chooseForeignInvoicePayee({ currency: 'EUR', cashAccountId: 'ca-1930', bankIban: null, locale: 'sv' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/cash-accounts/payee-defaults')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ currency: 'EUR', cash_account_id: 'ca-1930' })
  })

  it('an account whose IBAN only the bank connection knows: prints that IBAN first, then chooses it', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: {} }))
      .mockResolvedValueOnce(jsonResponse(200, { data: {} }))

    await chooseForeignInvoicePayee({ currency: 'EUR', cashAccountId: 'ca-1930', bankIban: IBAN, locale: 'sv' })

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      ['/api/cash-accounts/ca-1930', 'PATCH'],
      ['/api/cash-accounts/payee-defaults', 'PUT'],
    ])
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ iban: IBAN, invoice_payee: true })
  })

  it('a refused write throws the user-facing message and stops before the default is set', async () => {
    const refusal = { error: { code: 'INVOICE_PAYEE_ACCOUNT_INVALID', details: { reason: 'not_payee' } } }
    fetchMock.mockResolvedValueOnce(jsonResponse(400, refusal))

    const expected = getErrorMessage(refusal, { locale: 'sv', context: 'settings', statusCode: 400 })
    expect(expected).toBeTruthy()
    await expect(
      chooseForeignInvoicePayee({ currency: 'EUR', cashAccountId: 'ca-1930', bankIban: IBAN, locale: 'sv' }),
    ).rejects.toThrow(expected)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
