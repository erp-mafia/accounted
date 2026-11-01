import { beforeEach, describe, expect, it, vi } from 'vitest'
const { page, paginated } = vi.hoisted(() => ({ page: vi.fn(), paginated: vi.fn() }))
vi.mock('../visma/client', () => ({ VismaClient: class { getPage = page } }))
vi.mock('../fortnox/client', () => ({ FortnoxClient: class { getPage = page; getPaginated = paginated } }))
vi.mock('../briox/client', () => ({ BrioxClient: class { getPage = page } }))
vi.mock('../bjornlunden/client', () => ({ BjornLundenClient: class { getPage = page } }))
vi.mock('../wint/client', () => ({ WintClient: class { getPage = page } }))
vi.mock('../bokio/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../bokio/client')>()
  return { ...actual, BokioClient: class { getPage = page } }
})
import { BokioApiError } from '../bokio/client'
import { MIGRATION_LIST_TIMEOUT_MS, fetchMigrationPage, fetchSupplierInvoicesDirect } from '../provider-data-fetcher'
/** A Fortnox supplier-invoice list item, in the list form's own spelling. */
const listed = (givenNumber: string, extra: Record<string, unknown> = {}) => ({
  GivenNumber: givenNumber, InvoiceNumber: `F-${givenNumber}`, InvoiceDate: '2026-09-01', DueDate: '2026-10-01',
  SupplierNumber: '7', SupplierName: 'Leverantören AB', Total: '1250', Balance: '1250', Booked: true, Cancel: false, ...extra,
})
/** One of each: open, open while Fortnox pays it, open credit, settled, unbooked, cancelled. */
const REGISTER = [
  listed('3611'), listed('3612', { PaymentPending: true }), listed('3613', { Total: '-200', Balance: '-200' }),
  listed('3614', { Balance: '0' }), listed('3615', { Booked: false }), listed('3616', { Cancel: true }),
]
beforeEach(() => vi.clearAllMocks())
describe('durable provider listing', () => {
  it('fetches only the requested Visma page at its documented limit', async () => {
    page.mockResolvedValue({ items: [{ Id: 'customer-1', Name: 'Example' }], page: 3, totalPages: 24, totalCount: 23001 })
    const result = await fetchMigrationPage('visma', 'token', undefined, 'customers', 3)
    expect(page).toHaveBeenCalledExactlyOnceWith('token', '/customers', { page: 3, pageSize: 1000, timeoutMs: MIGRATION_LIST_TIMEOUT_MS })
    expect(MIGRATION_LIST_TIMEOUT_MS).toBe(60_000)
    expect(result).toMatchObject({ nextPage: 4, total: 23001, items: [{ id: 'customer-1' }] })
  })
  it.each(['fortnox', 'briox', 'bjornlunden'] as const)('honors %s final-page metadata without starting another page', async provider => {
    page.mockResolvedValue({ items: [], page: 7, totalPages: 7, totalCount: 600 })
    await expect(fetchMigrationPage(provider, 'token', 'tenant', 'customers', 7)).resolves.toMatchObject({ nextPage: null })
    expect(page).toHaveBeenCalledTimes(1)
  })
  it('lists the whole Fortnox supplier-invoice register, never Fortnox\'s unpaid filter', async () => {
    page.mockResolvedValue({ items: [], page: 1, totalPages: 1, totalCount: 0 })
    await fetchMigrationPage('fortnox', 'token', undefined, 'supplierInvoices', 1)
    await fetchMigrationPage('fortnox', 'token', undefined, 'supplierInvoices', 1, { allSupplierInvoices: true })
    await fetchMigrationPage('fortnox', 'token', undefined, 'salesInvoices', 1, { allSupplierInvoices: true })
    expect(page.mock.calls.map(call => call[1])).toEqual(['/supplierinvoices', '/supplierinvoices', '/invoices'])
  })
  it('keeps the open Fortnox supplier invoices Fortnox\'s unpaid filter left out, and says what it declined (PH 230)', async () => {
    page.mockResolvedValue({ items: REGISTER, page: 1, totalPages: 1, totalCount: REGISTER.length })
    const result = await fetchMigrationPage('fortnox', 'token', undefined, 'supplierInvoices', 1)
    expect(result.items.map(dto => dto.id)).toEqual(['3611', '3612', '3613'])
    expect(result.declined).toEqual({ paid: 1, unbooked: 1, cancelled: 1 })
    expect(result.total).toBe(REGISTER.length)
  })
  it('keeps every Fortnox supplier invoice when the job asks for all of them (crm#1114)', async () => {
    page.mockResolvedValue({ items: REGISTER, page: 1, totalPages: 1, totalCount: REGISTER.length })
    const result = await fetchMigrationPage('fortnox', 'token', undefined, 'supplierInvoices', 1, { allSupplierInvoices: true })
    expect(result.items).toHaveLength(REGISTER.length)
    expect(result).not.toHaveProperty('declined')
  })
  it('reads on past a Fortnox page that holds only settled supplier invoices', async () => {
    page.mockResolvedValue({ items: [listed('1', { Balance: '0' }), listed('2', { Balance: '0.00' })], page: 1, totalPages: 3, totalCount: 250 })
    const result = await fetchMigrationPage('fortnox', 'token', undefined, 'supplierInvoices', 1)
    expect(result).toMatchObject({ items: [], nextPage: 2, declined: { paid: 2 } })
  })
  it('reads the open Fortnox supplier invoices outside a job the same way, 500 per page', async () => {
    paginated.mockResolvedValue(REGISTER)
    const invoices = await fetchSupplierInvoicesDirect('fortnox', 'token')
    expect(paginated).toHaveBeenCalledExactlyOnceWith('token', '/supplierinvoices', 'SupplierInvoices', { pageSize: 500 })
    expect(invoices.map(dto => dto.id)).toEqual(['3611', '3612', '3613'])
  })
  it('does not accept a repeated or unexpectedly empty page as completion', async () => {
    page.mockResolvedValue({ items: [], page: 1, totalPages: 3, totalCount: 2500 })
    await expect(fetchMigrationPage('visma', 'token', undefined, 'customers', 2)).rejects.toThrow('PAGE_MISMATCH')
    await expect(fetchMigrationPage('visma', 'token', undefined, 'customers', 1)).rejects.toThrow('EMPTY_PAGE')
  })
  it('does not swallow provider rate limiting', async () => {
    const error = Object.assign(new Error('rate limited'), { statusCode: 429 })
    page.mockRejectedValue(error)
    await expect(fetchMigrationPage('visma', 'token', undefined, 'customers', 1)).rejects.toBe(error)
  })
  it.each(['suppliers', 'supplierInvoices'] as const)('continues past an unavailable Bokio %s endpoint', async resource => {
    page.mockRejectedValue(new BokioApiError('not found', 404))
    await expect(fetchMigrationPage('bokio', 'token', 'tenant', resource, 1))
      .resolves.toEqual({ items: [], nextPage: null, total: 0 })
  })
  it.each([401, 403, 429, 500])('preserves Bokio supplier failures with HTTP %s for recovery', async status => {
    const error = new BokioApiError('provider failed', status)
    page.mockRejectedValue(error)
    await expect(fetchMigrationPage('bokio', 'token', 'tenant', 'suppliers', 1)).rejects.toBe(error)
  })
  it.each(['customers', 'salesInvoices'] as const)('does not mistake a missing Bokio %s endpoint for an empty register', async resource => {
    const error = new BokioApiError('not found', 404)
    page.mockRejectedValue(error)
    await expect(fetchMigrationPage('bokio', 'token', 'tenant', resource, 1)).rejects.toBe(error)
  })
})
