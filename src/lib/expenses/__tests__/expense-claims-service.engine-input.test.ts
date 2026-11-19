/**
 * Posting port, step 2: what the expense claim producer hands the engine,
 * recorded call by call and compared with a committed fixture
 * (expense-claims-service.engine-input.json) that was taken before the
 * producer went through the port. Registration's createJournalEntry and the
 * claim removal's reverseEntry are recorded; every argument is recorded, an
 * absent one as '<undefined>', so an extra argument or a changed input fails
 * here.
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/expenses/__tests__/expense-claims-service.engine-input.test.ts
 *
 * Since the producer posts through the posting port, the scenarios also run
 * with POSTING_EVENTS=shadow: the engine must get the same arguments plus
 * only the event link, and a refused event write must still post. The
 * ledger adapter fills createJournalEntry's commitMethod and rubricVersion
 * positions (the pilot's six-argument call), which this producer's
 * four-argument call receives as undefined, the value its omitted optional
 * parameters had: trailing undefined arguments of createJournalEntry are
 * dropped before the comparison with the fixture, nothing else.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { CreateJournalEntryInput } from '@/types'

// The engine calls the producer makes are recorded; everything else in the
// engine stays real.
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  findFiscalPeriod: vi.fn(),
  createJournalEntry: vi.fn(),
  reverseEntry: vi.fn(),
}))
vi.mock('@/lib/core/documents/document-service', () => ({ linkToJournalEntry: vi.fn() }))
vi.mock('@/lib/currency/riksbanken', () => ({ fetchExchangeRate: vi.fn() }))
vi.mock('@/lib/salary/expense-claim-lines', () => ({ findPayslipLineForClaim: vi.fn(async () => null) }))

const { createJournalEntry, findFiscalPeriod, reverseEntry } = await import('@/lib/bookkeeping/engine')
const { registerExpenseClaim, deleteExpenseClaim } = await import('../expense-claims-service')
type RegisterInput = Parameters<typeof registerExpenseClaim>[3]

const mockedCreate = vi.mocked(createJournalEntry)
const mockedReverse = vi.mocked(reverseEntry)
const mockedFindPeriod = vi.mocked(findFiscalPeriod)

const FIXTURE = path.join(__dirname, 'expense-claims-service.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const EMPLOYEE = '00000000-0000-4000-8000-00000000e001'
const DOCUMENT = '00000000-0000-4000-8000-00000000d001'
const INBOX_ITEM = '00000000-0000-4000-8000-00000000b001'

/** A stable UUID per scenario: the claim row's id. */
function claimId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
}

interface RegisterScenario {
  name: string
  entityType?: string
  input: RegisterInput
}

const REGISTER: RegisterScenario[] = [
  {
    name: 'owner claim in SEK with ingående moms (aktiebolag)',
    input: {
      description: 'USB-hubb',
      expense_date: '2026-09-01',
      amount: 500,
      vat_amount: 100,
      currency: 'SEK',
      expense_account: '5410',
      claimant_name: 'Joakim Hansson',
    },
  },
  {
    name: 'owner claim of an enskild firma (egen insättning)',
    entityType: 'enskild_firma',
    input: {
      description: 'Pärmar',
      expense_date: '2026-09-02',
      amount: 125,
      vat_amount: 25,
      currency: 'SEK',
      expense_account: '6110',
      claimant_name: 'Ägaren',
    },
  },
  {
    name: 'employee claim with a project tag, underlag and inbox item',
    input: {
      description: 'Tågbiljett',
      expense_date: '2026-09-03',
      amount: 265,
      vat_amount: 15,
      currency: 'SEK',
      expense_account: '5810',
      employee_id: EMPLOYEE,
      document_id: DOCUMENT,
      inbox_item_id: INBOX_ITEM,
      dimensions: { '6': 'P100' },
    },
  },
  {
    name: 'foreign currency claim at an explicit rate',
    input: {
      description: 'Konferensavgift',
      expense_date: '2026-09-04',
      amount: 100,
      vat_amount: 0,
      currency: 'EUR',
      exchange_rate: 11.25,
      expense_account: '6990',
      claimant_name: 'Joakim Hansson',
    },
  },
  {
    name: 'service bought abroad under reverse charge',
    input: {
      description: 'Molntjänst',
      expense_date: '2026-09-05',
      amount: 800,
      vat_amount: 0,
      currency: 'SEK',
      expense_account: '6540',
      claimant_name: 'Joakim Hansson',
      reverse_charge: 'eu_services',
    },
  },
  {
    name: 'custom lines from the advanced booking step',
    input: {
      description: 'Lunch med kund',
      expense_date: '2026-09-06',
      amount: 560,
      vat_amount: 0,
      currency: 'SEK',
      expense_account: '6071',
      claimant_name: 'Joakim Hansson',
      lines: [
        { account_number: '6071', debit_amount: 500, credit_amount: 0, line_description: 'Representation' },
        { account_number: '2641', debit_amount: 60, credit_amount: 0, line_description: 'Moms' },
        { account_number: '2893', debit_amount: 0, credit_amount: 560 },
      ],
    },
  },
]

interface DeleteScenario {
  name: string
  /** The claim's own back-link; null drives the lookup through journal_entries.source_id. */
  journalEntryId: string | null
}

const DELETE: DeleteScenario[] = [
  { name: 'registered claim with its back-link: storno of its verifikat', journalEntryId: '00000000-0000-4000-8000-0000000fe001' },
  { name: 'registered claim whose back-link write failed: storno of the verifikat naming it', journalEntryId: null },
]

const SOURCED_ENTRY = '00000000-0000-4000-8000-0000000fe002'

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

interface Run {
  name: string
  calls: unknown[][]
  events: Array<Record<string, unknown>>
}

interface RunOptions {
  /** The business_events insert refuses (a shadow failure). */
  refuseEvent?: boolean
}

function eventTable(opts: RunOptions) {
  return opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null }
}

function registerMock(index: number, scenario: RegisterScenario, opts: RunOptions = {}) {
  return createTableMockSupabase({
    business_events: eventTable(opts),
    companies: { data: { entity_type: scenario.entityType ?? 'aktiebolag' } },
    employees: { data: { id: EMPLOYEE, first_name: 'Sofie', last_name: 'Persson' } },
    chart_of_accounts: { data: { default_vat_treatment: null, default_vat_rate: null } },
    invoice_inbox_items: (calls) =>
      calls.some((c) => c.method === 'update')
        ? { data: [{ id: INBOX_ITEM }] }
        : { data: { created_journal_entry_id: null, created_supplier_invoice_id: null } },
    expense_claims: (calls) =>
      calls.some((c) => c.method === 'insert')
        ? { data: { id: claimId(index), status: 'registered', journal_entry_id: null } }
        : { data: null },
    document_attachments: { data: { journal_entry_id: null } },
  })
}

function deleteMock(index: number, scenario: DeleteScenario, opts: RunOptions = {}) {
  return createTableMockSupabase({
    business_events: eventTable(opts),
    expense_claims: (calls) =>
      calls.some((c) => c.method === 'delete')
        ? { data: null }
        : { data: { id: claimId(index), status: 'registered', journal_entry_id: scenario.journalEntryId } },
    journal_entries: (calls) => {
      const select = calls.find((c) => c.method === 'select')?.args[0]
      return select === 'id' ? { data: { id: SOURCED_ENTRY } } : { data: { status: 'posted', reversed_by_id: null } }
    },
  })
}

async function runRegister(opts: RunOptions = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, s] of REGISTER.entries()) {
    mockedCreate.mockClear()
    mockedFindPeriod.mockResolvedValueOnce('00000000-0000-4000-8000-00000000f001')
    mockedCreate.mockImplementation(async (_sb, _c, _u, input: CreateJournalEntryInput) => ({ id: `je-${index}`, ...input }) as never)
    const { supabase, findCalls } = registerMock(index, s, opts)
    const result = await registerExpenseClaim(supabase as never, COMPANY, USER, s.input)
    expect(result.ok, `${s.name}: ${JSON.stringify(result)}`).toBe(true)
    out.push({
      name: s.name,
      calls: mockedCreate.mock.calls.map((c) => record(c as unknown[])),
      events: findCalls('business_events', 'insert').map((args) => args[0] as Record<string, unknown>),
    })
  }
  return out
}

async function runDelete(opts: RunOptions = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, s] of DELETE.entries()) {
    mockedReverse.mockClear()
    mockedReverse.mockResolvedValue({ id: 'je-storno' } as never)
    const { supabase, findCalls } = deleteMock(index, s, opts)
    const result = await deleteExpenseClaim(supabase as never, COMPANY, USER, claimId(index))
    expect(result, s.name).toEqual({ ok: true, reversal_entry_id: 'je-storno' })
    out.push({
      name: s.name,
      calls: mockedReverse.mock.calls.map((c) => record(c as unknown[])),
      events: findCalls('business_events', 'insert').map((args) => args[0] as Record<string, unknown>),
    })
  }
  return out
}

describe('expense claims engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  it('hands the engine exactly what it handed it before the port', async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const register = await runRegister()
    const remove = await runDelete()
    const recorded = {
      createJournalEntry: register.map(({ name, calls }) => ({ name, calls: calls.map(trimTrailingUndefined) })),
      reverseEntry: remove.map(({ name, calls }) => ({ name, calls })),
    }
    if (process.env.UPDATE_ENGINE_INPUT_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
    expect([...register, ...remove].flatMap((r) => r.events)).toEqual([])
  })

  it('with POSTING_EVENTS=shadow hands the engine the same arguments, plus only the event link', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const offRegister = await runRegister()
    const offRemove = await runDelete()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const register = await runRegister()
    const remove = await runDelete()

    for (const [i, run] of register.entries()) {
      const before = offRegister[i]!.calls[0]!
      const call = run.calls[0]!
      expect(run.calls, run.name).toHaveLength(1)
      expect(call[0], run.name).toBe(7)
      expect(call.slice(1, 5), run.name).toEqual(before.slice(1, 5))
      // The adapter's commitMethod and rubricVersion positions, undefined as before.
      expect(call.slice(5, 7), run.name).toEqual(['<undefined>', '<undefined>'])
      expect(call[7], run.name).toEqual({ businessEvent: { id: expect.stringMatching(UUID), role: 'produced', onFailure: 'log' } })
      expect(run.events, run.name).toHaveLength(1)
      expect((call[7] as { businessEvent: { id: string } }).businessEvent.id).toBe(run.events[0]!.id)
    }
    for (const [i, run] of remove.entries()) {
      const before = offRemove[i]!.calls[0]!
      const call = run.calls[0]!
      expect(before[0]).toBe(4)
      expect(call[0], run.name).toBe(6)
      expect(call.slice(1, 5), run.name).toEqual(before.slice(1, 5))
      expect(call[5], run.name).toBe('<undefined>')
      expect(call[6], run.name).toEqual({ businessEvent: { id: expect.stringMatching(UUID), role: 'reversal', onFailure: 'log' } })
      expect(run.events, run.name).toHaveLength(1)
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still posts, with exactly the off call', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const offRegister = await runRegister()
    const offRemove = await runDelete()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const register = await runRegister({ refuseEvent: true })
    const remove = await runDelete({ refuseEvent: true })
    expect(register.map((r) => r.calls)).toEqual(offRegister.map((r) => r.calls))
    expect(remove.map((r) => r.calls)).toEqual(offRemove.map((r) => r.calls))
    // The write was tried once per posting, and refused.
    expect([...register, ...remove].map((r) => r.events.length)).toEqual([...register, ...remove].map(() => 1))
  })

  it('records what happened in business terms', async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const register = await runRegister()
    const remove = await runDelete()
    const event = (name: string) => [...register, ...remove].find((r) => r.name === name)!.events[0]!

    expect(event('owner claim in SEK with ingående moms (aktiebolag)')).toMatchObject({
      kind: 'expense.claimed',
      category: null,
      occurred_on: '2026-09-01',
      subject_type: 'expense_claim',
      subject_id: claimId(0),
      party_type: null,
      party_id: null,
      currency: 'SEK',
      amount: 500,
      amount_sek: 500,
      tax_amounts: [{ tax: 'vat', treatment: null, amount_sek: 100 }],
      evidence: { link_basis: 'user_created' },
      pending_operation_id: null,
      jurisdiction: 'SE',
    })
    expect(event('owner claim in SEK with ingående moms (aktiebolag)').mapping_version).toMatch(/^se\.expense-claim@/)
    expect(event('employee claim with a project tag, underlag and inbox item')).toMatchObject({
      party_type: 'employee',
      party_id: EMPLOYEE,
      evidence: { document_id: DOCUMENT, inbox_item_id: INBOX_ITEM, link_basis: 'user_created' },
    })
    expect(event('foreign currency claim at an explicit rate')).toMatchObject({
      currency: 'EUR',
      amount: 100,
      amount_sek: 1125,
      tax_amounts: [],
    })
    expect(event('service bought abroad under reverse charge')).toMatchObject({ amount_sek: 800, tax_amounts: [] })
    // A person's own lines: no automatic kontering made them.
    expect(event('custom lines from the advanced booking step')).toMatchObject({
      mapping_version: null,
      tax_amounts: [{ tax: 'vat', amount_sek: 60 }],
    })
    expect(event('registered claim with its back-link: storno of its verifikat')).toMatchObject({
      kind: 'ledger.storno',
      subject_type: 'expense_claim',
      subject_id: claimId(0),
      amount: null,
      evidence: { link_basis: 'user_created' },
    })
    expect(event('registered claim with its back-link: storno of its verifikat').occurred_on).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
