import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { readDecisionRule, readSameRequest } from '../receipt-display-data'
import type { BookingWhyDecisions, ReceiptLike } from '../receipt-display'

const JE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const RULE = '11111111-1111-4111-8111-111111111111'
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const log = { warn: vi.fn() }

beforeEach(() => {
  reset()
  vi.clearAllMocks()
})

function decisionsChoosing(chosen: Partial<NonNullable<ReceiptLike['chosen']>> | null): BookingWhyDecisions {
  const latest = {
    receipt_id: '22222222-2222-4222-8222-222222222222',
    decided_at: '2026-11-28T09:00:00.000Z',
    outcome: 'accepted',
    decided_by: { actor_type: 'user', user_id: null, label: null, commit_method: 'user_accept' },
    proposed_by: null,
    candidates: [],
    chosen: chosen ? ({ source: 'counterparty_template', source_id: `counterparty:${RULE}`, ...chosen } as never) : null,
    booked: null,
  } as unknown as ReceiptLike
  return { latest, others: [], total: 1 }
}

describe('readDecisionRule', () => {
  it('names the counterpart rule the chosen suggestion came from, as the Regler page names it', async () => {
    enqueue({ data: { id: RULE, counterparty_name: 'telia sverige' } })
    expect(await readDecisionRule(supabase as never, 'company-1', decisionsChoosing({}), log)).toEqual({ id: RULE, name: 'Telia Sverige' })
    expect(findCalls('categorization_templates', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['id', RULE],
    ])
  })

  it('reads nothing when the chosen suggestion is no counterpart rule, or nothing was chosen', async () => {
    expect(await readDecisionRule(supabase as never, 'company-1', decisionsChoosing({ source: 'assistant', source_id: 'assistant:x' }), log)).toBeNull()
    expect(await readDecisionRule(supabase as never, 'company-1', decisionsChoosing(null), log)).toBeNull()
    expect(await readDecisionRule(supabase as never, 'company-1', null, log)).toBeNull()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('is null when the rule is gone or cannot be read', async () => {
    enqueue({ data: null })
    expect(await readDecisionRule(supabase as never, 'company-1', decisionsChoosing({}), log)).toBeNull()
    enqueue({ error: { code: '57014', message: 'timeout' } })
    expect(await readDecisionRule(supabase as never, 'company-1', decisionsChoosing({}), log)).toBeNull()
    expect(log.warn).toHaveBeenCalledTimes(1)
  })
})

describe('readSameRequest', () => {
  it('finds the other verifikat the committing request committed, by its trace on their COMMIT audit rows', async () => {
    enqueue({ data: [{ trace_id: TRACE, created_at: '2026-11-28T09:00:00.000Z' }] })
    enqueue({ data: [{ record_id: 'je-2' }, { record_id: 'je-3' }, { record_id: 'je-2' }] })
    enqueue({
      data: [
        { id: 'je-3', voucher_series: 'A', voucher_number: 14 },
        { id: 'je-2', voucher_series: 'A', voucher_number: 13 },
      ],
    })

    expect(await readSameRequest(supabase as never, 'company-1', JE, log)).toEqual({ vouchers: ['A13', 'A14'], total: 2 })

    const eqs = findCalls('audit_log', 'eq')
    expect(eqs.slice(0, 4)).toEqual([
      ['company_id', 'company-1'],
      ['table_name', 'journal_entries'],
      ['record_id', JE],
      ['action', 'COMMIT'],
    ])
    expect(eqs.slice(4)).toEqual([
      ['company_id', 'company-1'],
      ['table_name', 'journal_entries'],
      ['action', 'COMMIT'],
      ['trace_id', TRACE],
    ])
    // A window around the commit keeps the read on the (company_id, table_name, created_at) index.
    expect(findCalls('audit_log', 'gte')).toEqual([['created_at', '2026-11-28T08:45:00.000Z']])
    expect(findCalls('audit_log', 'lte')).toEqual([['created_at', '2026-11-28T09:15:00.000Z']])
    expect(findCalls('audit_log', 'neq')).toEqual([['record_id', JE]])
  })

  it('is null when the commit carries no trace or the request committed nothing else', async () => {
    enqueue({ data: [] })
    expect(await readSameRequest(supabase as never, 'company-1', JE, log)).toBeNull()

    enqueue({ data: [{ trace_id: TRACE, created_at: '2026-11-28T09:00:00.000Z' }] })
    enqueue({ data: [] })
    expect(await readSameRequest(supabase as never, 'company-1', JE, log)).toBeNull()
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('is null, quietly, before the trace column exists, and null with a warning when a read fails', async () => {
    enqueue({ error: { code: '42703', message: 'column audit_log.trace_id does not exist' } })
    expect(await readSameRequest(supabase as never, 'company-1', JE, log)).toBeNull()
    expect(log.warn).not.toHaveBeenCalled()

    enqueue({ data: [{ trace_id: TRACE, created_at: '2026-11-28T09:00:00.000Z' }] })
    enqueue({ error: { code: '57014', message: 'timeout' } })
    expect(await readSameRequest(supabase as never, 'company-1', JE, log)).toBeNull()
    expect(log.warn).toHaveBeenCalledTimes(1)
  })
})
