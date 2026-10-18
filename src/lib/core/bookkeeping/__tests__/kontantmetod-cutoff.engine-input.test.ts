/**
 * Posting port, step 2g: what postKontantmetodCutoff hands the engine,
 * recorded call by call and compared with a committed fixture
 * (kontantmetod-cutoff.engine-input.json) that was taken before the producer
 * went through the port: one carry verifikat per invoice open at the year
 * end (#3440, årsomföring per invoice, no vändning), the storno of a carry
 * that could not be linked, and the correction (correctEntry) of a cash
 * verifikat booked before the cut-off. Every argument of createJournalEntry,
 * reverseEntry and correctEntry is recorded, an absent one as '<undefined>',
 * so an extra argument or a changed input fails here, and so does a changed
 * order of the calls.
 *
 * Regenerate only on purpose, from the code before the move (the per-invoice
 * cut-off calling createJournalEntry and reverseEntry itself, 7f9db962e):
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/core/bookkeeping/__tests__/kontantmetod-cutoff.engine-input.test.ts -t 'exactly what'
 *
 * Since the producer posts through the posting port, the scenarios also run
 * with POSTING_EVENTS=shadow, with the link basis its only door (the staged
 * operation's executor) hands down: the engine must get the same arguments
 * plus only the event link, one event per carry and per storno, and a
 * refused event write must still post. The correction stays on correctEntry
 * (storno-service), which records no event. Trailing undefined arguments (the
 * ledger adapter's commitMethod and rubricVersion positions) are dropped
 * before the comparison with the fixture, nothing else.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { CreateJournalEntryInput, CreateJournalEntryLineInput } from '@/types'
import type { KontantmetodCarryPlan, PaidBeforePosting } from '../kontantmetod-cutoff'

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createJournalEntry: vi.fn(),
  reverseEntry: vi.fn(),
}))

vi.mock('@/lib/core/bookkeeping/storno-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/bookkeeping/storno-service')>()),
  correctEntry: vi.fn(),
}))

// The carry's underlag anchoring (best-effort, never throws, no verifikat):
// its own query shape is pinned by lib/core/documents/__tests__.
vi.mock('@/lib/core/documents/customer-invoice-underlag', () => ({ anchorCustomerInvoiceDocument: vi.fn() }))
vi.mock('@/lib/core/documents/supplier-invoice-underlag', () => ({ anchorSupplierInvoiceDocument: vi.fn() }))

const { createJournalEntry, reverseEntry } = await import('@/lib/bookkeeping/engine')
const { correctEntry } = await import('@/lib/core/bookkeeping/storno-service')
const { postKontantmetodCutoff, KontantmetodCutoffPartialError, kontantmetodCarryDescription } = await import(
  '../kontantmetod-cutoff'
)

const mockedCreate = vi.mocked(createJournalEntry)
const mockedReverse = vi.mocked(reverseEntry)
const mockedCorrect = vi.mocked(correctEntry)

const FIXTURE = path.join(__dirname, 'kontantmetod-cutoff.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const PERIOD = '00000000-0000-4000-8000-00000000f001'
const OPERATION = '00000000-0000-4000-8000-0000000c0001'
/** What the staged executor hands down: the approval being committed. */
const STAGED = { link_basis: 'agent_proposed_user_approved' as const, link_evidence: { pending_operation_id: OPERATION } }

type Chain = Array<{ method: string; args: unknown[] }>

const dr = (account_number: string, amount: number, extra: Partial<CreateJournalEntryLineInput> = {}): CreateJournalEntryLineInput =>
  ({ account_number, debit_amount: amount, credit_amount: 0, ...extra })
const cr = (account_number: string, amount: number, extra: Partial<CreateJournalEntryLineInput> = {}): CreateJournalEntryLineInput =>
  ({ account_number, debit_amount: 0, credit_amount: amount, ...extra })

function carry(
  side: 'customer' | 'supplier',
  invoiceId: string,
  reference: string,
  lines: CreateJournalEntryLineInput[],
  total: number,
  over: Partial<KontantmetodCarryPlan> = {},
): KontantmetodCarryPlan {
  const creditNote = over.creditNote ?? false
  return {
    side,
    invoiceId,
    reference,
    creditNote,
    mode: 'full',
    description: kontantmetodCarryDescription(side, reference, creditNote),
    notes: `Årsomföring kontantmetoden, BFL 5 kap 2 §, faktura ${reference}`,
    lines,
    total,
    ...over,
  }
}

/** A customer invoice at 25 % and 12 %, as the registration builder books it. */
const CUSTOMER = carry('customer', 'inv-1', 'F-10', [
  dr('1510', 13620, { line_description: 'Kundfaktura F-10' }),
  cr('3001', 10000),
  cr('3002', 1000),
  cr('2611', 2500, { line_description: 'Utgående moms 25%' }),
  cr('2621', 120, { line_description: 'Utgående moms 12%' }),
], 13620)

/** A kreditfaktura still unsettled at the year end: the registration mirrored. */
const CUSTOMER_CREDIT = carry('customer', 'inv-2', 'F-11', [
  cr('1510', 625),
  dr('3001', 500),
  dr('2611', 125),
], 625, { creditNote: true })

/** A domestic supplier invoice: cost, ingående moms on 2641, the skuld on 2440. */
const SUPPLIER = carry('supplier', 'si-1', 'L-1', [
  dr('4010', 2000),
  dr('2641', 500, { line_description: 'Ingående moms 25% Leverantörsfaktura L-1' }),
  cr('2440', 2500),
], 2500)

/** An EU service bought under omvänd skattskyldighet: the self-assessed pair stays in the lines. */
const SUPPLIER_REVERSE_CHARGE = carry('supplier', 'si-2', 'L-2', [
  dr('6540', 1000),
  cr('2440', 1000),
  dr('4535', 1000),
  cr('4598', 1000),
  dr('2645', 250),
  cr('2614', 250),
], 1000)

/** A ROT invoice partly settled at the year end: lines the accountant wrote (manual_carries). */
const MANUAL = carry('customer', 'inv-3', 'F-12', [
  dr('1510', 2500),
  dr('1513', 2500),
  cr('3001', 4000),
  cr('2611', 1000),
], 2500, {
  mode: 'manual',
  notes: 'Manuell årsomföring kontantmetoden, BFL 5 kap 2 §, faktura F-12',
})

/** The kontantmetod cash verifikat E of CUSTOMER, booked in the new year before the cut-off. */
const CASH_ENTRY = {
  id: 'je-cash',
  company_id: COMPANY,
  status: 'posted',
  entry_date: '2026-01-14',
  description: 'Kontantbetalning F-10',
  lines: [dr('1930', 13620), cr('3001', 10000), cr('3002', 1000), cr('2611', 2500), cr('2621', 120)],
}

const PAID_BEFORE_POSTING: PaidBeforePosting = {
  side: 'customer',
  invoiceId: 'inv-1',
  reference: 'F-10',
  entryId: 'je-cash',
  entryDate: '2026-01-14',
  paymentRowId: 'pay-1',
  paymentAmount: 13620,
  carryEntryId: null,
}

type LinkAnswer = { data: unknown; error: unknown }
const LINKED: LinkAnswer = { data: { ok: true }, error: null }
const ALREADY_LINKED: LinkAnswer = { data: { ok: false, code: 'CUTOFF_INVOICE_ALREADY_LINKED' }, error: null }

interface Scenario {
  name: string
  plans: KontantmetodCarryPlan[]
  paidBeforePosting?: PaidBeforePosting[]
  /** What record_kontantmetod_cutoff_link answers, call by call (linked when the list runs out). */
  links?: LinkAnswer[]
  /** A carry description whose posting the engine refuses. */
  refusePosting?: string
  /** The compensating storno is refused too. */
  refuseStorno?: boolean
  /** The scenario ends in KontantmetodCutoffPartialError. */
  partial?: boolean
}

const SCENARIOS: Scenario[] = [
  {
    name: 'every invoice open at the year end carried by its own verifikat on period end, each linked',
    plans: [CUSTOMER, CUSTOMER_CREDIT, SUPPLIER, SUPPLIER_REVERSE_CHARGE],
  },
  {
    name: 'a manual carry: the accountant\'s lines, posted and linked like any carry',
    plans: [MANUAL],
  },
  {
    name: 'a carry linked meanwhile: stornoed on the year end, the next carry stands',
    plans: [CUSTOMER, SUPPLIER],
    links: [ALREADY_LINKED, LINKED],
  },
  {
    name: 'a carry neither linked nor stornoed: the run stops, naming what posted',
    plans: [CUSTOMER, SUPPLIER, SUPPLIER_REVERSE_CHARGE],
    links: [LINKED, ALREADY_LINKED],
    refuseStorno: true,
    partial: true,
  },
  {
    name: 'a carry refused by the engine mid-run: what posted stands and is reported',
    plans: [CUSTOMER, SUPPLIER],
    refusePosting: SUPPLIER.description,
    partial: true,
  },
  {
    name: 'a cash verifikat booked before the cut-off corrected after its carry, on its own date',
    plans: [CUSTOMER],
    paidBeforePosting: [PAID_BEFORE_POSTING],
  },
]

function record(args: unknown[]): unknown[] {
  return [args.length, ...args.map((a, i) => (i === 0 ? SUPABASE : a === undefined ? '<undefined>' : a))]
}

/** A recorded call without its trailing undefined arguments (see the header). */
function trimTrailingUndefined(call: unknown[]): unknown[] {
  const args = call.slice(1)
  while (args.length > 0 && args[args.length - 1] === '<undefined>') args.pop()
  return [args.length, ...args]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A shadow call without its event link, trimmed as the off call is, and the link it carried. */
function splitLink(call: unknown[]): { call: unknown[]; link: unknown } {
  const args = call.slice(1)
  const last = args[args.length - 1]
  if (last && typeof last === 'object' && 'businessEvent' in last) {
    const { businessEvent, ...rest } = last as Record<string, unknown>
    args[args.length - 1] = Object.keys(rest).length > 0 ? rest : '<undefined>'
    return { call: trimTrailingUndefined([args.length, ...args]), link: businessEvent }
  }
  return { call: trimTrailingUndefined(call), link: undefined }
}

interface Run {
  name: string
  /** Every call in order: ['createJournalEntry' | 'reverseEntry' | 'correctEntry', ...args]. */
  calls: unknown[][]
  events: Array<Record<string, unknown>>
}

async function runScenarios(opts: { refuseEvent?: boolean } = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const s of SCENARIOS) {
    mockedCreate.mockReset()
    mockedReverse.mockReset()
    mockedCorrect.mockReset()
    const calls: unknown[][] = []
    let n = 0
    mockedCreate.mockImplementation(async (...args: unknown[]) => {
      calls.push(['createJournalEntry', ...record(args)])
      const input = args[3] as CreateJournalEntryInput
      if (input.description === s.refusePosting) throw new Error('pg: posting refused')
      n++
      return { id: `je-${n}`, voucher_series: 'A', voucher_number: n, entry_date: input.entry_date } as never
    })
    mockedReverse.mockImplementation(async (...args: unknown[]) => {
      calls.push(['reverseEntry', ...record(args)])
      if (s.refuseStorno) throw new Error('pg: storno refused')
      n++
      return { id: `je-${n}`, voucher_series: 'A', voucher_number: n } as never
    })
    mockedCorrect.mockImplementation(async (...args: unknown[]) => {
      calls.push(['correctEntry', ...record(args)])
      return { reversal: { id: 'je-storno-e' }, corrected: { id: 'je-rattelse-e' } } as never
    })
    const links = [...(s.links ?? [])]
    const { supabase, payloads } = createTableMockSupabase({
      'rpc:record_kontantmetod_cutoff_link': () => links.shift() ?? LINKED,
      journal_entries: (chain: Chain) => {
        // The cash verifikat E (maybeSingle), else the carries it is corrected against.
        if (chain.some((c) => c.method === 'maybeSingle')) return { data: CASH_ENTRY }
        const ids = (chain.find((c) => c.method === 'in')?.args[1] as string[] | undefined) ?? []
        return {
          data: ids.map((id) => ({
            id,
            status: 'posted',
            entry_date: '2025-12-31',
            voucher_series: 'A',
            voucher_number: Number(id.replace('je-', '')),
            lines: CUSTOMER.lines,
          })),
        }
      },
      business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
    })
    const posting = postKontantmetodCutoff(supabase as never, COMPANY, USER, {
      fiscalPeriodId: PERIOD,
      periodEnd: '2025-12-31',
      plans: s.plans,
      paidBeforePosting: s.paidBeforePosting,
      posting: () => ({ linkBasis: STAGED }),
    })
    if (s.partial) {
      await expect(posting, s.name).rejects.toBeInstanceOf(KontantmetodCutoffPartialError)
    } else {
      const result = await posting
      expect(result.posted.length + result.compensated.length, s.name).toBe(s.plans.length)
      expect(result.corrected.length, s.name).toBe(s.paidBeforePosting?.length ?? 0)
    }
    out.push({ name: s.name, calls, events: payloads('business_events', 'insert') as Array<Record<string, unknown>> })
  }
  return out
}

describe('postKontantmetodCutoff engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  it('hands the engine exactly what it handed it before the port', async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, calls }) => ({
      name,
      calls: calls.map(([fn, ...call]) => [fn, ...trimTrailingUndefined(call)]),
    }))
    if (process.env.UPDATE_ENGINE_INPUT_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
    expect(runs.flatMap((r) => r.events)).toEqual([])
  })

  it('with POSTING_EVENTS=shadow hands the engine the same arguments, plus only the event link', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const shadow = await runScenarios()
    for (const [i, run] of shadow.entries()) {
      expect(run.calls.map(([fn]) => fn), run.name).toEqual(off[i]!.calls.map(([fn]) => fn))
      const links = run.calls.flatMap(([fn, ...call], j) => {
        const { call: bare, link } = splitLink(call)
        const [, ...offCall] = off[i]!.calls[j]!
        expect(bare, `${run.name} #${j}`).toEqual(trimTrailingUndefined(offCall))
        if (fn === 'correctEntry') {
          // storno-service, not the port: no event and no link.
          expect(link, `${run.name} #${j}`).toBeUndefined()
          return []
        }
        expect(link, `${run.name} #${j}`).toEqual({
          id: expect.stringMatching(UUID),
          role: fn === 'reverseEntry' ? 'reversal' : 'produced',
          onFailure: 'log',
        })
        return [(link as { id: string }).id]
      })
      // One event per carry and per storno, each recorded before its call.
      expect(new Set(links).size, run.name).toBe(links.length)
      expect(run.events.map((e) => e.id), run.name).toEqual(links)
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still posts, with exactly the off call', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    expect(refused.map((r) => r.calls)).toEqual(off.map((r) => r.calls))
    expect(refused.map((r) => r.events.length)).toEqual(
      off.map((r) => r.calls.filter(([fn]) => fn !== 'correctEntry').length),
    )
  })

  it('records what happened in business terms', async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const staged = {
      evidence: { link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: OPERATION } },
      pending_operation_id: OPERATION,
    }
    const [customer, credit, supplier, reverseCharge] = runs[0]!.events
    // One year_end.closing per invoice carried, on the year's last day: the
    // 1510 leg and the utgående moms per treatment the carry books.
    expect(customer).toMatchObject({
      kind: 'year_end.closing',
      category: null,
      occurred_on: '2025-12-31',
      subject_type: 'fiscal_period',
      subject_id: PERIOD,
      party_type: null,
      currency: 'SEK',
      amount: 13620,
      amount_sek: 13620,
      tax_amounts: [
        { tax: 'vat', treatment: 'standard_25', amount_sek: 2500 },
        { tax: 'vat', treatment: 'reduced_12', amount_sek: 120 },
      ],
      jurisdiction: 'SE',
      ...staged,
    })
    expect(customer!.mapping_version).toMatch(/^se\.kontantmetod-cutoff@/)
    // A kreditfaktura's carry states the moms it takes back, as a magnitude.
    expect(credit).toMatchObject({ amount: 625, tax_amounts: [{ tax: 'vat', treatment: 'standard_25', amount_sek: 125 }] })
    // A supplier carry: the skuld, its ingående moms with no treatment; a reverse-charge pair states none.
    expect(supplier).toMatchObject({ amount: 2500, tax_amounts: [{ tax: 'vat', treatment: null, amount_sek: 500 }] })
    expect(reverseCharge).toMatchObject({ amount: 1000, tax_amounts: [] })
    // No vändning: nothing is dated the next year's first day.
    expect(runs.flatMap((r) => r.events).filter((e) => e.occurred_on === '2026-01-01')).toEqual([])

    // A manual carry's lines are the accountant's: no rule version.
    const [manual] = runs[1]!.events
    expect(manual).toMatchObject({
      kind: 'year_end.closing',
      amount: 2500,
      tax_amounts: [{ tax: 'vat', treatment: 'standard_25', amount_sek: 1000 }],
      mapping_version: null,
    })

    // A storno the writer makes of its own carry: system_derived, naming the approval, dated the day.
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date())
    const stornos = runs.flatMap((r) => r.events.filter((e) => e.kind === 'ledger.storno'))
    expect(stornos).toHaveLength(2)
    for (const storno of stornos) {
      expect(storno).toMatchObject({
        occurred_on: today,
        subject_type: 'fiscal_period',
        subject_id: PERIOD,
        amount: null,
        currency: null,
        mapping_version: null,
        evidence: { link_basis: 'system_derived', link_evidence: { pending_operation_id: OPERATION } },
        pending_operation_id: OPERATION,
      })
    }

    // The correction of E records nothing: one event, the carry's.
    expect(runs[5]!.events.map((e) => e.kind)).toEqual(['year_end.closing'])
  })
})
