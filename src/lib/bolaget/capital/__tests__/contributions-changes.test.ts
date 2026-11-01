/**
 * Aktieägartillskott and changes of aktiekapital with the engine boundary
 * mocked: what each verifikat hands the posting port, that it balances, and
 * that a locked period's refusal reaches the caller with nothing marked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { OperationContext } from '@/lib/operations/types'

vi.mock('@/lib/posting/port', () => ({ postingPort: { postJournalEntry: vi.fn() } }))
vi.mock('@/lib/bookkeeping/engine', () => ({ findFiscalPeriod: vi.fn() }))
vi.mock('@/lib/bolaget/people', () => ({
  loadRegisterParties: vi.fn().mockResolvedValue(new Map()),
  ensureRegisterParty: vi.fn(),
  checkPartyRef: vi.fn(),
}))
vi.mock('@/lib/bolaget/share-register', () => ({ registerShareEvent: vi.fn() }))
vi.mock('../free-equity', () => ({ checkFreeEquity: vi.fn() }))
vi.mock('../deadlines', () => ({ upsertCapitalDeadline: vi.fn(), completeCapitalDeadlines: vi.fn() }))
vi.mock('@/lib/dates/iso', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dates/iso')>()),
  todayIsoStockholm: () => '2026-10-29',
}))

const { postingPort } = await import('@/lib/posting/port')
const { findFiscalPeriod } = await import('@/lib/bookkeeping/engine')
const { ensureRegisterParty } = await import('@/lib/bolaget/people')
const { registerShareEvent } = await import('@/lib/bolaget/share-register')
const { checkFreeEquity } = await import('../free-equity')
const { upsertCapitalDeadline, completeCapitalDeadlines } = await import('../deadlines')
const { createShareholderContribution } = await import('../contributions')
const { createCapitalChange, bookCapitalChange } = await import('../capital-changes')
const { linesBalance } = await import('../postings')

const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const ANNA = '00000000-0000-4000-8000-0000000b0001'
const ORIGINAL = '00000000-0000-4000-8000-0000000c0c01'
const CHANGE = '00000000-0000-4000-8000-0000000cc001'

let mock: ReturnType<typeof createTableMockSupabase>
let ctx: OperationContext

function lines(call = 0) {
  return vi.mocked(postingPort.postJournalEntry).mock.calls[call]![0].input.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])
}

beforeEach(() => {
  vi.clearAllMocks()
  mock = createTableMockSupabase({
    shareholder_contributions: { data: { id: 'sc-1' } },
    capital_changes: { data: { id: CHANGE } },
    company_settings: { data: { aktiekapital: 25_000, antal_aktier: 1_000 } },
  })
  ctx = { supabase: mock.supabase as never, companyId: COMPANY, userId: USER, log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as never }
  vi.mocked(findFiscalPeriod).mockResolvedValue('fp-2026')
  vi.mocked(postingPort.postJournalEntry).mockResolvedValue({ id: 'je-1' } as never)
  vi.mocked(ensureRegisterParty).mockResolvedValue(ANNA)
  vi.mocked(checkFreeEquity).mockResolvedValue({ exceeds: false, available: 1_000_000 } as never)
  vi.mocked(registerShareEvent).mockResolvedValue({ ok: true, dryRun: true, preview: {} })
})

describe('createShareholderContribution', () => {
  it('books a villkorat tillskott D bank / K 2093 on the utfästelse and records it', async () => {
    const outcome = await createShareholderContribution(ctx, { holder: { party_id: ANNA }, promised_on: '2026-03-01', amount: 50_000, conditional: true }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: true, data: { kind: 'contribution', party_id: ANNA, amount: 50_000, journal_entry_id: 'je-1' } })
    expect(lines()).toEqual([
      ['1930', 50_000, 0],
      ['2093', 0, 50_000],
    ])
    expect(linesBalance(vi.mocked(postingPort.postJournalEntry).mock.calls[0]![0].input.lines)).toBe(true)
    expect(vi.mocked(postingPort.postJournalEntry).mock.calls[0]![0].input).toMatchObject({ entry_date: '2026-03-01', source_type: 'manual' })
    expect(mock.payloads('shareholder_contributions', 'insert')[0]).toMatchObject({ party_id: ANNA, kind: 'contribution', conditional: true, counter_account: '1930', journal_entry_id: 'je-1', status: 'booked' })
  })

  it('books a promised, unpaid tillskott against 1685 with a note', async () => {
    const outcome = await createShareholderContribution(ctx, { holder: { name: 'Anna Ek' }, promised_on: '2026-03-01', amount: 10_000, counter_account: '1685' }, { dryRun: false })
    expect(outcome.ok && !outcome.dryRun && outcome.warnings?.map((w) => w.code)).toEqual(['CONTRIBUTION_PROMISED'])
    expect(lines()[0]).toEqual(['1685', 10_000, 0])
  })

  it('with no account named a contribution lands on the primary bank account', async () => {
    mock.setTable('cash_accounts', { data: [{ id: 'ca', ledger_account: '1931', enabled: true, currency: 'SEK', is_primary: true, kind: 'bank' }] })
    await createShareholderContribution(ctx, { holder: { party_id: ANNA }, promised_on: '2026-03-01', amount: 50_000, conditional: true }, { dryRun: false })
    expect(lines()[0]).toEqual(['1931', 50_000, 0])
  })

  it('repays a villkorat tillskott D 2093 / K bank, warning without a stämma decision', async () => {
    mock.setTable('shareholder_contributions', (chain) =>
      chain.some((c) => c.method === 'insert')
        ? { data: { id: 'sc-2' } }
        : { data: [{ id: ORIGINAL, party_id: ANNA, kind: 'contribution', amount: 50_000, conditional: true, status: 'booked', repays_contribution_id: null }] },
    )
    const outcome = await createShareholderContribution(ctx, { kind: 'repayment', repays_contribution_id: ORIGINAL, promised_on: '2026-10-01', amount: 20_000 }, { dryRun: false })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || outcome.dryRun) return
    expect(outcome.warnings?.map((w) => w.code)).toEqual(['CONTRIBUTION_REPAYMENT_DECISION_MISSING'])
    expect(lines()).toEqual([
      ['2093', 20_000, 0],
      ['1930', 0, 20_000],
    ])
  })

  it('refuses to repay more than is left, or an ovillkorat tillskott', async () => {
    mock.setTable('shareholder_contributions', {
      data: [
        { id: ORIGINAL, party_id: ANNA, kind: 'contribution', amount: 50_000, conditional: true, status: 'booked', repays_contribution_id: null },
        { id: 'r1', party_id: ANNA, kind: 'repayment', amount: 40_000, conditional: true, status: 'booked', repays_contribution_id: ORIGINAL },
      ],
    })
    expect(await createShareholderContribution(ctx, { kind: 'repayment', repays_contribution_id: ORIGINAL, promised_on: '2026-10-01', amount: 20_000, decided_by: 'arsstamma', decided_on: '2026-05-01' }, { dryRun: true }))
      .toMatchObject({ ok: false, code: 'CONTRIBUTION_REPAYMENT_EXCEEDS', details: { left: 10_000 } })
    mock.setTable('shareholder_contributions', { data: [{ id: ORIGINAL, party_id: ANNA, kind: 'contribution', amount: 50_000, conditional: false, status: 'booked', repays_contribution_id: null }] })
    expect(await createShareholderContribution(ctx, { kind: 'repayment', repays_contribution_id: ORIGINAL, promised_on: '2026-10-01', amount: 1 }, { dryRun: true })).toMatchObject({ ok: false, code: 'CONTRIBUTION_NOT_CONDITIONAL' })
  })

  it('lets a locked period refuse the posting; nothing is recorded', async () => {
    const locked = Object.assign(new Error('Perioden är låst'), { code: 'PERIOD_LOCKED' })
    vi.mocked(postingPort.postJournalEntry).mockRejectedValueOnce(locked)
    await expect(createShareholderContribution(ctx, { holder: { party_id: ANNA }, promised_on: '2026-03-01', amount: 1 }, { dryRun: false })).rejects.toBe(locked)
    expect(mock.payloads('shareholder_contributions', 'insert')).toEqual([])
  })
})

describe('createCapitalChange', () => {
  it('nyemission: överkurs above the kvotvärde, the allotment into the aktiebok, the 6-month deadline', async () => {
    vi.mocked(registerShareEvent).mockImplementation(async (_c, _input, { dryRun }) =>
      dryRun ? { ok: true, dryRun: true, preview: {} } : { ok: true, data: { share_register_event_id: 'ev-1', event_number: 2, kind: 'nyemission', event_date: '2026-09-01', range_start: 1001, range_end: 1100, share_class_id: 'A', from_party_id: null, to_party_id: ANNA } },
    )
    const outcome = await createCapitalChange(
      ctx,
      { kind: 'nyemission', decided_on: '2026-09-01', decided_by: 'extra_stamma', share_count: 100, price_per_share: 1_000, allotments: [{ party_id: ANNA, share_count: 100 }] },
      { dryRun: false },
    )
    expect(outcome).toMatchObject({ ok: true, data: { capital_change_id: CHANGE, share_capital_amount: 2_500, premium_amount: 97_500, share_register_event_ids: ['ev-1'] } })
    expect(vi.mocked(registerShareEvent).mock.calls.at(-1)![1]).toMatchObject({ kind: 'nyemission', event_date: '2026-09-01', to_party_id: ANNA, share_count: 100, price_total: 100_000 })
    expect(mock.payloads('capital_changes', 'insert')[0]).toMatchObject({ kind: 'nyemission', share_capital_amount: 2_500, premium_amount: 97_500, status: 'decided' })
    expect(upsertCapitalDeadline).toHaveBeenCalledWith(ctx, expect.objectContaining({ sourceKey: `bolaget:capital:${CHANGE}:registration`, dueOn: '2027-03-01' }))
    expect(postingPort.postJournalEntry).not.toHaveBeenCalled()
  })

  it('refuses an allotment that does not add up, and a price below the kvotvärde', async () => {
    expect(await createCapitalChange(ctx, { kind: 'nyemission', decided_on: '2026-09-01', decided_by: 'extra_stamma', share_count: 100, price_per_share: 1_000, allotments: [{ party_id: ANNA, share_count: 99 }] }, { dryRun: true }))
      .toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
    expect(await createCapitalChange(ctx, { kind: 'nyemission', decided_on: '2026-09-01', decided_by: 'extra_stamma', share_count: 100, price_per_share: 10 }, { dryRun: true }))
      .toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
  })

  it('minskning: the 4-month filing deadline and the notice to the holders', async () => {
    await createCapitalChange(ctx, { kind: 'minskning', decided_on: '2026-06-30', decided_by: 'extra_stamma', share_count: 100, purpose: 'aterbetalning' }, { dryRun: false })
    expect(mock.payloads('capital_changes', 'insert')[0]).toMatchObject({ kind: 'minskning', share_capital_amount: 2_500, purpose: 'aterbetalning', target_account: '2890' })
    const keys = vi.mocked(upsertCapitalDeadline).mock.calls.map(([, d]) => [d.sourceKey.split(':').pop(), d.dueOn])
    expect(keys).toEqual([
      ['registration', '2026-10-30'],
      ['notice', '2026-07-07'],
    ])
  })
})

describe('bookCapitalChange', () => {
  const nyemission = (over: Record<string, unknown> = {}) => ({
    id: CHANGE,
    kind: 'nyemission',
    decided_on: '2026-09-01',
    decided_by: 'extra_stamma',
    share_count: 100,
    share_capital_amount: '2500.00',
    premium_amount: '97500.00',
    price_per_share: 1000,
    source_account: null,
    purpose: null,
    target_account: null,
    allotments: [],
    registered_on: null,
    payment_entry_id: null,
    registration_entry_id: null,
    status: 'decided',
    ...over,
  })

  it('with no account named the payment lands on the primary bank account', async () => {
    mock.setTable('cash_accounts', { data: [{ id: 'ca', ledger_account: '1931', enabled: true, currency: 'SEK', is_primary: true, kind: 'bank' }] })
    mock.setTable('capital_changes', (chain) => (chain.some((c) => c.method === 'update') ? { data: null } : { data: nyemission() }))
    await bookCapitalChange(ctx, { capital_change_id: CHANGE, step: 'payment', date: '2026-09-10' }, { dryRun: false })
    expect(lines()[0]?.[0]).toBe('1931')
  })

  it('books the payment D bank / K 2082 + 2097, then the registration D 2082 / K 2081', async () => {
    mock.setTable('capital_changes', (chain) => (chain.some((c) => c.method === 'update') ? { data: null } : { data: nyemission() }))
    expect(await bookCapitalChange(ctx, { capital_change_id: CHANGE, step: 'payment', date: '2026-09-10' }, { dryRun: false })).toMatchObject({ ok: true, data: { step: 'payment', journal_entry_id: 'je-1' } })
    expect(lines(0)).toEqual([
      ['1930', 100_000, 0],
      ['2082', 0, 2_500],
      ['2097', 0, 97_500],
    ])
    mock.setTable('capital_changes', (chain) => (chain.some((c) => c.method === 'update') ? { data: null } : { data: nyemission({ payment_entry_id: 'je-1' }) }))
    expect(await bookCapitalChange(ctx, { capital_change_id: CHANGE, step: 'registration', date: '2026-10-01' }, { dryRun: false })).toMatchObject({ ok: true, data: { step: 'registration', status: 'registered' } })
    expect(lines(1)).toEqual([
      ['2082', 2_500, 0],
      ['2081', 0, 2_500],
    ])
    expect(mock.payloads('capital_changes', 'update')[1]).toMatchObject({ registered_on: '2026-10-01', status: 'registered' })
    expect(completeCapitalDeadlines).toHaveBeenCalledWith(ctx, `bolaget:capital:${CHANGE}:registration`)
  })

  it('refuses a registration before the payment (ABL 13:28)', async () => {
    mock.setTable('capital_changes', { data: nyemission() })
    expect(await bookCapitalChange(ctx, { capital_change_id: CHANGE, step: 'registration', date: '2026-10-01' }, { dryRun: false })).toMatchObject({ ok: false, code: 'CAPITAL_CHANGE_NOT_PAID' })
    expect(postingPort.postJournalEntry).not.toHaveBeenCalled()
  })

  it('books a fondemission from the fund and a minskning out of 2081', async () => {
    mock.setTable('capital_changes', (chain) => (chain.some((c) => c.method === 'update') ? { data: null } : { data: nyemission({ kind: 'fondemission', premium_amount: 0, source_account: '2097' }) }))
    await bookCapitalChange(ctx, { capital_change_id: CHANGE, step: 'registration', date: '2026-10-01' }, { dryRun: false })
    expect(lines(0)).toEqual([
      ['2097', 2_500, 0],
      ['2081', 0, 2_500],
    ])
    mock.setTable('capital_changes', (chain) => (chain.some((c) => c.method === 'update') ? { data: null } : { data: nyemission({ kind: 'minskning', premium_amount: 0, purpose: 'forlusttackning', target_account: '2091' }) }))
    await bookCapitalChange(ctx, { capital_change_id: CHANGE, step: 'registration', date: '2026-10-01' }, { dryRun: false })
    expect(lines(1)).toEqual([
      ['2081', 2_500, 0],
      ['2091', 0, 2_500],
    ])
  })

  it('lets a locked period refuse the registration; the change stays decided', async () => {
    mock.setTable('capital_changes', (chain) => (chain.some((c) => c.method === 'update') ? { data: null } : { data: nyemission({ payment_entry_id: 'je-0' }) }))
    const locked = Object.assign(new Error('Perioden är låst'), { code: 'PERIOD_LOCKED' })
    vi.mocked(postingPort.postJournalEntry).mockRejectedValueOnce(locked)
    await expect(bookCapitalChange(ctx, { capital_change_id: CHANGE, step: 'registration', date: '2026-10-01' }, { dryRun: false })).rejects.toBe(locked)
    expect(mock.payloads('capital_changes', 'update')).toEqual([])
  })
})
