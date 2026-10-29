/**
 * The dividend register's services with the engine boundary mocked: the
 * posting port records what each capital verifikat hands the engine (lines,
 * date, source type), and refuses like the engine does for a locked period.
 * The aktiebok and the fritt eget kapital check are mocked to fixed answers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { OperationContext } from '@/lib/operations/types'

vi.mock('@/lib/posting/port', () => ({ postingPort: { postJournalEntry: vi.fn() } }))
vi.mock('@/lib/bookkeeping/engine', () => ({ findFiscalPeriod: vi.fn() }))
vi.mock('@/lib/reports/trial-balance', () => ({ generateTrialBalance: vi.fn() }))
vi.mock('@/lib/bookkeeping/entry-lines', () => ({ fetchEntryLines: vi.fn() }))
vi.mock('@/lib/bolaget/share-register', () => ({ loadShareRegisterData: vi.fn() }))
vi.mock('@/lib/bolaget/people', () => ({
  loadRegisterParties: vi.fn(),
  ensureRegisterParty: vi.fn(),
  loadFullPersonnummer: vi.fn(),
  checkPartyRef: vi.fn(),
}))
vi.mock('../free-equity', () => ({ checkFreeEquity: vi.fn() }))
vi.mock('../deadlines', () => ({ syncKu31Deadline: vi.fn(), upsertCapitalDeadline: vi.fn(), completeCapitalDeadlines: vi.fn() }))
vi.mock('@/lib/dates/iso', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dates/iso')>()),
  todayIsoStockholm: () => '2026-10-29',
}))

const { postingPort } = await import('@/lib/posting/port')
const { findFiscalPeriod } = await import('@/lib/bookkeeping/engine')
const { generateTrialBalance } = await import('@/lib/reports/trial-balance')
const { fetchEntryLines } = await import('@/lib/bookkeeping/entry-lines')
const { loadShareRegisterData } = await import('@/lib/bolaget/share-register')
const { loadRegisterParties } = await import('@/lib/bolaget/people')
const { checkFreeEquity } = await import('../free-equity')
const { syncKu31Deadline, upsertCapitalDeadline } = await import('../deadlines')
const { createDividend, bookDividend, payDividend, cancelDividend, recordLedgerDividend } = await import('../dividends')
const { linesBalance } = await import('../postings')

const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const DIVIDEND = '00000000-0000-4000-8000-0000000d0001'
const ANNA = '00000000-0000-4000-8000-0000000b0001'
const BO = '00000000-0000-4000-8000-0000000b0002'
const BOLAG = '00000000-0000-4000-8000-0000000b0003'
const CLASS_A = '00000000-0000-4000-8000-0000000ca001'

const parties = new Map([
  [ANNA, { party_id: ANNA, name: 'Anna Ek', kind: 'person', org_number: null, personnummer_masked: 'XXXXXXXX-1234', birth_date: null, address: null, email: null }],
  [BO, { party_id: BO, name: 'Bo Ek', kind: 'person', org_number: null, personnummer_masked: null, birth_date: null, address: null, email: null }],
  [BOLAG, { party_id: BOLAG, name: 'Holding AB', kind: 'company', org_number: '5560000000', personnummer_masked: null, birth_date: null, address: null, email: null }],
])

function register(holders: Array<[string, number]>, events: unknown[] = []) {
  return {
    as_of: '2026-05-01',
    is_avstamningsbolag: false,
    classes: [{ id: CLASS_A, code: 'A', votes_per_share: 1 }],
    events,
    replay: { ranges: [], annotations: [], totalShares: holders.reduce((n, [, s]) => n + s, 0) },
    summary: {
      total_shares: holders.reduce((n, [, s]) => n + s, 0),
      total_votes: holders.reduce((n, [, s]) => n + s, 0),
      classes: [],
      holders: holders.map(([party_id, shares]) => ({ party_id, shares, votes: shares, capital_pct: 0, votes_pct: 0, by_class: [{ share_class_id: CLASS_A, code: 'A', shares }], ranges: [] })),
    },
    parties,
    reconciliation: { status: 'match' },
  }
}

const EQUITY_OK = {
  basis: 'balance_sheet',
  fiscal_period_id: 'fp-2025',
  balance_date: '2025-12-31',
  adopted_on: '2026-05-01',
  free_equity: 500_000,
  later_transfers: 0,
  available: 500_000,
  amount: 100_000,
  exceeds: false,
}

function decidedRow(over: Record<string, unknown> = {}) {
  return {
    id: DIVIDEND,
    company_id: COMPANY,
    decided_on: '2026-05-01',
    decided_by: 'arsstamma',
    decision_id: null,
    document_id: null,
    origin: 'register',
    share_class_ids: null,
    amount_per_share: 100,
    total_amount: '100000.00',
    record_date: '2026-05-01',
    record_date_basis: 'decision_date',
    payment_date: '2026-05-15',
    source_account: null,
    prudence_confirmed: true,
    equity_check: {},
    status: 'decided',
    decision_entry_id: null,
    payout_entry_id: null,
    paid_on: null,
    note: null,
    created_at: '2026-05-01T10:00:00Z',
    ...over,
  }
}

let mock: ReturnType<typeof createTableMockSupabase>
let ctx: OperationContext

beforeEach(() => {
  vi.clearAllMocks()
  mock = createTableMockSupabase({
    dividends: { data: { id: DIVIDEND } },
    dividend_distributions: { data: null },
  })
  ctx = {
    supabase: mock.supabase as never,
    companyId: COMPANY,
    userId: USER,
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
  }
  vi.mocked(loadShareRegisterData).mockResolvedValue(register([[ANNA, 600], [BO, 400]]) as never)
  vi.mocked(loadRegisterParties).mockResolvedValue(parties as never)
  vi.mocked(checkFreeEquity).mockResolvedValue(EQUITY_OK as never)
  vi.mocked(findFiscalPeriod).mockResolvedValue('fp-2026')
  vi.mocked(generateTrialBalance).mockResolvedValue({ rows: [{ account_number: '2098', closing_debit: 0, closing_credit: 400_000 }] } as never)
  vi.mocked(postingPort.postJournalEntry).mockResolvedValue({ id: 'je-1' } as never)
})

describe('createDividend', () => {
  const input = { decided_on: '2026-05-01', decided_by: 'arsstamma' as const, amount_per_share: 100, payment_date: '2026-05-15', prudence_confirmed: true }

  it('previews the split per holder from the aktiebok on the decision day, without writing', async () => {
    const outcome = await createDividend(ctx, input, { dryRun: true })
    expect(outcome.ok && outcome.dryRun).toBe(true)
    if (!outcome.ok || !outcome.dryRun) return
    expect(outcome.preview).toMatchObject({
      record_date: '2026-05-01',
      record_date_basis: 'decision_date',
      payment_date: '2026-05-15',
      total_amount: 100_000,
      total_shares: 1000,
      holders: [
        { party_id: ANNA, name: 'Anna Ek', identity: 'XXXXXXXX-1234', share_count: 600, amount: 60_000 },
        { party_id: BO, name: 'Bo Ek', identity: null, share_count: 400, amount: 40_000 },
      ],
    })
    // Bo has no personnummer: KU31 will need it.
    expect((outcome.preview.warnings as string[]).some((w) => w.includes('saknar personnummer'))).toBe(true)
    expect(loadShareRegisterData).toHaveBeenCalledWith(ctx, '2026-05-01')
    expect(mock.payloads('dividends', 'insert')).toEqual([])
    expect(postingPort.postJournalEntry).not.toHaveBeenCalled()
  })

  it('records the decision and one distribution per holder; nothing is booked yet', async () => {
    const outcome = await createDividend(ctx, input, { dryRun: false })
    expect(outcome).toMatchObject({ ok: true, data: { dividend_id: DIVIDEND, status: 'decided', total_amount: 100_000 } })
    expect(mock.payloads('dividends', 'insert')[0]).toMatchObject({
      company_id: COMPANY,
      decided_on: '2026-05-01',
      decided_by: 'arsstamma',
      origin: 'register',
      amount_per_share: 100,
      total_amount: 100_000,
      record_date: '2026-05-01',
      payment_date: '2026-05-15',
      status: 'decided',
      created_by: USER,
    })
    expect(mock.payloads('dividend_distributions', 'insert')).toEqual([
      { company_id: COMPANY, dividend_id: DIVIDEND, party_id: ANNA, share_count: 600, amount: 60_000, by_class: [{ share_class_id: CLASS_A, code: 'A', shares: 600 }] },
      { company_id: COMPANY, dividend_id: DIVIDEND, party_id: BO, share_count: 400, amount: 40_000, by_class: [{ share_class_id: CLASS_A, code: 'A', shares: 400 }] },
    ])
    expect(postingPort.postJournalEntry).not.toHaveBeenCalled()
  })

  it('reads the register on the betalningsdag when that day decides', async () => {
    await createDividend(ctx, { ...input, record_date_basis: 'payment_date' }, { dryRun: true })
    expect(loadShareRegisterData).toHaveBeenCalledWith(ctx, '2026-05-15')
  })

  it('warns when the dividend exceeds the fritt eget kapital, and on an extra stämma adds the registration deadline', async () => {
    vi.mocked(checkFreeEquity).mockResolvedValue({ ...EQUITY_OK, available: 50_000, exceeds: true } as never)
    const outcome = await createDividend(ctx, { ...input, decided_by: 'extra_stamma' }, { dryRun: false })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || outcome.dryRun) return
    expect(outcome.warnings?.map((w) => w.code)).toEqual(expect.arrayContaining(['DIVIDEND_EXCEEDS_FREE_EQUITY', 'DIVIDEND_EXTRA_STAMMA_REGISTRATION']))
    expect(upsertCapitalDeadline).toHaveBeenCalledWith(ctx, expect.objectContaining({ sourceKey: `bolaget:dividend:${DIVIDEND}:registration` }))
  })

  it('refuses a dividend stated both ways, one dated ahead, and one without holders', async () => {
    expect(await createDividend(ctx, { ...input, total_amount: 5 }, { dryRun: true })).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
    expect(await createDividend(ctx, { ...input, decided_on: '2026-11-01', payment_date: '2026-11-01' }, { dryRun: true })).toMatchObject({ ok: false, code: 'BOLAGET_DATES_INVALID' })
    expect(await createDividend(ctx, { ...input, payment_date: '2026-04-01' }, { dryRun: true })).toMatchObject({ ok: false, code: 'BOLAGET_DATES_INVALID' })
    vi.mocked(loadShareRegisterData).mockResolvedValue(register([]) as never)
    expect(await createDividend(ctx, input, { dryRun: true })).toMatchObject({ ok: false, code: 'DIVIDEND_NO_HOLDERS' })
  })
})

describe('bookDividend', () => {
  beforeEach(() => {
    mock.setTable('dividends', (chain) =>
      chain.some((c) => c.method === 'update') ? { data: [{ id: DIVIDEND }] } : { data: decidedRow() },
    )
    mock.setTable('dividend_distributions', { data: [] })
  })

  it('posts D 2098 / K 2898 on the decision day through the port, freezes the split and marks it booked', async () => {
    const outcome = await bookDividend(ctx, { dividend_id: DIVIDEND }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: true, data: { status: 'booked', decision_entry_id: 'je-1', source_account: '2098', total_amount: 100_000 } })
    const call = vi.mocked(postingPort.postJournalEntry).mock.calls[0]![0]
    expect(call.input).toMatchObject({ fiscal_period_id: 'fp-2026', entry_date: '2026-05-01', source_type: 'manual' })
    expect(call.input.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['2098', 100_000, 0],
      ['2898', 0, 100_000],
    ])
    expect(linesBalance(call.input.lines)).toBe(true)
    // Claimed before posting, the verifikat id written after.
    expect(mock.payloads('dividends', 'update')).toEqual([
      { status: 'booked', source_account: '2098', total_amount: 100_000, prudence_confirmed: true, equity_check: expect.objectContaining({ exceeds: false }) },
      { decision_entry_id: 'je-1' },
    ])
    expect(mock.payloads('dividend_distributions', 'insert')).toHaveLength(2)
    expect(syncKu31Deadline).toHaveBeenCalledWith(ctx, 2026)
  })

  it('books from 2091 when 2098 does not hold the amount', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue({ rows: [{ account_number: '2098', closing_debit: 0, closing_credit: 10 }] } as never)
    const outcome = await bookDividend(ctx, { dividend_id: DIVIDEND }, { dryRun: true })
    expect(outcome.ok && outcome.dryRun && outcome.preview.source_account).toBe('2091')
  })

  it('refuses a dividend above the fritt eget kapital and books nothing (ABL 17:3)', async () => {
    vi.mocked(checkFreeEquity).mockResolvedValue({ ...EQUITY_OK, available: 99_999.99, exceeds: true } as never)
    const outcome = await bookDividend(ctx, { dividend_id: DIVIDEND }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: false, code: 'DIVIDEND_EXCEEDS_FREE_EQUITY', details: { available: 99_999.99 } })
    expect(postingPort.postJournalEntry).not.toHaveBeenCalled()
    expect(mock.payloads('dividends', 'update')).toEqual([])
  })

  it('lets the engine refuse a locked period: the refusal surfaces and the claim is released', async () => {
    const locked = Object.assign(new Error('Perioden är låst'), { code: 'PERIOD_LOCKED' })
    vi.mocked(postingPort.postJournalEntry).mockRejectedValue(locked)
    await expect(bookDividend(ctx, { dividend_id: DIVIDEND }, { dryRun: false })).rejects.toBe(locked)
    const updates = mock.payloads('dividends', 'update')
    expect(updates).toHaveLength(2)
    expect(updates[1]).toEqual({ status: 'decided' })
    expect(updates.some((u) => (u as Record<string, unknown>).decision_entry_id)).toBe(false)
  })

  it('posts nothing when another approval claimed the dividend first', async () => {
    mock.setTable('dividends', (chain) => (chain.some((c) => c.method === 'update') ? { data: [] } : { data: decidedRow() }))
    expect(await bookDividend(ctx, { dividend_id: DIVIDEND }, { dryRun: false })).toMatchObject({ ok: false, code: 'DIVIDEND_STATUS_INVALID' })
    expect(postingPort.postJournalEntry).not.toHaveBeenCalled()
  })

  it('refuses when no open fiscal year holds the decision day', async () => {
    vi.mocked(findFiscalPeriod).mockResolvedValue(null)
    await expect(bookDividend(ctx, { dividend_id: DIVIDEND, source_account: '2091' }, { dryRun: false })).rejects.toMatchObject({ code: 'CAPITAL_NO_OPEN_PERIOD' })
    expect(postingPort.postJournalEntry).not.toHaveBeenCalled()
  })

  it('refuses a dividend that is not decided, and one that does not exist', async () => {
    mock.setTable('dividends', { data: decidedRow({ status: 'booked', decision_entry_id: 'je-0' }) })
    expect(await bookDividend(ctx, { dividend_id: DIVIDEND }, { dryRun: true })).toMatchObject({ ok: false, code: 'DIVIDEND_STATUS_INVALID' })
    mock.setTable('dividends', { data: null })
    expect(await bookDividend(ctx, { dividend_id: DIVIDEND }, { dryRun: true })).toMatchObject({ ok: false, code: 'DIVIDEND_NOT_FOUND' })
  })
})

describe('payDividend', () => {
  beforeEach(() => {
    mock.setTable('dividends', (chain) =>
      chain.some((c) => c.method === 'update') ? { data: [{ id: DIVIDEND }] } : { data: decidedRow({ status: 'booked', decision_entry_id: 'je-0', source_account: '2098' }) },
    )
  })

  it('posts D 2898 / K bank on the betalningsdag and marks it paid', async () => {
    const outcome = await payDividend(ctx, { dividend_id: DIVIDEND }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: true, data: { status: 'paid', payout_entry_id: 'je-1', paid_on: '2026-05-15', linked: false } })
    const call = vi.mocked(postingPort.postJournalEntry).mock.calls[0]![0]
    expect(call.input.entry_date).toBe('2026-05-15')
    expect(call.input.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['2898', 100_000, 0],
      ['1930', 0, 100_000],
    ])
    expect(mock.payloads('dividends', 'update')).toEqual([{ status: 'paid', paid_on: '2026-05-15' }, { payout_entry_id: 'je-1' }])
  })

  it('links a payout already booked from the bank instead of booking another', async () => {
    vi.mocked(fetchEntryLines).mockResolvedValue([{ journal_entry_id: 'je-bank', account_number: '2898', debit_amount: '100000.00', journal_entries: {} }] as never)
    const outcome = await payDividend(ctx, { dividend_id: DIVIDEND, journal_entry_id: 'je-bank', paid_on: '2026-05-16' }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: true, data: { payout_entry_id: 'je-bank', linked: true, paid_on: '2026-05-16' } })
    expect(postingPort.postJournalEntry).not.toHaveBeenCalled()
  })

  it('refuses a link to a verifikat that does not debit 2898', async () => {
    vi.mocked(fetchEntryLines).mockResolvedValue([] as never)
    expect(await payDividend(ctx, { dividend_id: DIVIDEND, journal_entry_id: 'je-x' }, { dryRun: false })).toMatchObject({ ok: false, code: 'DIVIDEND_PAYOUT_ENTRY_INVALID' })
  })

  it('refuses a payout dated ahead', async () => {
    expect(await payDividend(ctx, { dividend_id: DIVIDEND, paid_on: '2026-12-01' }, { dryRun: true })).toMatchObject({ ok: false, code: 'BOLAGET_DATES_INVALID' })
  })
})

describe('cancelDividend', () => {
  it('cancels a decided dividend only', async () => {
    mock.setTable('dividends', (chain) => (chain.some((c) => c.method === 'update') ? { data: null } : { data: decidedRow() }))
    expect(await cancelDividend(ctx, DIVIDEND)).toMatchObject({ ok: true, data: { status: 'cancelled' } })
    mock.setTable('dividends', { data: decidedRow({ status: 'paid', paid_on: '2026-05-15' }) })
    expect(await cancelDividend(ctx, DIVIDEND)).toMatchObject({ ok: false, code: 'DIVIDEND_STATUS_INVALID' })
  })
})

describe('recordLedgerDividend (who received)', () => {
  const input = {
    decided_on: '2026-04-20',
    decided_by: 'arsstamma' as const,
    paid_on: '2026-04-30',
    payout_entry_id: 'je-2898',
    recipients: [
      { party_id: ANNA, amount: 30_000 },
      { name: 'Bo Ek', amount: 20_000 },
    ],
  }

  it('records recipients against the 2898 payout already booked, and books nothing', async () => {
    vi.mocked(fetchEntryLines).mockResolvedValue([{ journal_entry_id: 'je-2898', account_number: '2898', debit_amount: 50_000, journal_entries: {} }] as never)
    const { ensureRegisterParty } = await import('@/lib/bolaget/people')
    vi.mocked(ensureRegisterParty).mockImplementation(async (_ctx, ref) => (ref.party_id ?? BO) as string)
    const outcome = await recordLedgerDividend(ctx, input, { dryRun: false })
    expect(outcome).toMatchObject({ ok: true, data: { status: 'paid', total_amount: 50_000, payment_date: '2026-04-30' } })
    expect(mock.payloads('dividends', 'insert')[0]).toMatchObject({ origin: 'ledger', total_amount: 50_000, payment_date: '2026-04-30' })
    expect(mock.payloads('dividends', 'update')[0]).toEqual({ status: 'paid', paid_on: '2026-04-30', payout_entry_id: 'je-2898' })
    expect(postingPort.postJournalEntry).not.toHaveBeenCalled()
    expect(syncKu31Deadline).toHaveBeenCalledWith(ctx, 2026)
  })

  it('refuses recipients that do not add up to the payout', async () => {
    vi.mocked(fetchEntryLines).mockResolvedValue([{ journal_entry_id: 'je-2898', account_number: '2898', debit_amount: 60_000, journal_entries: {} }] as never)
    expect(await recordLedgerDividend(ctx, input, { dryRun: true })).toMatchObject({ ok: false, code: 'DIVIDEND_RECIPIENTS_MISMATCH' })
  })
})
