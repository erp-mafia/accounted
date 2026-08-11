/**
 * Gmail refuses before any quota is near.
 *
 * The search fanned out one request per message id at once. Gmail answers 429
 * "Too many concurrent requests for user" to that, and the catch turned the
 * refusal into an empty result — which is indistinguishable from a mailbox that
 * genuinely holds nothing. A real run against two connections produced
 * `mails=25 documents=0`, and the client loop read the zero as "nothing left to
 * find" and stopped. The user was told there were no receipts by a search that
 * never happened.
 *
 * Two things must hold: the fan-out stays under the ceiling, and a refusal is
 * distinguishable from an empty mailbox.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const searchMessageIds = vi.fn()
const getMessageSummary = vi.fn()
const getAccessToken = vi.fn()
const listActiveConnections = vi.fn()
const touchSearched = vi.fn()

vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => ({}) }))
vi.mock('../gmail-client', () => ({
  searchMessageIds: (...a: unknown[]) => searchMessageIds(...a),
  getMessageSummary: (...a: unknown[]) => getMessageSummary(...a),
  fetchAttachmentBytes: vi.fn(),
  clearMessageCache: vi.fn(),
  describeAttachment: vi.fn(),
}))
vi.mock('../google-oauth', () => ({ isGoogleMailConfigured: () => true }))
vi.mock('../connections', () => ({
  getAccessToken: (...a: unknown[]) => getAccessToken(...a),
  listActiveConnections: (...a: unknown[]) => listActiveConnections(...a),
  touchSearched: (...a: unknown[]) => touchSearched(...a),
}))

const { GmailSearchService } = await import('../search-service')

function connection(id: string) {
  return { id, email_address: `${id}@example.test`, provider: 'gmail', status: 'active' }
}

beforeEach(() => {
  vi.clearAllMocks()
  getAccessToken.mockResolvedValue('token')
  listActiveConnections.mockResolvedValue([connection('c1')])
  touchSearched.mockResolvedValue(undefined)
})

describe('GmailSearchService.search', () => {
  it('never has more than a handful of summary requests in flight', async () => {
    // The ceiling is Gmail's, not ours: exceeding it fails the whole search.
    let inFlight = 0
    let peak = 0
    searchMessageIds.mockResolvedValue(Array.from({ length: 40 }, (_, i) => `m${i}`))
    getMessageSummary.mockImplementation(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
      return { messageId: 'm', subject: 'Kvitto', from: 'a@b.c' }
    })

    const svc = new GmailSearchService()
    await svc.search('company-1', { merchant: 'x', amount: 1, currency: 'SEK', date: '2026-08-01' })

    expect(getMessageSummary).toHaveBeenCalledTimes(40)
    expect(peak).toBeLessThanOrEqual(5)
  })

  it('reports a refused search instead of passing it off as an empty mailbox', async () => {
    searchMessageIds.mockRejectedValue(new Error('Gmail 429: Too many concurrent requests for user.'))

    const svc = new GmailSearchService()
    const out = await svc.search('company-1', { merchant: 'x', amount: 1, currency: 'SEK', date: '2026-08-01' })

    // No candidates either way; the count is the only thing that separates
    // "could not look" from "nothing there".
    expect(out).toEqual([])
    expect(svc.searchFailureCount()).toBe(1)
  })

  it('counts a genuinely empty mailbox as no failure', async () => {
    searchMessageIds.mockResolvedValue([])
    const svc = new GmailSearchService()
    const out = await svc.search('company-1', { merchant: 'x', amount: 1, currency: 'SEK', date: '2026-08-01' })
    expect(out).toEqual([])
    expect(svc.searchFailureCount()).toBe(0)
  })

  it('lets one refused mailbox shrink the search without hiding the others', async () => {
    listActiveConnections.mockResolvedValue([connection('c1'), connection('c2')])
    let call = 0
    searchMessageIds.mockImplementation(async () => {
      call++
      if (call === 1) throw new Error('Gmail 429')
      return ['m1']
    })
    getMessageSummary.mockResolvedValue({ messageId: 'm1', subject: 'Kvitto', from: 'a@b.c' })

    const svc = new GmailSearchService()
    const out = await svc.search('company-1', { merchant: 'x', amount: 1, currency: 'SEK', date: '2026-08-01' })

    expect(out.length).toBe(1)
    expect(svc.searchFailureCount()).toBe(1)
  })

  it('starts each search from zero failures', async () => {
    searchMessageIds.mockRejectedValueOnce(new Error('Gmail 429')).mockResolvedValue([])
    const svc = new GmailSearchService()
    const q = { merchant: 'x', amount: 1, currency: 'SEK', date: '2026-08-01' }
    await svc.search('company-1', q)
    expect(svc.searchFailureCount()).toBe(1)
    await svc.search('company-1', q)
    expect(svc.searchFailureCount()).toBe(0)
  })
})
