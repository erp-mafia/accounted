/**
 * refreshSkattekontoProposals when a read the matcher needs fails.
 *
 * The matcher answered a failed read as "no candidates", and the refresh then
 * cleared every stored proposal: one timeout during a sync wiped the proposals
 * of every open row, and they came back only with the next refresh that could
 * read. Here the matcher's read of the rows already linked to its candidates
 * fails, through the fake gateway (tests/gateway-supabase.ts), and the stored
 * proposal must stay.
 */
import { describe, expect, it, vi } from 'vitest'
import { createGatewaySupabase, inListOf, type GatewayRequest } from '@/tests/gateway-supabase'

// The refresh's log records, to see that it says what it did.
const { proposalLogs } = vi.hoisted(() => ({ proposalLogs: [] as Array<Record<string, unknown>> }))
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>()
  return {
    ...actual,
    createLogger: (module: string, base = {}) =>
      module === 'skattekonto-proposals'
        ? actual.createTestLogger(module, proposalLogs as never, base)
        : actual.createLogger(module, base),
  }
})

import { refreshSkattekontoProposals } from '../lib/skattekonto-proposals'

const COMPANY = '5b0c3c1e-0000-4000-8000-000000000001'
const ENTRY = 'eeeeeeee-0000-4000-8000-000000000001'
const ROW = 'cccccccc-0000-4000-8000-000000000001'

/** An open SKV row of 5 000 kr whose stored proposal is the inbetalning booked on 1630. */
function books() {
  return {
    skattekonto_transactions: [{
      id: ROW, company_id: COMPANY, status: 'booked', is_ignored: false, journal_entry_id: null,
      transaktionsdatum: '2026-08-12', transaktionstext: 'Inbetalning bokförd', belopp_skatteverket: 5000,
      suggested_journal_entry_id: ENTRY,
    }],
    journal_entries: [{
      id: ENTRY, company_id: COMPANY, voucher_number: 1, voucher_series: 'A', entry_date: '2026-08-11',
      description: 'Inbetalning skattekonto', status: 'posted',
    }],
    journal_entry_lines: [{
      id: 'dddddddd-0000-4000-8000-000000000001', journal_entry_id: ENTRY, account_number: '1630', debit_amount: 5000, credit_amount: 0,
    }],
  }
}

/** The matcher's read of the SKV rows already linked to its candidates. */
const linkedRowsRead = (request: GatewayRequest) =>
  request.table === 'skattekonto_transactions' && request.method === 'GET' && inListOf(request, 'journal_entry_id').length > 0

describe('refreshSkattekontoProposals: a read the matcher needs fails', () => {
  it('keeps every stored proposal, and says so', async () => {
    proposalLogs.length = 0
    const { supabase, requests } = createGatewaySupabase(books(), { refuse: linkedRowsRead })

    const result = await refreshSkattekontoProposals(supabase, COMPANY, '1630')

    expect(result).toEqual({ considered: 0, proposed: 0, cleared: 0, unchanged: 0 })
    expect(requests.filter((r) => r.table === 'skattekonto_transactions' && r.method === 'PATCH')).toEqual([])
    expect(proposalLogs).toContainEqual(expect.objectContaining({
      level: 'warn',
      msg: 'proposal refresh: candidates unreadable, stored proposals kept',
    }))
  })

  it('still keeps a proposal its candidate confirms when every read succeeds', async () => {
    const { supabase, requests } = createGatewaySupabase(books())

    const result = await refreshSkattekontoProposals(supabase, COMPANY, '1630')

    expect(result).toEqual({ considered: 1, proposed: 0, cleared: 0, unchanged: 1 })
    expect(requests.filter((r) => r.table === 'skattekonto_transactions' && r.method === 'PATCH')).toEqual([])
  })
})
