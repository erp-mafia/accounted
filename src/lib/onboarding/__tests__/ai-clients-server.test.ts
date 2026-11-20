import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

const warn = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/api-keys', () => ({ OAUTH_MCP_KEY_NAME: 'MCP OAuth' }))
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ warn, info: vi.fn(), error: vi.fn() }) }))

import {
  hasAgentWorked,
  loadAiConnection,
  loadConnectedAiClients,
  readAiConnection,
  readConnectedAiClients,
  readFirstTaskClient,
} from '../ai-clients.server'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
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

describe('whether an agent has worked', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('is true once a key has had a working tool call', async () => {
    enqueue({ data: [{ sequence: 1 }], error: null })
    await expect(hasAgentWorked(client, 'user-1')).resolves.toBe(true)
    expect(supabase.from).toHaveBeenCalledWith('event_log')
  })

  it('is false for a person whose connector has only listed its tools', async () => {
    enqueue({ data: [], error: null })
    await expect(hasAgentWorked(client, 'user-1')).resolves.toBe(false)
  })

  it('counts only a successful tool call by a key: a connector lists its tools by itself', async () => {
    enqueue({ data: [], error: null })
    await hasAgentWorked(client, 'user-1')
    expect(findCalls('event_log', 'eq')).toEqual([
      ['user_id', 'user-1'],
      ['event_type', 'mcp.tool_called'],
      ['data->>actorType', 'api_key'],
      ['data->>success', 'true'],
      ['data->>isError', 'false'],
    ])
  })

  it('reads as worked when the read fails: a broken read must not start asking people', async () => {
    enqueue({ data: null, error: { message: 'connection reset' } })
    await expect(hasAgentWorked(client, 'user-1')).resolves.toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('the first task client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('names the client of a person whose agent has not worked', async () => {
    enqueue({ data: [], error: null })
    await expect(readFirstTaskClient(client, 'user-1', { connected: true, clients: ['claude'] })).resolves.toBe('claude')
  })

  it('answers null once an agent has worked', async () => {
    enqueue({ data: [{ sequence: 1 }], error: null })
    await expect(readFirstTaskClient(client, 'user-1', { connected: true, clients: ['claude'] })).resolves.toBeNull()
  })

  it('spends no read on a person with no client to name', async () => {
    await expect(readFirstTaskClient(client, 'user-1', { connected: false, clients: [] })).resolves.toBeNull()
    await expect(readFirstTaskClient(client, 'user-1', { connected: true, clients: [] })).resolves.toBeNull()
    expect(supabase.from).not.toHaveBeenCalled()
  })
})
