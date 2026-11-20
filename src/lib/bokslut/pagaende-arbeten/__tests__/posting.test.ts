import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/posting/port', () => ({ postingPort: { draftJournalEntry: vi.fn(), commitSqlPosting: vi.fn() } }))
vi.mock('@/lib/reports/vat-revenue-accounts', () => ({ fetchDynamicVatAccounts: vi.fn() }))

import { postingPort } from '@/lib/posting/port'
import { fetchDynamicVatAccounts } from '@/lib/reports/vat-revenue-accounts'
import { DEFAULT_CONTRACT_REVENUE_ACCOUNTS, type ContractInput } from '../calculator'
import { ContractRevenueAccountError, bookContractRevenueAdjustment, unregisteredBalances } from '../posting'
import { contractRevenueDisclosures } from '../disclosures'

/** contract_revenue_register_balances: what the register's own verifikat hold. */
const rpc = vi.fn()
const supabase = { rpc } as never
const contract: ContractInput = {
  id: 'c1',
  name: 'Tak Storgatan 1',
  kind: 'fast_pris',
  uppdragsinkomst: 1_000_000,
  beraknade_totala_utgifter: 800_000,
  nedlagda_utgifter: 400_000,
  fakturerat: 300_000,
  innehallna_belopp: 30_000,
  tillforlitligt_utfall: true,
  fardigstallandegrad_metod: 'utgifter',
  angiven_fardigstallandegrad: null,
  ersattningsbara_utgifter: null,
  upparbetat_lopande: null,
  vasentligen_fullgjort: false,
}

function dynamic(mapped: string[] = []) {
  return {
    accounts: mapped,
    mappingByAccount: new Map(mapped.map((a) => [a, { box: 'ruta05', side: 'credit' }])),
    explicitAccounts: new Set(mapped),
  } as never
}

function args(revenueAdjustment: string) {
  return {
    supabase,
    companyId: 'company-1',
    userId: 'user-1',
    fiscalPeriodId: 'period-1',
    periodEnd: '2026-12-31',
    method: 'successiv' as const,
    contracts: [contract],
    accounts: { ...DEFAULT_CONTRACT_REVENUE_ACCOUNTS, revenueAdjustment },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(fetchDynamicVatAccounts).mockResolvedValue(dynamic())
  rpc.mockResolvedValue({ data: [], error: null })
  vi.mocked(postingPort.draftJournalEntry).mockResolvedValue({ id: 'draft-1', fiscal_period_id: 'period-1' } as never)
  vi.mocked(postingPort.commitSqlPosting).mockResolvedValue({ entry: { id: 'draft-1' } } as never)
})

describe('bookContractRevenueAdjustment', () => {
  it('refuses a revenue account the momsdeklaration reads, fixed or the company\'s own', async () => {
    await expect(bookContractRevenueAdjustment(args('3001'))).rejects.toBeInstanceOf(ContractRevenueAccountError)
    vi.mocked(fetchDynamicVatAccounts).mockResolvedValue(dynamic(['3090']))
    await expect(bookContractRevenueAdjustment(args('3090'))).rejects.toMatchObject({ reason: 'vat_ruta' })
    await expect(bookContractRevenueAdjustment(args('1620'))).rejects.toMatchObject({ reason: 'not_revenue' })
    expect(postingPort.draftJournalEntry).not.toHaveBeenCalled()
  })

  it('drafts the year-end adjustment through the posting port on balansdagen', async () => {
    const { entry, result } = await bookContractRevenueAdjustment(args('3090'))
    expect(entry).toEqual({ id: 'draft-1' })
    expect(rpc).toHaveBeenCalledWith('contract_revenue_register_balances', { p_company_id: 'company-1', p_as_of: '2026-12-31' })
    const call = vi.mocked(postingPort.draftJournalEntry).mock.calls[0][0]
    expect(call.input).toMatchObject({
      fiscal_period_id: 'period-1',
      entry_date: '2026-12-31',
      source_type: 'year_end',
    })
    // The engine takes the company's year_end series (accounted#58).
    expect(call.input).not.toHaveProperty('voucher_series')
    expect(call.input.lines).toEqual(result.lines)
    expect(call.input.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['1620', 200_000, 0],
      ['3090', 0, 200_000],
    ])
    const event = typeof call.event === 'function' ? call.event() : call.event
    expect(event).toMatchObject({ kind: 'ledger.accrual', occurredOn: '2026-12-31', amount: 200_000 })
  })

  it('commits the draft with what it was computed from, in one SQL posting', async () => {
    const { result } = await bookContractRevenueAdjustment(args('3090'))
    const commit = vi.mocked(postingPort.commitSqlPosting).mock.calls[0][0]
    expect(commit.fn).toBe('commit_contract_revenue')
    const [draft, booking] = commit.args as unknown as [unknown, Record<string, unknown>]
    expect(draft).toEqual({ id: 'draft-1', fiscal_period_id: 'period-1' })
    expect(booking).toEqual({
      method: 'successiv',
      accounts: { ...DEFAULT_CONTRACT_REVENUE_ACCOUNTS, revenueAdjustment: '3090' },
      contracts: [contract],
      positions: result.positions,
      targets: result.targets,
    })
    expect(booking.targets).toMatchObject({ '1620': 200_000, '2450': 0, '2290': 0 })
  })

  it('books nothing when the register\'s own verifikat already hold the positions', async () => {
    rpc.mockResolvedValue({ data: [{ account_number: '1620', balance: '200000.00' }, { account_number: '3090', balance: '-200000.00' }], error: null })
    const { entry } = await bookContractRevenueAdjustment(args('3090'))
    expect(entry).toBeNull()
    expect(postingPort.draftJournalEntry).not.toHaveBeenCalled()
  })

  it('books only the change from what the register holds, never another balance on the account', async () => {
    // The register holds 150 000 on 1620; whatever else 1620 holds (a manual
    // posting) is not in what the register reads, so it is not moved.
    rpc.mockResolvedValue({ data: [{ account_number: '1620', balance: 150_000 }], error: null })
    const { result } = await bookContractRevenueAdjustment(args('3090'))
    expect(result.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['1620', 50_000, 0],
      ['3090', 0, 50_000],
    ])
  })

  it('fails when the register cannot be read, before any draft', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } })
    await expect(bookContractRevenueAdjustment(args('3090'))).rejects.toThrow(/registrets/)
    expect(postingPort.draftJournalEntry).not.toHaveBeenCalled()
  })
})

describe('unregisteredBalances', () => {
  it('names what the position accounts hold beyond the register, per account', () => {
    const accounts = { ...DEFAULT_CONTRACT_REVENUE_ACCOUNTS, revenueAdjustment: '3090' }
    expect(
      unregisteredBalances({ '1620': 250_000, '2290': -40_000, '2450': -10_000 }, { '1620': 200_000, '2450': -10_000 }, accounts),
    ).toEqual([
      { account: '1620', amount: 50_000 },
      { account: '2290', amount: -40_000 },
    ])
  })
})

describe('contractRevenueDisclosures (K3 23.29-23.30)', () => {
  it('states the principle, the methods and the amounts in progress', async () => {
    const { result } = await bookContractRevenueAdjustment(args('3090'))
    expect(contractRevenueDisclosures(result, [contract])).toEqual({
      principle: 'successiv',
      completionMethods: ['utgifter'],
      inProgress: { upparbetade_intakter: 500_000, fakturerade_belopp: 300_000, innehallna_belopp: 30_000 },
      nettedGross: {
        assets: { upparbetat: 500_000, fakturerat: 300_000 },
        liabilities: { upparbetat: 0, fakturerat: 0 },
      },
      befarade_forluster: 0,
    })
  })
})
