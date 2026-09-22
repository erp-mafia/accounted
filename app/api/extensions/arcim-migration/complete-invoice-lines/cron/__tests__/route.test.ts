import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
vi.mock('@/lib/extensions/loader', () => ({ loadExtensions: vi.fn() }))
vi.mock('@/lib/extensions/registry', () => ({ extensionRegistry: { get: vi.fn() } }))
vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn().mockReturnValue(null) }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn(() => ({})) }))
vi.mock('@/extensions/general/arcim-migration/lib/invoice-completion-worker', () => ({ runInvoiceCompletion: vi.fn() }))
vi.mock('@/extensions/general/arcim-migration/lib/complete-bokio-supplier-invoices', () => ({ runBokioSupplierCompletion: vi.fn().mockResolvedValue([]) }))
import { runBokioSupplierCompletion } from '@/extensions/general/arcim-migration/lib/complete-bokio-supplier-invoices'
import { GET, maxDuration } from '../route'
import { loadExtensions } from '@/lib/extensions/loader'
import { extensionRegistry } from '@/lib/extensions/registry'
import { verifyCronSecret } from '@/lib/auth/cron'
import { runInvoiceCompletion } from '@/extensions/general/arcim-migration/lib/invoice-completion-worker'
const request = () => new Request('http://localhost/api/extensions/arcim-migration/complete-invoice-lines/cron')
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(runBokioSupplierCompletion).mockResolvedValue([])
  vi.mocked(verifyCronSecret).mockReturnValue(null)
  vi.mocked(extensionRegistry.get).mockReturnValue({ id: 'arcim-migration' } as never)
})
afterEach(() => vi.useRealTimers())
describe('invoice completion cron', () => {
  it('refuses an unauthenticated invocation before doing work', async () => {
    vi.mocked(verifyCronSecret).mockReturnValue(NextResponse.json({}, { status: 401 }))
    expect((await GET(request())).status).toBe(401)
    expect(runInvoiceCompletion).not.toHaveBeenCalled()
  })
  it('refuses a disabled extension', async () => {
    vi.mocked(extensionRegistry.get).mockReturnValue(undefined)
    expect((await GET(request())).status).toBe(503)
    expect(runInvoiceCompletion).not.toHaveBeenCalled()
  })
  it('starts the absolute deadline before initialization and returns partial counts unchanged', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    vi.mocked(loadExtensions).mockImplementation(() => { vi.setSystemTime(start + 30_000) })
    const summary = { completed: 4, deferred: 2, uncertain: 1, budgetReachedAt: 'provider-listing', backlogComplete: null }
    vi.mocked(runInvoiceCompletion).mockResolvedValue(summary as never)
    const response = await GET(request())
    expect(maxDuration).toBe(300)
    expect(runInvoiceCompletion).toHaveBeenCalledWith(expect.anything(), start + 240_000)
    expect(await response.json()).toEqual({ data: summary, supplierCompletion: [] })
  })
  it('continues customer completion when the supplier queue fails', async () => {
    vi.mocked(runBokioSupplierCompletion).mockRejectedValue(new Error('unavailable'))
    expect((await GET(request())).status).toBe(200)
    expect(runInvoiceCompletion).toHaveBeenCalled()
  })
  it('surfaces a discovery failure instead of returning an empty successful run', async () => {
    vi.mocked(runInvoiceCompletion).mockRejectedValue(new Error('database unavailable'))
    expect((await GET(request())).status).toBe(500)
  })
})
