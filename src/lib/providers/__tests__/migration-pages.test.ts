import { beforeEach, describe, expect, it, vi } from 'vitest'
const { page } = vi.hoisted(() => ({ page: vi.fn() }))
vi.mock('../visma/client', () => ({ VismaClient: class { getPage = page } }))
vi.mock('../fortnox/client', () => ({ FortnoxClient: class { getPage = page } }))
vi.mock('../briox/client', () => ({ BrioxClient: class { getPage = page } }))
vi.mock('../bjornlunden/client', () => ({ BjornLundenClient: class { getPage = page } }))
vi.mock('../wint/client', () => ({ WintClient: class { getPage = page } }))
vi.mock('../bokio/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../bokio/client')>()
  return { ...actual, BokioClient: class { getPage = page } }
})
import { BokioApiError } from '../bokio/client'
import { fetchMigrationPage } from '../provider-data-fetcher'
beforeEach(() => vi.clearAllMocks())
describe('durable provider listing', () => {
  it('fetches only the requested Visma page at its documented limit', async () => {
    page.mockResolvedValue({ items: [{ Id: 'customer-1', Name: 'Example' }], page: 3, totalPages: 24, totalCount: 23001 })
    const result = await fetchMigrationPage('visma', 'token', undefined, 'customers', 3)
    expect(page).toHaveBeenCalledExactlyOnceWith('token', '/customers', { page: 3, pageSize: 1000 })
    expect(result).toMatchObject({ nextPage: 4, total: 23001, items: [{ id: 'customer-1' }] })
  })
  it.each(['fortnox', 'briox', 'bjornlunden'] as const)('honors %s final-page metadata without starting another page', async provider => {
    page.mockResolvedValue({ items: [], page: 7, totalPages: 7, totalCount: 600 })
    await expect(fetchMigrationPage(provider, 'token', 'tenant', 'customers', 7)).resolves.toMatchObject({ nextPage: null })
    expect(page).toHaveBeenCalledTimes(1)
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
