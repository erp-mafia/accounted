import { describe, it, expect, beforeEach, vi } from 'vitest'
import { extensionRegistry, setContextFactory } from '../registry'
import { eventBus } from '@/lib/events/bus'
import type { Extension, ExtensionContext } from '../types'

// The request's cookie client (anon under a v1 API key, an MCP bearer token
// or a webhook: no session cookie) and the service-role client.
const { cookieClient, serviceClient } = vi.hoisted(() => ({
  cookieClient: { role: 'cookie' },
  serviceClient: { role: 'service' },
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => cookieClient),
}))
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(() => serviceClient),
}))

import { createClient } from '@/lib/supabase/server'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'

beforeEach(() => {
  extensionRegistry.clear()
  eventBus.clear()
  vi.mocked(createClient).mockClear()
  vi.mocked(createServiceClientNoCookies).mockReset()
  vi.mocked(createServiceClientNoCookies).mockImplementation(() => serviceClient as never)
})

function makeExtension(overrides: Partial<Extension> = {}): Extension {
  return {
    id: 'test-ext',
    name: 'Test Extension',
    version: '1.0.0',
    ...overrides,
  }
}

describe('ExtensionRegistry', () => {
  it('register() stores extension, queryable via get() and getAll()', async () => {
    const ext = makeExtension()
    extensionRegistry.register(ext)

    expect(await extensionRegistry.get('test-ext')).toBe(ext)
    expect(await extensionRegistry.getAll()).toEqual([ext])
  })

  it('register() wires event handlers to the bus', async () => {
    const handler = vi.fn()
    const ext = makeExtension({
      id: 'event-ext',
      eventHandlers: [{ eventType: 'journal_entry.committed', handler }],
    })

    extensionRegistry.register(ext)

    await eventBus.emit({
      type: 'journal_entry.committed',
      payload: { entry: { id: 'e1' } as never, userId: 'u1', companyId: 'company-1' },
    })

    expect(handler).toHaveBeenCalled()
    expect(handler.mock.calls[0][0]).toEqual({ entry: { id: 'e1' }, userId: 'u1', companyId: 'company-1' })
  })

  it('register() skips duplicate registration (same id)', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ext1 = makeExtension()
    const ext2 = makeExtension({ name: 'Duplicate' })

    extensionRegistry.register(ext1)
    extensionRegistry.register(ext2)

    // Original is kept
    expect((await extensionRegistry.get('test-ext'))!.name).toBe('Test Extension')
    expect(await extensionRegistry.getAll()).toHaveLength(1)

    consoleSpy.mockRestore()
  })

  it('unregister() removes extension and unsubscribes handlers', async () => {
    const handler = vi.fn()
    const ext = makeExtension({
      id: 'removable',
      eventHandlers: [{ eventType: 'journal_entry.committed', handler }],
    })

    extensionRegistry.register(ext)
    extensionRegistry.unregister('removable')

    expect(await extensionRegistry.get('removable')).toBeUndefined()

    await eventBus.emit({
      type: 'journal_entry.committed',
      payload: { entry: { id: 'e1' } as never, userId: 'u1', companyId: 'company-1' },
    })

    expect(handler).not.toHaveBeenCalled()
  })

  it('clear() removes all extensions and unsubscribes all handlers', async () => {
    const handler1 = vi.fn()
    const handler2 = vi.fn()

    extensionRegistry.register(
      makeExtension({
        id: 'ext1',
        eventHandlers: [{ eventType: 'journal_entry.committed', handler: handler1 }],
      })
    )
    extensionRegistry.register(
      makeExtension({
        id: 'ext2',
        eventHandlers: [{ eventType: 'journal_entry.drafted', handler: handler2 }],
      })
    )

    extensionRegistry.clear()

    expect(await extensionRegistry.getAll()).toHaveLength(0)

    await eventBus.emit({
      type: 'journal_entry.committed',
      payload: { entry: { id: 'e1' } as never, userId: 'u1', companyId: 'company-1' },
    })
    await eventBus.emit({
      type: 'journal_entry.drafted',
      payload: { entry: { id: 'e1' } as never, userId: 'u1', companyId: 'company-1' },
    })

    expect(handler1).not.toHaveBeenCalled()
    expect(handler2).not.toHaveBeenCalled()
  })

  it('handler receives ExtensionContext when context factory is set', async () => {
    const handler = vi.fn()
    const mockCtx = { extensionId: 'ctx-ext', userId: 'u1', companyId: 'company-1' } as ExtensionContext

    setContextFactory((_supabase, _userId, _extId) => mockCtx)

    const ext = makeExtension({
      id: 'ctx-ext',
      eventHandlers: [{ eventType: 'journal_entry.committed', handler }],
    })

    extensionRegistry.register(ext)

    await eventBus.emit({
      type: 'journal_entry.committed',
      payload: { entry: { id: 'e1' } as never, userId: 'u1', companyId: 'company-1' },
    })

    expect(handler).toHaveBeenCalledWith(
      { entry: { id: 'e1' }, userId: 'u1', companyId: 'company-1' },
      mockCtx
    )
  })

  // B15: a credit note issued under a v1 API key or an MCP bearer token
  // emitted credit_note.created inside a request with no session cookie: the
  // cookie client was the anon role, the Stripe handler read no invoice row
  // and the credited invoice kept its payment link.
  it('builds the handler context on the service-role client, never the request cookie client', async () => {
    const factory = vi.fn(
      (supabase: unknown, userId: string, companyId: string, extensionId: string) =>
        ({ supabase, userId, companyId, extensionId }) as unknown as ExtensionContext,
    )
    setContextFactory(factory as never)
    const handler = vi.fn()
    extensionRegistry.register(
      makeExtension({ id: 'svc-ext', eventHandlers: [{ eventType: 'journal_entry.committed', handler }] }),
    )

    await eventBus.emit({
      type: 'journal_entry.committed',
      payload: { entry: { id: 'e1' } as never, userId: 'u1', companyId: 'company-1' },
    })

    expect(createClient).not.toHaveBeenCalled()
    expect(factory).toHaveBeenCalledWith(serviceClient, 'u1', 'company-1', 'svc-ext')
    expect(handler.mock.calls[0][1]).toMatchObject({ supabase: serviceClient, companyId: 'company-1' })
  })

  it('still calls the handler, without a context, when the client cannot be built', async () => {
    setContextFactory(((supabase: unknown) => ({ supabase }) as unknown as ExtensionContext) as never)
    vi.mocked(createServiceClientNoCookies).mockImplementation(() => {
      throw new Error('supabaseUrl is required.')
    })
    const handler = vi.fn()
    extensionRegistry.register(
      makeExtension({ id: 'noctx-ext', eventHandlers: [{ eventType: 'journal_entry.committed', handler }] }),
    )

    await eventBus.emit({
      type: 'journal_entry.committed',
      payload: { entry: { id: 'e1' } as never, userId: 'u1', companyId: 'company-1' },
    })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][1]).toBeUndefined()
  })
})
