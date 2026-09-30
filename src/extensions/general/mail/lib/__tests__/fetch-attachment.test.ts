/**
 * Downloading an attachment runs on the service role, which skips RLS, so the
 * connection lookup itself has to be scoped: a connection id must only ever
 * resolve to a usable mailbox of the company asking.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { filters, row, mockGetAccessToken, mockBytes, mockDescribe } = vi.hoisted(() => ({
  filters: [] as Array<[string, unknown]>,
  row: { current: null as Record<string, unknown> | null },
  mockGetAccessToken: vi.fn(),
  mockBytes: vi.fn(),
  mockDescribe: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: () => {
    const chain: Record<string, unknown> = {}
    chain.select = () => chain
    chain.eq = (column: string, value: unknown) => {
      filters.push([column, value])
      return chain
    }
    chain.maybeSingle = () => Promise.resolve({ data: row.current, error: null })
    return { from: () => chain }
  },
}))
vi.mock('../gmail-client', () => ({
  searchMessageIds: vi.fn(),
  getMessageSummary: vi.fn(),
  clearMessageCache: vi.fn(),
  fetchAttachmentBytes: (...args: unknown[]) => mockBytes(...args),
  describeAttachment: (...args: unknown[]) => mockDescribe(...args),
}))
vi.mock('../connections', () => ({
  getAccessToken: (...args: unknown[]) => mockGetAccessToken(...args),
  listActiveConnections: vi.fn(),
  touchSearched: vi.fn(),
}))

import { GmailSearchService } from '../search-service'

beforeEach(() => {
  vi.clearAllMocks()
  filters.length = 0
  row.current = { id: 'conn-1', company_id: 'co-1', status: 'active' }
  mockGetAccessToken.mockResolvedValue('token')
  mockBytes.mockResolvedValue(Buffer.from('%PDF-1.4'))
  mockDescribe.mockResolvedValue({ filename: 'kvitto.pdf', mimeType: 'application/pdf' })
})

describe('GmailSearchService.fetchAttachment', () => {
  it('looks the connection up within the asking company, and only while it is active', async () => {
    const fetched = await new GmailSearchService().fetchAttachment('co-1', 'conn-1', 'msg-1', 'att-1')

    expect(filters).toEqual([
      ['id', 'conn-1'],
      ['company_id', 'co-1'],
      ['status', 'active'],
    ])
    expect(fetched).toMatchObject({ filename: 'kvitto.pdf', mimeType: 'application/pdf' })
  })

  it('downloads nothing through a connection the company does not have', async () => {
    row.current = null

    await expect(new GmailSearchService().fetchAttachment('co-2', 'conn-1', 'msg-1', 'att-1')).resolves.toBeNull()
    expect(mockGetAccessToken).not.toHaveBeenCalled()
    expect(mockBytes).not.toHaveBeenCalled()
  })
})
