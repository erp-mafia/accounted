/**
 * Posting port, step 2i: what the storno service writes for a correction
 * (correctEntry: the storno and the corrected verifikat, BFL 5 kap 5 §) and
 * a move to another date (recordateEntry), recorded write by write and
 * compared with a committed fixture (storno-service.engine-input.json) that
 * was taken before the correction paths went through the port. The service
 * builds both drafts itself and posts each through commit_journal_entry
 * (commitStornoOrCorrectionDraft), so its "engine input" is every insert,
 * update and RPC call it makes, in order.
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/core/bookkeeping/__tests__/storno-service.engine-input.test.ts
 *
 * With the posting port's event links (CorrectionBusinessEvents, which the
 * port hands down while POSTING_EVENTS is shadow or strict) the service must
 * write exactly the same, plus each link right after its draft's header and
 * before its lines and number. A link refused under shadow is logged and the
 * correction goes ahead; under strict a refused storno link cancels the
 * storno's draft before any number, and a refused correction link (the
 * storno is numbered and posted by then) cancels the corrected draft and the
 * posted storno, which keeps its number as a cancelled verifikat.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResult } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import type { CreateJournalEntryLineInput } from '@/types'
import type { CorrectionBusinessEvents } from '../storno-service'

vi.mock('@/lib/core/bookkeeping/storno-target', () => ({
  assertStornoTarget: vi.fn(async (_sb: unknown, _c: unknown, original: { entry_date: string }, date?: string) => date ?? original.entry_date),
}))
vi.mock('@/lib/core/bookkeeping/correction-chain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/bookkeeping/correction-chain')>()),
  correctionChainDepth: vi.fn().mockResolvedValue({ depth: 0, rootVoucher: null }),
}))
vi.mock('@/lib/core/bookkeeping/period-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/bookkeeping/period-service')>()),
  resolvePeriodStatusForDate: vi.fn().mockResolvedValue({ status: 'open', period_id: '00000000-0000-4000-8000-00000000f025', lock_date: null }),
}))

const { correctEntry, recordateEntry } = await import('../storno-service')

const FIXTURE = path.join(__dirname, 'storno-service.engine-input.json')
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const PERIOD = '00000000-0000-4000-8000-00000000f026'
const ORIGINAL = '00000000-0000-4000-8000-0000000e0001'
const STORNO = '00000000-0000-4000-8000-0000000e0002'
const CORRECTED = '00000000-0000-4000-8000-0000000e0003'

const ORIGINAL_LINES = [
  { id: 'l1', account_number: '6110', account_id: 'acc-6110', debit_amount: 400, credit_amount: 0, currency: 'SEK', amount_in_currency: null, exchange_rate: null, line_description: 'Pärmar', tax_code: null, dimensions: { '1': 'BUTIK' }, sort_order: 0 },
  { id: 'l2', account_number: '2641', account_id: 'acc-2641', debit_amount: 100, credit_amount: 0, currency: 'SEK', amount_in_currency: null, exchange_rate: null, line_description: null, tax_code: null, dimensions: {}, sort_order: 1 },
  { id: 'l3', account_number: '1930', account_id: 'acc-1930', debit_amount: 0, credit_amount: 500, currency: 'SEK', amount_in_currency: null, exchange_rate: null, line_description: null, tax_code: null, dimensions: {}, sort_order: 2 },
]

const ORIGINAL_ROW = {
  id: ORIGINAL,
  company_id: COMPANY,
  status: 'posted',
  entry_date: '2026-03-10',
  fiscal_period_id: PERIOD,
  voucher_series: 'A',
  voucher_number: 12,
  description: 'Kontorsmaterial',
  source_type: 'manual',
  source_id: null,
  notes: 'Kvitto i pärmen',
  correction_of_id: null,
  reverses_id: null,
  lines: ORIGINAL_LINES,
}

const CORRECTED_LINES: CreateJournalEntryLineInput[] = [
  { account_number: '5410', debit_amount: 400, credit_amount: 0, line_description: 'Skärm' },
  { account_number: '2641', debit_amount: 100, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: 500 },
]

const CHART = {
  data: ['6110', '2641', '1930', '5410'].map((n) => ({ id: `acc-${n}`, account_number: n })),
}

interface Scenario {
  name: string
  run: (supabase: never, businessEvents?: CorrectionBusinessEvents) => Promise<unknown>
  tables: Record<string, TableMockResult | TableMockResult[]>
}

const draftRow = (id: string) => ({ data: { id, status: 'draft', voucher_number: 0 } })
const finalRow = (id: string) => ({ data: { id, status: 'posted', voucher_number: 13, lines: [] } })

const SCENARIOS: Scenario[] = [
  {
    name: 'correctEntry: new lines and its own text',
    run: (sb, businessEvents) =>
      correctEntry(sb, COMPANY, USER, ORIGINAL, CORRECTED_LINES, {
        description: 'Rättelse: skärm, inte pärmar',
        ...(businessEvents ? { businessEvents } : {}),
      }),
    tables: {
      journal_entries: [{ data: ORIGINAL_ROW }, draftRow(STORNO), draftRow(CORRECTED), { data: [{ id: ORIGINAL }] }, finalRow(STORNO), finalRow(CORRECTED)],
      journal_entry_lines: { data: null },
      chart_of_accounts: CHART,
    },
  },
  {
    name: 'correctEntry: the corrected lines are refused, so both new verifikat are cancelled',
    run: (sb, businessEvents) =>
      businessEvents
        ? correctEntry(sb, COMPANY, USER, ORIGINAL, CORRECTED_LINES, { businessEvents })
        : correctEntry(sb, COMPANY, USER, ORIGINAL, CORRECTED_LINES),
    tables: {
      journal_entries: [{ data: ORIGINAL_ROW }, draftRow(STORNO), draftRow(CORRECTED)],
      journal_entry_lines: [{ data: null }, { error: { message: 'line insert refused', code: '23514' } }],
      chart_of_accounts: CHART,
    },
  },
  {
    name: 'correctEntry: a concurrent storno won, so both new verifikat are cancelled',
    run: (sb, businessEvents) =>
      correctEntry(sb, COMPANY, USER, ORIGINAL, CORRECTED_LINES, { allowDeepChain: true, ...(businessEvents ? { businessEvents } : {}) }),
    tables: {
      journal_entries: [{ data: ORIGINAL_ROW }, draftRow(STORNO), draftRow(CORRECTED), { data: [] }],
      journal_entry_lines: { data: null },
      chart_of_accounts: CHART,
    },
  },
  {
    name: 'recordateEntry: moved to the year before',
    run: (sb, businessEvents) =>
      businessEvents
        ? recordateEntry(sb, COMPANY, USER, ORIGINAL, '2025-03-10', { businessEvents })
        : recordateEntry(sb, COMPANY, USER, ORIGINAL, '2025-03-10'),
    tables: {
      journal_entries: [{ data: ORIGINAL_ROW }, draftRow(STORNO), draftRow(CORRECTED), { data: [{ id: ORIGINAL }] }, finalRow(STORNO), finalRow(CORRECTED)],
      journal_entry_lines: { data: null },
      fiscal_periods: { data: { name: '2025', period_start: '2025-01-01', period_end: '2025-12-31' } },
      chart_of_accounts: CHART,
    },
  },
]

const WRITES = new Set(['insert', 'update', 'delete', 'upsert', 'rpc'])

interface Run {
  name: string
  writes: unknown[]
  /** Every write in order, the event links included, as [table, method, payload]. */
  allWrites: unknown[][]
  outcome: unknown
  links: unknown[]
}

interface RunOptions {
  businessEvents?: CorrectionBusinessEvents
  /** How business_event_entries answers each link insert (the last repeats). */
  linkAnswers?: TableMockResult[]
  only?: string[]
}

async function runScenarios(opts: RunOptions = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const s of SCENARIOS.filter((x) => !opts.only || opts.only.includes(x.name))) {
    const mock = createTableMockSupabase({
      business_event_entries: opts.linkAnswers ?? { data: null },
      'rpc:commit_journal_entry': { data: null },
      'rpc:cancel_orphaned_entry': { data: null },
      'rpc:relink_documents_to_correction': { data: null },
      transactions: { data: null },
      transaction_voucher_links: { data: null },
      ...s.tables,
    })
    let outcome: unknown
    try {
      const result = (await runWithActor({ type: 'user' }, () => s.run(mock.supabase as never, opts.businessEvents))) as {
        reversal?: { id: string }
        corrected?: { id: string }
      }
      outcome = { reversal: result.reversal?.id ?? null, corrected: result.corrected?.id ?? null }
    } catch (err) {
      outcome = { error: (err as Error).name }
    }
    const writes = mock.calls
      .filter((c) => WRITES.has(c.method) && !c.table.startsWith('business_event'))
      .map((c) => [c.table, c.method, c.args[0] ?? null])
    out.push({
      name: s.name,
      writes,
      allWrites: mock.calls.filter((c) => WRITES.has(c.method)).map((c) => [c.table, c.method, c.args[0] ?? null]),
      outcome,
      links: mock.payloads('business_event_entries', 'insert'),
    })
  }
  return out
}

describe('storno service writes (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    eventBus.clear()
  })

  it('writes exactly what it wrote before the port', { timeout: 60_000 }, async () => {
    const runs = await runScenarios()
    const recorded = runs.map(({ name, writes, outcome }) => ({ name, writes, outcome }))
    if (process.env.UPDATE_ENGINE_INPUT_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
    expect(runs.flatMap((r) => r.links)).toEqual([])
  })
  const REVERSAL_EVENT = '00000000-0000-4000-8000-0000000be001'
  const CORRECTION_EVENT = '00000000-0000-4000-8000-0000000be002'
  const links = (onFailure: 'log' | 'abort'): CorrectionBusinessEvents => ({
    reversal: { id: REVERSAL_EVENT, role: 'reversal', onFailure },
    correction: { id: CORRECTION_EVENT, role: 'correction', onFailure },
  })
  const REFUSED = { error: { message: 'business_event_entries refused', code: '42501' } }
  const fixture = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Array<{ name: string; writes: unknown[]; outcome: unknown }>

  it('with the port\'s links writes the same, plus each link right after its draft\'s header', { timeout: 60_000 }, async () => {
    const runs = await runScenarios({ businessEvents: links('log') })
    for (const [i, run] of runs.entries()) {
      expect({ writes: run.writes, outcome: run.outcome }, run.name).toEqual({ writes: fixture()[i]!.writes, outcome: fixture()[i]!.outcome })
      const tables = run.allWrites.map(([table]) => table)
      // storno header, its link, then its lines; the corrected header, its link, then its lines.
      expect(tables.slice(0, 3), run.name).toEqual(['journal_entries', 'business_event_entries', 'journal_entry_lines'])
      const second = tables.indexOf('journal_entries', 1)
      expect(tables.slice(second, second + 3), run.name).toEqual(['journal_entries', 'business_event_entries', 'journal_entry_lines'])
      expect(run.links, run.name).toEqual([
        { business_event_id: REVERSAL_EVENT, journal_entry_id: STORNO, company_id: COMPANY, role: 'reversal' },
        { business_event_id: CORRECTION_EVENT, journal_entry_id: CORRECTED, company_id: COMPANY, role: 'correction' },
      ])
    }
  })

  it('under shadow a refused link is logged and the correction writes exactly what it wrote before', { timeout: 60_000 }, async () => {
    const runs = await runScenarios({ businessEvents: links('log'), linkAnswers: [REFUSED] })
    for (const [i, run] of runs.entries()) {
      expect({ writes: run.writes, outcome: run.outcome }, run.name).toEqual({ writes: fixture()[i]!.writes, outcome: fixture()[i]!.outcome })
    }
  })

  it('under strict a refused storno link cancels the storno draft before any number is drawn', { timeout: 60_000 }, async () => {
    const [run] = await runScenarios({ businessEvents: links('abort'), linkAnswers: [REFUSED], only: ['correctEntry: new lines and its own text'] })
    expect(run!.outcome).toEqual({ error: 'BookkeepingDatabaseError' })
    expect(run!.allWrites.map(([table, method]) => `${table}.${method}`)).toEqual([
      'journal_entries.insert',
      'business_event_entries.insert',
      'rpc:cancel_orphaned_entry.rpc',
    ])
    expect(run!.allWrites[2]![2]).toMatchObject({ p_entry_id: STORNO })
  })

  it('under strict a refused correction link, after the storno is numbered, cancels the corrected draft and the posted storno', { timeout: 60_000 }, async () => {
    const [run] = await runScenarios({
      businessEvents: links('abort'),
      linkAnswers: [{ data: null }, REFUSED],
      only: ['correctEntry: new lines and its own text'],
    })
    expect(run!.outcome).toEqual({ error: 'BookkeepingDatabaseError' })
    expect(run!.allWrites.map(([table, method]) => `${table}.${method}`)).toEqual([
      'journal_entries.insert',
      'business_event_entries.insert',
      'journal_entry_lines.insert',
      'rpc:commit_journal_entry.rpc',
      'journal_entries.insert',
      'business_event_entries.insert',
      'rpc:cancel_orphaned_entry.rpc',
      'rpc:cancel_orphaned_entry.rpc',
    ])
    // The corrected draft first (no number yet), then the storno, which keeps its number as a cancelled verifikat.
    expect(run!.allWrites[6]![2]).toMatchObject({ p_entry_id: CORRECTED })
    expect(run!.allWrites[7]![2]).toMatchObject({ p_entry_id: STORNO })
  })
})
