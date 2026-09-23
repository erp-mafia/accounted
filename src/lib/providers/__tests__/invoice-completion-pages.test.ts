import { beforeEach, describe, expect, it, vi } from 'vitest'
const { page, detail } = vi.hoisted(() => ({ page: vi.fn(), detail: vi.fn() }))
vi.mock('../fortnox/client', () => ({ FortnoxClient: class { getPage = page; get = detail } }))
vi.mock('../visma/client', () => ({ VismaClient: class { getPage = page; get = detail } }))
vi.mock('../briox/client', () => ({ BrioxClient: class { getPage = page; get = detail } }))
vi.mock('../bjornlunden/client', () => ({ BjornLundenClient: class { getPage = page; getDetail = detail } }))
vi.mock('../wint/client', () => ({ WintClient: class { getPage = page; get = detail } }))
vi.mock('../bokio/client', async importOriginal => ({
  ...await importOriginal<typeof import('../bokio/client')>(),
  BokioClient: class { getPage = page; getDetail = detail },
}))
import { BokioApiError } from '../bokio/client'
import { fetchInvoiceCompletionPage, fetchInvoiceCompletionDetail } from '../provider-data-fetcher'

beforeEach(() => vi.clearAllMocks())

describe('invoice completion discovery', () => {
  it('keeps BL identity separate from the invoice number used by its detail endpoint', async () => {
    const raw = { entityId: 'bl-entity', invoiceNumber: 42, invoiceDate: '2026-09-01' }
    page.mockResolvedValue({ items: [raw], page: 3, totalPages: 8, totalCount: 8000 })
    const result = await fetchInvoiceCompletionPage('bjornlunden', 'token', 'tenant', 'invoices', 3)
    expect(result.sources).toEqual([{ id: 'bl-entity', detailId: '42', invoiceNumber: '42', issueDate: '2026-09-01', creditNote: false }])
    expect(result.nextPage).toBe(4)
    detail.mockResolvedValue(raw)
    await expect(fetchInvoiceCompletionDetail('bjornlunden', 'token', 'tenant', result.sources[0])).resolves.toMatchObject({ id: 'bl-entity' })
    expect(detail).toHaveBeenCalledExactlyOnceWith('token', 'tenant', '/customerinvoice/42')
  })

  it('checkpoints the transition to Bokio credit notes without fetching them in the invoice page', async () => {
    page.mockResolvedValue({ items: [{ id: 'invoice', invoiceNumber: '42', invoiceDate: '2026-09-01' }], page: 3, totalPages: 3 })
    const result = await fetchInvoiceCompletionPage('bokio', 'token', 'tenant', 'invoices', 3)
    expect(result).toMatchObject({ nextPage: 1, nextPart: 'creditNotes', sources: [{ id: 'invoice', creditNote: false }] })
    expect(page).toHaveBeenCalledExactlyOnceWith('token', 'tenant', '/invoices', { page: 3, pageSize: 100 })
  })

  it('resumes Bokio credit pages and retrieves the matching credit detail', async () => {
    const raw = { id: 'credit', creditNoteNumber: '43', creditDate: '2026-09-01' }
    page.mockResolvedValue({ items: [raw], page: 2, totalPages: 4 })
    const result = await fetchInvoiceCompletionPage('bokio', 'token', 'tenant', 'creditNotes', 2)
    expect(result).toMatchObject({ nextPage: 3, nextPart: 'creditNotes', sources: [{ id: 'credit', creditNote: true }] })
    detail.mockResolvedValue(raw)
    await fetchInvoiceCompletionDetail('bokio', 'token', 'tenant', result.sources[0])
    expect(detail).toHaveBeenCalledExactlyOnceWith('token', 'tenant', '/credit-notes/credit')
  })

  it('accepts an absent optional credit resource but keeps invoice 404 and rate limits as failures', async () => {
    const missing = new BokioApiError('not found', 404)
    page.mockRejectedValue(missing)
    await expect(fetchInvoiceCompletionPage('bokio', 'token', 'tenant', 'creditNotes', 1))
      .resolves.toMatchObject({ sources: [], nextPage: null })
    await expect(fetchInvoiceCompletionPage('bokio', 'token', 'tenant', 'invoices', 1)).rejects.toBe(missing)
    const rateLimit = new BokioApiError('limited', 429)
    page.mockRejectedValue(rateLimit)
    await expect(fetchInvoiceCompletionPage('bokio', 'token', 'tenant', 'creditNotes', 1)).rejects.toBe(rateLimit)
  })

  it('does not persist invalid provider dates as matching evidence', async () => {
    page.mockResolvedValue({ items: [
      { DocumentNumber: 1, InvoiceDate: '2026-02-30' },
      { DocumentNumber: 2, InvoiceDate: 'invalid' },
      { DocumentNumber: 3, InvoiceDate: '2026-09-01' },
    ], page: 1, totalPages: 1 })
    const result = await fetchInvoiceCompletionPage('fortnox', 'token', undefined, 'invoices', 1)
    expect(result.sources).toEqual([{ id: '3', detailId: '3', invoiceNumber: '3', issueDate: '2026-09-01', creditNote: false }])
  })
})
