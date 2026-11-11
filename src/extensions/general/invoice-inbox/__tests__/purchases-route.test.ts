/**
 * GET /purchases — the purchases the page could never show.
 *
 * The list has always been documents, so a purchase with no document at all
 * could not appear on it. This route supplies that half, and attaches the
 * portal link when we know where the supplier keeps its invoices.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import { createMockRequest, parseJsonResponse, testRoutes } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

const fetchPurchases = vi.fn()
vi.mock('@/lib/receipt-hunt/purchases-without-underlag', () => ({
  fetchPurchasesWithoutUnderlag: (...a: unknown[]) => fetchPurchases(...a),
}))

const vendorLogoUrls = vi.fn()
vi.mock('@/lib/vendor-logos/read', () => ({ vendorLogoUrls: (...a: unknown[]) => vendorLogoUrls(...a) }))

const readCompanyPortals = vi.fn()
vi.mock('@/lib/receipt-hunt/company-portals-read', () => ({
  readCompanyPortals: (...a: unknown[]) => readCompanyPortals(...a),
}))

const route = testRoutes(invoiceInboxExtension).find(
  (r) => r.method === 'GET' && r.path === '/purchases',
)!

function buildCtx(): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'invoice-inbox',
    supabase: {} as ExtensionContext['supabase'],
    emit: vi.fn(),
    settings: { get: vi.fn(), set: vi.fn() },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as ExtensionContext['log'],
    services: {},
  } as unknown as ExtensionContext
}

const req = () => createMockRequest('/purchases', { method: 'GET' })

function purchase(over: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    company_id: 'company-1',
    date: '2026-07-23',
    description: 'OPENAI  CHATGPT SUBSCR',
    merchant_name: null,
    amount: -229,
    currency: 'SEK',
    amount_sek: null,
    exchange_rate: null,
    journal_entry_id: null,
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  fetchPurchases.mockResolvedValue([])
  vendorLogoUrls.mockResolvedValue(new Map())
  readCompanyPortals.mockResolvedValue([])
})

describe('GET /purchases', () => {

  it('returns the purchases with a count', async () => {
    fetchPurchases.mockResolvedValue([purchase(), purchase({ id: 'tx-2' })])
    const { body } = await parseJsonResponse<{ data: { count: number; purchases: unknown[] } }>(
      await route.handler(req(), buildCtx()),
    )
    expect(body.data.count).toBe(2)
    expect(body.data.purchases).toHaveLength(2)
  })

  it("carries the vendor's stored icon when there is one, read from the bank's merchant and text", async () => {
    fetchPurchases.mockResolvedValue([
      purchase({ id: 'tx-1', merchant_name: 'Loopia AB', description: 'LOOPIA AB' }),
      purchase({ id: 'tx-2' }),
    ])
    vendorLogoUrls.mockResolvedValue(new Map([['tx-1', 'https://db.example/storage/v1/object/public/logos/vendor-icons/abc.png']]))
    const { body } = await parseJsonResponse<{ data: { purchases: { id: string; logo_url: string | null }[] } }>(
      await route.handler(req(), buildCtx()),
    )
    expect(vendorLogoUrls).toHaveBeenCalledWith([
      { key: 'tx-1', name: 'Loopia AB', texts: ['LOOPIA AB'] },
      { key: 'tx-2', name: 'OPENAI  CHATGPT SUBSCR', texts: ['OPENAI  CHATGPT SUBSCR'] },
    ])
    expect(body.data.purchases.map((p) => p.logo_url)).toEqual([
      'https://db.example/storage/v1/object/public/logos/vendor-icons/abc.png',
      null,
    ])
  })

  it('says where the invoice lives when the supplier keeps it behind a login', async () => {
    fetchPurchases.mockResolvedValue([purchase()])
    const { body } = await parseJsonResponse<{
      data: { purchases: { portal: { vendor: string; url: string } | null }[] }
    }>(await route.handler(req(), buildCtx()))
    expect(body.data.purchases[0].portal?.vendor).toBe('OpenAI')
    expect(body.data.purchases[0].portal?.url).toContain('https://')
  })

  it('answers the company its own portal for every purchase from that supplier, before the directory', async () => {
    readCompanyPortals.mockResolvedValue([
      { id: 'portal-telia', counterparty_key: 'telia sverige', vendor_name: 'Telia', url: 'https://minasidor.telia.se/foretag' },
      { id: 'portal-openai', counterparty_key: 'openai chatgpt subscr', vendor_name: 'OpenAI', url: 'https://openai.example.se/billing' },
    ])
    fetchPurchases.mockResolvedValue([
      purchase({ id: 'tx-oct', description: 'TELIA SVERIGE AB' }),
      purchase({ id: 'tx-sep', description: 'TELIA SVERIGE AB AUTOGIRO' }),
      purchase({ id: 'tx-ai' }),
      purchase({ id: 'tx-hetz', description: 'HETZNER ONLINE GMBH K3667' }),
    ])
    const { body } = await parseJsonResponse<{ data: { purchases: { id: string; portal: unknown }[] } }>(
      await route.handler(req(), buildCtx()),
    )
    const telia = { vendor: 'Telia', url: 'https://minasidor.telia.se/foretag', note: null, id: 'portal-telia' }
    expect(body.data.purchases.map((p) => p.portal)).toEqual([
      telia,
      telia,
      { vendor: 'OpenAI', url: 'https://openai.example.se/billing', note: null, id: 'portal-openai' },
      { vendor: 'Hetzner', url: 'https://accounts.hetzner.com/invoice', note: null, id: null },
    ])
    expect(readCompanyPortals).toHaveBeenCalledTimes(1)
    expect(readCompanyPortals).toHaveBeenCalledWith(expect.anything(), 'company-1')
  })

  it('offers no portal for a payment that has no invoice', async () => {
    // A salary run has nothing to fetch. A link there implies somewhere to go.
    fetchPurchases.mockResolvedValue([
      purchase({ description: 'Lön Juli Jakob Överföring via internet', merchant_name: null }),
    ])
    const { body } = await parseJsonResponse<{ data: { purchases: { portal: unknown }[] } }>(
      await route.handler(req(), buildCtx()),
    )
    expect(body.data.purchases[0].portal).toBeNull()
  })

  it('offers no portal for a supplier the directory does not know', async () => {
    fetchPurchases.mockResolvedValue([
      purchase({ description: 'ALVIKS KOETT OCH FISK K3667', merchant_name: 'Alviks Kött och Fisk' }),
    ])
    const { body } = await parseJsonResponse<{ data: { purchases: { portal: unknown }[] } }>(
      await route.handler(req(), buildCtx()),
    )
    expect(body.data.purchases[0].portal).toBeNull()
  })

  it('scopes the lookup to the caller’s company', async () => {
    await route.handler(req(), buildCtx())
    expect(fetchPurchases).toHaveBeenCalledWith(expect.anything(), 'company-1')
  })

  it('reports a failure as a failure', async () => {
    fetchPurchases.mockRejectedValue(new Error('boom'))
    const res = await route.handler(req(), buildCtx())
    expect(res.status).toBe(500)
  })
})
