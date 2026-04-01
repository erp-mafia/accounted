import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createExtensionContext } from '../context-factory'
import { eventBus } from '@/lib/events/bus'
import { createMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/transactions/ingest', () => ({
  ingestTransactions: vi.fn().mockResolvedValue({
    imported: 0, duplicates: 0, reconciled: 0,
    auto_categorized: 0, auto_matched_invoices: 0, errors: 0,
    transaction_ids: [],
  }),
}))

vi.mock('@/lib/logger', () => ({
  createLogger: (module: string) => {
    const prefix = `[${module}]`
    return {
      info: (message: string, ...args: unknown[]) => console.log(prefix, message, ...args),
      warn: (message: string, ...args: unknown[]) => console.warn(prefix, message, ...args),
      error: (message: string, ...args: unknown[]) => console.error(prefix, message, ...args),
    }
  },
}))

beforeEach(() => {
  eventBus.clear()
  vi.clearAllMocks()
})

describe('createExtensionContext', () => {
  it('returns context with correct userId and extensionId', () => {
    const { supabase } = createMockSupabase()
    const ctx = createExtensionContext(supabase as never, 'user-1', 'company-1', 'test-ext')

    expect(ctx.userId).toBe('user-1')
    expect(ctx.extensionId).toBe('test-ext')
  })

  it('provides supabase client', () => {
    const { supabase } = createMockSupabase()
    const ctx = createExtensionContext(supabase as never, 'user-1', 'company-1', 'test-ext')

    expect(ctx.supabase).toBe(supabase)
  })

  it('emit() delegates to eventBus.emit()', async () => {
    const { supabase } = createMockSupabase()
    const ctx = createExtensionContext(supabase as never, 'user-1', 'company-1', 'test-ext')

    const handler = vi.fn()
    eventBus.on('journal_entry.committed', handler)

    await ctx.emit({
      type: 'journal_entry.committed',
      payload: { entry: { id: 'e1' } as never, userId: 'user-1', companyId: 'company-1' },
    })

    expect(handler).toHaveBeenCalledWith({ entry: { id: 'e1' }, userId: 'user-1', companyId: 'company-1' })
  })

  it('log methods prefix with extensionId', () => {
    const { supabase } = createMockSupabase()
    const ctx = createExtensionContext(supabase as never, 'user-1', 'company-1', 'my-ext')

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    ctx.log.info('hello', 42)
    ctx.log.warn('caution')
    ctx.log.error('oops')

    expect(logSpy).toHaveBeenCalledWith('[ext:my-ext]', 'hello', 42)
    expect(warnSpy).toHaveBeenCalledWith('[ext:my-ext]', 'caution')
    expect(errorSpy).toHaveBeenCalledWith('[ext:my-ext]', 'oops')

    logSpy.mockRestore()
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('settings.get() queries extension_data table', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: { value: { autoOcr: true } }, error: null })

    const ctx = createExtensionContext(supabase as never, 'user-1', 'company-1', 'mcp-server')
    const result = await ctx.settings.get<{ autoOcr: boolean }>('settings')

    expect(result).toEqual({ autoOcr: true })
    expect(supabase.from).toHaveBeenCalledWith('extension_data')
  })

  it('settings.get() without key defaults to "settings"', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: { value: { foo: 'bar' } }, error: null })

    const ctx = createExtensionContext(supabase as never, 'user-1', 'company-1', 'test-ext')
    const result = await ctx.settings.get<{ foo: string }>()

    expect(result).toEqual({ foo: 'bar' })
  })

  it('settings.get() returns null when no data', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: null, error: null })

    const ctx = createExtensionContext(supabase as never, 'user-1', 'company-1', 'test-ext')
    const result = await ctx.settings.get('missing-key')

    expect(result).toBeNull()
  })

  it('settings.set() upserts into extension_data table', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: null, error: null })

    const ctx = createExtensionContext(supabase as never, 'user-1', 'company-1', 'test-ext')
    await ctx.settings.set('my-key', { value: 123 })

    expect(supabase.from).toHaveBeenCalledWith('extension_data')
  })

  it('storage.getPublicUrl() returns URL string', () => {
    const { supabase } = createMockSupabase()
    const ctx = createExtensionContext(supabase as never, 'user-1', 'company-1', 'test-ext')

    const url = ctx.storage.getPublicUrl('documents', 'path/to/file.pdf')
    expect(typeof url).toBe('string')
  })

  it('services.ingestTransactions is a function', () => {
    const { supabase } = createMockSupabase()
    const ctx = createExtensionContext(supabase as never, 'user-1', 'company-1', 'test-ext')

    expect(typeof ctx.services.ingestTransactions).toBe('function')
  })
})
