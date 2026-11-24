/**
 * reverseEntry against the reversal hook registry, with the hook list
 * (lib/composition/reversal-hooks.ts) swapped through vi.mock: there is no
 * hooks parameter a caller could leave empty.
 *   - a source type that needs a mirror with no hook registered refuses the
 *     storno before anything is written: no insert, no RPC, no voucher number;
 *   - beforeReversal runs before any write and its throw refuses the storno;
 *   - afterReversal hooks run after the storno is posted and the original is
 *     marked reversed, in list order, one at a time, before the emits, and an
 *     unexpected throw propagates with the storno standing and the emits
 *     skipped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReversalHook } from '../reversal-hooks'

const h = vi.hoisted(() => ({
  trace: [] as string[],
  hooks: [] as ReversalHook[],
}))

vi.mock('@/lib/composition/reversal-hooks', () => ({ REVERSAL_HOOKS: h.hooks }))
vi.mock('@/lib/events', () => ({
  eventBus: {
    emit: vi.fn(async (event: { type: string }) => {
      h.trace.push(`emit ${event.type}`)
      return []
    }),
  },
}))
vi.mock('@/lib/bookkeeping/account-backfill', () => ({ backfillStandardBASAccounts: vi.fn().mockResolvedValue([]) }))
vi.mock('@/lib/core/bookkeeping/storno-target', () => ({
  assertStornoTarget: vi.fn(async (_s: unknown, _c: unknown, original: { entry_date: string; fiscal_period_id: string }) => {
    h.trace.push('assertStornoTarget')
    return { date: original.entry_date, fiscal_period_id: original.fiscal_period_id, moved: false }
  }),
}))

import { reverseEntry } from '../engine'
import { REVERSAL_MIRROR_REQUIRED, ReversalHookMissingError } from '../reversal-hooks'

function originalOf(sourceType: string) {
  return {
    id: 'entry-1',
    company_id: 'company-1',
    status: 'posted',
    fiscal_period_id: 'period-1',
    voucher_series: 'A',
    voucher_number: 7,
    entry_date: '2026-03-10',
    description: 'Original',
    source_type: sourceType,
    source_id: 'source-1',
    lines: [
      { account_number: '1930', debit_amount: 100, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: 100 },
    ],
  }
}

/** Walks reverseEntry's happy path; every write and RPC lands in the trace. */
function clientFor(original: ReturnType<typeof originalOf>) {
  let journalReads = 0
  function builder(table: string) {
    let op = 'select'
    let payload: unknown
    const b: Record<string, unknown> = {}
    for (const kind of ['insert', 'update', 'delete']) {
      b[kind] = (p?: unknown) => {
        op = kind
        payload = p
        const status = (p as { status?: string } | undefined)?.status
        h.trace.push(`${kind} ${table}${status ? ` status=${status}` : ''}`)
        return b
      }
    }
    for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit']) b[m] = () => b
    const resolve = () => {
      if (table === 'journal_entries') {
        if (op === 'insert') return { data: { id: 'reversal-1', status: 'draft' }, error: null }
        if (op === 'update') {
          return (payload as { status?: string }).status === 'reversed'
            ? { data: [{ id: original.id }], error: null }
            : { data: null, error: null }
        }
        journalReads++
        return journalReads === 1
          ? { data: original, error: null }
          : { data: { id: 'reversal-1', status: 'posted', lines: [] }, error: null }
      }
      if (table === 'chart_of_accounts') {
        return { data: original.lines.map((l) => ({ id: `acc-${l.account_number}`, account_number: l.account_number })), error: null }
      }
      return op === 'select' ? { data: [], error: null } : { data: null, error: null }
    }
    b.single = async () => resolve()
    b.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onFulfilled, onRejected)
    return b
  }
  return {
    from: vi.fn((table: string) => builder(table)),
    rpc: vi.fn(async (name: string) => {
      h.trace.push(`rpc ${name}`)
      return { data: name === 'release_reversed_entry_transactions' ? { released: 0, dropped: 0 } : null, error: null }
    }),
  }
}

const writes = () => h.trace.filter((s) => /^(insert|update|delete|rpc) /.test(s))

beforeEach(() => {
  vi.clearAllMocks()
  h.trace.length = 0
  h.hooks.length = 0
})

describe('reverseEntry: a missing required hook refuses the storno', () => {
  it('refuses a rot_rut_reclaim storno with ReversalHookMissingError before any insert or RPC', async () => {
    const client = clientFor(originalOf('rot_rut_reclaim'))

    const refusal = reverseEntry(client as never, 'company-1', 'user-1', 'entry-1')

    await expect(refusal).rejects.toBeInstanceOf(ReversalHookMissingError)
    await expect(refusal).rejects.toMatchObject({ code: 'REVERSAL_HOOK_MISSING', sourceType: 'rot_rut_reclaim' })
    expect(client.rpc).not.toHaveBeenCalled()
    expect(writes()).toEqual([])
    expect(h.trace).not.toContain('assertStornoTarget')
  })

  it.each(REVERSAL_MIRROR_REQUIRED)('refuses %s with no hook registered, writing nothing', async (sourceType) => {
    const client = clientFor(originalOf(sourceType))
    await expect(reverseEntry(client as never, 'company-1', 'user-1', 'entry-1')).rejects.toBeInstanceOf(
      ReversalHookMissingError,
    )
    expect(writes()).toEqual([])
  })

  it('reverses a source type that needs no mirror with no hook registered', async () => {
    const client = clientFor(originalOf('manual'))
    await reverseEntry(client as never, 'company-1', 'user-1', 'entry-1')
    expect(h.trace).toContain('rpc commit_journal_entry')
    expect(h.trace.slice(-2)).toEqual(['emit journal_entry.committed', 'emit journal_entry.reversed'])
  })
})

describe('reverseEntry: running the registered hooks', () => {
  it('hands each hook the client, the company, the actor and the original as read', async () => {
    const original = originalOf('manual')
    const client = clientFor(original)
    const seen: unknown[] = []
    h.hooks.push({
      id: 'probe',
      module: 'ledger',
      sourceTypes: ['manual'],
      beforeReversal: async (ctx) => void seen.push(ctx),
      afterReversal: async (ctx) => void seen.push(ctx),
    })
    await reverseEntry(client as never, 'company-1', 'user-1', 'entry-1')
    expect(seen).toHaveLength(2)
    expect(seen[0]).toEqual({ supabase: client, companyId: 'company-1', userId: 'user-1', entry: original })
    // afterReversal also gets the storno it follows.
    expect(seen[1]).toEqual({
      supabase: client,
      companyId: 'company-1',
      userId: 'user-1',
      entry: original,
      // The mocked insert answers no entry_date.
      storno: { id: 'reversal-1', entry_date: undefined },
    })
    expect((seen[0] as { entry: unknown }).entry).toBe(original)
  })

  it('refuses before any write when a beforeReversal throws, and runs no afterReversal', async () => {
    const client = clientFor(originalOf('manual'))
    const after = vi.fn(async () => {})
    h.hooks.push({
      id: 'refuser',
      module: 'ledger',
      sourceTypes: ['manual'],
      beforeReversal: async () => {
        throw new Error('held')
      },
      afterReversal: after,
    })
    await expect(reverseEntry(client as never, 'company-1', 'user-1', 'entry-1')).rejects.toThrow('held')
    expect(writes()).toEqual([])
    expect(after).not.toHaveBeenCalled()
  })

  it('runs afterReversal hooks in list order, one at a time, after the CAS and before the emits', async () => {
    const client = clientFor(originalOf('manual'))
    h.hooks.push(
      {
        id: 'first',
        module: 'ledger',
        sourceTypes: ['manual'],
        // Yields to the timer queue: hooks started together would interleave here.
        afterReversal: async () => {
          h.trace.push('first:start')
          await new Promise<void>((resolve) => setTimeout(resolve, 5))
          h.trace.push('first:end')
        },
      },
      {
        id: 'second',
        module: 'invoicing',
        sourceTypes: ['manual'],
        afterReversal: async () => void h.trace.push('second'),
      },
    )
    await reverseEntry(client as never, 'company-1', 'user-1', 'entry-1')
    const at = (step: string) => h.trace.indexOf(step)
    expect(at('first:start')).toBeGreaterThan(at('update journal_entries status=reversed'))
    expect(at('first:start')).toBeGreaterThan(at('rpc release_reversed_entry_transactions'))
    expect(at('first:end')).toBe(at('first:start') + 1)
    expect(at('second')).toBe(at('first:end') + 1)
    expect(at('emit journal_entry.committed')).toBeGreaterThan(at('second'))
  })

  it('propagates an afterReversal throw: the storno stands, later hooks and the emits are skipped', async () => {
    const client = clientFor(originalOf('manual'))
    const second = vi.fn(async () => {})
    h.hooks.push(
      {
        id: 'failing',
        module: 'ledger',
        sourceTypes: ['manual'],
        afterReversal: async () => {
          throw new Error('mirror failed')
        },
      },
      { id: 'second', module: 'ledger', sourceTypes: ['manual'], afterReversal: second },
    )
    await expect(reverseEntry(client as never, 'company-1', 'user-1', 'entry-1')).rejects.toThrow('mirror failed')
    expect(h.trace).toContain('rpc commit_journal_entry')
    expect(h.trace).toContain('update journal_entries status=reversed')
    expect(h.trace).not.toContain('update journal_entries status=cancelled')
    expect(second).not.toHaveBeenCalled()
    expect(h.trace.filter((s) => s.startsWith('emit '))).toEqual([])
  })
})

describe('reverseEntry through the posting port (step 2i): the registry refuses exactly as before', () => {
  const STORNO_EVENT = {
    kind: 'ledger.storno' as const,
    occurredOn: '2026-10-18',
    subject: { type: 'journal_entry' as const, id: '00000000-0000-4000-8000-0000000e0001' },
    evidence: { link_basis: 'user_created' as const },
  }

  it.each(['off', 'shadow', 'strict'])(
    'POSTING_EVENTS=%s: a storno of a source type with no required hook refuses with REVERSAL_HOOK_MISSING, no verifikat written',
    async (mode) => {
      vi.stubEnv('POSTING_EVENTS', mode)
      try {
        const { postingPort } = await import('@/lib/posting/port')
        const client = clientFor(originalOf('rot_rut_reclaim'))
        const refusal = postingPort.reverseJournalEntry({
          supabase: client as never,
          companyId: 'company-1',
          userId: 'user-1',
          entryId: 'entry-1',
          event: STORNO_EVENT,
          role: 'reversal',
        })
        await expect(refusal).rejects.toBeInstanceOf(ReversalHookMissingError)
        await expect(refusal).rejects.toMatchObject({ code: 'REVERSAL_HOOK_MISSING', sourceType: 'rot_rut_reclaim' })
        expect(client.rpc).not.toHaveBeenCalled()
        // Only the event the port records first (shadow, strict); nothing on the journal.
        expect(writes()).toEqual(mode === 'off' ? [] : ['insert business_events'])
      } finally {
        vi.unstubAllEnvs()
      }
    },
  )
})
