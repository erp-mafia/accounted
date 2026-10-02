import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

const warn = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/api-keys', () => ({ OAUTH_MCP_KEY_NAME: 'MCP OAuth' }))
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ warn, info: vi.fn(), error: vi.fn() }) }))

import { loadAiConnection, loadConnectedAiClients, readAiConnection, readConnectedAiClients } from '../ai-clients.server'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
const client = supabase as unknown as SupabaseClient

describe('connected AI clients read', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('reads the connected clients', async () => {
    enqueue({ data: [{ client: 'chatgpt' }, { client: 'claude' }], error: null })
    await expect(readConnectedAiClients(client, 'user-1')).resolves.toEqual(['claude', 'chatgpt'])
  })

  it('reads a key with no known client as a connected agent that names no client', async () => {
    enqueue({ data: [{ client: null }, { client: 'cursor' }], error: null })
    await expect(readAiConnection(client, 'user-1')).resolves.toEqual({ connected: true, clients: [] })
  })

  it('reads no live key as not connected', async () => {
    enqueue({ data: [], error: null })
    await expect(readAiConnection(client, 'user-1')).resolves.toEqual({ connected: false, clients: [] })
  })

  it('throws from the connection read when the database fails, never answering "not connected"', async () => {
    enqueue({ data: null, error: { message: 'connection reset' } })
    await expect(readAiConnection(client, 'user-1')).rejects.toThrow('connection reset')
  })

  it('keeps the verified-only readout for handoff surfaces', async () => {
    enqueue({ data: [{ client: null }, { client: 'claude' }], error: null })
    await expect(readConnectedAiClients(client, 'user-1')).resolves.toEqual(['claude'])
  })

  it('throws from the strict read when the database fails', async () => {
    enqueue({ data: null, error: { message: 'connection reset' } })
    await expect(readConnectedAiClients(client, 'user-1')).rejects.toThrow('connection reset')
  })

  it('answers none from the lenient read, and logs the failure', async () => {
    enqueue({ data: null, error: { message: 'connection reset' } })
    await expect(loadConnectedAiClients(client, 'user-1')).resolves.toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][1]).toMatchObject({ userId: 'user-1' })
  })

  it('answers no connection from the lenient connection read, and logs the failure', async () => {
    enqueue({ data: null, error: { message: 'connection reset' } })
    await expect(loadAiConnection(client, 'user-1')).resolves.toEqual({ connected: false, clients: [] })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('keeps an unknown-client key connected in the lenient connection read', async () => {
    enqueue({ data: [{ client: null }], error: null })
    await expect(loadAiConnection(client, 'user-1')).resolves.toEqual({ connected: true, clients: [] })
  })
})
