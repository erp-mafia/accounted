/**
 * Posting port, step 2e: what the inbox book-direct door
 * (POST /items/:id/book-direct, an underlag booked straight to a verifikat on
 * the person's own rows) hands the engine, recorded call by call and
 * compared with a committed fixture (book-direct.engine-input.json) that was
 * taken before the door went through the port. The verifikat is the bank
 * line's when the caller names one, else the inbox item's; when the bank line
 * cannot be pointed at it, or another booking claimed the item first, it is
 * reversed with a storno. Every argument is recorded, an absent one as
 * '<undefined>'; trailing undefined arguments are dropped before the
 * comparison (see
 * src/lib/bookkeeping/__tests__/supplier-payment-entries.engine-input.test.ts).
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/extensions/general/invoice-inbox/__tests__/book-direct.engine-input.test.ts
 *
 * Since the verifikat and the door's stornos post through the posting port,
 * the scenarios also run with POSTING_EVENTS=shadow and strict: the engine
 * must get the same arguments plus only the event link, a refused event
 * write must still book and reverse under shadow, and under strict the door
 * stops before the engine is called.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createTableMockSupabase, testRoutes } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'
import type { CreateJournalEntryInput } from '@/types'

vi.mock('@/lib/suggestion-log/inbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/suggestion-log/inbox')>()),
  snapshotInboxExtraction: vi.fn(async (_supabase: unknown, companyId: string, item: { id: string; document_id?: string | null }) => ({
    companyId,
    inboxItemId: item.id,
    documentId: item.document_id ?? null,
    extraction: null,
    model: null,
  })),
  recordInboxDecision: vi.fn(async () => undefined),
}))
vi.mock('@/lib/suggestion-log/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/suggestion-log/record')>()),
  snapshotSuggestions: vi.fn(async (_supabase: unknown, companyId: string) => ({ companyId, byTransaction: new Map() })),
  recordDecisions: vi.fn(async () => undefined),
}))
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createJournalEntry: vi.fn(),
  reverseEntry: vi.fn(),
}))
vi.mock('@/lib/core/documents/document-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/documents/document-service')>()),
  linkToJournalEntry: vi.fn(async () => ({ id: 'doc' })),
}))
vi.mock('@/lib/transactions/is-booked', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions/is-booked')>()),
  assertTransactionBookable: vi.fn(async () => ({ ok: true })),
}))
vi.mock('@/lib/bookkeeping/settlement-account', () => ({
  resolveSettlementAccount: vi.fn(async () => '1930'),
}))

const { createJournalEntry, reverseEntry } = await import('@/lib/bookkeeping/engine')
const { invoiceInboxExtension } = await import('@/extensions/general/invoice-inbox')

const mockedCreate = vi.mocked(createJournalEntry)
const mockedReverse = vi.mocked(reverseEntry)

const FIXTURE = path.join(__dirname, 'book-direct.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const PERIOD = '00000000-0000-4000-8000-00000000f001'
const CASH_ACCOUNT = '00000000-0000-4000-8000-00000000ca01'

function itemId(index: number): string {
  return `00000000-0000-4000-8000-0000000b${String(index + 1).padStart(4, '0')}`
}

function documentId(index: number): string {
  return `00000000-0000-4000-8000-0000000d${String(index + 1).padStart(4, '0')}`
}

function transactionId(index: number): string {
  return `00000000-0000-4000-8000-0000000a${String(index + 1).padStart(4, '0')}`
}

const RECEIPT_LINES = [
  { account_number: '6540', debit_amount: 79.2, credit_amount: 0 },
  { account_number: '2641', debit_amount: 19.8, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: 99 },
]

interface Scenario {
  name: string
  index: number
  /** The bank row the caller names in the body. */
  bodyTransaction?: boolean
  /** The bank row the item was already matched to. */
  matchedTransaction?: boolean
  notes?: string
  /** The bank line link loses to a concurrent booking. */
  linkLost?: boolean
  /** Another booking claimed the item first. */
  claimLost?: boolean
}

const SCENARIOS: Scenario[] = [
  { name: 'a receipt without a bank row books the inbox item', index: 0, notes: 'Deltagare: Anna, Per. Syfte: kundmöte' },
  { name: 'a receipt booked against the bank row the caller names', index: 1, bodyTransaction: true },
  { name: 'a receipt whose item is already matched to a bank row', index: 2, matchedTransaction: true },
  { name: 'the bank line link loses to a concurrent booking: the verifikat is reversed', index: 3, bodyTransaction: true, linkLost: true },
  { name: 'another booking claimed the item first: the verifikat is reversed', index: 4, claimLost: true },
]

function record(args: unknown[]): unknown[] {
  return [args.length, ...args.map((a, i) => (i === 0 ? SUPABASE : a === undefined ? '<undefined>' : a))]
}

function trimTrailingUndefined(call: unknown[]): unknown[] {
  const args = call.slice(1)
  while (args.length > 0 && args[args.length - 1] === '<undefined>') args.pop()
  return [args.length, ...args]
}

interface Run {
  name: string
  calls: unknown[][]
  reversals: unknown[][]
  outcome: unknown
  events: Array<Record<string, unknown>>
}

interface RunOptions {
  /** The business_events insert refuses (a shadow failure). */
  refuseEvent?: boolean
}

function bookDirect() {
  return testRoutes(invoiceInboxExtension).find((r) => r.method === 'POST' && r.path === '/items/:id/book-direct')!
}

function supabaseFor(s: Scenario, opts: RunOptions) {
  const transaction = {
    id: transactionId(s.index),
    journal_entry_id: null,
    cash_account_id: CASH_ACCOUNT,
    date: '2026-09-20',
    amount: -99,
    currency: 'SEK',
    amount_sek: null,
    exchange_rate: null,
    transaction_voucher_links: [],
  }
  return createTableMockSupabase({
    business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
    invoice_inbox_items: [
      {
        data: {
          id: itemId(s.index),
          document_id: documentId(s.index),
          status: 'received',
          created_supplier_invoice_id: null,
          created_journal_entry_id: null,
          matched_transaction_id: s.matchedTransaction ? transaction.id : null,
          correlation_id: null,
          channel_context: null,
          extracted_data: { totals: { total: 99 }, invoice: { currency: 'SEK' } },
        },
      },
      { data: s.claimLost ? [] : [{ id: itemId(s.index) }] },
    ],
    transactions: [{ data: transaction }, { data: s.linkLost ? [] : [{ id: transaction.id }] }],
  })
}

async function runScenarios(opts: RunOptions = {}): Promise<Run[]> {
  const route = bookDirect()
  const out: Run[] = []
  for (const s of SCENARIOS) {
    mockedCreate.mockReset()
    mockedReverse.mockReset()
    mockedCreate.mockImplementation(async (_sb, _c, _u, input: CreateJournalEntryInput) => ({ id: `je-${s.index}`, ...input }) as never)
    mockedReverse.mockImplementation(async (_sb, _c, _u, entryId: string) => ({ id: `storno-${entryId}`, status: 'posted' }) as never)
    const { supabase, findCalls } = supabaseFor(s, opts)
    const ctx = {
      userId: USER,
      companyId: COMPANY,
      extensionId: 'invoice-inbox',
      supabase,
      emit: vi.fn(),
      settings: { get: vi.fn(), set: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      services: {},
    } as unknown as ExtensionContext
    const body = {
      fiscal_period_id: PERIOD,
      entry_date: '2026-09-20',
      description: 'Kvitto från Spotify',
      lines: RECEIPT_LINES,
      ...(s.bodyTransaction ? { transaction_id: transactionId(s.index) } : {}),
      ...(s.notes ? { notes: s.notes } : {}),
    }
    const response = await route.handler(
      createMockRequest(`/items/${itemId(s.index)}/book-direct`, { method: 'POST', body, searchParams: { _id: itemId(s.index) } }),
      ctx,
    )
    const json = (await response.json()) as { data?: { journal_entry?: { id?: string } }; error?: unknown }
    out.push({
      name: s.name,
      calls: mockedCreate.mock.calls.map((c) => record(c as unknown[])),
      reversals: mockedReverse.mock.calls.map((c) => record(c as unknown[])),
      outcome: {
        status: response.status,
        journal_entry_id: json.data?.journal_entry?.id ?? null,
        error: typeof json.error === 'string' ? json.error : ((json.error as { code?: string } | undefined)?.code ?? null),
      },
      events: findCalls('business_events', 'insert').map((args) => args[0] as Record<string, unknown>),
    })
  }
  return out
}

describe('inbox book-direct engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  it('hands the engine exactly what it handed it before the port', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, calls, reversals, outcome }) => ({
      name,
      calls: calls.map(trimTrailingUndefined),
      reversals,
      outcome,
    }))
    if (process.env.UPDATE_ENGINE_INPUT_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
    expect(runs.flatMap((r) => r.events)).toEqual([])
  })

  it('with POSTING_EVENTS=shadow hands the engine the same arguments, plus only the event link', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const shadow = await runScenarios()
    for (const [i, run] of shadow.entries()) {
      const before = off[i]!
      expect(run.outcome, run.name).toEqual(before.outcome)
      expect(run.calls, run.name).toHaveLength(before.calls.length)
      expect(run.reversals, run.name).toHaveLength(before.reversals.length)
      expect(run.events, run.name).toHaveLength(before.calls.length + before.reversals.length)
      const ids = run.events.map((e) => e.id)
      for (const [j, call] of run.calls.entries()) {
        expect(trimTrailingUndefined(before.calls[j]!)[0], run.name).toBe(4)
        expect(call[0], run.name).toBe(7)
        expect(call.slice(1, 5), run.name).toEqual(before.calls[j]!.slice(1, 5))
        expect(call.slice(5, 7), run.name).toEqual(['<undefined>', '<undefined>'])
        expect(call[7], run.name).toEqual({ businessEvent: { id: ids[0], role: 'produced', onFailure: 'log' } })
      }
      for (const [j, reversal] of run.reversals.entries()) {
        expect(before.reversals[j]![0], run.name).toBe(4)
        expect(reversal[0], run.name).toBe(6)
        expect(reversal.slice(1, 5), run.name).toEqual(before.reversals[j]!.slice(1, 5))
        expect(reversal[5], run.name).toBe('<undefined>')
        expect(reversal[6], run.name).toEqual({ businessEvent: { id: ids[1], role: 'reversal', onFailure: 'log' } })
      }
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still books and reverses, with exactly the off calls', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    const view = (runs: Run[]) => runs.map(({ calls, reversals, outcome }) => ({ calls, reversals, outcome }))
    expect(view(refused)).toEqual(view(off))
  })

  it('with POSTING_EVENTS=strict a refused event write stops the booking before the engine is called', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'strict')
    const refused = await runScenarios({ refuseEvent: true })
    for (const run of refused) {
      expect(run.calls, run.name).toEqual([])
      expect(run.reversals, run.name).toEqual([])
      expect((run.outcome as { status: number }).status, run.name).toBeGreaterThanOrEqual(400)
    }
  })

  it('records what happened in business terms: the kind the source type names', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const events = (name: string) => runs.find((r) => r.name.startsWith(name))!.events
    expect(events('a receipt without a bank row')[0]).toMatchObject({
      kind: 'purchase.document_booked',
      category: null,
      occurred_on: '2026-09-20',
      subject_type: 'inbox_item',
      subject_id: itemId(0),
      party_type: null,
      currency: null,
      amount: null,
      amount_sek: null,
      tax_amounts: [],
      evidence: { document_id: documentId(0), inbox_item_id: itemId(0), link_basis: 'user_created' },
      mapping_version: null,
      jurisdiction: 'SE',
    })
    expect(events('a receipt booked against the bank row the caller names')[0]).toMatchObject({
      kind: 'bank.categorized',
      category: null,
      occurred_on: '2026-09-20',
      subject_type: 'transaction',
      subject_id: transactionId(1),
      currency: 'SEK',
      amount: 99,
      amount_sek: 99,
      evidence: { direction: 'out', document_id: documentId(1), inbox_item_id: itemId(1), link_basis: 'user_created' },
      mapping_version: null,
    })
    // Matched before, but the caller named no bank row: the verifikat is the inbox item's.
    expect(events('a receipt whose item is already matched')[0]).toMatchObject({ kind: 'purchase.document_booked', subject_id: itemId(2) })
    const [linkBooked, linkStorno] = events('the bank line link loses')
    expect(linkBooked).toMatchObject({ kind: 'bank.categorized', subject_id: transactionId(3) })
    expect(linkStorno).toMatchObject({ kind: 'ledger.storno', subject_type: 'transaction', subject_id: transactionId(3), evidence: { link_basis: 'system_derived' } })
    const [claimBooked, claimStorno] = events('another booking claimed the item first')
    expect(claimBooked).toMatchObject({ kind: 'purchase.document_booked', subject_id: itemId(4) })
    expect(claimStorno).toMatchObject({ kind: 'ledger.storno', subject_type: 'inbox_item', subject_id: itemId(4), evidence: { link_basis: 'system_derived' } })
  })
})
