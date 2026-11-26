import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { eventBus } from '@/lib/events/bus'
import { MCP_TOOL_CAPABILITY_MAP } from '@/lib/entitlements/keys'
import { setBankFeedConnectForTests, type BankFeedConnect } from '@/lib/bank-feed/connect'
import { createTableMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

// The filing readiness reads on the service role whichever client the tool
// gets (skv-connection-health.ts), as on MCP: it reads the same rows here.
let serviceDb: unknown = null
vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return { ...actual, createServiceClientNoCookies: () => serviceDb }
})

// Onboarding connect-link tools (issue #1814 PR 3): status + the browser link
// the user opens. Both flows need a cookie session and BankID in a browser,
// so the tools never try to drive them.

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const bankTool = tools.find((t) => t.name === 'gnubok_connect_bank')!
const skvTool = tools.find((t) => t.name === 'gnubok_connect_skatteverket')!
// The link names the company the tool was called for: the BankID session is
// stored for it, not for the company the user's browser has open (crm#1622).
const SKV_CONNECT_URL = `https://app.example.test/api/extensions/ext/skatteverket/authorize?return_to=%2Fsettings%2Fskatteverket&company_id=${COMPANY_ID}`

/** Open the Open Payments door for COMPANY_ID: a connector with these banks, and the company on the pilot list. */
function openDoor(banks: Array<{ bic: string; name: string }> | Error = [{ bic: 'SWEDSESS', name: 'Swedbank' }, { bic: 'ESSESESS', name: 'SEB' }]) {
  vi.stubEnv('OPENPAYMENTS_READING_COMPANY_IDS', COMPANY_ID)
  setBankFeedConnectForTests({
    banks: async () => {
      if (banks instanceof Error) throw banks
      return banks.map((b) => ({ ...b, logoUrl: null, decoupled: true, redirect: false }))
    },
  } as unknown as BankFeedConnect)
}

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
  const client = { from: vi.fn(() => chain), chain }
  serviceDb = client
  return client
}

describe('onboarding connect-link tools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    serviceDb = null
    eventBus.clear()
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    setBankFeedConnectForTests(undefined)
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
        aggregator: 'enable_banking',
        status: 'active',
        since: '2026-08-01T00:00:00Z',
        last_synced_at: '2026-08-30T05:00:00Z',
        consent_expires: '2026-11-01T00:00:00Z',
        error_message: null,
      },
    ])
    expect(result.instructions).toContain('last_synced_at')
    // Door closed: no switch link, no Open Payments prose.
    expect(result.connections).toEqual([expect.not.objectContaining({ switch_url: expect.anything() })])
    expect(result.instructions).not.toContain('Open Payments')
  })

  describe('once the Enable Banking feed has ended', () => {
    const rows = [
      { id: 'c1', bank_name: 'Swedbank', aggregator: 'enable_banking', status: 'active', created_at: '2026-08-01T00:00:00Z', last_synced_at: '2026-11-09T05:00:00Z', consent_expires: '2027-01-01T00:00:00Z', error_message: null },
      { id: 'c2', bank_name: 'SEB', aggregator: 'open_payments', status: 'active', created_at: '2026-11-01T00:00:00Z', last_synced_at: '2026-11-10T05:00:00Z', consent_expires: '2027-04-01T00:00:00Z', error_message: null },
    ]

    it('flags the Enable Banking rows with sunset and tells the agent what the person does instead', async () => {
      vi.stubEnv('OPENPAYMENTS_SWITCH_DEADLINE', '2026-01-01')
      openDoor()
      const { from } = listClient(rows)
      const result = (await bankTool.execute({}, COMPANY_ID, 'user-1', { from } as never)) as { connections: Array<Record<string, unknown>>; instructions: string }
      expect(result.connections[0]).toMatchObject({ connection_id: 'c1', sunset: true, switch_url: expect.stringContaining('bank_connect_switch=c1') })
      expect(result.connections[1]).not.toHaveProperty('sunset')
      expect(result.instructions).toContain('ENABLE BANKING HAS ENDED')
      expect(result.instructions).toContain('ENABLE_BANKING_SUNSET')
    })

    it('says nothing about it while the deadline is ahead, or when no Enable Banking row is left', async () => {
      vi.stubEnv('OPENPAYMENTS_SWITCH_DEADLINE', '2099-01-01')
      openDoor()
      const ahead = (await bankTool.execute({}, COMPANY_ID, 'user-1', { from: listClient(rows).from } as never)) as { connections: Array<Record<string, unknown>>; instructions: string }
      expect(ahead.connections.every((c) => !('sunset' in c))).toBe(true)
      expect(ahead.instructions).not.toContain('ENABLE BANKING HAS ENDED')
      vi.stubEnv('OPENPAYMENTS_SWITCH_DEADLINE', '2026-01-01')
      const onlyNew = (await bankTool.execute({}, COMPANY_ID, 'user-1', { from: listClient([rows[1]]).from } as never)) as { instructions: string }
      expect(onlyNew.instructions).not.toContain('ENABLE BANKING HAS ENDED')
    })
  })

  describe('with the Open Payments door open', () => {
    const ENABLE_BANKING_ROW = {
      id: 'c1',
      bank_name: 'Swedbank',
      aggregator: 'enable_banking',
      status: 'active',
      created_at: '2026-08-01T00:00:00Z',
      last_synced_at: '2026-08-30T05:00:00Z',
      consent_expires: '2026-11-01T00:00:00Z',
      error_message: null,
    }
    const OPEN_PAYMENTS_ROW = { ...ENABLE_BANKING_ROW, id: 'c2', bank_name: 'SEB', aggregator: 'open_payments' }

    it('hands out the Koppla banken deep link, the picker when no bank is named', async () => {
      openDoor()
      const { from } = listClient([])
      const result = (await bankTool.execute({}, COMPANY_ID, 'user-1', { from } as never)) as Record<string, unknown>
      expect(result.connect_url).toBe('https://app.example.test/settings/connections?bank_connect=new')
      expect(result.instructions).toContain('BankID')
      expect(result.instructions).toContain('180 days')
      expect(result.instructions).toContain('CONFIRMS WHICH ACCOUNTS')
      expect(result.instructions).toContain('know-your-customer')
      expect(result.instructions).toContain('gnubok_bank_feed_connect_link')
      // No Enable Banking rows: nothing about a switch.
      expect(result.instructions).not.toContain('switch_url')
    })

    it('preselects a named bank by its BIC when the bank list resolves it', async () => {
      openDoor()
      const { from } = listClient([])
      const result = (await bankTool.execute({ bank: 'seb' }, COMPANY_ID, 'user-1', { from } as never)) as Record<string, unknown>
      expect(result.connect_url).toBe('https://app.example.test/settings/connections?bank_connect=new&bic=ESSESESS')
    })

    it('falls back to the picker for a bank the list does not know, and when the list cannot be read', async () => {
      openDoor()
      const unknown = (await bankTool.execute({ bank: 'Monopolbanken' }, COMPANY_ID, 'user-1', { from: listClient([]).from } as never)) as Record<string, unknown>
      expect(unknown.connect_url).toBe('https://app.example.test/settings/connections?bank_connect=new')

      openDoor(new Error('provider down'))
      const failed = (await bankTool.execute({ bank: 'Swedbank' }, COMPANY_ID, 'user-1', { from: listClient([]).from } as never)) as Record<string, unknown>
      expect(failed.connect_url).toBe('https://app.example.test/settings/connections?bank_connect=new')
    })

    it('gives every connection its aggregator and Enable Banking rows the one-click switch link', async () => {
      openDoor()
      const { from } = listClient([ENABLE_BANKING_ROW, OPEN_PAYMENTS_ROW])
      const result = (await bankTool.execute({}, COMPANY_ID, 'user-1', { from } as never)) as {
        connections: Array<Record<string, unknown>>
        instructions: string
      }
      expect(result.connections).toEqual([
        expect.objectContaining({ connection_id: 'c1', aggregator: 'enable_banking', switch_url: 'https://app.example.test/settings/connections?bank_connect_switch=c1' }),
        expect.objectContaining({ connection_id: 'c2', aggregator: 'open_payments' }),
      ])
      expect(result.connections[1]).not.toHaveProperty('switch_url')
      expect(result.instructions).toContain('one click')
      expect(result.instructions).toContain('gnubok_bank_feed_switch_progress')
    })

    it('keeps the Enable Banking link when the company is not on the pilot list', async () => {
      openDoor()
      vi.stubEnv('OPENPAYMENTS_READING_COMPANY_IDS', '22222222-2222-4222-8222-222222222222')
      const { from } = listClient([])
      const result = (await bankTool.execute({ bank: 'Swedbank' }, COMPANY_ID, 'user-1', { from } as never)) as Record<string, unknown>
      expect(result.connect_url).toBe('https://app.example.test/import?mode=psd2&bank=Swedbank')
    })
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
    expect(result.connect_url).toBe(SKV_CONNECT_URL)
  })

  it('skatteverket: reports connected with the token expiry', async () => {
    vi.stubEnv('SKATTEVERKET_ENABLED', 'true')
    const { from } = listClient([
      { user_id: 'user-1', status: 'active', created_at: '2026-09-01T00:00:00Z', expires_at: '2026-12-01T00:00:00Z' },
    ])
    const result = (await skvTool.execute({}, COMPANY_ID, 'user-1', { from } as never)) as Record<string, unknown>
    expect(result.connected).toBe(true)
    expect(result.status).toBe('connected')
    expect(result.token_expires_at).toBe('2026-12-01T00:00:00Z')
  })

  it("skatteverket: connected through another member's session, the caller cannot file and gets the link (crm#1263)", async () => {
    vi.stubEnv('SKATTEVERKET_ENABLED', 'true')
    const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString()
    const { from } = listClient([
      { user_id: 'user-2', status: 'active', created_at: inMinutes(-3), expires_at: inMinutes(57), refresh_count: 0, refresh_token: 'c' },
      { user_id: 'user-1', status: 'needs_reconsent', created_at: '2026-09-20T04:00:46Z', expires_at: '2026-09-20T05:00:46Z', refresh_count: 2, refresh_token: 'c' },
    ])
    const result = (await skvTool.execute({}, COMPANY_ID, 'user-1', { from } as never)) as Record<string, unknown>
    // The company is connected (reads work) ...
    expect(result.connected).toBe(true)
    expect(result.status).toBe('connected')
    // ... but filing runs on the caller's own BankID login, which is dead.
    expect(result.can_file).toBe(false)
    expect(result.connect_url).toBe(SKV_CONNECT_URL)
    expect(String(result.instructions)).toContain('Filing is not possible for this user yet')
    expect(String(result.instructions)).toContain('another member of the company')
    expect(String(result.instructions)).not.toContain('can be filed from here')
  })

  it('skatteverket: can_file when the caller holds the live session', async () => {
    vi.stubEnv('SKATTEVERKET_ENABLED', 'true')
    const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString()
    const { from } = listClient([
      { user_id: 'user-1', status: 'active', created_at: inMinutes(-3), expires_at: inMinutes(57), refresh_count: 0, refresh_token: 'c' },
    ])
    const result = (await skvTool.execute({}, COMPANY_ID, 'user-1', { from } as never)) as Record<string, unknown>
    expect(result.can_file).toBe(true)
    expect(String(result.instructions)).toContain('can be filed from here')
  })

  it('skatteverket: a token flagged needs_reconsent is NOT connected (feedback seq 604946)', async () => {
    vi.stubEnv('SKATTEVERKET_ENABLED', 'true')
    const { from } = listClient([
      { user_id: 'user-1', status: 'needs_reconsent', created_at: '2026-09-15T12:00:00Z', expires_at: '2026-09-15T13:27:00Z' },
    ])
    const result = (await skvTool.execute({}, COMPANY_ID, 'user-1', { from } as never)) as Record<string, unknown>
    expect(result.connected).toBe(false)
    expect(result.status).toBe('needs_reconsent')
    expect(result.connect_url).toBe(SKV_CONNECT_URL)
    expect(String(result.instructions)).toMatch(/expired/)
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

  // crm#1649: the migration brings no underlag; a step of its own does. The
  // tool promised "documents" with the migration and said nothing when they
  // never came.
  describe('underlag (crm#1649)', () => {
    const run = (value: Record<string, unknown> | null) =>
      createTableMockSupabase({ extension_data: { data: value ? { value } : null } }).supabase

    it('says the underlag step has not run and how the user runs it, without promising documents', async () => {
      const result = (await migrationTool.execute(
        { provider: 'fortnox' }, COMPANY_ID, 'user-1', run(null) as never
      )) as Record<string, unknown>

      expect(result.underlag).toEqual({ status: 'not_fetched' })
      expect(result.instructions).toContain('Hämta underlag')
      expect(result.instructions).toContain('approves Fortnox file access once')
      expect(result.instructions).not.toMatch(/suppliers and documents/)
      expect(migrationTool.description).not.toMatch(/documents/)
    })

    it('reports a finished run with what came and what was left out', async () => {
      const result = (await migrationTool.execute(
        { provider: 'fortnox' }, COMPANY_ID, 'user-1',
        run({
          provider: 'fortnox', complete: true, updatedAt: '2026-11-03T13:07:02.863Z', total: 50,
          linked: 30, skipped: 18, unmatched: 2, failed: 0, locked: 0,
          unreachableSources: [{ source: 'supplier_invoice_files', scope: 'connectfile', reason: 'permission', providerMessage: null }],
        }) as never
      )) as Record<string, unknown>

      expect(result.underlag).toEqual({
        status: 'complete', updated_at: '2026-11-03T13:07:02.863Z', on_verifikat: 48, total: 50,
        unmatched: 2, failed: 0, locked: 0, left_out: ['connectfile:permission'],
      })
    })

    it('tells an unfinished run, and one waiting for a reconnect, apart from a finished one', async () => {
      const open = (await migrationTool.execute(
        { provider: 'fortnox' }, COMPANY_ID, 'user-1',
        run({ provider: 'fortnox', complete: false, total: 50, linked: 10, skipped: 0 }) as never
      )) as { underlag: { status: string } }
      const refused = (await migrationTool.execute(
        { provider: 'fortnox' }, COMPANY_ID, 'user-1',
        run({ provider: 'fortnox', complete: false, needsReconnect: true, total: 50, linked: 10, skipped: 0 }) as never
      )) as { underlag: { status: string } }

      expect(open.underlag.status).toBe('incomplete')
      expect(refused.underlag.status).toBe('needs_reconnect')
    })

    it('does not count another provider run as this one', async () => {
      const result = (await migrationTool.execute(
        { provider: 'fortnox' }, COMPANY_ID, 'user-1',
        run({ provider: 'bokio', complete: true, total: 5, linked: 5, skipped: 0 }) as never
      )) as Record<string, unknown>

      expect(result.underlag).toEqual({ status: 'not_fetched' })
    })

    it('says a provider without an underlag import has none, and reads nothing', async () => {
      const result = (await migrationTool.execute(
        { provider: 'briox' }, COMPANY_ID, 'user-1', {} as never
      )) as Record<string, unknown>

      expect(result.underlag).toBeUndefined()
      expect(result.instructions).toContain('underlag are not fetched')
    })

    it('keeps the connect card when the run cannot be read', async () => {
      const result = (await migrationTool.execute(
        { provider: 'fortnox' }, COMPANY_ID, 'user-1', {} as never
      )) as Record<string, unknown>

      expect(result.connect_url).toBe('https://app.example.test/import?mode=migration&provider=fortnox')
      expect(result.underlag).toEqual({ status: 'unknown' })
    })
  })

  // Agents had no read of the import itself: a job stopped on records to
  // review looked the same as one still running.
  describe('job', () => {
    const JOB = { id: 'job-1', state: 'needs_attention', phase: 'completed', error_code: null, updated_at: '2026-11-08T10:00:00Z', review_accepted_at: null }

    it('reports the latest job of the provider with its records per resource, read for this company only', async () => {
      const { supabase, findCalls } = createTableMockSupabase({
        migration_jobs: { data: JOB },
        'rpc:provider_migration_counts': {
          data: [{ resource: 'supplierInvoices', total: '12', imported: '10', completed: '10', skipped: '0', needs_attention: '2', pending: '0' }],
        },
      })
      const result = (await migrationTool.execute({ provider: 'fortnox' }, COMPANY_ID, 'user-1', supabase as never)) as Record<string, unknown>

      expect(result.job).toEqual({
        status: 'needs_attention', phase: 'completed', error_code: null, updated_at: '2026-11-08T10:00:00Z', accepted_at: null,
        resources: [{ resource: 'supplierInvoices', total: 12, imported: 10, needs_attention: 2, pending: 0, skipped: 0 }],
      })
      expect(findCalls('migration_jobs', 'eq')).toEqual(expect.arrayContaining([['company_id', COMPANY_ID], ['provider', 'fortnox']]))
      expect(findCalls('rpc:provider_migration_counts', 'rpc')).toEqual([[{ p_job_id: 'job-1' }]])
      expect(result.instructions).toContain('job.status')
    })

    it('says no job has started, for a file provider too', async () => {
      const { supabase } = createTableMockSupabase({ migration_jobs: { data: null } })
      const result = (await migrationTool.execute({ provider: 'bokio' }, COMPANY_ID, 'user-1', supabase as never)) as Record<string, unknown>

      expect(result.job).toEqual({ status: 'not_started' })
    })

    it('marks counts it could not read as null, never as an empty import', async () => {
      const { supabase } = createTableMockSupabase({
        migration_jobs: { data: { ...JOB, state: 'running', phase: 'import' } },
        'rpc:provider_migration_counts': { error: { code: '57014', message: 'canceling statement due to statement timeout' } },
      })
      const result = (await migrationTool.execute({ provider: 'fortnox' }, COMPANY_ID, 'user-1', supabase as never)) as { job: Record<string, unknown> }

      expect(result.job).toMatchObject({ status: 'running', phase: 'import', resources: null })
    })

    it('keeps the connect card when the job cannot be read', async () => {
      const { supabase } = createTableMockSupabase({ migration_jobs: { error: { code: '42501', message: 'permission denied' } } })
      const result = (await migrationTool.execute({ provider: 'fortnox' }, COMPANY_ID, 'user-1', supabase as never)) as Record<string, unknown>

      expect(result.connect_url).toBe('https://app.example.test/import?mode=migration&provider=fortnox')
      expect(result.job).toEqual({ status: 'unknown' })
    })
  })
})

/**
 * crm#1201: SEB keeps one active Enable Banking consent per BankID login, so
 * connecting it for a second company stops the first company's feed. The web
 * page warns before BankID; the agent tool has to say it before it hands out
 * the link, with the ways that keep the other feed (the Återanvänd offer,
 * another signer, files).
 */
describe('gnubok_connect_bank: one consent per login at the same bank in another company', () => {
  const SIBLING = '22222222-2222-4222-8222-222222222222'
  const HIDDEN = '33333333-3333-4333-8333-333333333333'

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    setBankFeedConnectForTests(undefined)
  })

  /**
   * bank_connections answers this company's rows, or (the query that
   * excludes it) the user's rows in OTHER companies; company_members the
   * user's memberships for the names.
   */
  function world(opts: {
    own?: Array<Record<string, unknown>>
    elsewhere: Array<{ company_id: string; bank_name: string }>
    members?: Array<{ id: string; name: string }>
  }) {
    const siblingCalls: Array<Array<{ method: string; args: unknown[] }>> = []
    const members = opts.members ?? [{ id: COMPANY_ID, name: 'Nya AB' }, { id: SIBLING, name: 'Första AB' }]
    const { supabase } = createTableMockSupabase({
      bank_connections: (calls) => {
        if (calls.some((c) => c.method === 'neq')) {
          siblingCalls.push(calls)
          return { data: opts.elsewhere }
        }
        return { data: opts.own ?? [] }
      },
      company_members: {
        data: members.map((c, i) => ({ id: `m${i}`, company_id: c.id, role: 'owner', companies: { id: c.id, name: c.name, archived_at: null } })),
      },
      company_settings: { data: [] },
    })
    return { supabase, siblingCalls }
  }

  async function run(args: Record<string, unknown>, w: ReturnType<typeof world>, actor?: Record<string, unknown>) {
    return (await bankTool.execute(args, COMPANY_ID, 'user-1', w.supabase as never, actor as never)) as { instructions: string; connect_url: string }
  }

  it('warns before the Enable Banking link and names the ways that keep the other feed', async () => {
    const w = world({ elsewhere: [{ company_id: SIBLING, bank_name: 'SEB' }] })
    const result = await run({ bank: 'SEB' }, w)

    expect(result.connect_url).toBe('https://app.example.test/import?mode=psd2&bank=SEB')
    expect(result.instructions).toContain('ONE CONSENT PER LOGIN')
    expect(result.instructions).toContain(`Första AB (${SIBLING})`)
    expect(result.instructions).toContain('stops that feed')
    expect(result.instructions).toContain('Återanvänd')
    expect(result.instructions).toContain('another person with their own BankID')
    // Only the caller's own live Enable Banking rows, in other companies.
    expect(w.siblingCalls[0]).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['user_id', 'user-1'] },
        { method: 'eq', args: ['aggregator', 'enable_banking'] },
        { method: 'eq', args: ['status', 'active'] },
        { method: 'neq', args: ['company_id', COMPANY_ID] },
      ])
    )
  })

  it('says it also without a named bank, and not for a bank that allows several consents', async () => {
    const seb = await run({}, world({ elsewhere: [{ company_id: SIBLING, bank_name: 'SEB' }] }))
    expect(seb.instructions).toContain('ONE CONSENT PER LOGIN: SEB')

    const handelsbanken = await run({}, world({ elsewhere: [{ company_id: SIBLING, bank_name: 'Handelsbanken' }] }))
    expect(handelsbanken.instructions).not.toContain('ONE CONSENT PER LOGIN')
  })

  it('stays quiet about another bank than the one the user named', async () => {
    const result = await run({ bank: 'Swedbank' }, world({ elsewhere: [{ company_id: SIBLING, bank_name: 'SEB' }] }))
    expect(result.instructions).not.toContain('ONE CONSENT PER LOGIN')
  })

  it('stays quiet when this company already reads that bank', async () => {
    const own = [{ id: 'c1', bank_name: 'SEB', status: 'active', created_at: '2026-10-01T00:00:00Z', last_synced_at: null, consent_expires: null, error_message: null }]
    const result = await run({}, world({ own, elsewhere: [{ company_id: SIBLING, bank_name: 'SEB' }] }))
    expect(result.instructions).not.toContain('ONE CONSENT PER LOGIN')
  })

  it('never names a company the connection does not reach', async () => {
    const w = world({ elsewhere: [{ company_id: HIDDEN, bank_name: 'SEB' }] })
    const result = await run({}, w, { type: 'api_key', allowedCompanyIds: [COMPANY_ID, SIBLING] })
    expect(result.instructions).not.toContain(HIDDEN)
    expect(result.instructions).not.toContain('ONE CONSENT PER LOGIN')
  })

  it('through Open Payments says the effect on the other feed is not known and to check it after', async () => {
    openDoor()
    const result = await run({ bank: 'SEB' }, world({ elsewhere: [{ company_id: SIBLING, bank_name: 'SEB' }] }))

    expect(result.connect_url).toContain('/settings/connections?bank_connect=new')
    expect(result.instructions).not.toContain('ONE CONSENT PER LOGIN')
    expect(result.instructions).toContain('This company connects through Open Payments with its own consent')
    expect(result.instructions).toContain('not known yet')
    expect(result.instructions).toContain(`Första AB (${SIBLING})`)
  })

  it('says nothing once the Enable Banking feed has ended', async () => {
    vi.stubEnv('OPENPAYMENTS_SWITCH_DEADLINE', '2026-01-01')
    const result = await run({ bank: 'SEB' }, world({ elsewhere: [{ company_id: SIBLING, bank_name: 'SEB' }] }))
    expect(result.instructions).not.toContain('Första AB')
  })
})
