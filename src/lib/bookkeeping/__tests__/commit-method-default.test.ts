/**
 * The commit doors record HOW a verifikat was committed even when the caller
 * names nothing: the method follows from WHO is committing
 * (defaultCommitMethod). Before, commit_method was opt-in per call site, and
 * the bank-row paths (categorize, book, bulk-book) never opted in, so their
 * verifikat said neither who nor how.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/lib/events', () => ({
  eventBus: { emit: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('@/lib/bookkeeping/account-backfill', () => ({
  backfillStandardBASAccounts: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/bookkeeping/dimension-rules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/dimension-rules')>()),
  fetchActiveDimensionRules: vi.fn().mockResolvedValue([]),
}))

const { commitEntry, commitBulkBooking } = await import('../engine')
const { runWithActor } = await import('../actor-context-node')
const { defaultCommitMethod } = await import('../actor-context')

/** rpc records its arguments; every table read resolves to a posted entry. */
function makeSupabase(rpcData: unknown = [{ voucher_number: 1 }]) {
  const chain: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve({ data: { id: 'je-1', status: 'posted', lines: [] }, error: null })
        }
        return () => chain
      },
    },
  )
  const rpc = vi.fn().mockResolvedValue({ data: rpcData, error: null })
  return { supabase: { rpc, from: () => chain } as never, rpc }
}

function commitArgs(rpc: ReturnType<typeof vi.fn>) {
  const call = rpc.mock.calls.find(([name]) => name === 'commit_journal_entry')
  return call?.[1] as Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('defaultCommitMethod', () => {
  it.each([
    ['user', 'user_accept'],
    ['api_key', 'api_key'],
    ['mcp_oauth', 'api_key'],
    ['agent_chat', 'agent'],
    ['cron', null],
    ['system', null],
  ] as const)('%s commits as %s', (type, method) => {
    expect(defaultCommitMethod({ type })).toBe(method)
  })

  it('no actor, no method', () => {
    expect(defaultCommitMethod(undefined)).toBeNull()
  })
})

describe('commitEntry: commit method follows the actor', () => {
  it('a signed-in user with no method passed commits as user_accept', async () => {
    const { supabase, rpc } = makeSupabase()

    await runWithActor({ type: 'user' }, () => commitEntry(supabase, 'co', 'user-1', 'je-1'))

    expect(commitArgs(rpc)).toMatchObject({
      p_commit_method: 'user_accept',
      p_actor_type: 'user',
      p_actor_label: null,
    })
  })

  it('a method the caller names wins over the derived one', async () => {
    const { supabase, rpc } = makeSupabase()

    await runWithActor({ type: 'user' }, () =>
      commitEntry(supabase, 'co', 'user-1', 'je-1', 'bulk_accept'),
    )

    expect(commitArgs(rpc)).toMatchObject({ p_commit_method: 'bulk_accept', p_actor_type: 'user' })
  })

  it('an API key commits as api_key with its label', async () => {
    const { supabase, rpc } = makeSupabase()

    await runWithActor({ type: 'api_key', label: 'Bokföringsrobot' }, () =>
      commitEntry(supabase, 'co', 'user-1', 'je-1'),
    )

    expect(commitArgs(rpc)).toMatchObject({
      p_commit_method: 'api_key',
      p_actor_type: 'api_key',
      p_actor_label: 'Bokföringsrobot',
    })
  })

  it('cron records its actor and no method', async () => {
    const { supabase, rpc } = makeSupabase()

    await runWithActor({ type: 'cron' }, () => commitEntry(supabase, 'co', 'user-1', 'je-1'))

    expect(commitArgs(rpc)).toMatchObject({ p_commit_method: null, p_actor_type: 'cron' })
  })

  it('outside any actor scope both stay NULL', async () => {
    const { supabase, rpc } = makeSupabase()

    await commitEntry(supabase, 'co', 'user-1', 'je-1')

    expect(commitArgs(rpc)).toMatchObject({
      p_commit_method: null,
      p_actor_type: null,
      p_actor_label: null,
    })
  })
})

describe('commitBulkBooking: method and actor reach bulk_book_transactions', () => {
  const INPUT = { txIds: ['tx-1'], existingJournalEntryId: 'je-0', newEntry: null }
  const LINKED = { ok: true, mode: 'link_existing', journal_entry_id: 'je-0' }

  it('passes the method the caller names and the actor in scope', async () => {
    const { supabase, rpc } = makeSupabase(LINKED)

    await runWithActor({ type: 'user' }, () =>
      commitBulkBooking(supabase, 'co', 'user-1', { ...INPUT, commitMethod: 'bulk_accept' }),
    )

    expect(rpc).toHaveBeenCalledWith('bulk_book_transactions', expect.objectContaining({
      p_commit_method: 'bulk_accept',
      p_actor_type: 'user',
      p_actor_label: null,
    }))
  })

  it('derives the method from the actor when the caller names none', async () => {
    const { supabase, rpc } = makeSupabase(LINKED)

    await runWithActor({ type: 'mcp_oauth', label: 'MCP-klient (OAuth)' }, () =>
      commitBulkBooking(supabase, 'co', 'user-1', INPUT),
    )

    expect(rpc).toHaveBeenCalledWith('bulk_book_transactions', expect.objectContaining({
      p_commit_method: 'api_key',
      p_actor_type: 'mcp_oauth',
      p_actor_label: 'MCP-klient (OAuth)',
    }))
  })
})
