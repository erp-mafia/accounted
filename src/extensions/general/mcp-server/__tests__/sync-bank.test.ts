import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Agent-triggered PSD2 sync: the MCP twin of
// POST /api/v1/companies/{id}/bank-connections/{connectionId}/sync.
// The runner itself is covered in extensions/general/enable-banking; this
// file pins the tool's contract: scope, capability gate, the in-band
// cooldown answer, and that real failures flow through the coded envelope.

const mocks = vi.hoisted(() => ({
  triggerConnectionSync: vi.fn(),
}))

vi.mock('@/extensions/general/enable-banking/lib/trigger-sync', async () => {
  const actual = await vi.importActual<
    typeof import('@/extensions/general/enable-banking/lib/trigger-sync')
  >('@/extensions/general/enable-banking/lib/trigger-sync')
  return {
    ...actual,
    triggerConnectionSync: (...args: unknown[]) => mocks.triggerConnectionSync(...args),
  }
})

import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { eventBus } from '@/lib/events/bus'
import { MCP_TOOL_CAPABILITY_MAP } from '@/lib/entitlements/keys'
import { tools } from '../server'
import { toToolError } from '../tool-result'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const CONNECTION_ID = '22222222-2222-4222-8222-222222222222'
const tool = tools.find((t) => t.name === 'gnubok_sync_bank')!

describe('gnubok_sync_bank', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is a transactions:write tool gated on bank_sync and flagged open-world', () => {
    expect(TOOL_SCOPE_MAP.gnubok_sync_bank).toBe('transactions:write')
    expect(MCP_TOOL_CAPABILITY_MAP.gnubok_sync_bank).toBe('bank_sync')
    expect(tool.annotations.readOnlyHint).toBe(false)
    expect(tool.annotations.openWorldHint).toBe(true)
    expect(tool.inputSchema).toMatchObject({ additionalProperties: false, required: ['connection_id'] })
  })

  it('runs the shared sync runner for the company and reports the outcome', async () => {
    mocks.triggerConnectionSync.mockResolvedValue({
      ok: true,
      connection_id: CONNECTION_ID,
      bank: 'Swedbank',
      imported: 3,
      duplicates: 12,
      from_date: '2026-08-26',
      to_date: '2026-09-02',
      last_synced_at: '2026-09-02T09:14:03.000Z',
    })
    const supabase = {} as never
    const result = (await tool.execute(
      { connection_id: CONNECTION_ID },
      COMPANY_ID,
      'user-1',
      supabase,
    )) as Record<string, unknown>

    expect(mocks.triggerConnectionSync).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ companyId: COMPANY_ID, userId: 'user-1', connectionId: CONNECTION_ID }),
    )
    expect(result).toMatchObject({
      synced: true,
      connection_id: CONNECTION_ID,
      bank: 'Swedbank',
      imported: 3,
      duplicates: 12,
      last_synced_at: '2026-09-02T09:14:03.000Z',
      next_allowed_at: null,
    })
    expect(result.instructions).toContain('3 new transaction')
  })

  it('tells the agent nothing was missing when the bank had no news', async () => {
    mocks.triggerConnectionSync.mockResolvedValue({
      ok: true,
      connection_id: CONNECTION_ID,
      bank: 'SEB',
      imported: 0,
      duplicates: 4,
      from_date: '2026-08-26',
      to_date: '2026-09-02',
      last_synced_at: '2026-09-02T09:14:03.000Z',
    })
    const result = (await tool.execute(
      { connection_id: CONNECTION_ID },
      COMPANY_ID,
      'user-1',
      {} as never,
    )) as Record<string, unknown>
    expect(result.synced).toBe(true)
    expect(result.instructions).toContain('nothing new')
  })

  it('answers a cooldown in-band with next_allowed_at instead of throwing', async () => {
    mocks.triggerConnectionSync.mockResolvedValue({
      ok: false,
      code: 'BANK_SYNC_COOLDOWN',
      connection_id: CONNECTION_ID,
      next_allowed_at: '2026-09-02T09:29:03.000Z',
      retry_after_seconds: 600,
    })
    const result = (await tool.execute(
      { connection_id: CONNECTION_ID },
      COMPANY_ID,
      'user-1',
      {} as never,
    )) as Record<string, unknown>
    expect(result).toMatchObject({
      synced: false,
      connection_id: CONNECTION_ID,
      next_allowed_at: '2026-09-02T09:29:03.000Z',
    })
    expect(result.instructions).toContain('next_allowed_at')
    // A cooldown can follow a FAILED attempt too (durable lease): the agent
    // must be told to check freshness rather than assume it.
    expect(result.instructions).toContain('last_synced_at')
  })

  it('answers a bank rate limit in-band with the time, and never suggests a renewal', async () => {
    mocks.triggerConnectionSync.mockResolvedValue({
      ok: false,
      code: 'BANK_RATE_LIMITED',
      connection_id: CONNECTION_ID,
      status: 'active',
      next_allowed_at: '2026-09-20T16:00:00.000Z',
      retry_after_seconds: 21600,
    })
    const result = (await tool.execute(
      { connection_id: CONNECTION_ID },
      COMPANY_ID,
      'user-1',
      {} as never,
    )) as Record<string, unknown>
    expect(result).toMatchObject({
      synced: false,
      connection_id: CONNECTION_ID,
      next_allowed_at: '2026-09-20T16:00:00.000Z',
    })
    // Our cooldown must not be presented as the bank's reset time.
    expect(result.instructions).toContain('not a reset time confirmed by the bank')
    expect(result.instructions).toContain('do not ask the user to renew')
  })

  it.each([
    'NOT_FOUND',
    'BANK_SYNC_NOT_ACTIVE',
    'BANK_SYNC_NO_ACCOUNTS',
    'BANK_SESSION_EXPIRED',
    'BANK_SYNC_FAILED',
  ] as const)('throws a coded error for %s so the dispatch envelope carries the remediation', async (code) => {
    mocks.triggerConnectionSync.mockResolvedValue({ ok: false, code, connection_id: CONNECTION_ID })
    await expect(
      tool.execute({ connection_id: CONNECTION_ID }, COMPANY_ID, 'user-1', {} as never),
    ).rejects.toMatchObject({ code })
  })

  // Replays the 12 calls (2026-10-29..11-09) that sent no
  // connection_id: the runner passed '' to a uuid column and the agent read
  // `invalid input syntax for type uuid: ""`.
  it.each([
    [{}, 'connection_id is required'],
    [{ connection_id: '' }, 'connection_id is required'],
    [{ connection_id: '  ' }, 'connection_id is required'],
    [{ connection_id: 'Swedbank' }, 'must be the UUID of a connection from gnubok_connect_bank (got "Swedbank")'],
  ])('refuses %j before the runner, naming where the id comes from', async (args, expected) => {
    const error = await tool.execute(args, COMPANY_ID, 'user-1', {} as never).then(
      () => null,
      (err: Error) => err,
    )
    expect(error).not.toBeNull()
    expect(mocks.triggerConnectionSync).not.toHaveBeenCalled()
    const envelope = toToolError(error, { toolName: 'gnubok_sync_bank' }).error
    expect(envelope).toMatchObject({
      code: 'VALIDATION_ERROR',
      retryable: false,
      remediation: { tool: 'gnubok_connect_bank' },
    })
    expect(envelope.message_en).toContain(expected)
    expect(envelope.message_en).not.toContain('invalid input syntax')
  })
})
