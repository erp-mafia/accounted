import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/posting/port', () => ({ postingPort: { postJournalEntry: vi.fn() } }))
vi.mock('@/lib/reports/trial-balance', () => ({ generateTrialBalance: vi.fn() }))
vi.mock('@/lib/reports/vat-revenue-accounts', () => ({ fetchDynamicVatAccounts: vi.fn() }))

import { postingPort } from '@/lib/posting/port'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { fetchDynamicVatAccounts } from '@/lib/reports/vat-revenue-accounts'
import { DEFAULT_CONTRACT_REVENUE_ACCOUNTS, type ContractInput } from '../calculator'
import { ContractRevenueAccountError, bookContractRevenueAdjustment } from '../posting'
import { contractRevenueDisclosures } from '../disclosures'

const supabase = {} as never
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
  vi.mocked(generateTrialBalance).mockResolvedValue({ rows: [], totalDebit: 0, totalCredit: 0, isBalanced: true } as never)
  vi.mocked(postingPort.postJournalEntry).mockResolvedValue({ id: 'entry-1' } as never)
})

describe('bookContractRevenueAdjustment', () => {
  it('refuses a revenue account the momsdeklaration reads, fixed or the company\'s own', async () => {
    await expect(bookContractRevenueAdjustment(args('3001'))).rejects.toBeInstanceOf(ContractRevenueAccountError)
    vi.mocked(fetchDynamicVatAccounts).mockResolvedValue(dynamic(['3090']))
    await expect(bookContractRevenueAdjustment(args('3090'))).rejects.toMatchObject({ reason: 'vat_ruta' })
    await expect(bookContractRevenueAdjustment(args('1620'))).rejects.toMatchObject({ reason: 'not_revenue' })
    expect(postingPort.postJournalEntry).not.toHaveBeenCalled()
  })

  it('posts the year-end adjustment through the posting port on balansdagen', async () => {
    const { entry, result } = await bookContractRevenueAdjustment(args('3090'))
    expect(entry).toEqual({ id: 'entry-1' })
    const call = vi.mocked(postingPort.postJournalEntry).mock.calls[0][0]
    expect(call.input).toMatchObject({
      fiscal_period_id: 'period-1',
      entry_date: '2026-12-31',
      source_type: 'year_end',
    })
    expect(call.input.lines).toEqual(result.lines)
    expect(call.input.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['1620', 200_000, 0],
      ['3090', 0, 200_000],
    ])
    const event = typeof call.event === 'function' ? call.event() : call.event
    expect(event).toMatchObject({ kind: 'ledger.accrual', occurredOn: '2026-12-31', amount: 200_000 })
  })

  it('books nothing when the ledger already holds the positions', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [{
        account_number: '1620', account_name: 'Upparbetad men ej fakturerad intäkt', account_class: 1,
        opening_debit: 0, opening_credit: 0, period_debit: 200_000, period_credit: 0,
        closing_debit: 200_000, closing_credit: 0,
      }],
      totalDebit: 200_000, totalCredit: 200_000, isBalanced: true,
    } as never)
    const { entry } = await bookContractRevenueAdjustment(args('3090'))
    expect(entry).toBeNull()
    expect(postingPort.postJournalEntry).not.toHaveBeenCalled()
  })
})

describe('contractRevenueDisclosures (K3 23.29-23.30)', () => {
  it('states the principle, the methods and the amounts in progress', async () => {
    const { result } = await bookContractRevenueAdjustment(args('3090'))
    expect(contractRevenueDisclosures(result, [contract])).toEqual({
      principle: 'successiv_vinstavrakning',
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
