/**
 * The service-account MCP tools (lib/service-accounts): a read that lists the
 * company's accounts and a staged revoke. Both run the v1 doors' gate (a
 * person's key, an owner or admin) and never handle a secret; no tool mints
 * a key.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import type { ActorContext } from '../server'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))

import { tools } from '../server'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const OWNER_ID = '22222222-2222-4222-8222-222222222222'
const ACCOUNT_ID = '5b6c1d2e-0000-4000-8000-0000000000a1'
const OTHER_ACCOUNT_ID = '5b6c1d2e-0000-4000-8000-0000000000a2'
const OPERATION_ID = '33333333-3333-4333-8333-333333333333'

const listTool = tools.find((t) => t.name === 'gnubok_list_service_accounts')!
const revokeTool = tools.find((t) => t.name === 'gnubok_revoke_service_account')!

const PERSON_KEY: ActorContext = { type: 'api_key', id: 'key-1', label: 'Admin key' }
const SERVICE_ACCOUNT_KEY: ActorContext = { type: 'api_key', id: 'key-sa', label: 'Nattlig synk', serviceAccountId: ACCOUNT_ID }

const ACCOUNT_ROW = {
  id: ACCOUNT_ID,
  company_id: COMPANY_ID,
  name: 'Nattlig synk',
  sponsor_user_id: OWNER_ID,
  created_by: OWNER_ID,
  created_at: '2026-10-16T08:00:00Z',
  revoked_at: null,
  revoked_by: null,
}

/**
 * The caller's own membership (the gate's maybeSingle) and the sponsors'
 * memberships (the status read's list) come from the same table.
 */
function members(role: string) {
  return (calls: { method: string }[]) =>
    calls.some((c) => c.method === 'maybeSingle')
      ? { data: { role } }
      : { data: [{ user_id: OWNER_ID, role: 'owner' }] }
}

function client(over: NonNullable<Parameters<typeof createTableMockSupabase>[0]> = {}) {
  return createTableMockSupabase({
    company_members: members('owner'),
    companies: { data: { archived_at: null } },
    // One account by id (maybeSingle) for the revoke, the list otherwise.
    service_accounts: (calls: { method: string }[]) =>
      calls.some((c) => c.method === 'maybeSingle') ? { data: ACCOUNT_ROW } : { data: [ACCOUNT_ROW] },
    api_keys: { data: [] },
    api_key_companies: { data: [] },
    profiles: { data: [{ id: OWNER_ID, full_name: 'Anna Ägare', email: 'anna@example.se' }] },
    pending_operations: { data: { id: OPERATION_ID } },
    ...over,
  })
}

beforeEach(() => vi.clearAllMocks())

describe('service-account MCP tools: registration', () => {
  it('lists and stages a revoke under service_accounts:manage, search-only, and nothing mints a key', () => {
    expect(listTool).toBeDefined()
    expect(revokeTool).toBeDefined()
    expect(TOOL_SCOPE_MAP.gnubok_list_service_accounts).toBe('service_accounts:manage')
    expect(TOOL_SCOPE_MAP.gnubok_revoke_service_account).toBe('service_accounts:manage')
    expect(listTool.catalogVisibility).toBe('search')
    expect(revokeTool.catalogVisibility).toBe('search')
    expect(listTool.annotations.readOnlyHint).toBe(true)
    expect(revokeTool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    // A secret must never pass through a chat transcript.
    const minting = tools.filter((t) => /service_account/.test(t.name) && /(mint|create|key)/.test(t.name))
    expect(minting.map((t) => t.name)).toEqual([])
  })
})

describe('gnubok_list_service_accounts', () => {
  it('answers each account with its sponsor, status and key counts, never a key', async () => {
    const revoked = { ...ACCOUNT_ROW, id: OTHER_ACCOUNT_ID, name: 'Gammal import', revoked_at: '2026-10-01T00:00:00Z', revoked_by: OWNER_ID }
    const { supabase, findCalls } = client({
      service_accounts: { data: [ACCOUNT_ROW, revoked] },
      api_keys: {
        data: [
          { id: 'k1', service_account_id: ACCOUNT_ID, revoked_at: null },
          { id: 'k2', service_account_id: ACCOUNT_ID, revoked_at: '2026-10-10T00:00:00Z' },
          { id: 'k3', service_account_id: OTHER_ACCOUNT_ID, revoked_at: '2026-10-01T00:00:00Z' },
        ],
      },
    })

    const result = (await listTool.execute({}, COMPANY_ID, OWNER_ID, supabase as never, PERSON_KEY)) as {
      service_accounts: Array<Record<string, unknown>>
      count: number
    }

    expect(result.count).toBe(2)
    expect(result.service_accounts).toEqual([
      {
        service_account_id: ACCOUNT_ID,
        name: 'Nattlig synk',
        status: 'active',
        sponsor_user_id: OWNER_ID,
        sponsor_name: 'Anna Ägare',
        live_key_count: 1,
        revoked_key_count: 1,
        created_at: '2026-10-16T08:00:00Z',
        created_by_user_id: OWNER_ID,
        revoked_at: null,
        revoked_by_user_id: null,
      },
      expect.objectContaining({ service_account_id: OTHER_ACCOUNT_ID, status: 'revoked', live_key_count: 0, revoked_key_count: 1 }),
    ])
    // Keys are counted from their id and revocation only: no hash, no prefix.
    expect(findCalls('api_keys', 'select')).toEqual([['id, service_account_id, revoked_at']])
    expect(findCalls('api_keys', 'eq')).toContainEqual(['company_id', COMPANY_ID])
  })

  it("marks an account suspended when its sponsor is no longer an owner or admin, and names the sponsor by email without a name", async () => {
    const { supabase } = client({
      company_members: (calls: { method: string }[]) =>
        calls.some((c) => c.method === 'maybeSingle') ? { data: { role: 'admin' } } : { data: [{ user_id: OWNER_ID, role: 'member' }] },
      profiles: { data: [{ id: OWNER_ID, full_name: null, email: 'anna@example.se' }] },
    })
    const result = (await listTool.execute({}, COMPANY_ID, 'admin-1', supabase as never, PERSON_KEY)) as {
      service_accounts: Array<Record<string, unknown>>
    }
    expect(result.service_accounts[0]).toMatchObject({ status: 'suspended', sponsor_name: 'anna@example.se' })
  })

  it("refuses a service account's own key and a member, before reading any account", async () => {
    const asServiceAccount = client()
    await expect(
      listTool.execute({}, COMPANY_ID, OWNER_ID, asServiceAccount.supabase as never, SERVICE_ACCOUNT_KEY),
    ).rejects.toMatchObject({ code: 'SERVICE_ACCOUNT_KEY_NOT_PERMITTED' })
    expect(asServiceAccount.tables()).not.toContain('service_accounts')

    const asMember = client({ company_members: members('member') })
    await expect(listTool.execute({}, COMPANY_ID, 'member-1', asMember.supabase as never, PERSON_KEY)).rejects.toMatchObject({
      code: 'SERVICE_ACCOUNT_ADMIN_REQUIRED',
    })
    expect(asMember.tables()).not.toContain('service_accounts')
  })
})

describe('gnubok_revoke_service_account', () => {
  it('stages revoke_service_account (high risk) with the keys it will revoke, by prefix only', async () => {
    const { supabase, payloads, findCalls } = client({
      api_keys: {
        data: [
          { id: 'k1', name: 'Nyckel 1', key_prefix: 'gnubok_sk_Xb3k', scopes: ['invoices:read'], mode: 'live', created_at: '2026-10-16T08:01:00Z', last_used_at: null, revoked_at: null, service_account_id: ACCOUNT_ID },
          { id: 'k0', name: 'Gammal', key_prefix: 'gnubok_sk_Old0', scopes: ['invoices:read'], mode: 'live', created_at: '2026-10-15T08:01:00Z', last_used_at: null, revoked_at: '2026-10-16T07:00:00Z', service_account_id: ACCOUNT_ID },
        ],
      },
    })

    const result = (await revokeTool.execute({ service_account_id: ACCOUNT_ID }, COMPANY_ID, OWNER_ID, supabase as never, PERSON_KEY)) as Record<string, unknown>

    expect(result).toMatchObject({ staged: true, operation_id: OPERATION_ID, risk_level: 'high' })
    const [row] = payloads('pending_operations', 'insert') as Array<Record<string, unknown>>
    expect(row).toMatchObject({
      company_id: COMPANY_ID,
      user_id: OWNER_ID,
      operation_type: 'revoke_service_account',
      title: 'Återkalla tjänstekontot Nattlig synk',
      params: { service_account_id: ACCOUNT_ID },
      risk_level: 'high',
      actor_type: 'api_key',
    })
    expect((row.preview_data as Record<string, unknown>)).toMatchObject({
      service_account_id: ACCOUNT_ID,
      name: 'Nattlig synk',
      status: 'active',
      live_key_count: 1,
      keys_to_revoke: [{ api_key_id: 'k1', name: 'Nyckel 1', key_prefix: 'gnubok_sk_Xb3k' }],
    })
    // The staging reads; the revocation itself runs only on approval.
    expect(findCalls('rpc:revoke_service_account', 'rpc')).toEqual([])
    expect(JSON.stringify(row)).not.toMatch(/key_hash/)
  })

  it('stages nothing on a dry run', async () => {
    const { supabase, payloads } = client()
    const result = (await revokeTool.execute({ service_account_id: ACCOUNT_ID, dry_run: true }, COMPANY_ID, OWNER_ID, supabase as never, PERSON_KEY)) as Record<string, unknown>
    expect(result).toMatchObject({ staged: false, dry_run: true, risk_level: 'high' })
    expect(payloads('pending_operations', 'insert')).toEqual([])
  })

  it('answers SERVICE_ACCOUNT_NOT_FOUND for an id of no account here, and for a malformed one without a query', async () => {
    const missing = client({ service_accounts: { data: null } })
    await expect(
      revokeTool.execute({ service_account_id: OTHER_ACCOUNT_ID }, COMPANY_ID, OWNER_ID, missing.supabase as never, PERSON_KEY),
    ).rejects.toMatchObject({ code: 'SERVICE_ACCOUNT_NOT_FOUND' })

    const malformed = client()
    await expect(
      revokeTool.execute({ service_account_id: 'not-a-uuid' }, COMPANY_ID, OWNER_ID, malformed.supabase as never, PERSON_KEY),
    ).rejects.toMatchObject({ code: 'SERVICE_ACCOUNT_NOT_FOUND' })
    expect(malformed.tables()).not.toContain('service_accounts')
    expect(malformed.payloads('pending_operations', 'insert')).toEqual([])
  })

  it('stages nothing for an account that is already revoked', async () => {
    const { supabase, payloads } = client({
      service_accounts: { data: { ...ACCOUNT_ROW, revoked_at: '2026-10-01T00:00:00Z', revoked_by: OWNER_ID } },
    })
    await expect(
      revokeTool.execute({ service_account_id: ACCOUNT_ID }, COMPANY_ID, OWNER_ID, supabase as never, PERSON_KEY),
    ).rejects.toMatchObject({ code: 'SERVICE_ACCOUNT_REVOKED' })
    expect(payloads('pending_operations', 'insert')).toEqual([])
  })

  it("refuses a service account's own key and a member, and a missing id", async () => {
    const asServiceAccount = client()
    await expect(
      revokeTool.execute({ service_account_id: ACCOUNT_ID }, COMPANY_ID, OWNER_ID, asServiceAccount.supabase as never, SERVICE_ACCOUNT_KEY),
    ).rejects.toMatchObject({ code: 'SERVICE_ACCOUNT_KEY_NOT_PERMITTED' })

    const asMember = client({ company_members: members('member') })
    await expect(
      revokeTool.execute({ service_account_id: ACCOUNT_ID }, COMPANY_ID, 'member-1', asMember.supabase as never, PERSON_KEY),
    ).rejects.toMatchObject({ code: 'SERVICE_ACCOUNT_ADMIN_REQUIRED' })
    expect(asMember.payloads('pending_operations', 'insert')).toEqual([])

    await expect(revokeTool.execute({}, COMPANY_ID, OWNER_ID, client().supabase as never, PERSON_KEY)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
  })
})
