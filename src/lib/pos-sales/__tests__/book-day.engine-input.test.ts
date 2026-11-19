/**
 * Posting port, step 2: what bookPosSalesDay hands the engine, recorded call
 * by call and compared with a committed fixture (book-day.engine-input.json)
 * that was taken before the producer went through the port. The day is booked
 * draft -> claim -> commit, so both engine calls are recorded: every
 * argument, an absent one as '<undefined>', so an extra argument or a changed
 * input fails here.
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/pos-sales/__tests__/book-day.engine-input.test.ts
 *
 * Since the producer drafts and commits through the posting port, the
 * scenarios also run with POSTING_EVENTS=shadow: the draft must get the same
 * four arguments plus only the event link, the commit exactly the same
 * arguments, and a refused event write must still post.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PosDay } from '@accounted/connect-contract'
import type { CreateJournalEntryInput } from '@/types'
import { createFakeDb, type FakeDb } from './fake-db'

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }))

vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => h.db.client }))
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createDraftEntry: vi.fn(),
  commitEntry: vi.fn(),
  findFiscalPeriod: vi.fn(),
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({ checkPeriodLock: vi.fn(async () => ({ locked: false })) }))
vi.mock('@/lib/core/documents/document-service', () => ({ uploadDocument: vi.fn(async () => ({ id: 'doc-1' })) }))
vi.mock('../day-report-pdf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../day-report-pdf')>()),
  renderPosDayReport: vi.fn(async () => Buffer.from('%PDF-1.4')),
}))

const { createDraftEntry, commitEntry, findFiscalPeriod } = await import('@/lib/bookkeeping/engine')
const { bookPosSalesDay } = await import('../book-day')

const mockedDraft = vi.mocked(createDraftEntry)
const mockedCommit = vi.mocked(commitEntry)

const FIXTURE = path.join(__dirname, 'book-day.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const CONNECTION = '00000000-0000-4000-8000-0000000c0001'
const SHA = 'a'.repeat(64)
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never

function posDay(overrides: Partial<PosDay> = {}): PosDay {
  return {
    businessDate: '2026-09-30',
    currency: 'SEK',
    sales: { net: 100, vat: 12, gross: 112 },
    vatGroups: [{ ratePercent: 12, net: 100, vat: 12, gross: 112 }],
    tenders: [{ kind: 'card', method: 'card', amount: 112, tips: 0, receiptCount: 1 }],
    tips: 0,
    discounts: 0,
    refunds: { count: 0, gross: 0 },
    receiptCount: 1,
    firstReceiptNumber: '1001',
    lastReceiptNumber: '1001',
    firstPaidAt: null,
    lastPaidAt: null,
    categories: [],
    receipts: [],
    issues: [],
    ...overrides,
  }
}

interface Scenario {
  name: string
  day: PosDay
  summary: { gross: number; net: number; vat: number; tips: number }
  settings?: Record<string, unknown>
  input?: { acknowledge_issues?: boolean }
}

const SCENARIOS: Scenario[] = [
  {
    name: 'card day at 12 % moms',
    day: posDay(),
    summary: { gross: 112, net: 100, vat: 12, tips: 0 },
  },
  {
    name: 'mixed tenders, two rates, tips and öresutjämning',
    day: posDay({
      businessDate: '2026-10-01',
      sales: { net: 900, vat: 127.5, gross: 1027.5 },
      vatGroups: [
        { ratePercent: 12, net: 750, vat: 90, gross: 840 },
        { ratePercent: 25, net: 150, vat: 37.5, gross: 187.5 },
      ],
      tenders: [
        { kind: 'card', method: 'card', amount: 900, tips: 40, receiptCount: 9 },
        { kind: 'cash', method: 'cash', amount: 167.75, tips: 0, receiptCount: 3 },
      ],
      tips: 40,
      receiptCount: 12,
      firstReceiptNumber: '2001',
      lastReceiptNumber: '2012',
    }),
    summary: { gross: 1027.5, net: 900, vat: 127.5, tips: 40 },
  },
  {
    name: 'a day with a provider issue the person acknowledged',
    day: posDay({
      businessDate: '2026-10-02',
      issues: [{ code: 'late_receipts', message: 'Kvitton kom in efter dagsavslut' }],
    }),
    summary: { gross: 112, net: 100, vat: 12, tips: 0 },
    input: { acknowledge_issues: true },
  },
]

function dayId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
}

function seed(index: number, s: Scenario): void {
  h.db = createFakeDb({
    pos_sales_days: [
      {
        id: dayId(index),
        company_id: COMPANY,
        connection_id: CONNECTION,
        business_date: s.day.businessDate,
        currency: 'SEK',
        status: 'ready',
        review_reasons: [],
        gross: String(s.summary.gross),
        net: String(s.summary.net),
        vat: String(s.summary.vat),
        tips: String(s.summary.tips),
        receipt_count: s.day.receiptCount,
        tenders: [],
        vat_groups: [],
        raw_sha256: SHA,
        fetched_at: '2026-10-03T04:15:00Z',
        fetch_count: 1,
        changed_after_booking: false,
        journal_entry_id: null,
        day: s.day,
      },
    ],
    pos_connections: [
      {
        id: CONNECTION,
        company_id: COMPANY,
        provider: 'heynow',
        provider_name: 'Heynow',
        venue_ref: 'v',
        venue_name: 'Restaurang Exempel',
        settings: s.settings ?? {},
        status: 'active',
      },
    ],
    company_settings: [{ company_id: COMPANY, company_name: 'Exempel AB', org_number: '556677-8899' }],
    journal_entries: [],
  })
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The request's client: the fake db, with the business_events insert refused when asked. */
function requestClient(refuseEvent: boolean) {
  return {
    from: (table: string) =>
      refuseEvent && table === 'business_events'
        ? { insert: async () => ({ data: null, error: { message: 'business_events refused', code: '42501' } }) }
        : h.db.client.from(table),
  }
}

function record(args: unknown[]): unknown[] {
  return [args.length, ...args.map((a, i) => (i === 0 ? SUPABASE : a === undefined ? '<undefined>' : a))]
}

interface Run {
  name: string
  createDraftEntry: unknown[][]
  commitEntry: unknown[][]
  events: Array<Record<string, unknown>>
  eventAttempts: number
}

async function runScenarios(opts: { refuseEvent?: boolean } = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, s] of SCENARIOS.entries()) {
    seed(index, s)
    mockedDraft.mockReset()
    mockedCommit.mockReset()
    vi.mocked(findFiscalPeriod).mockResolvedValue('00000000-0000-4000-8000-00000000f001')
    const entryId = `je-${index}`
    mockedDraft.mockImplementation(async (_sb, _c, _u, input: CreateJournalEntryInput) => {
      h.db.tables.journal_entries.push({ id: entryId, status: 'draft' })
      return { id: entryId, ...input } as never
    })
    mockedCommit.mockImplementation(async () => ({ id: entryId, voucher_series: 'F', voucher_number: index + 1 }) as never)
    let eventAttempts = 0
    const client = requestClient(opts.refuseEvent ?? false)
    const counted = {
      from: (table: string) => {
        if (table === 'business_events') eventAttempts++
        return client.from(table)
      },
    }
    const outcome = await bookPosSalesDay(
      { supabase: counted as never, companyId: COMPANY, userId: USER, log },
      { day_id: dayId(index), expected_raw_sha256: SHA, ...s.input },
    )
    expect(outcome.ok, `${s.name}: ${JSON.stringify(outcome)}`).toBe(true)
    out.push({
      name: s.name,
      createDraftEntry: mockedDraft.mock.calls.map((c) => record(c as unknown[])),
      commitEntry: mockedCommit.mock.calls.map((c) => record(c as unknown[])),
      events: h.db.inserts.filter((i) => i.table === 'business_events').map((i) => i.row),
      eventAttempts,
    })
  }
  return out
}

describe('bookPosSalesDay engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  it('hands the engine exactly what it handed it before the port', async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, createDraftEntry: draft, commitEntry: commit }) => ({
      name,
      createDraftEntry: draft,
      commitEntry: commit,
    }))
    if (process.env.UPDATE_ENGINE_INPUT_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
    expect(runs.flatMap((r) => r.events)).toEqual([])
    expect(runs.map((r) => r.eventAttempts)).toEqual(runs.map(() => 0))
  })

  it('with POSTING_EVENTS=shadow drafts with the same four arguments plus only the link, and commits exactly as before', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const shadow = await runScenarios()
    for (const [i, run] of shadow.entries()) {
      const before = off[i]!
      expect(run.createDraftEntry, run.name).toHaveLength(1)
      expect(before.createDraftEntry[0]![0]).toBe(4)
      expect(run.createDraftEntry[0]![0], run.name).toBe(5)
      expect(run.createDraftEntry[0]!.slice(1, 5), run.name).toEqual(before.createDraftEntry[0]!.slice(1, 5))
      expect(run.createDraftEntry[0]![5], run.name).toEqual({
        businessEvent: { id: expect.stringMatching(UUID), role: 'produced', onFailure: 'log' },
      })
      expect(run.commitEntry, run.name).toEqual(before.commitEntry)
      expect(run.events, run.name).toHaveLength(1)
      expect((run.createDraftEntry[0]![5] as { businessEvent: { id: string } }).businessEvent.id).toBe(run.events[0]!.id)
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still posts, with exactly the off calls', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    expect(refused.map((r) => [r.createDraftEntry, r.commitEntry])).toEqual(off.map((r) => [r.createDraftEntry, r.commitEntry]))
    expect(refused.map((r) => r.eventAttempts)).toEqual(refused.map(() => 1))
  })

  it('records what happened in business terms', async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const event = (name: string) => runs.find((r) => r.name === name)!.events[0]!
    expect(event('card day at 12 % moms')).toMatchObject({
      kind: 'sale.pos_daily_takings',
      category: 'income.sales',
      occurred_on: '2026-09-30',
      subject_type: null,
      party_type: null,
      currency: 'SEK',
      amount: 112,
      amount_sek: 112,
      tax_amounts: [{ tax: 'vat', treatment: null, amount_sek: 12 }],
      evidence: { direction: 'in', link_basis: 'user_created' },
      pending_operation_id: null,
      jurisdiction: 'SE',
    })
    expect(event('card day at 12 % moms').mapping_version).toMatch(/^se\.pos-daily-takings@/)
    expect(event('mixed tenders, two rates, tips and öresutjämning')).toMatchObject({
      occurred_on: '2026-10-01',
      amount: 1027.5,
      tax_amounts: [{ tax: 'vat', amount_sek: 127.5 }],
    })
  })
})
