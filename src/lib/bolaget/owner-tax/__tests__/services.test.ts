/**
 * The owner tax services against a table-mocked database: the K10 year
 * from the aktiebok, dividends, payroll and the owner's inputs; the owner
 * loan register's writes with the låneförbud warnings; KU20's recipients.
 * The registers W1 and W3 own are mocked to fixed answers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { OperationContext } from '@/lib/operations/types'

vi.mock('@/lib/bolaget/share-register', () => ({ loadShareRegisterData: vi.fn() }))
vi.mock('@/lib/bolaget/capital/dividends', () => ({ loadDividends: vi.fn(), loadDistributions: vi.fn() }))
vi.mock('@/lib/bolaget/capital/contributions', () => ({ loadContributions: vi.fn() }))
vi.mock('@/lib/bolaget/capital/ku31', () => ({
  loadKu31Settings: vi.fn(),
  famansDerivationFor: vi.fn(),
  companyIdentity: vi.fn(),
  kuRecipientIdentity: vi.fn(),
  unreadablePersonnummer: vi.fn(),
  stockholmTimestamp: () => '2027-01-10T09:30:00',
  KU31_PROGRAM_NAME: 'Accounted',
}))
vi.mock('@/lib/bolaget/people', async (importOriginal) => ({
  checkPartyRef: (await importOriginal<typeof import('@/lib/bolaget/people')>()).checkPartyRef,
  PartyRefError: (await importOriginal<typeof import('@/lib/bolaget/people')>()).PartyRefError,
  loadRegisterParties: vi.fn(),
  ensureRegisterParty: vi.fn(),
  assertPartiesInCompany: vi.fn(),
  loadFullPersonnummer: vi.fn(),
}))
vi.mock('../payroll', async (importOriginal) => ({ ...(await importOriginal<typeof import('../payroll')>()), loadPayrollCashPay: vi.fn() }))
vi.mock('../insiders', async (importOriginal) => ({ ...(await importOriginal<typeof import('../insiders')>()), loadInsiderTimeline: vi.fn() }))
vi.mock('@/lib/dates/iso', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dates/iso')>()),
  todayIsoStockholm: () => '2026-10-29',
}))

const { loadShareRegisterData } = await import('@/lib/bolaget/share-register')
const { loadDividends, loadDistributions } = await import('@/lib/bolaget/capital/dividends')
const { loadContributions } = await import('@/lib/bolaget/capital/contributions')
const { loadKu31Settings, famansDerivationFor, companyIdentity } = await import('@/lib/bolaget/capital/ku31')
const { loadRegisterParties, ensureRegisterParty } = await import('@/lib/bolaget/people')
const { loadPayrollCashPay } = await import('../payroll')
const { loadInsiderTimeline } = await import('../insiders')
const { loadK10Year, saveK10Inputs } = await import('../k10')
const { createOwnerLoan, updateOwnerLoan, setLoanInterest } = await import('../loans')
const { loadKu20Status } = await import('../ku20')

const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const ANNA = '00000000-0000-4000-8000-0000000b0001'
const BO = '00000000-0000-4000-8000-0000000b0002'
const HOLDING = '00000000-0000-4000-8000-0000000b0003'
const LOAN = '00000000-0000-4000-8000-0000000e0001'
const CLASS_A = '00000000-0000-4000-8000-0000000ca001'

const PARTIES = new Map([
  [ANNA, { party_id: ANNA, name: 'Anna Ek', kind: 'person', org_number: null, personnummer_masked: 'XXXXXXXX-1234', foreign_id_masked: null, birth_date: null, address: null, email: null }],
  [BO, { party_id: BO, name: 'Bo Ek', kind: 'person', org_number: null, personnummer_masked: null, foreign_id_masked: null, birth_date: null, address: null, email: null }],
  [HOLDING, { party_id: HOLDING, name: 'Holding AB', kind: 'company', org_number: '5560000000', personnummer_masked: null, foreign_id_masked: null, birth_date: null, address: null, email: null }],
])

function ev(over: Record<string, unknown>) {
  return {
    id: `ev-${String(over.event_number)}`, event_date: '2020-01-10', kind: 'bildande', share_class_id: CLASS_A, to_share_class_id: null, from_party_id: null,
    to_party_id: ANNA, range_start: 1, range_end: 1_000, transfer_reason: null, price_total: 25_000, ratio: null, aktiebrev_number: null, aktiebrev_action: null,
    counterparty_party_id: null, note_status: null, corrects_event_id: null, registered_on: null, decision_id: null, document_id: null, journal_entry_id: null,
    note: null, created_at: '2020-01-10T00:00:00Z', ...over,
  }
}

const EVENTS = [
  ev({ event_number: 1 }),
  ev({ event_number: 2, event_date: '2024-06-01', kind: 'overlatelse', from_party_id: ANNA, to_party_id: HOLDING, range_start: 601, range_end: 1_000, transfer_reason: 'kop', price_total: 400_000 }),
]

function registerAtStart() {
  return {
    as_of: '2025-12-31',
    events: EVENTS,
    summary: {
      total_shares: 1_000,
      total_votes: 1_000,
      classes: [],
      holders: [
        { party_id: ANNA, shares: 600, votes: 600, capital_pct: 60, votes_pct: 60, by_class: [], ranges: [{ share_class_id: CLASS_A, party_id: ANNA, range_start: 1, range_end: 600 }] },
        { party_id: HOLDING, shares: 400, votes: 400, capital_pct: 40, votes_pct: 40, by_class: [], ranges: [{ share_class_id: CLASS_A, party_id: HOLDING, range_start: 601, range_end: 1_000 }] },
      ],
    },
    parties: PARTIES,
  }
}

let mock: ReturnType<typeof createTableMockSupabase>
let ctx: OperationContext

function timeline(snapshot: { holders?: Array<[string, number]>; board?: string[]; ceo?: string[] } = {}) {
  const s = { holders: new Map(snapshot.holders ?? []), board: new Set(snapshot.board ?? []), ceo: new Set(snapshot.ceo ?? []) }
  vi.mocked(loadInsiderTimeline).mockResolvedValue(() => s)
}

beforeEach(() => {
  vi.clearAllMocks()
  mock = createTableMockSupabase({ k10_owner_inputs: { data: [] }, owner_loans: { data: { id: LOAN } }, parties: { data: [] } })
  ctx = { supabase: mock.supabase as never, companyId: COMPANY, userId: USER, log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as never }
  vi.mocked(loadShareRegisterData).mockResolvedValue(registerAtStart() as never)
  vi.mocked(loadDividends).mockResolvedValue([
    { id: 'div-1', status: 'paid', payment_date: '2026-05-15' },
    { id: 'div-2', status: 'decided', payment_date: '2026-06-15' },
    { id: 'div-3', status: 'paid', payment_date: '2025-05-15' },
  ] as never)
  vi.mocked(loadDistributions).mockResolvedValue(new Map([['div-1', [{ party_id: ANNA, share_count: 600, amount: 60_000, by_class: [] }, { party_id: HOLDING, share_count: 400, amount: 40_000, by_class: [] }]]]))
  vi.mocked(loadContributions).mockResolvedValue([])
  vi.mocked(loadKu31Settings).mockResolvedValue({ famansforetag: true } as never)
  vi.mocked(famansDerivationFor).mockResolvedValue({ derived: true, top_four_votes_pct: 100, holders: 2 })
  vi.mocked(loadRegisterParties).mockImplementation(async (_c, ids) => new Map(ids.filter((id) => PARTIES.has(id)).map((id) => [id, PARTIES.get(id)!])) as never)
  vi.mocked(loadPayrollCashPay).mockResolvedValue({
    year: 2025,
    total: 1_500_000,
    runs: 12,
    opening_balance_amount: 0,
    employees: [
      { employee_id: 'emp-bo', name: 'Bo Ek', amount: 800_000 },
      { employee_id: 'emp-anna', name: 'Anna  ek', amount: 700_000 },
    ],
  })
  vi.mocked(ensureRegisterParty).mockResolvedValue(BO)
  timeline()
})

describe('loadK10Year', () => {
  it('computes the underlag of each natural-person owner from the registers, the dividends and the payroll', async () => {
    const view = await loadK10Year(ctx, 2026)
    expect(vi.mocked(loadShareRegisterData).mock.calls[0]![1]).toBe('2025-12-31')
    expect(vi.mocked(loadPayrollCashPay).mock.calls[0]![2]).toBe(2025)
    expect(view).toMatchObject({ supported: true, start_date: '2025-12-31', famansforetag: { value: true, confirmed: true }, total_shares_at_start: 1_000 })
    expect(view.company_holders).toEqual([{ party_id: HOLDING, name: 'Holding AB', shares: 400 }])
    expect(view.owners).toHaveLength(1)
    const anna = view.owners[0]!
    expect(anna).toMatchObject({ party_id: ANNA, identity: 'XXXXXXXX-1234', shares_at_start: 600, dividend_received: 60_000, warnings: [] })
    // Bildande 25 000 kr for 1 000 shares, 600 of them kept.
    expect(anna.cost_basis).toMatchObject({ register_amount: 15_000, complete: true })
    expect(anna.own_pay_employees.map((e) => e.employee_id)).toEqual(['emp-anna'])
    // 0.6 x 322 400 + 50 % x (0.6 x 1 500 000 - 644 800) = 193 440 + 127 600.
    expect(anna.result).toMatchObject({ basic_amount: 193_440, wage_space: 127_600, capital_interest: 0, annual_limit: 321_040, dividend: 60_000, saved_space_carried_forward: 261_040 })
  })

  it('uses what the owner entered over the books', async () => {
    mock.setTable('k10_owner_inputs', { data: [{ party_id: ANNA, saved_dividend_space: 100_000, cost_basis_override: 500_000, payroll_base_override: null, own_pay_override: 0, uses_basic_amount: true, note: null, updated_at: '2026-10-01' }] })
    const anna = (await loadK10Year(ctx, 2026)).owners[0]!
    expect(anna.inputs_saved).toBe(true)
    // (500 000 - 100 000) x 11.55 % = 46 200; own pay 0 caps the lönebaserat utrymme at 0.
    expect(anna.result).toMatchObject({ capital_interest: 46_200, wage_space: 0, total_limit: 193_440 + 46_200 + 100_000 })
  })

  it('warns when the owner is not on the payroll by name, and when a gift leaves the cost basis open', async () => {
    vi.mocked(loadPayrollCashPay).mockResolvedValue({ year: 2025, total: 800_000, runs: 12, opening_balance_amount: 0, employees: [{ employee_id: 'emp-bo', name: 'Bo Ek', amount: 800_000 }] })
    vi.mocked(loadShareRegisterData).mockResolvedValue({
      ...registerAtStart(),
      events: [EVENTS[0], { ...EVENTS[1], transfer_reason: 'gava', price_total: null, to_party_id: HOLDING }, ev({ event_number: 3, event_date: '2025-02-01', kind: 'overlatelse', from_party_id: ANNA, to_party_id: ANNA, range_start: 1, range_end: 600, transfer_reason: 'arv', price_total: null })],
    } as never)
    const anna = (await loadK10Year(ctx, 2026)).owners[0]!
    expect(anna.warnings.map((w) => w.code).sort()).toEqual(['K10_COST_BASIS_INCOMPLETE', 'K10_OWN_PAY_UNMATCHED'])
  })

  it('has no underlag before the 2026 rules', async () => {
    const view = await loadK10Year(ctx, 2025)
    expect(view).toMatchObject({ supported: false, owners: [] })
    expect(view.unsupported_reason_sv).toContain('2026')
  })
})

describe('saveK10Inputs', () => {
  it('refuses a year without parameters and a party that is no owner', async () => {
    expect(await saveK10Inputs(ctx, { party_id: ANNA, income_year: 2025, saved_dividend_space: 1 }, { dryRun: false })).toMatchObject({ ok: false, code: 'K10_YEAR_UNSUPPORTED' })
    expect(await saveK10Inputs(ctx, { party_id: BO, income_year: 2026, saved_dividend_space: 1 }, { dryRun: false })).toMatchObject({ ok: false, code: 'K10_OWNER_NOT_FOUND' })
    expect(mock.payloads('k10_owner_inputs', 'upsert')).toEqual([])
  })

  it('previews without writing, then upserts keeping omitted fields', async () => {
    const preview = await saveK10Inputs(ctx, { party_id: ANNA, income_year: 2026, saved_dividend_space: 120_000 }, { dryRun: true })
    expect(preview).toMatchObject({ ok: true, dryRun: true, preview: { after: { saved_dividend_space: 120_000, uses_basic_amount: true } } })
    expect(mock.payloads('k10_owner_inputs', 'upsert')).toEqual([])
    const saved = await saveK10Inputs(ctx, { party_id: ANNA, income_year: 2026, saved_dividend_space: 120_000, cost_basis_override: 30_000 }, { dryRun: false })
    expect(saved.ok).toBe(true)
    expect(mock.payloads('k10_owner_inputs', 'upsert')[0]).toMatchObject({
      company_id: COMPANY, party_id: ANNA, income_year: 2026, saved_dividend_space: 120_000, cost_basis_override: 30_000, payroll_base_override: null, own_pay_override: null, uses_basic_amount: true, updated_by: USER,
    })
  })
})

describe('createOwnerLoan', () => {
  it('a loan to a 60 % holder is registered with a låneförbud warning, on 1685 by default', async () => {
    timeline({ holders: [[ANNA, 60]] })
    const outcome = await createOwnerLoan(ctx, { party: { party_id: ANNA }, direction: 'lends', principal: 50_000, start_date: '2026-03-01' }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: true, data: { owner_loan_id: LOAN, account: '1685', outstanding: 50_000, loan_ban: { status: 'prohibited' } } })
    expect(outcome.ok && !outcome.dryRun && outcome.warnings?.map((w) => w.code)).toEqual(['LOAN_BAN_PROHIBITED'])
    expect(mock.payloads('owner_loans', 'insert')[0]).toMatchObject({ company_id: COMPANY, party_id: ANNA, kind: 'loan', direction: 'lends', account: '1685', status: 'active', exception: 'none', created_by: USER })
  })

  it('a loan from an owner is outside the förbud, on 2893 by default; the dry run writes nothing', async () => {
    timeline({ holders: [[ANNA, 60]] })
    const preview = await createOwnerLoan(ctx, { party: { party_id: ANNA }, direction: 'borrows', principal: 200_000, interest_rate: 5, start_date: '2026-03-01' }, { dryRun: true })
    expect(preview).toMatchObject({ ok: true, dryRun: true, preview: { account: '2893', loan_ban: { status: 'not_applicable' }, warnings: [] } })
    expect(mock.payloads('owner_loans', 'insert')).toEqual([])
  })

  it('a business loan to a board member is cleared and goes on the 21:10 list', async () => {
    timeline({ board: [BO] })
    const outcome = await createOwnerLoan(ctx, { party: { party_id: BO }, direction: 'lends', principal: 10_000, start_date: '2026-03-01', exception: 'business_loan' }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: true, data: { loan_ban: { status: 'exception', exception: 'business_loan', special_list: true } } })
  })

  it('refuses an account on the wrong side, a related person without the insider, and outstanding above principal', async () => {
    expect(await createOwnerLoan(ctx, { party: { party_id: ANNA }, direction: 'lends', account: '2893', principal: 1, start_date: '2026-03-01' }, { dryRun: false })).toMatchObject({ ok: false, code: 'OWNER_LOAN_ACCOUNT_INVALID' })
    expect(await createOwnerLoan(ctx, { party: { party_id: BO }, direction: 'lends', relation: 'related_person', principal: 1, start_date: '2026-03-01' }, { dryRun: false })).toMatchObject({ ok: false, code: 'OWNER_LOAN_RELATED_REQUIRED' })
    expect(await createOwnerLoan(ctx, { party: { party_id: ANNA }, direction: 'borrows', principal: 100, outstanding: 200, start_date: '2026-03-01' }, { dryRun: false })).toMatchObject({ ok: false, code: 'OWNER_LOAN_OUTSTANDING_INVALID' })
    expect(mock.payloads('owner_loans', 'insert')).toEqual([])
  })

  it('refuses a personnummer as an org number: it is entered in the app only', async () => {
    const outcome = await createOwnerLoan(ctx, { party: { name: 'Bo Ek', org_number: '19121212-1212' }, direction: 'lends', principal: 1, start_date: '2026-03-01' }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: false, code: 'BOLAGET_PERSONNUMMER_IN_APP_ONLY' })
  })
})

function loanRow(over: Record<string, unknown> = {}) {
  return {
    id: LOAN, party_id: ANNA, kind: 'loan', direction: 'borrows', relation: 'none', related_to_party_id: null, relation_detail: null, account: '2893',
    principal: 200_000, outstanding: 200_000, interest_rate: 5, start_date: '2026-03-01', maturity_date: null, terms: null, document_id: null,
    exception: 'none', exception_note: null, status: 'active', repaid_on: null, note: null, created_at: '2026-03-01T00:00:00Z', ...over,
  }
}

describe('updateOwnerLoan', () => {
  it('answers not found, and refuses to change a cancelled loan', async () => {
    mock.setTable('owner_loans', { data: null })
    expect(await updateOwnerLoan(ctx, { owner_loan_id: LOAN, outstanding: 1 }, { dryRun: false })).toMatchObject({ ok: false, code: 'OWNER_LOAN_NOT_FOUND' })
    mock.setTable('owner_loans', { data: loanRow({ status: 'cancelled' }) })
    expect(await updateOwnerLoan(ctx, { owner_loan_id: LOAN, outstanding: 1 }, { dryRun: false })).toMatchObject({ ok: false, code: 'OWNER_LOAN_STATUS_INVALID' })
  })

  it('marks a loan repaid: outstanding 0 and the day', async () => {
    mock.setTable('owner_loans', { data: loanRow() })
    const outcome = await updateOwnerLoan(ctx, { owner_loan_id: LOAN, status: 'repaid', repaid_on: '2026-11-30' }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: true, data: { status: 'repaid', outstanding: 0 } })
    expect(mock.payloads('owner_loans', 'update')[0]).toMatchObject({ status: 'repaid', repaid_on: '2026-11-30', outstanding: 0, account: '2893', interest_rate: 5 })
  })
})

describe('setLoanInterest', () => {
  it('warns when a fåmansföretag withheld less than 30 % on interest to a delägare', async () => {
    mock.setTable('owner_loans', { data: loanRow() })
    const outcome = await setLoanInterest(ctx, { owner_loan_id: LOAN, income_year: 2026, interest_amount: 8_000, tax_withheld: 0 }, { dryRun: false })
    expect(outcome.ok && !outcome.dryRun && outcome.warnings?.map((w) => w.code)).toEqual(['KU20_WITHHOLDING_EXPECTED'])
    expect(mock.payloads('owner_loan_interest', 'upsert')[0]).toMatchObject({ company_id: COMPANY, owner_loan_id: LOAN, income_year: 2026, interest_amount: 8_000, tax_withheld: 0, updated_by: USER })
  })

  it('takes 30 % withheld without a warning, and refuses tax above the interest', async () => {
    mock.setTable('owner_loans', { data: loanRow() })
    const ok = await setLoanInterest(ctx, { owner_loan_id: LOAN, income_year: 2026, interest_amount: 8_000, tax_withheld: 2_400 }, { dryRun: false })
    expect(ok.ok && !ok.dryRun && ok.warnings).toBeUndefined()
    expect(await setLoanInterest(ctx, { owner_loan_id: LOAN, income_year: 2026, interest_amount: 100, tax_withheld: 200 }, { dryRun: false })).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
  })
})

describe('loadKu20Status', () => {
  it('lists interest paid to persons with fields 503, 001 and 061; companies get none', async () => {
    timeline({ holders: [[ANNA, 60]] })
    vi.mocked(companyIdentity).mockResolvedValue({ name: 'Exempel AB', org_number: '5560160680' })
    vi.mocked(loadKu31Settings).mockResolvedValue({ famansforetag: true, contact_name: 'Anna Ek', contact_phone: '070', contact_email: 'a@b.se' } as never)
    mock.setTable('owner_loans', { data: [loanRow(), loanRow({ id: 'loan-h', party_id: HOLDING }), loanRow({ id: 'loan-l', direction: 'lends', account: '1685' })] })
    mock.setTable('owner_loan_interest', {
      data: [
        { owner_loan_id: LOAN, income_year: 2026, interest_amount: 8_000.75, tax_withheld: 2_400, note: null },
        { owner_loan_id: 'loan-h', income_year: 2026, interest_amount: 5_000, tax_withheld: 0, note: null },
        { owner_loan_id: 'loan-l', income_year: 2026, interest_amount: 900, tax_withheld: 0, note: null },
      ],
    })
    const status = await loadKu20Status(ctx, 2026)
    expect(status.recipients).toEqual([
      expect.objectContaining({ party_id: ANNA, interest: 8_000.75, reported_interest: 8_000, reported_tax: 2_400, delagare: true, expected_tax: 2_400.23, reason: null }),
    ])
    expect(status.legal_person_interest).toBe(5_000)
    expect(status.blockers).toEqual([])
    expect(status.warnings.map((w) => w.code)).toEqual(['KU20_WITHHOLDING_EXPECTED'])
    expect(status.ready).toBe(true)
  })
})
