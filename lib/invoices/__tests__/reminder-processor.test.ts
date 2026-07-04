import { describe, it, expect, vi, beforeEach } from 'vitest'

const chainCalls: Array<{ method: string; args: unknown[] }> = []

vi.mock('@supabase/ssr', () => {
  const buildChain = (): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) =>
              resolve({ data: [], error: null, count: null })
          }
          return (...args: unknown[]) => {
            chainCalls.push({ method: String(prop), args })
            return buildChain()
          }
        },
      },
    )

  return {
    createServerClient: vi.fn(() => ({
      from: vi.fn(() => buildChain()),
      rpc: vi.fn(() => buildChain()),
    })),
  }
})

vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({
    sendEmail: vi.fn().mockResolvedValue({ success: true }),
  }),
}))

import {
  processOverdueReminders,
  determineReminderLevel,
  calculateDaysOverdue,
} from '../reminder-processor'

describe('determineReminderLevel', () => {
  it('returns null below the level-1 threshold', () => {
    expect(determineReminderLevel(10, [])).toBeNull()
  })

  it('returns 1 at 15 days overdue', () => {
    expect(determineReminderLevel(15, [])).toBe(1)
  })

  it('returns 2 at 30 days when level 1 already sent', () => {
    expect(determineReminderLevel(30, [1])).toBe(2)
  })

  it('returns 3 at 45 days when 1 and 2 already sent', () => {
    expect(determineReminderLevel(45, [1, 2])).toBe(3)
  })

  it('returns null when all levels have been sent', () => {
    expect(determineReminderLevel(60, [1, 2, 3])).toBeNull()
  })
})

describe('calculateDaysOverdue', () => {
  it('returns a positive number for a past due date', () => {
    const tenDaysAgo = new Date()
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10)
    const days = calculateDaysOverdue(tenDaysAgo.toISOString().split('T')[0])
    expect(days).toBeGreaterThanOrEqual(9)
    expect(days).toBeLessThanOrEqual(10)
  })
})

describe('processOverdueReminders: credit-note filter', () => {
  beforeEach(() => {
    chainCalls.length = 0
  })

  it('excludes credit notes via .is("credited_invoice_id", null)', async () => {
    await processOverdueReminders()

    const isCall = chainCalls.find(
      (c) => c.method === 'is' && c.args[0] === 'credited_invoice_id',
    )

    expect(
      isCall,
      'overdue-invoice query must filter out credit notes: credit notes have a negative total and must never trigger a payment reminder (e.g. KR-F2026002)',
    ).toBeDefined()
    expect(isCall?.args[1]).toBeNull()
  })

  it('combines the credit-note filter with status allowlist and due_date cutoff', async () => {
    await processOverdueReminders()

    const inStatus = chainCalls.find(
      (c) => c.method === 'in' && c.args[0] === 'status',
    )
    const isCreditedNull = chainCalls.find(
      (c) => c.method === 'is' && c.args[0] === 'credited_invoice_id',
    )
    const lteDueDate = chainCalls.find(
      (c) => c.method === 'lte' && c.args[0] === 'due_date',
    )

    expect(inStatus?.args[1]).toEqual(['sent', 'overdue'])
    expect(isCreditedNull?.args[1]).toBeNull()
    expect(lteDueDate).toBeDefined()
  })

  it('uses a positive allowlist (sent + overdue) so paid / partially_paid / cancelled / credited can never match', async () => {
    await processOverdueReminders()

    const inStatus = chainCalls.find(
      (c) => c.method === 'in' && c.args[0] === 'status',
    )
    expect(inStatus?.args[1]).toEqual(['sent', 'overdue'])

    // Defense in depth: ensure no .eq('status', terminal) somehow snuck in.
    const eqTerminal = chainCalls.find(
      (c) =>
        c.method === 'eq' &&
        c.args[0] === 'status' &&
        ['paid', 'partially_paid', 'cancelled', 'credited'].includes(
          c.args[1] as string,
        ),
    )
    expect(eqTerminal).toBeUndefined()
  })

  it('includes overdue in the allowlist so level-2 and level-3 reminders re-fire after the first reminder flips status', async () => {
    await processOverdueReminders()
    const inStatus = chainCalls.find(
      (c) => c.method === 'in' && c.args[0] === 'status',
    )
    expect(inStatus?.args[1]).toContain('overdue')
  })
})
