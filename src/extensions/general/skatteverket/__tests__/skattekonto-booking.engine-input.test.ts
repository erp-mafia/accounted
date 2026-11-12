/**
 * Posting port, step 2b: what the skattekonto booking hands the engine,
 * recorded call by call and compared with a committed fixture
 * (skattekonto-booking.engine-input.json) that was taken before the producer
 * went through the port. A row is drafted (createDraftEntry), claimed on the
 * draft, and in a batch committed (commitEntry); both engine calls are
 * recorded with every argument, an absent one as '<undefined>', so an extra
 * argument or a changed input fails here. The guards that search the ledger
 * (twins, the reconciliation's holding, direct bookings) are stubbed: they
 * have their own tests, and only their answer reaches the input.
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/extensions/general/skatteverket/__tests__/skattekonto-booking.engine-input.test.ts
 *
 * Since the producer drafts and commits through the posting port, the
 * scenarios also run with POSTING_EVENTS=shadow: the draft must get the same
 * four arguments plus only the event link, the commit exactly the same
 * arguments, and a refused event write must still post.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { SkattekontoMatchCandidate } from '../lib/skattekonto-match'

vi.mock('@/lib/skatteverket/skattekonto-account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/skatteverket/skattekonto-account')>()),
  resolveSkattekontoAccount: vi.fn(async () => '1630'),
}))
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  findFiscalPeriod: vi.fn(),
  createDraftEntry: vi.fn(),
  commitEntry: vi.fn(),
}))
vi.mock('../lib/skattekonto-match', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/skattekonto-match')>()),
  findLedgerTwinCandidates: vi.fn(),
  findLedgerTwinCandidatesForIds: vi.fn(),
}))
vi.mock('../lib/skattekonto-direct', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/skattekonto-direct')>()),
  findDirectLedgerHolders: vi.fn(),
  findDirectLedgerHoldersForIds: vi.fn(),
}))
vi.mock('@/lib/bookkeeping/ledger-balance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/ledger-balance')>()),
  sumAccountBalance: vi.fn(),
  findOpeningBalanceFloor: vi.fn(),
}))
vi.mock('@/lib/reconciliation/skattekonto-reconciliation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reconciliation/skattekonto-reconciliation')>()),
  getSkattekontoReconciliationStatus: vi.fn(),
  skattekontoPlannedHolds: vi.fn(),
}))

const { findFiscalPeriod, createDraftEntry, commitEntry } = await import('@/lib/bookkeeping/engine')
const { findOpeningBalanceFloor, sumAccountBalance } = await import('@/lib/bookkeeping/ledger-balance')
const { getSkattekontoReconciliationStatus, skattekontoPlannedHolds } = await import(
  '@/lib/reconciliation/skattekonto-reconciliation'
)
const { findLedgerTwinCandidates, findLedgerTwinCandidatesForIds } = await import('../lib/skattekonto-match')
const { findDirectLedgerHolders, findDirectLedgerHoldersForIds } = await import('../lib/skattekonto-direct')
const { bokforSkattekontoTransaction, bokforSkattekontoTransactionsBatch } = await import('../lib/skattekonto-booking')
const { runInOperationCommit } = await import('@/lib/pending-operations/commit-scope')

const mockedDraft = vi.mocked(createDraftEntry)
const mockedCommit = vi.mocked(commitEntry)

const FIXTURE = path.join(__dirname, 'skattekonto-booking.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const FISCAL_PERIOD = '00000000-0000-4000-8000-00000000f001'

/** The system seeds of supabase/migrations/20260519100000_skattekonto_rules.sql that the scenarios reach. */
const SEED_RULES = [
  { id: 'sys-1', company_id: null, priority: 10, pattern: 'inbetalning bokförd,inbetalning,överföring från bank', amount_min: null, amount_max: null, company_type: 'all', counter_account: '__PRIMARY_SEK__', counter_account_ef: null, label: 'Inbetalning till skattekonto', active: true },
  { id: 'sys-3', company_id: null, priority: 20, pattern: 'debiterad preliminärskatt,preliminärskatt,f-skatt,fskatt', amount_min: null, amount_max: null, company_type: 'all', counter_account: '2510', counter_account_ef: '2012', label: 'Preliminär skatt', active: true },
  { id: 'sys-6', company_id: null, priority: 20, pattern: 'mervärdesskatt,moms,momsdeklaration', amount_min: null, amount_max: null, company_type: 'all', counter_account: '2650', counter_account_ef: null, label: 'Redovisningskonto för moms', active: true },
  { id: 'sys-8', company_id: null, priority: 30, pattern: 'kostnadsränta', amount_min: null, amount_max: null, company_type: 'all', counter_account: '8423', counter_account_ef: null, label: 'Kostnadsränta skattekonto', active: true },
  { id: 'sys-9', company_id: null, priority: 30, pattern: 'intäktsränta', amount_min: null, amount_max: null, company_type: 'all', counter_account: '8314', counter_account_ef: null, label: 'Intäktsränta skattekonto', active: true },
]

interface Row {
  id: string
  transaktionsdatum: string
  transaktionstext: string
  belopp_skatteverket: number
  transaktionsidentitet: number | null
}

interface Scenario {
  name: string
  rows: Row[]
  /** 'batch' drafts and commits every row; 'draft' drafts the first row for review. */
  door: 'batch' | 'draft'
  /** The 1650 receivable a VAT refund clears. */
  vatReceivable?: number
  /** Ledger twins per row id, and the override that books over them. */
  twins?: Record<string, SkattekontoMatchCandidate[]>
  duplicateReason?: string
}

function rowId(scenario: number, row: number): string {
  return `00000000-0000-4000-8000-${String(scenario + 1).padStart(6, '0')}${String(row + 1).padStart(6, '0')}`
}

const SCENARIOS: Scenario[] = [
  {
    name: 'three settled rows booked in one batch',
    door: 'batch',
    rows: [
      { id: rowId(0, 0), transaktionsdatum: '2026-07-12', transaktionstext: 'Debiterad preliminärskatt', belopp_skatteverket: -1000, transaktionsidentitet: 9001 },
      { id: rowId(0, 1), transaktionsdatum: '2026-07-14', transaktionstext: 'Inbetalning bokförd', belopp_skatteverket: 1000, transaktionsidentitet: 9002 },
      { id: rowId(0, 2), transaktionsdatum: '2026-07-31', transaktionstext: 'Kostnadsränta', belopp_skatteverket: -12, transaktionsidentitet: 9003 },
    ],
  },
  {
    name: 'one row drafted for review',
    door: 'draft',
    rows: [{ id: rowId(1, 0), transaktionsdatum: '2026-08-12', transaktionstext: 'Debiterad preliminärskatt', belopp_skatteverket: -1500, transaktionsidentitet: null }],
  },
  {
    name: 'a one-row batch (a person accepting the suggestion)',
    door: 'batch',
    rows: [{ id: rowId(2, 0), transaktionsdatum: '2026-08-20', transaktionstext: 'Intäktsränta', belopp_skatteverket: 3, transaktionsidentitet: 9005 }],
  },
  {
    name: 'a VAT refund that clears 1650 with öresutjämning',
    door: 'batch',
    vatReceivable: 4749.9,
    rows: [{ id: rowId(3, 0), transaktionsdatum: '2026-08-26', transaktionstext: 'Moms juli 2026', belopp_skatteverket: 4750, transaktionsidentitet: 9006 }],
  },
  {
    name: 'a row booked over a ledger twin, with the reason in the notes',
    door: 'batch',
    rows: [{ id: rowId(4, 0), transaktionsdatum: '2026-09-12', transaktionstext: 'Debiterad preliminärskatt', belopp_skatteverket: -1000, transaktionsidentitet: 9007 }],
    twins: {
      [rowId(4, 0)]: [
        {
          journal_entry_id: '00000000-0000-4000-8000-0000000e0001',
          voucher_number: 17,
          voucher_series: 'A',
          entry_date: '2026-09-12',
          description: 'Preliminärskatt september',
          status: 'posted',
          matched_amount: 1000,
          matched_side: 'credit',
        },
      ],
    },
    duplicateReason: 'Skatteverket debiterade två gånger',
  },
]

function record(args: unknown[]): unknown[] {
  return [args.length, ...args.map((a, i) => (i === 0 ? SUPABASE : a === undefined ? '<undefined>' : a))]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface Run {
  name: string
  createDraftEntry: unknown[][]
  commitEntry: unknown[][]
  events: Array<Record<string, unknown>>
}

function hasCall(chain: { method: string; args: unknown[] }[], method: string): boolean {
  return chain.some((c) => c.method === method)
}

async function runScenarios(opts: { refuseEvent?: boolean; operationId?: string } = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, s] of SCENARIOS.entries()) {
    mockedDraft.mockReset()
    mockedCommit.mockReset()
    vi.mocked(findFiscalPeriod).mockResolvedValue(FISCAL_PERIOD)
    let drafted = 0
    mockedDraft.mockImplementation(async (_sb, _c, _u, input) => ({ id: `je-${index}-${drafted++}`, status: 'draft', ...input }) as never)
    mockedCommit.mockImplementation(async (_sb, _c, _u, entryId) => ({ id: entryId, voucher_series: 'A', voucher_number: 40 + index }) as never)
    const twins = s.twins ?? {}
    vi.mocked(findLedgerTwinCandidates).mockImplementation(async (_s, _c, probes) => new Map(probes.map((p) => [p.id, twins[p.id] ?? []])))
    vi.mocked(findLedgerTwinCandidatesForIds).mockImplementation(async (_s, _c, ids) => new Map(ids.map((id) => [id, twins[id] ?? []])))
    vi.mocked(findDirectLedgerHolders).mockImplementation(async (_s, _c, probes) => new Map(probes.map((p) => [p.id, []])))
    vi.mocked(findDirectLedgerHoldersForIds).mockResolvedValue(new Map())
    vi.mocked(findOpeningBalanceFloor).mockResolvedValue(null)
    vi.mocked(sumAccountBalance).mockResolvedValue(s.vatReceivable ?? 0)
    vi.mocked(getSkattekontoReconciliationStatus).mockResolvedValue({ account_number: '1630', ledger_read_failed: false, cover: null } as never)
    vi.mocked(skattekontoPlannedHolds).mockReturnValue(new Map())

    const rows = new Map(s.rows.map((r) => [r.id, { ...r, company_id: COMPANY, status: 'booked', is_ignored: false, journal_entry_id: null }]))
    const { supabase, payloads } = createTableMockSupabase({
      skattekonto_rules: { data: SEED_RULES },
      company_settings: { data: { entity_type: 'aktiebolag', employer_registered: null, pays_salaries: null } },
      cash_accounts: { data: null },
      business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
      // A claim answers the claimed row; a read answers the row the chain asked for.
      skattekonto_transactions: (chain) => {
        const id = chain.find((c) => c.method === 'eq' && c.args[0] === 'id')?.args[1] as string
        return hasCall(chain, 'update') ? { data: [{ id }] } : { data: rows.get(id) ?? null }
      },
    })
    const ids = s.rows.map((r) => r.id)
    const book = async () => {
      if (s.door === 'batch') {
        const result = await bokforSkattekontoTransactionsBatch(supabase as never, COMPANY, USER, ids, {
          ...(s.duplicateReason ? { allowDuplicateIds: ids, duplicateReason: s.duplicateReason } : {}),
        })
        expect(result.summary, `${s.name}: ${JSON.stringify(result.results)}`).toMatchObject({ succeeded: ids.length })
      } else {
        await bokforSkattekontoTransaction(supabase as never, COMPANY, USER, ids[0]!)
      }
    }
    if (opts.operationId) await runInOperationCommit(opts.operationId, book)
    else await book()
    out.push({
      name: s.name,
      createDraftEntry: mockedDraft.mock.calls.map((c) => record(c as unknown[])),
      commitEntry: mockedCommit.mock.calls.map((c) => record(c as unknown[])),
      events: payloads('business_events', 'insert') as Array<Record<string, unknown>>,
    })
  }
  return out
}

describe('skattekonto booking engine input (posting port parity)', () => {
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
  })

  it('with POSTING_EVENTS=shadow drafts with the same four arguments plus only the link, and commits exactly as before', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const shadow = await runScenarios()
    for (const [i, run] of shadow.entries()) {
      const before = off[i]!
      expect(run.createDraftEntry, run.name).toHaveLength(before.createDraftEntry.length)
      for (const [j, call] of run.createDraftEntry.entries()) {
        expect(before.createDraftEntry[j]![0]).toBe(4)
        expect(call[0], run.name).toBe(5)
        expect(call.slice(1, 5), run.name).toEqual(before.createDraftEntry[j]!.slice(1, 5))
        expect(call[5], run.name).toEqual({ businessEvent: { id: expect.stringMatching(UUID), role: 'produced', onFailure: 'log' } })
        expect((call[5] as { businessEvent: { id: string } }).businessEvent.id).toBe(run.events[j]!.id)
      }
      expect(run.commitEntry, run.name).toEqual(before.commitEntry)
      // One event per verifikat.
      expect(run.events, run.name).toHaveLength(run.createDraftEntry.length)
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still posts, with exactly the off calls', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    expect(refused.map((r) => [r.createDraftEntry, r.commitEntry])).toEqual(off.map((r) => [r.createDraftEntry, r.commitEntry]))
    expect(refused.map((r) => r.events.length)).toEqual(refused.map((r) => r.createDraftEntry.length))
  })

  it('records what happened in business terms', async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const events = (name: string) => runs.find((r) => r.name === name)!.events
    expect(events('three settled rows booked in one batch')).toMatchObject([
      { occurred_on: '2026-07-12', amount: 1000, evidence: { direction: 'out' } },
      { occurred_on: '2026-07-14', amount: 1000, evidence: { direction: 'in' } },
      { occurred_on: '2026-07-31', amount: 12, evidence: { direction: 'out' } },
    ])
    for (const event of runs.flatMap((r) => r.events)) {
      expect(event).toMatchObject({
        kind: 'se.tax_account.booked',
        category: 'se.tax.settlement',
        subject_type: null,
        party_type: null,
        currency: 'SEK',
        evidence: { link_basis: 'user_created' },
        pending_operation_id: null,
        jurisdiction: 'SE',
      })
      expect(event.mapping_version).toMatch(/^se\.skattekonto-rules@/)
      expect(event.amount_sek).toBe(event.amount)
    }
    expect(events('a VAT refund that clears 1650 with öresutjämning')[0]).toMatchObject({ amount: 4750, evidence: { direction: 'in' } })
  })

  it('names the staged operation inside its approval', async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const operationId = '00000000-0000-4000-8000-0000000a0b01'
    const runs = await runScenarios({ operationId })
    for (const event of runs.flatMap((r) => r.events)) {
      expect(event).toMatchObject({
        pending_operation_id: operationId,
        evidence: { link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: operationId } },
      })
    }
  })
})
