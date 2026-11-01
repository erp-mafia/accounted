import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchWithTimeout = vi.hoisted(() => vi.fn())
vi.mock('@/lib/http/fetch-with-timeout', () => ({ fetchWithTimeout }))

import { isRevokedCredentialsError, listPurchasesPage, ZettleApiError, ZETTLE_PAGE_SIZE } from '../lib/api-client'

describe('zettle api-client', () => {
  it('treats 401/403 as revoked credentials', () => {
    expect(isRevokedCredentialsError(new ZettleApiError('denied', 401))).toBe(true)
    expect(isRevokedCredentialsError(new ZettleApiError('denied', 403))).toBe(true)
    expect(isRevokedCredentialsError(new ZettleApiError('oops', 500))).toBe(false)
    expect(isRevokedCredentialsError(new Error('nope'))).toBe(false)
  })
})

describe('listPurchasesPage', () => {
  beforeEach(() => {
    fetchWithTimeout.mockReset()
  })

  const options = { startDate: '2026-09-01', lastPurchaseHash: null }

  it('reads an empty page as the end of the window', async () => {
    fetchWithTimeout.mockResolvedValueOnce(new Response(JSON.stringify({ purchases: [], lastPurchaseHash: null }), { status: 200 }))
    await expect(listPurchasesPage('token', options)).resolves.toEqual({ purchases: [], lastPurchaseHash: null, hasMore: false })
  })

  it('reports another page when this one is full and carries a hash', async () => {
    const purchases = Array.from({ length: ZETTLE_PAGE_SIZE }, (_, i) => ({ purchaseUUID1: `p-${i}` }))
    fetchWithTimeout.mockResolvedValueOnce(new Response(JSON.stringify({ purchases, lastPurchaseHash: 'h-1' }), { status: 200 }))
    const page = await listPurchasesPage('token', options)
    expect(page.purchases).toHaveLength(ZETTLE_PAGE_SIZE)
    expect(page).toMatchObject({ lastPurchaseHash: 'h-1', hasMore: true })
  })

  // An empty page moves the cursor to the run start: an unreadable 200 must
  // fail the run instead of passing for one (accounted#115).
  it('throws on a 200 whose body is not JSON', async () => {
    fetchWithTimeout.mockResolvedValueOnce(new Response('<html>maintenance</html>', { status: 200 }))
    await expect(listPurchasesPage('token', options)).rejects.toMatchObject({ name: 'ZettleApiError', status: 200, code: 'invalid_body' })
  })

  it('throws on a 200 whose body has no purchases list', async () => {
    fetchWithTimeout.mockResolvedValueOnce(new Response(JSON.stringify({ data: { purchases: [] } }), { status: 200 }))
    await expect(listPurchasesPage('token', options)).rejects.toMatchObject({ name: 'ZettleApiError', code: 'invalid_body' })
  })
})
