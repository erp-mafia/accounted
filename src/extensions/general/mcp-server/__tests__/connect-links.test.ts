import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { eventBus } from '@/lib/events/bus'
import { MCP_TOOL_CAPABILITY_MAP } from '@/lib/entitlements/keys'
import { tools } from '../server'

// Onboarding connect-link tools (issue #1814 PR 3): status + the browser link
// the user opens. Both flows need a cookie session and BankID in a browser,
// so the tools never try to drive them.

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const bankTool = tools.find((t) => t.name === 'gnubok_connect_bank')!
const skvTool = tools.find((t) => t.name === 'gnubok_connect_skatteverket')!

function listClient(rows: unknown[] | null, error: unknown = null) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    in: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    maybeSingle: vi.fn().mockResolvedValue({ data: rows?.[0] ?? null, error }),
    then: (resolve: (v: unknown) => void) => resolve({ data: rows, error }),
  }
  return { from: vi.fn(() => chain), chain }
}

describe('onboarding connect-link tools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('are read-only companies:read tools gated on the capability their link needs', () => {
    expect(TOOL_SCOPE_MAP.gnubok_connect_bank).toBe('companies:read')
    expect(TOOL_SCOPE_MAP.gnubok_connect_skatteverket).toBe('companies:read')
    expect(MCP_TOOL_CAPABILITY_MAP.gnubok_connect_bank).toBe('bank_sync')
    expect(MCP_TOOL_CAPABILITY_MAP.gnubok_connect_skatteverket).toBe('skatteverket')
    expect(bankTool.annotations.readOnlyHint).toBe(true)
    expect(skvTool.annotations.readOnlyHint).toBe(true)
  })

  it('bank: reports no connection and hands out the PSD2 import link', async () => {
    const { from, chain } = listClient([])
    const result = (await bankTool.execute({}, COMPANY_ID, 'user-1', { from } as never)) as Record<string, unknown>
    expect(result.connected).toBe(false)
    expect(result.connect_url).toBe('https://app.example.test/import?mode=psd2')
    expect(chain.eq).toHaveBeenCalledWith('company_id', COMPANY_ID)
  })

  it('bank: a named bank deep-links straight into that bank\'s consent', async () => {
    const { from } = listClient([])
    const result = (await bankTool.execute(
      { bank: 'Danske Bank' },
      COMPANY_ID,
      'user-1',
      { from } as never
    )) as Record<string, unknown>
    expect(result.connect_url).toBe('https://app.example.test/import?mode=psd2&bank=Danske%20Bank')
  })

  it('bank: a blank bank argument falls back to the plain picker link', async () => {
    const { from } = listClient([])
    const result = (await bankTool.execute(
      { bank: '   ' },
      COMPANY_ID,
      'user-1',
      { from } as never
    )) as Record<string, unknown>
    expect(result.connect_url).toBe('https://app.example.test/import?mode=psd2')
  })

  it('bank: nudges the agent to ask for the bank when none was passed, and not when one was', async () => {
    const bare = (await bankTool.execute({}, COMPANY_ID, 'user-1', {
      from: listClient([]).from,
    } as never)) as Record<string, unknown>
    expect(bare.instructions).toContain('BETTER LINK AVAILABLE')

    const named = (await bankTool.execute({ bank: 'Swedbank' }, COMPANY_ID, 'user-1', {
      from: listClient([]).from,
    } as never)) as Record<string, unknown>
    expect(named.instructions).not.toContain('BETTER LINK AVAILABLE')
  })

  it('bank: reports an active connection with freshness fields', async () => {
    const { from } = listClient([
      {
        id: 'c1',
        bank_name: 'Swedbank',
        status: 'active',
        created_at: '2026-08-01T00:00:00Z',
        last_synced_at: '2026-08-30T05:00:00Z',
        consent_expires: '2026-11-01T00:00:00Z',
        error_message: null,
      },
    ])
    const result = (await bankTool.execute({}, COMPANY_ID, 'user-1', { from } as never)) as Record<string, unknown>
    expect(result.connected).toBe(true)
    expect(result.connections).toEqual([
      {
        connection_id: 'c1',
        bank: 'Swedbank',
        status: 'active',
        since: '2026-08-01T00:00:00Z',
        last_synced_at: '2026-08-30T05:00:00Z',
        consent_expires: '2026-11-01T00:00:00Z',
        error_message: null,
      },
    ])
    expect(result.instructions).toContain('last_synced_at')
  })

  it('bank: surfaces the error_message and null sync stamp on a dead connection', async () => {
    const { from } = listClient([
      {
        id: 'c2',
        bank_name: 'SEB',
        status: 'expired',
        created_at: '2026-05-01T00:00:00Z',
        last_synced_at: null,
        consent_expires: '2026-07-15T00:00:00Z',
        error_message: 'Bankkopplingen behöver förnyas.',
      },
    ])
    const result = (await bankTool.execute({}, COMPANY_ID, 'user-1', { from } as never)) as Record<string, unknown>
    expect(result.connected).toBe(false)
    const rows = result.connections as Array<Record<string, unknown>>
    expect(rows[0].last_synced_at).toBeNull()
    expect(rows[0].consent_expires).toBe('2026-07-15T00:00:00Z')
    expect(rows[0].error_message).toBe('Bankkopplingen behöver förnyas.')
  })

  it('skatteverket: hands out the authorize link when enabled and not connected', async () => {
    vi.stubEnv('SKATTEVERKET_ENABLED', 'true')
    const { from } = listClient([])
    const result = (await skvTool.execute({}, COMPANY_ID, 'user-1', { from } as never)) as Record<string, unknown>
    expect(result.available).toBe(true)
    expect(result.connected).toBe(false)
    expect(result.connect_url).toBe(
      'https://app.example.test/api/extensions/ext/skatteverket/authorize?return_to=%2F'
    )
  })

  it('skatteverket: reports connected with the token expiry', async () => {
    vi.stubEnv('SKATTEVERKET_ENABLED', 'true')
    const { from } = listClient([{ expires_at: '2026-12-01T00:00:00Z' }])
    const result = (await skvTool.execute({}, COMPANY_ID, 'user-1', { from } as never)) as Record<string, unknown>
    expect(result.connected).toBe(true)
    expect(result.token_expires_at).toBe('2026-12-01T00:00:00Z')
  })

  it('refuses to hand out a link when NEXT_PUBLIC_APP_URL is not configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    const { from } = listClient([])
    await expect(bankTool.execute({}, COMPANY_ID, 'user-1', { from } as never)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    })
  })

  it('skatteverket: says so when the integration is disabled on the installation', async () => {
    vi.stubEnv('SKATTEVERKET_ENABLED', 'false')
    const { from } = listClient([])
    const result = (await skvTool.execute({}, COMPANY_ID, 'user-1', { from } as never)) as Record<string, unknown>
    expect(result.available).toBe(false)
    expect(result.connect_url).toBeNull()
  })
})

describe('gnubok_connect_migration', () => {
  const migrationTool = tools.find((t) => t.name === 'gnubok_connect_migration')!

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('renders the connect card and deep-links the wizard for an API provider', async () => {
    expect(
      (migrationTool as { _meta?: { ui: { resourceUri: string } } })._meta
    ).toEqual({ ui: { resourceUri: 'ui://connect-card/app.html' } })

    const result = (await migrationTool.execute(
      { provider: 'fortnox' },
      COMPANY_ID,
      'user-1',
      {} as never
    )) as Record<string, unknown>
    expect(result.connect_url).toBe('https://app.example.test/import?mode=migration&provider=fortnox')
    expect(result.api_connected).toBe(true)
    expect(result.provider_name).toBe('Fortnox')
  })

  it('tells the agent SIE comes first for a file-only provider', async () => {
    const result = (await migrationTool.execute(
      { provider: 'bokio' },
      COMPANY_ID,
      'user-1',
      {} as never
    )) as Record<string, unknown>
    expect(result.api_connected).toBe(false)
    expect(result.instructions).toContain('gnubok_create_sie_upload')
  })

  it('rejects an unknown provider', async () => {
    await expect(
      migrationTool.execute({ provider: 'monopol' }, COMPANY_ID, 'user-1', {} as never)
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })
})
