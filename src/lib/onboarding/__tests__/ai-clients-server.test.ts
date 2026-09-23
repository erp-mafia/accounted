import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

const warn = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/api-keys', () => ({ OAUTH_MCP_KEY_NAME: 'MCP OAuth' }))
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ warn, info: vi.fn(), error: vi.fn() }) }))

import { loadConnectedAiClients, readConnectedAiClients } from '../ai-clients.server'

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
})
