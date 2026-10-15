/**
 * Pinned previews over MCP (lib/operations/preview-token.ts), on one
 * generated write: gnubok_update_account (operation accounts.update).
 *
 * An MCP write never commits: its "commit" is the staging the person then
 * approves. So the pin holds the staging to the dry run the person saw: the
 * dry run answers preview_token; staging with it recomputes the dry run and,
 * when the fingerprint differs, refuses with PREVIEW_STALE (the fresh
 * preview and its token in error.details) and stages nothing. The token is
 * the one v1 issues for the same input, so it crosses doors but never
 * companies, operations or inputs.
 *
 * The argument is accepted but not declared (tools/list budget): the
 * dispatcher's unknown-argument guard lets it through on generated writes
 * only, which the second block checks end to end.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'

const holder = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))
vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    validateApiKey: vi.fn().mockResolvedValue({
      userId: 'user-1',
      companyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      scopes: ['bookkeeping:write', 'reports:read'],
      apiKeyId: 'key-1',
      apiKeyName: 'Agent key',
      mode: 'live',
    }),
    createServiceClientNoCookies: vi.fn(() => holder.client),
  }
})
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})

import { createTableMockSupabase, type TableMockResult } from '@/tests/helpers'
import { accountsUpdate } from '@/lib/operations/accounts'
import { operationPreviewToken } from '@/lib/operations/preview-token'
import { handleMcpRequest, tools } from '../server'

const COMPANY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const COMPANY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const updateAccount = tools.find((t) => t.name === 'gnubok_update_account')!
const createAccount = tools.find((t) => t.name === 'gnubok_create_account')!

const CURRENT = {
  account_number: '6570',
  account_name: 'Bankkostnader',
  description: null,
  default_vat_code: null,
  default_vat_rate: null,
  default_vat_treatment: null,
  vat_box: null,
  sru_code: '7522',
  is_active: true,
}
const ARGS = { account_number: '6570', account_name: 'Bankavgifter' }

/** One call's database; chart_of_accounts answers the dry run's read. */
function db(chart: TableMockResult[] = [{ data: CURRENT }]) {
  const mock = createTableMockSupabase({
    company_members: (calls) => ({
      data: {
        company_id: calls.find((c) => c.method === 'eq' && c.args[0] === 'company_id')?.args[1] ?? COMPANY_A,
        role: 'owner',
      },
    }),
    chart_of_accounts: chart,
    pending_operations: (calls) => {
      const insert = calls.find((c) => c.method === 'insert')
      return { data: insert ? { id: '44444444-4444-4444-8444-444444444444', ...(insert.args[0] as object) } : null }
    },
  })
  holder.client = mock.supabase
  return mock
}

type Staged = { staged: boolean; preview_token?: string; message: string; preview: Record<string, unknown> }

async function dryRun(current = CURRENT, companyId = COMPANY_A): Promise<Staged> {
  const mock = db([{ data: current }])
  const answer = (await updateAccount.execute({ ...ARGS, dry_run: true }, companyId, 'user-1', mock.supabase as never)) as Staged
  return answer
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('gnubok_update_account: a staging pinned to the preview the person saw', () => {
  it('the dry run answers preview_token, says how to send it back, and stages nothing', async () => {
    const mock = db()
    const answer = (await updateAccount.execute({ ...ARGS, dry_run: true }, COMPANY_A, 'user-1', mock.supabase as never)) as Staged
    expect(answer.staged).toBe(false)
    expect(answer.preview).toMatchObject({ current: CURRENT, changes: { account_name: 'Bankavgifter' } })
    expect(answer.preview_token).toMatch(/^pv1\.[A-Za-z0-9_-]{43}$/)
    expect(answer.message).toContain(`preview_token="${answer.preview_token}"`)
    expect(mock.payloads('pending_operations', 'insert')).toHaveLength(0)
  })

  it('is the token v1 issues for the same input: one fingerprint for every door', async () => {
    const { preview_token } = await dryRun()
    const v1Preview = { account_number: '6570', current: CURRENT, changes: { account_name: 'Bankavgifter' } }
    expect(preview_token).toBe(operationPreviewToken(accountsUpdate, COMPANY_A, ARGS, v1Preview))
  })

  it('staging with the token while nothing changed stages exactly one pending operation', async () => {
    const { preview_token } = await dryRun()
    const mock = db()
    const staged = (await updateAccount.execute({ ...ARGS, preview_token }, COMPANY_A, 'user-1', mock.supabase as never)) as Staged
    expect(staged.staged).toBe(true)
    expect(mock.payloads('pending_operations', 'insert')).toEqual([
      expect.objectContaining({ operation_type: 'update_account', params: ARGS }),
    ])
  })

  it('staging after the account changed: PREVIEW_STALE with the fresh preview and token, nothing staged', async () => {
    const { preview_token } = await dryRun()
    const moved = { ...CURRENT, is_active: false }
    const mock = db([{ data: moved }])

    const refusal = await updateAccount
      .execute({ ...ARGS, preview_token }, COMPANY_A, 'user-1', mock.supabase as never)
      .then(() => null, (err: unknown) => err as { code: string; details: { preview: unknown; preview_token: string } })

    expect(refusal?.code).toBe('PREVIEW_STALE')
    expect(refusal?.details.preview).toMatchObject({ current: moved })
    expect(refusal?.details.preview_token).toBe((await dryRun(moved)).preview_token)
    expect(refusal?.details.preview_token).not.toBe(preview_token)
    expect(mock.payloads('pending_operations', 'insert')).toHaveLength(0)
  })

  it('a token never crosses companies, inputs or operations', async () => {
    const { preview_token } = await dryRun()

    let mock = db()
    await expect(
      updateAccount.execute({ ...ARGS, preview_token }, COMPANY_B, 'user-1', mock.supabase as never),
    ).rejects.toMatchObject({ code: 'PREVIEW_STALE' })
    expect(mock.payloads('pending_operations', 'insert')).toHaveLength(0)

    mock = db()
    await expect(
      updateAccount.execute({ ...ARGS, account_name: 'Något annat', preview_token }, COMPANY_A, 'user-1', mock.supabase as never),
    ).rejects.toMatchObject({ code: 'PREVIEW_STALE' })
    expect(mock.payloads('pending_operations', 'insert')).toHaveLength(0)

    // gnubok_create_account for a number the chart does not carry: its own
    // dry run passes, and its fingerprint is not update_account's.
    mock = db([{ data: null }])
    await expect(
      createAccount.execute({ account_number: '6570', preview_token }, COMPANY_A, 'user-1', mock.supabase as never),
    ).rejects.toMatchObject({ code: 'PREVIEW_STALE' })
    expect(mock.payloads('pending_operations', 'insert')).toHaveLength(0)
  })

  it('a malformed token is VALIDATION_ERROR before anything runs; null means no token', async () => {
    const mock = db()
    await expect(
      updateAccount.execute({ ...ARGS, preview_token: 'pv1.nope' }, COMPANY_A, 'user-1', mock.supabase as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(mock.findCalls('chart_of_accounts', 'select')).toHaveLength(0)

    const staged = (await updateAccount.execute({ ...ARGS, preview_token: null }, COMPANY_A, 'user-1', db().supabase as never)) as Staged
    expect(staged.staged).toBe(true)
  })

  it('without a token nothing changes: it stages as before and the staged answer carries no token', async () => {
    const mock = db()
    const staged = (await updateAccount.execute(ARGS, COMPANY_A, 'user-1', mock.supabase as never)) as Staged
    expect(staged.staged).toBe(true)
    expect(staged.preview_token).toBeUndefined()
    expect(mock.payloads('pending_operations', 'insert')).toHaveLength(1)
  })
})

describe('the dispatcher: preview_token accepted but never declared', () => {
  function call(name: string, args: Record<string, unknown>): Request {
    return new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })
  }
  async function result(response: Response) {
    const json = await response.json()
    const r = json.result as { isError?: boolean; content: { text: string }[] }
    return { isError: r.isError === true, payload: JSON.parse(r.content[0].text) as Record<string, unknown> }
  }

  it('costs nothing in tools/list: inputSchema does not declare it', () => {
    expect(Object.keys((updateAccount.inputSchema as { properties: object }).properties)).not.toContain('preview_token')
    expect(updateAccount.undeclaredArgs).toEqual(['preview_token'])
  })

  it('a stale token reaches the agent as PREVIEW_STALE with error.details, not as an unknown parameter', async () => {
    const { preview_token } = await dryRun()
    const mock = db([{ data: { ...CURRENT, account_name: 'Bank' } }])

    const { isError, payload } = await result(await handleMcpRequest(call('gnubok_update_account', { ...ARGS, preview_token })))

    expect(isError).toBe(true)
    const error = payload.error as { code: string; retryable: boolean; details: { preview: unknown; preview_token: string } }
    expect(error.code).toBe('PREVIEW_STALE')
    expect(error.retryable).toBe(false)
    expect(error.details.preview).toMatchObject({ current: { account_name: 'Bank' } })
    expect(error.details.preview_token).toMatch(/^pv1\./)
    expect(mock.payloads('pending_operations', 'insert')).toHaveLength(0)
  })

  it('a matching token stages through the dispatcher', async () => {
    const { preview_token } = await dryRun()
    const mock = db()
    const { isError, payload } = await result(await handleMcpRequest(call('gnubok_update_account', { ...ARGS, preview_token })))
    expect(isError).toBe(false)
    expect(payload.staged).toBe(true)
    expect(mock.payloads('pending_operations', 'insert')).toHaveLength(1)
  })

  it('a hand-written tool still refuses it as an unknown parameter', async () => {
    db()
    const { isError, payload } = await result(
      await handleMcpRequest(call('gnubok_list_accounts', { preview_token: 'pv1.' + 'a'.repeat(43) })),
    )
    expect(isError).toBe(true)
    expect((payload.error as { code: string; message_en: string }).message_en).toContain('"preview_token"')
  })
})
