import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))
vi.mock('@/lib/company/entity-type', async () => {
  const actual = await vi.importActual<typeof import('@/lib/company/entity-type')>('@/lib/company/entity-type')
  return { ...actual, resolveCompanyEntityType: vi.fn() }
})

import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import { AssociationRegisterError } from '../errors'
import {
  memberCapitalReconciliation,
  memberRegisterCsv,
  memberRegisterExtract,
  requireMemberCapitalForm,
  settleContribution,
} from '../member-register'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
const client = supabase as unknown as Parameters<typeof settleContribution>[0]

const paid = {
  id: 'c1',
  company_id: 'company-1',
  member_id: 'm1',
  kind: 'obligatory',
  units: 1,
  amount: '500.00',
  status: 'paid',
  paid_on: '2026-01-10',
  settled_on: null,
  journal_entry_id: null,
  settlement_journal_entry_id: null,
  notes: null,
  created_at: '2026-01-10T00:00:00Z',
  updated_at: '2026-01-10T00:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

describe('requireMemberCapitalForm', () => {
  it('admits an ekonomisk förening and refuses the other forms with ASSOCIATION_FORM_REQUIRED', async () => {
    vi.mocked(resolveCompanyEntityType).mockResolvedValue('ekonomisk_forening')
    await expect(requireMemberCapitalForm(client, 'company-1')).resolves.toBeUndefined()
    for (const form of ['aktiebolag', 'enskild_firma', 'ideell_forening'] as const) {
      vi.mocked(resolveCompanyEntityType).mockResolvedValue(form)
      await expect(requireMemberCapitalForm(client, 'company-1')).rejects.toMatchObject({
        code: 'ASSOCIATION_FORM_REQUIRED',
      })
    }
  })
})

describe('settleContribution: EFL 10 kap. 11 § guards', () => {
  it('refuses to repay a member who has not left', async () => {
    enqueue({ data: paid }) // contribution read
    enqueue({ data: { id: 'm1', exited_on: null } }) // member read
    await expect(
      settleContribution(client, 'company-1', 'user-1', 'c1', { status: 'repaid', settled_on: '2026-08-01' }),
    ).rejects.toBeInstanceOf(AssociationRegisterError)
  })

  it('refuses a repayment above the paid amount before reading the member', async () => {
    enqueue({ data: paid })
    await expect(
      settleContribution(client, 'company-1', 'user-1', 'c1', {
        status: 'repaid',
        settled_on: '2026-08-01',
        amount: 600,
      }),
    ).rejects.toMatchObject({ code: 'ASSOCIATION_REPAYMENT_EXCEEDS_CONTRIBUTION' })
  })

  it('refuses to settle twice', async () => {
    enqueue({ data: { ...paid, status: 'repaid', settled_on: '2026-08-01' } })
    await expect(
      settleContribution(client, 'company-1', 'user-1', 'c1', { status: 'forfeited', settled_on: '2026-09-01' }),
    ).rejects.toMatchObject({ code: 'ASSOCIATION_CONTRIBUTION_ALREADY_SETTLED' })
  })

  it('repays a member who has left and records the settlement event', async () => {
    enqueue({ data: paid }) // contribution read
    enqueue({ data: { id: 'm1', exited_on: '2026-06-30' } }) // member read
    enqueue({ data: { ...paid, status: 'repaid', settled_on: '2026-12-31' } }) // update
    enqueue({ data: null }) // event insert
    const result = await settleContribution(client, 'company-1', 'user-1', 'c1', {
      status: 'repaid',
      settled_on: '2026-12-31',
    })
    expect(result.status).toBe('repaid')
    expect(supabase.from).toHaveBeenCalledWith('association_member_events')
  })

  it('redeems a förlagsinsats without an exit (EFL 11 kap. 7 §)', async () => {
    enqueue({ data: { ...paid, kind: 'forlags', amount: '10000.00' } })
    enqueue({ data: { ...paid, kind: 'forlags', status: 'repaid', settled_on: '2031-03-01' } })
    enqueue({ data: null })
    const result = await settleContribution(client, 'company-1', 'user-1', 'c1', {
      status: 'repaid',
      settled_on: '2031-03-01',
    })
    expect(result.status).toBe('repaid')
  })
})

describe('memberCapitalReconciliation', () => {
  it('compares register sums per kind with the ledger and reports the difference', async () => {
    enqueue({
      data: [
        paid,
        { ...paid, id: 'c2', kind: 'over', amount: '250.00' },
        { ...paid, id: 'c3', kind: 'emission', amount: '100.00' },
        { ...paid, id: 'c4', kind: 'forlags', amount: '10000.00' },
        { ...paid, id: 'c5', status: 'repaid', settled_on: '2026-08-01', amount: '999.00' },
      ],
    })
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [
        { account_number: '2083', closing_debit: 0, closing_credit: 750 },
        { account_number: '2087', closing_debit: 0, closing_credit: 100 },
        { account_number: '2084', closing_debit: 0, closing_credit: 9000 },
      ],
    } as Awaited<ReturnType<typeof generateTrialBalance>>)

    const result = await memberCapitalReconciliation(client, 'company-1', 'period-1')
    expect(result.lines.map((l) => [l.label, l.register_amount, l.ledger_balance, l.difference])).toEqual([
      ['Medlemsinsatser (2083)', 750, 750, 0],
      ['Insatsemission (2087)', 100, 100, 0],
      ['Förlagsinsatser (2084)', 10000, 9000, -1000],
    ])
    expect(result.is_reconciled).toBe(false)
  })
})

describe('memberRegisterExtract', () => {
  it('lists every member with insatser held and renders a semicolon CSV', async () => {
    enqueue({
      data: [
        {
          id: 'm1',
          company_id: 'company-1',
          member_number: '2',
          name: 'Bertil "B" Berg',
          postal_address: 'Storgatan 1; 123 45 Röstånga',
          email: null,
          party_id: null,
          member_class: null,
          admitted_on: '2025-01-01',
          exited_on: null,
          notes: null,
          created_at: '',
          updated_at: '',
        },
        {
          id: 'm2',
          company_id: 'company-1',
          member_number: '1',
          name: 'Anna',
          postal_address: null,
          email: null,
          party_id: null,
          member_class: null,
          admitted_on: '2024-01-01',
          exited_on: '2026-03-31',
          notes: null,
          created_at: '',
          updated_at: '',
        },
      ],
    })
    enqueue({
      data: [
        { ...paid, member_id: 'm1', units: 2, amount: '1000.00' },
        { ...paid, id: 'c2', member_id: 'm1', kind: 'forlags', amount: '5000.00' },
        { ...paid, id: 'c3', member_id: 'm2', status: 'repaid', settled_on: '2026-09-30' },
      ],
    })
    const rows = await memberRegisterExtract(client, 'company-1')
    expect(rows.map((r) => r.member_number)).toEqual(['1', '2'])
    expect(rows[1]).toMatchObject({ contribution_units: 2, contribution_amount: 1000, forlagsinsats_amount: 5000 })
    expect(rows[0]).toMatchObject({ exited_on: '2026-03-31', contribution_amount: 0 })
    const csv = memberRegisterCsv(rows)
    expect(csv.split('\n')[0]).toBe('Medlemsnummer;Namn;Postadress;Inträde;Utträde;Antal insatser;Insatsbelopp;Förlagsinsatser')
    expect(csv).toContain('"Bertil ""B"" Berg";"Storgatan 1; 123 45 Röstånga"')
  })
})
