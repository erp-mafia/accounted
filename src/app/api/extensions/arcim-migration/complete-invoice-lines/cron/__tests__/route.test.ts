import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn() }))
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>()
  const logger = { debug: vi.fn(), info: vi.fn(), warn: log.warn, error: log.error, child: (): unknown => logger }
  return { ...actual, createLogger: () => logger }
})
vi.mock('@/lib/extensions/registry', () => ({ extensionRegistry: { get: vi.fn() } }))
vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn().mockReturnValue(null) }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn(() => ({})) }))
vi.mock('@/extensions/general/arcim-migration/lib/invoice-completion-worker', () => ({ runInvoiceCompletion: vi.fn() }))
vi.mock('@/extensions/general/arcim-migration/lib/complete-bokio-supplier-invoices', () => ({ runBokioSupplierCompletion: vi.fn().mockResolvedValue([]) }))
import { runBokioSupplierCompletion } from '@/extensions/general/arcim-migration/lib/complete-bokio-supplier-invoices'
import { GET, maxDuration } from '../route'
import { extensionRegistry } from '@/lib/extensions/registry'
import { verifyCronSecret } from '@/lib/auth/cron'
import { runInvoiceCompletion } from '@/extensions/general/arcim-migration/lib/invoice-completion-worker'
const request = () => new Request('http://localhost/api/extensions/arcim-migration/complete-invoice-lines/cron')
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(runBokioSupplierCompletion).mockResolvedValue([])
  vi.mocked(verifyCronSecret).mockReturnValue(null)
  vi.mocked(extensionRegistry.get).mockResolvedValue({ id: 'arcim-migration' } as never)
})
afterEach(() => vi.useRealTimers())
describe('invoice completion cron', () => {
  it('refuses an unauthenticated invocation before doing work', async () => {
    vi.mocked(verifyCronSecret).mockReturnValue(NextResponse.json({}, { status: 401 }))
    expect((await GET(request())).status).toBe(401)
    expect(runInvoiceCompletion).not.toHaveBeenCalled()
  })
  it('answers 200 skipped for a disabled extension', async () => {
    vi.mocked(extensionRegistry.get).mockResolvedValue(undefined)
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ skipped: true, reason: 'extension_disabled', processed: 0 })
    expect(runInvoiceCompletion).not.toHaveBeenCalled()
  })
  it('starts the absolute deadline before initialization and returns partial counts unchanged', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    vi.mocked(extensionRegistry.get).mockImplementation(async () => {
      vi.setSystemTime(start + 30_000)
      return { id: 'arcim-migration' } as never
    })
    const summary = { completed: 4, deferred: 2, uncertain: 1, budgetReachedAt: 'provider-listing', backlogComplete: null }
    vi.mocked(runInvoiceCompletion).mockResolvedValue(summary as never)
    const response = await GET(request())
    expect(maxDuration).toBe(300)
    expect(runInvoiceCompletion).toHaveBeenCalledWith(expect.anything(), start + 240_000)
    expect(await response.json()).toEqual({ data: summary, supplierCompletion: [] })
  })
  it('continues customer completion when the supplier queue fails, and reports the failure with its code', async () => {
    const failure = Object.assign(new Error('BOKIO_COMPLETION_QUEUE_READ_FAILED'), { code: '42501' })
    vi.mocked(runBokioSupplierCompletion).mockRejectedValue(failure)
    expect((await GET(request())).status).toBe(200)
    expect(runInvoiceCompletion).toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledWith('Bokio supplier completion failed', failure, { code: '42501' })
  })
  it('takes a supplier pass that ran out of time as a deferral, not an error', async () => {
    vi.mocked(runBokioSupplierCompletion).mockRejectedValue(new Error('MIGRATION_DEADLINE'))
    expect((await GET(request())).status).toBe(200)
    expect(log.error).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith('Bokio supplier completion deferred: out of time')
  })
  it('surfaces a discovery failure instead of returning an empty successful run', async () => {
    vi.mocked(runInvoiceCompletion).mockRejectedValue(new Error('database unavailable'))
    expect((await GET(request())).status).toBe(500)
  })
})
