import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONTRACT_REVENUE_ACCOUNTS,
  computeContractRevenue,
  fardigstallandePosition,
  successivPosition,
  type ContractInput,
  type ContractRevenueAccounts,
  type ContractRevenueLine,
} from '../calculator'

const ACCOUNTS: ContractRevenueAccounts = { ...DEFAULT_CONTRACT_REVENUE_ACCOUNTS, revenueAdjustment: '3090' }

function contract(overrides: Partial<ContractInput> = {}): ContractInput {
  return {
    id: 'c1',
    name: 'Tak Storgatan 1',
    kind: 'fast_pris',
    uppdragsinkomst: 1_000_000,
    beraknade_totala_utgifter: 800_000,
    nedlagda_utgifter: 400_000,
    fakturerat: 300_000,
    innehallna_belopp: 0,
    tillforlitligt_utfall: true,
    fardigstallandegrad_metod: 'utgifter',
    angiven_fardigstallandegrad: null,
    ersattningsbara_utgifter: null,
    upparbetat_lopande: null,
    vasentligen_fullgjort: false,
    ...overrides,
  }
}

const net = (lines: ContractRevenueLine[], account: string) =>
  lines.filter((l) => l.account_number === account).reduce((sum, l) => sum + l.debit_amount - l.credit_amount, 0)
const balanced = (lines: ContractRevenueLine[]) =>
  Math.abs(lines.reduce((sum, l) => sum + l.debit_amount - l.credit_amount, 0)) < 0.005

describe('successiv vinstavräkning (K3 23.18-23.27)', () => {
  it('recognises income by the cost-based grade and shows the net position per contract', () => {
    const position = successivPosition(contract())
    expect(position.fardigstallandegrad_procent).toBe(50)
    expect(position.upparbetad_intakt).toBe(500_000)
    expect(position.netto).toBe(200_000) // upparbetad 500 000 less fakturerat 300 000
    expect(position.befarad_forlust).toBe(0)
  })

  it('uses a stated survey or physical grade when that measures the work better (23.22)', () => {
    const position = successivPosition(contract({ fardigstallandegrad_metod: 'fysisk', angiven_fardigstallandegrad: 0.6 }))
    expect(position.upparbetad_intakt).toBe(600_000)
  })

  it('recognises only reimbursable costs when the outcome is not reliable (23.23)', () => {
    const position = successivPosition(contract({ tillforlitligt_utfall: false, ersattningsbara_utgifter: 350_000 }))
    expect(position.upparbetad_intakt).toBe(350_000)
  })

  it('provides for the whole expected loss at once (23.24)', () => {
    // Revenue 1 000 000, costs 1 200 000: a loss of 200 000. At 40 % the
    // recognised result is 400 000 - 480 000 = -80 000, so 120 000 is provided.
    const position = successivPosition(contract({ beraknade_totala_utgifter: 1_200_000, nedlagda_utgifter: 480_000 }))
    expect(position.upparbetad_intakt).toBe(400_000)
    expect(position.befarad_forlust).toBe(120_000)
  })

  it('takes the value of work performed for löpande räkning (23.17)', () => {
    const position = successivPosition(contract({ kind: 'lopande_rakning', upparbetat_lopande: 420_000 }))
    expect(position.upparbetad_intakt).toBe(420_000)
    expect(position.netto).toBe(120_000)
    expect(position.befarad_forlust).toBe(0)
  })

  it('does not net one contract\'s asset against another\'s liability, and books only the change', () => {
    const contracts = [
      contract(), // +200 000 asset
      contract({ id: 'c2', name: 'Fasad', fakturerat: 700_000 }), // -200 000 liability
    ]
    const first = computeContractRevenue('successiv', contracts, ACCOUNTS, {})
    expect(first.targets['1620']).toBe(200_000)
    expect(first.targets['2450']).toBe(-200_000)
    expect(net(first.lines, '1620')).toBe(200_000)
    expect(net(first.lines, '2450')).toBe(-200_000)
    expect(net(first.lines, '3090')).toBe(0)
    expect(balanced(first.lines)).toBe(true)

    // The same year recomputed after the adjustment was posted: nothing to book.
    const again = computeContractRevenue('successiv', contracts, ACCOUNTS, { '1620': 200_000, '2450': -200_000 })
    expect(again.lines).toEqual([])
  })

  it('books the loss on 6330 against the provision and keeps the entry balanced', () => {
    const result = computeContractRevenue(
      'successiv',
      [contract({ beraknade_totala_utgifter: 1_200_000, nedlagda_utgifter: 480_000 })],
      ACCOUNTS,
      {},
    )
    expect(net(result.lines, '6330')).toBe(120_000)
    expect(net(result.lines, '2290')).toBe(-120_000)
    expect(net(result.lines, '1620')).toBe(100_000) // 400 000 upparbetad less 300 000 fakturerat
    expect(net(result.lines, '3090')).toBe(-100_000)
    expect(balanced(result.lines)).toBe(true)
  })

  it('flags a missing grade and an estimate below what is already spent', () => {
    const result = computeContractRevenue('successiv', [
      contract({ fardigstallandegrad_metod: 'undersokning' }),
      contract({ id: 'c2', nedlagda_utgifter: 900_000 }),
    ], ACCOUNTS, {})
    expect(result.issues).toEqual([
      { code: 'CONTRACT_GRADE_MISSING', contractId: 'c1' },
      { code: 'CONTRACT_ESTIMATE_BELOW_INCURRED', contractId: 'c2' },
    ])
  })
})

describe('färdigställandemetoden (K3 23.31-23.32)', () => {
  it('keeps an unfinished contract on the balance sheet: costs an asset, invoices a liability', () => {
    const result = computeContractRevenue('fardigstallande', [contract()], ACCOUNTS, {})
    expect(net(result.lines, '1471')).toBe(400_000)
    expect(net(result.lines, '4970')).toBe(-400_000)
    expect(net(result.lines, '2431')).toBe(-300_000)
    expect(net(result.lines, '3090')).toBe(300_000) // the invoiced revenue leaves the result
    expect(balanced(result.lines)).toBe(true)
  })

  it('releases both into the result when the work is väsentligen fullgjort', () => {
    const balances = { '1471': 400_000, '2431': -300_000 }
    const result = computeContractRevenue(
      'fardigstallande',
      [contract({ vasentligen_fullgjort: true, nedlagda_utgifter: 790_000, fakturerat: 1_000_000 })],
      ACCOUNTS,
      balances,
    )
    expect(net(result.lines, '1471')).toBe(-400_000)
    expect(net(result.lines, '4970')).toBe(400_000)
    expect(net(result.lines, '2431')).toBe(300_000)
    expect(net(result.lines, '3090')).toBe(-300_000)
    expect(balanced(result.lines)).toBe(true)
  })

  it('provides for the whole expected loss of an unfinished contract (23.32)', () => {
    const position = fardigstallandePosition(contract({ beraknade_totala_utgifter: 1_150_000 }))
    expect(position.befarad_forlust).toBe(150_000)
  })
})
