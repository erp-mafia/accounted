/**
 * accounted#211: the recurring cron and "Skapa faktura nu" on one schedule,
 * with the real service between them, never bill a period twice and never
 * leave one unbilled with nobody told.
 *
 * One schedule, its invoices and the mails sent live in memory, served
 * through createTableMockSupabase resolvers. Every statement is matched on
 * its filters and applied as Postgres would apply it, and a test can cut any
 * of them: fail without landing (the database is
 * down) or land with its answer lost (a reset connection or a gateway timeout
 * after the commit; postgrest-js answers both as an error and retries no
 * POST). The cron route, the run-now route and executeRecurringSchedule are
 * the real ones; only the far end of the send (number, PDF, booking, mail) is
 * stood in for. Each invoice names the period it bills: the schedule's notes
 * are "{periodstart}".
 *
 * route-held-runs.test.ts cuts the cron at each of its own steps, kills
 * included, against the service's pinned contract. This file adds the cuts of
 * #211: a claim taken from a token read before the cron's record, a header
 * insert whose answer is lost, and a record whose answer is lost on a
 * schedule that sends. After the cut the cron runs again later the same day,
 * the next day and the day after.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createTableMockSupabase, makeCompanySettings, makeCustomer } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

type Row = Record<string, unknown>
type Call = { method: string; args: unknown[] }
type Answer = { data: unknown; error: unknown }
/**
 * What happens to a statement: it lands, fails without landing ('down'), is
 * refused by the database itself ('refused'), or lands with its answer lost
 * ('lost'), answered as a PostgREST client error ('pgrst001': the connection
 * was lost mid-command) or as a duplicate of its own key ('dup': a replayed
 * POST whose first delivery committed).
 */
type Fate = 'lands' | 'down' | 'lost' | 'refused' | 'pgrst001' | 'dup'

const db = vi.hoisted(() => ({
  schedule: {} as Record<string, unknown>,
  invoices: new Map<string, Record<string, unknown>>(),
  /** Invoices mailed to the customer, by id. */
  sent: [] as string[],
  /** What happens to a statement, by `<kind>#<n>`: update#2 is the second UPDATE of the schedule. */
  fates: new Map<string, 'lands' | 'down' | 'lost' | 'refused' | 'pgrst001' | 'dup'>(),
  counts: new Map<string, number>(),
  /** Run right after the n-th UPDATE of the schedule has applied. */
  afterUpdate: new Map<number, () => void>(),
  /** Run while the n-th invoice INSERT is on its way, before it applies. */
  duringInsert: new Map<number, () => Promise<void>>(),
  /** What run-now's next read of its schedule returns: a read taken earlier. */
  runNowSees: null as Record<string, unknown> | null,
  /** The function is killed right after this step: nothing after it lands. */
  killAfter: null as 'insert' | 'send' | null,
  killed: false,
  /** Run while the cron's due read is on its way, after the rows it returns were read. */
  duringDueRead: null as null | (() => Promise<void>),
  /** Run while the mail is on its way, before it is sent. */
  duringSend: null as null | (() => Promise<void>),
  /** The n-th insert of invoice lines never answers (the function is frozen, then killed); onFrozen is told. */
  freezeLinesInsert: 0,
  onFrozen: null as null | (() => void),
}))

const CUSTOMER = makeCustomer({ id: 'cust-1', company_id: 'c-1', email: 'kund@test.se' })
const SETTINGS = makeCompanySettings({ company_id: 'c-1', company_name: 'Exempelbolaget AB', bankgiro: '123-4567' })
const ITEMS = [
  { id: 'si-1', schedule_id: 's-1', sort_order: 0, line_type: 'product', description: 'Förvaltning', quantity: 1, unit: 'st', unit_price: 1000, vat_rate: 25 },
]
const SCHEDULE: Row = {
  id: 's-1',
  company_id: 'c-1',
  user_id: 'user-1',
  customer_id: 'cust-1',
  name: 'Förvaltning',
  status: 'active',
  day_of_month: 6,
  interval_months: 1,
  send_hour: 8,
  payment_terms_days: 30,
  currency: 'SEK',
  your_reference: null,
  our_reference: null,
  notes: '{periodstart}',
  auto_send: false,
  next_run_date: '2026-07-06',
  period_start: '2026-07-01',
  last_run_at: '2026-06-06T06:30:00.000Z',
  last_invoice_id: null,
  last_run_warning: null,
  generated_count: 4,
  default_dimensions: {},
}

const ok = (data: unknown): Answer => ({ data, error: null })
const DOWN: Answer = { data: null, error: { message: 'connection refused' } }
const LOST: Answer = { data: null, error: { message: 'upstream connect error or disconnect/reset before headers' } }
/** The database itself refused the statement: it rolled back, nothing landed. */
const REFUSED: Answer = { data: null, error: { code: '40P01', message: 'deadlock detected' } }
/** PostgREST's answer to a libpq client error: the connection was lost mid-command, at COMMIT included. */
const PGRST001: Answer = { data: null, error: { code: 'PGRST001', message: 'Database client error. Retrying the connection.' } }
/** A replayed POST whose first delivery committed: its own primary key is taken. */
const DUP: Answer = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "invoices_pkey"' } }

function count(kind: string): number {
  const n = (db.counts.get(kind) ?? 0) + 1
  db.counts.set(kind, n)
  return n
}

const fateOf = (kind: string, n: number): Fate => db.fates.get(`${kind}#${n}`) ?? 'lands'

function matches(row: Row, calls: Call[]): boolean {
  return calls.every((c) => (c.method === 'eq' || c.method === 'is' ? row[c.args[0] as string] === c.args[1] : true))
}

async function schedules(calls: Call[]): Promise<Answer> {
  if (db.killed) return DOWN
  const update = calls.find((c) => c.method === 'update')
  if (update) {
    const n = count('update')
    const fate = fateOf('update', n)
    if (fate === 'down') return DOWN
    const matched = matches(db.schedule, calls)
    if (matched) Object.assign(db.schedule, update.args[0] as Row)
    db.afterUpdate.get(n)?.()
    return fate === 'lost' ? LOST : ok(matched ? [{ id: db.schedule.id }] : [])
  }
  const lte = calls.find((c) => c.method === 'lte')
  if (lte) {
    // The cron's due read: active and due on or before today.
    const due = db.schedule.status === 'active' && (db.schedule.next_run_date as string) <= (lte.args[1] as string)
    const rows = ok(due ? [{ ...db.schedule, items: ITEMS }] : [])
    const during = db.duringDueRead
    db.duringDueRead = null
    await during?.()
    return rows
  }
  if (calls.some((c) => c.method === 'maybeSingle')) {
    // An edit's read of the stored schedule.
    return ok(matches(db.schedule, calls) ? { ...db.schedule } : null)
  }
  if (calls.some((c) => c.method === 'single')) {
    // Run-now's read of its schedule.
    const seen = db.runNowSees ?? db.schedule
    db.runNowSees = null
    return ok({ ...seen, items: ITEMS })
  }
  // The cron's read-back of a record whose answer was an error.
  if (fateOf('read', count('read')) !== 'lands') return DOWN
  return ok(matches(db.schedule, calls) ? [{ id: db.schedule.id }] : [])
}

async function invoices(calls: Call[]): Promise<Answer> {
  if (db.killed) return DOWN
  const insert = calls.find((c) => c.method === 'insert')
  if (insert) {
    const n = count('insert')
    await db.duringInsert.get(n)?.()
    const fate = fateOf('insert', n)
    if (fate === 'down') return DOWN
    if (fate === 'refused') return REFUSED
    // The database's own id, unless the run gave one.
    const row: Row = { id: `db-${n}`, status: 'draft', ...(insert.args[0] as Row) }
    db.invoices.set(row.id as string, row)
    if (db.killAfter === 'insert') db.killed = true
    if (fate === 'pgrst001') return PGRST001
    if (fate === 'dup') return DUP
    return fate === 'lost' ? LOST : ok(row)
  }
  if (calls.some((c) => c.method === 'delete')) {
    const gone = [...db.invoices.values()].filter((row) => matches(row, calls))
    for (const row of gone) {
      db.invoices.delete(row.id as string)
      // recurring_invoice_schedules.last_invoice_id is ON DELETE SET NULL.
      if (db.schedule.last_invoice_id === row.id) db.schedule.last_invoice_id = null
    }
    return ok(gone.map((row) => ({ id: row.id })))
  }
  const row = [...db.invoices.values()].find((r) => matches(r, calls))
  if (calls.some((c) => c.method === 'maybeSingle')) {
    // The read-back of a header insert whose answer was an error, by the id the run gave it.
    if (fateOf('readback', count('readback')) !== 'lands') return DOWN
    return ok(row ? { id: row.id } : null)
  }
  // The reload, with its customer and lines.
  return row ? ok({ ...row, customer: CUSTOMER, items: [] }) : { data: null, error: { code: 'PGRST116', message: 'no row' } }
}

// Every other table and RPC answers { data: null, error: null }.
const mock = createTableMockSupabase({
  recurring_invoice_schedules: schedules,
  invoices,
  invoice_items: (calls: Call[]) => {
    if (db.killed) return DOWN
    if (calls.some((c) => c.method === 'insert') && count('lines') === db.freezeLinesInsert) {
      db.onFrozen?.()
      return new Promise<Answer>(() => {})
    }
    return ok(null)
  },
  customers: ok(CUSTOMER),
  company_settings: ok(SETTINGS),
})

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => mock.supabase, createServiceClient: () => mock.supabase }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: () => null }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: async () => 'c-1' }))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: async () => ({ ok: true }) }))
vi.mock('@/lib/sandbox/guard', () => ({ isSandboxCompany: async () => false }))
vi.mock('@/lib/logger', async (importOriginal) => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  log.child.mockReturnValue(log)
  return { ...(await importOriginal<typeof import('@/lib/logger')>()), createLogger: () => log }
})

// The far end of the send: what it would do to the invoice, and the mail.
vi.mock('@/lib/email/service', () => ({ getEmailService: async () => ({ isConfigured: () => true }) }))
vi.mock('@/lib/email/invoice-sender', () => ({ resolveInvoiceSender: async () => undefined }))
vi.mock('@/lib/email/invoice-templates', () => ({
  generateInvoiceEmailHtml: () => '<p>Faktura</p>',
  generateInvoiceEmailText: () => 'Faktura',
  generateInvoiceEmailSubject: () => 'Faktura',
}))
vi.mock('@/lib/entitlements/has-capability', () => ({ hasCapability: async () => true }))
vi.mock('@/lib/extensions/payment-links', () => ({ applyPaymentLinkToInvoice: async () => ({ failure: null }) }))
vi.mock('@/lib/invoices/render-invoice-pdf', () => ({ renderInvoicePdfBuffer: async () => ({ buffer: Buffer.from('pdf') }) }))
vi.mock('@/lib/core/documents/document-service', () => ({ linkToJournalEntry: async () => undefined }))
vi.mock('@/lib/invoices/ensure-invoice-number', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/invoices/ensure-invoice-number')>()),
  ensureInvoiceNumber: async (_supabase: unknown, _companyId: unknown, invoice: { id: string; invoice_number: string | null }) => {
    invoice.invoice_number = `F-${invoice.id}`
    const row = db.invoices.get(invoice.id)
    if (row) row.invoice_number = invoice.invoice_number
    return invoice.invoice_number
  },
}))
vi.mock('@/lib/invoices/issue-and-book-invoice', () => ({
  issuable: () => null,
  markInvoiceSentAndBook: async ({ invoice }: { invoice: { id: string } }) => {
    const row = db.invoices.get(invoice.id)
    if (row) row.status = 'sent'
    return { ok: true, journalEntryId: 'je-1', partialFailures: [] }
  },
  restoreUnbookedDraft: async () => true,
  archiveIssuedInvoicePdf: async () => null,
}))
vi.mock('@/lib/invoices/invoice-deliveries', () => ({
  reserveInvoiceDelivery: async () => 'delivery-1',
  sendTrackedInvoiceEmail: async (input: { invoiceId: string }) => {
    const during = db.duringSend
    db.duringSend = null
    await during?.()
    db.sent.push(input.invoiceId)
    if (db.killAfter === 'send') db.killed = true
    return { success: true, deliveryId: 'delivery-1', documentId: 'document-1' }
  },
}))

const { GET } = await import('../route')
const { POST } = await import('../../[id]/run/route')
const { PATCH } = await import('../../[id]/route')

const HELD = 'Har schemat inte flyttats till nästa körning väntar det tills du har gjort något av detta.'

type CronBody = { failed: number; results: Array<{ skipReason?: string; invoiceId?: string }> }

/** Run the cron at `instant` (UTC). */
async function cronAt(instant: string): Promise<CronBody> {
  vi.setSystemTime(new Date(instant))
  const res = await GET(createMockRequest('/api/invoices/recurring/cron', { method: 'GET' }))
  return (await res.json()) as CronBody
}

/**
 * "Skapa faktura nu" on the schedule, a second after whatever ran before it:
 * the clock moves on between two requests, so its tokens are its own.
 */
function runNow(): Promise<Response> {
  return runNowAt(new Date(Date.now() + 1000).toISOString())
}

/** "Skapa faktura nu" on the schedule at `instant` (UTC). */
function runNowAt(instant: string): Promise<Response> {
  vi.setSystemTime(new Date(instant))
  return POST(createMockRequest('/api/invoices/recurring/s-1/run', { method: 'POST' }), { params: Promise.resolve({ id: 's-1' }) })
}

/** The cron later the same day, the next day and the day after, with the database up. */
async function carryOn() {
  db.fates.clear()
  db.killAfter = null
  db.killed = false
  const later = await cronAt('2026-07-06T11:30:00Z')
  const nextDay = await cronAt('2026-07-07T08:30:00Z')
  const dayAfter = await cronAt('2026-07-08T08:30:00Z')
  return { later, nextDay, dayAfter }
}

/** The periods the invoices that exist bill, one entry per invoice. */
const periodsBilled = () => [...db.invoices.values()].map((row) => row.notes).sort()

const skips = (body: CronBody) => body.results.map((r) => r.skipReason)

/** A schedule that may have an invoice it does not record waits for a person: no run bills it again. */
function expectHeldForAPerson() {
  expect(db.schedule).toMatchObject({ next_run_date: '2026-07-06', period_start: '2026-07-01' })
  expect(String(db.schedule.last_run_warning).endsWith(HELD)).toBe(true)
}

beforeEach(() => {
  vi.useFakeTimers()
  eventBus.clear()
  mock.reset()
  // Signed in, for "Skapa faktura nu"; the cron runs as the service role.
  mock.supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'agare@test.se' } }, error: null })
  db.schedule = { ...SCHEDULE }
  db.invoices = new Map()
  db.sent = []
  db.fates = new Map()
  db.counts = new Map()
  db.afterUpdate = new Map()
  db.duringInsert = new Map()
  db.runNowSees = null
  db.killAfter = null
  db.killed = false
  db.duringDueRead = null
  db.duringSend = null
  db.freezeLinesInsert = 0
  db.onFrozen = null
})

afterEach(() => {
  vi.useRealTimers()
})

describe('accounted#211: the recurring cron and "Skapa faktura nu" on one schedule', () => {
  it('as a control: a run that goes through bills the period once and moves the schedule on', async () => {
    await cronAt('2026-07-06T08:30:00Z')
    const { later, nextDay } = await carryOn()

    expect(periodsBilled()).toEqual(['2026-07-01'])
    expect(db.schedule).toMatchObject({ next_run_date: '2026-08-06', period_start: '2026-08-01', generated_count: 5, last_run_warning: null })
    // Moved on to August: not due again this month.
    expect(later.results).toEqual([])
    expect(nextDay.results).toEqual([])
  })

  describe('item 1: "Skapa faktura nu" racing the cron\'s run', () => {
    it('read while the cron held the schedule, claimed after its record: 409, and the period is billed once', async () => {
      // The page read the schedule, or the click arrived, right after the cron's claim.
      db.afterUpdate.set(1, () => {
        db.runNowSees = { ...db.schedule }
      })
      await cronAt('2026-07-06T08:30:00Z')

      const res = await runNow()

      expect(periodsBilled()).toEqual(['2026-07-01'])
      expect(res.status).toBe(409)
      expect(db.schedule).toMatchObject({ next_run_date: '2026-08-06', period_start: '2026-08-01', generated_count: 5 })
      await carryOn()
      expect(periodsBilled()).toEqual(['2026-07-01'])
    })

    it('claimed while the cron creates its invoice: the cron\'s record finds its claim gone and removes its draft, so the period is billed once', async () => {
      let answer: Response | undefined
      db.duringInsert.set(1, async () => {
        answer = await runNow()
      })

      const first = await cronAt('2026-07-06T08:30:00Z')

      expect(answer!.status).toBe(200)
      expect(first.failed).toBe(1)
      expect(periodsBilled()).toEqual(['2026-07-01'])
      await carryOn()
      expect(periodsBilled()).toEqual(['2026-07-01'])
    })

    it('after the cron has finished, "Skapa faktura nu" bills the next period, not the same one again', async () => {
      await cronAt('2026-07-06T08:30:00Z')

      const res = await runNow()

      expect(res.status).toBe(200)
      expect(periodsBilled()).toEqual(['2026-07-01', '2026-08-01'])
    })
  })

  describe('item 2: the invoice header insert answers an error', () => {
    it('it landed: the run reads it back by the id it gave it and goes on, so the period is billed once and the schedule moves on (accounted#213)', async () => {
      db.fates.set('insert#1', 'lost')

      await cronAt('2026-07-06T08:30:00Z')
      const { later, nextDay } = await carryOn()

      expect(periodsBilled()).toEqual(['2026-07-01'])
      expect(db.schedule).toMatchObject({ next_run_date: '2026-08-06', period_start: '2026-08-01', generated_count: 5, last_run_warning: null })
      expect(later.results).toEqual([])
      expect(nextDay.results).toEqual([])
    })

    it('it landed and its read-back fails too: the draft is kept, the schedule waits for a person, and no run bills the period again', async () => {
      db.fates.set('insert#1', 'lost')
      db.fates.set('readback#1', 'down')

      await cronAt('2026-07-06T08:30:00Z')
      const { later, nextDay, dayAfter } = await carryOn()

      expect(periodsBilled()).toEqual(['2026-07-01'])
      expectHeldForAPerson()
      expect(skips(later)).toEqual(['already_ran_today'])
      expect(skips(nextDay)).toEqual(['held_for_a_person'])
      expect(skips(dayAfter)).toEqual(['held_for_a_person'])
    })

    it('it never landed: no invoice, the schedule waits for a person, and "Skapa faktura nu" then bills the period once', async () => {
      db.fates.set('insert#1', 'down')

      await cronAt('2026-07-06T08:30:00Z')
      await carryOn()

      // Nobody can tell this from the case above, so it is not billed behind a person's back.
      expect(periodsBilled()).toEqual([])
      expectHeldForAPerson()
      // What the held warning says to do when no invoice was created.
      const res = await runNow()
      expect(res.status).toBe(200)
      expect(periodsBilled()).toEqual(['2026-07-01'])
    })
  })

  describe('item 3: the record answers an error on a schedule that sends', () => {
    beforeEach(() => {
      db.schedule.auto_send = true
    })

    it('it landed: the read-back finds this run\'s invoice and the send goes on; billed and sent once', async () => {
      db.fates.set('update#2', 'lost') // the record

      await cronAt('2026-07-06T08:30:00Z')
      await carryOn()

      expect(periodsBilled()).toEqual(['2026-07-01'])
      expect(db.sent).toEqual([...db.invoices.keys()])
      expect(db.schedule).toMatchObject({ next_run_date: '2026-08-06', period_start: '2026-08-01', generated_count: 5, last_run_warning: null })
    })

    it('it landed and the read-back fails too: the invoice is kept unsent, the person is told, and nothing is billed again', async () => {
      db.fates.set('update#2', 'lost') // the record
      db.fates.set('read#1', 'down') // the read-back

      await cronAt('2026-07-06T08:30:00Z')
      await carryOn()

      expect(periodsBilled()).toEqual(['2026-07-01'])
      expect(db.sent).toEqual([])
      expect(db.schedule).toMatchObject({ next_run_date: '2026-08-06', period_start: '2026-08-01' })
      expect(String(db.schedule.last_run_warning)).toContain('Kontrollera om en faktura skapades för perioden')
    })

    it('it never landed: held, the draft removed, the run given back; the next hour bills and sends the period once', async () => {
      db.fates.set('update#2', 'down') // the record

      await cronAt('2026-07-06T08:30:00Z')
      expect(periodsBilled()).toEqual([])
      const { later } = await carryOn()

      expect(later.results.map((r) => r.invoiceId)).toHaveLength(1)
      expect(periodsBilled()).toEqual(['2026-07-01'])
      expect(db.sent).toEqual([...db.invoices.keys()])
    })
  })
})

describe('accounted#213: "Skapa faktura nu" records its run as the hourly run does', () => {
  /** No period has two invoices. */
  const expectEachPeriodOnce = () => {
    const periods = periodsBilled()
    expect(new Set(periods).size).toBe(periods.length)
  }
  const says = () => String(db.schedule.last_run_warning ?? '')

  describe('item 1: the run made by hand is recorded before its send, gated on its own claim', () => {
    beforeEach(() => {
      db.schedule.auto_send = true
    })

    it('the record answers an error once the invoice exists: the person is not told it was created, and the hourly run bills the period once', async () => {
      db.fates.set('update#2', 'down') // after the claim, the schedule's next write

      // The day before the schedule's date.
      const res = await runNowAt('2026-07-05T08:00:00Z')
      await carryOn()

      expect(periodsBilled()).toEqual(['2026-07-01'])
      expect(db.sent).toHaveLength(1)
      expect(res.status).not.toBe(200)
    })

    it('killed between the send and the record: the hourly run does not bill the period again', async () => {
      db.killAfter = 'send'

      await runNowAt('2026-07-05T08:00:00Z')
      await carryOn()

      // Clicked ahead of the date: July by hand, August by the hourly run on its date.
      expectEachPeriodOnce()
      expect(db.sent).toEqual([...db.invoices.keys()])
    })

    it('killed once its invoice exists, before the record: the schedule waits for a person, and no run bills the period again', async () => {
      db.killAfter = 'insert'

      await runNowAt('2026-07-05T08:00:00Z')
      const { later, nextDay } = await carryOn()

      expect(periodsBilled()).toEqual(['2026-07-01'])
      expectHeldForAPerson()
      expect(skips(later)).toEqual(['held_for_a_person'])
      expect(skips(nextDay)).toEqual(['held_for_a_person'])
    })
  })

  describe('item 2: the header insert lands but its answer is lost', () => {
    beforeEach(() => {
      db.schedule.auto_send = true
    })

    it('the run goes on with the invoice it finds by its id, so the person has no reason to click again', async () => {
      db.fates.set('insert#1', 'lost')

      const first = await runNowAt('2026-07-05T08:00:00Z')
      // A person clicks again only when told it failed.
      if (!first.ok) await runNow()

      expect(first.status).toBe(200)
      expect(periodsBilled()).toEqual(['2026-07-01'])
      expect(db.sent).toEqual([...db.invoices.keys()])
      expect(db.schedule).toMatchObject({ period_start: '2026-08-01', last_invoice_id: [...db.invoices.keys()][0], generated_count: 5 })
    })

    it('nobody can tell whether it landed: the person is told to check the drafts, and no run bills the period behind their back', async () => {
      db.fates.set('insert#1', 'lost')
      db.fates.set('readback#1', 'down')

      const first = await runNowAt('2026-07-05T08:00:00Z')
      const body = (await first.json()) as { error?: { code?: string } }
      const { later, nextDay } = await carryOn()

      expect(body.error?.code).toBe('RECURRING_RUN_INVOICE_KEPT')
      expect(periodsBilled()).toEqual(['2026-07-01'])
      expect(db.sent).toEqual([])
      expectHeldForAPerson()
      expect(skips(later)).toEqual(['held_for_a_person'])
      expect(skips(nextDay)).toEqual(['held_for_a_person'])
    })
  })

  describe('item 3: the run made by hand is the one that was due', () => {
    /** A person who reads "Ingen faktura skapades" on the schedule bills it by hand. */
    async function personActsOnTheSchedule(instant: string) {
      if (says().includes('Ingen faktura skapades')) await runNowAt(instant)
    }

    it('on a held schedule: the next hourly run says nothing false, and nothing bills the next period early', async () => {
      db.fates.set('insert#1', 'down') // the hourly run cannot tell whether its invoice landed
      await cronAt('2026-07-06T08:30:00Z')
      expectHeldForAPerson()
      db.fates.clear()

      // The day after, a person finds no invoice for July and does what the schedule says.
      const res = await runNowAt('2026-07-07T07:00:00Z')
      await cronAt('2026-07-07T08:30:00Z')
      await personActsOnTheSchedule('2026-07-07T09:00:00Z')

      expect(res.status).toBe(200)
      expect(says()).not.toContain('Ingen faktura skapades')
      expect(periodsBilled()).toEqual(['2026-07-01'])
      expect(db.schedule).toMatchObject({ next_run_date: '2026-08-06', period_start: '2026-08-01' })
      // August is billed on its own date, once.
      await cronAt('2026-08-06T08:30:00Z')
      expect(periodsBilled()).toEqual(['2026-07-01', '2026-08-01'])
    })

    it('on its own day before its hour: the day after says nothing false, and nothing bills the next period early', async () => {
      // 07:00 in Stockholm; the schedule's hour is 08.
      await runNowAt('2026-07-06T05:00:00Z')
      await carryOn()
      await personActsOnTheSchedule('2026-07-08T09:00:00Z')

      expect(says()).not.toContain('Ingen faktura skapades')
      expect(periodsBilled()).toEqual(['2026-07-01'])
      expect(db.schedule).toMatchObject({ next_run_date: '2026-08-06', period_start: '2026-08-01' })
    })

    it('ahead of its date: the cadence stays, and the hourly run bills the next period on the date', async () => {
      await runNowAt('2026-07-01T08:00:00Z')
      expect(db.schedule).toMatchObject({ next_run_date: '2026-07-06', period_start: '2026-08-01' })

      await cronAt('2026-07-06T08:30:00Z')

      expect(periodsBilled()).toEqual(['2026-07-01', '2026-08-01'])
    })
  })

  describe('low: an insert the database itself refused', () => {
    it('nothing landed: the hourly run gives its run back and bills the period the hour after', async () => {
      db.fates.set('insert#1', 'refused')

      await cronAt('2026-07-06T08:30:00Z')
      expect(says()).toContain('Nytt försök görs automatiskt')
      const { later } = await carryOn()

      expect(later.results.map((r) => r.invoiceId)).toHaveLength(1)
      expect(periodsBilled()).toEqual(['2026-07-01'])
    })
  })
})

describe('accounted#213, review of !1529: the cuts the first version still let through', () => {
  const says = () => String(db.schedule.last_run_warning ?? '')
  /** A person who reads "Ingen faktura skapades" on the schedule bills it by hand. */
  async function personActsOnTheSchedule(instant: string) {
    if (says().includes('Ingen faktura skapades')) await runNowAt(instant)
  }
  /** The person edits the schedule in the dialog (PATCH). */
  function edit(body: Record<string, unknown>, instant: string): Promise<Response> {
    vi.setSystemTime(new Date(instant))
    return PATCH(createMockRequest('/api/invoices/recurring/s-1', { method: 'PATCH', body }), { params: Promise.resolve({ id: 's-1' }) })
  }

  describe('finding 1: a header insert error is settled by reading the row back before its code is trusted', () => {
    it('the insert committed but PostgREST answered PGRST001 (the connection lost at COMMIT): the hourly run finds it and bills July once', async () => {
      db.fates.set('insert#1', 'pgrst001')

      await cronAt('2026-07-06T08:30:00Z')
      await carryOn()

      expect(periodsBilled()).toEqual(['2026-07-01'])
      expect(db.schedule).toMatchObject({ next_run_date: '2026-08-06', period_start: '2026-08-01', generated_count: 5 })
    })

    it('the same on "Skapa faktura nu": the run goes on with the invoice it finds, so the person has no reason to click again', async () => {
      db.fates.set('insert#1', 'pgrst001')

      const first = await runNowAt('2026-07-05T08:00:00Z')
      // A person clicks again only when told it failed.
      if (!first.ok) await runNow()

      expect(periodsBilled()).toEqual(['2026-07-01'])
      expect(first.status).toBe(200)
    })

    it('a replayed insert answered 23505 on the id this run gave it: the row is this run\'s, found and billed once', async () => {
      db.fates.set('insert#1', 'dup')

      await cronAt('2026-07-06T08:30:00Z')
      await carryOn()

      expect(periodsBilled()).toEqual(['2026-07-01'])
      expect(db.schedule).toMatchObject({ next_run_date: '2026-08-06', period_start: '2026-08-01' })
    })
  })

  describe('finding 2: "Skapa faktura nu" on a run that was due moves the date one interval past it, the cron\'s own rule', () => {
    it('a hold resolved by hand after the next date has passed: that date is not swallowed, the schedule says no invoice was made for it', async () => {
      db.fates.set('insert#1', 'down') // the cron cannot tell whether its July invoice landed
      await cronAt('2026-07-06T08:30:00Z')
      db.fates.clear()
      await cronAt('2026-08-06T08:30:00Z') // still held on August's date

      // 10 August: a person finds no July invoice and bills it by hand.
      const res = await runNowAt('2026-08-10T08:00:00Z')
      await cronAt('2026-08-10T09:30:00Z')

      expect(res.status).toBe(200)
      expect(says()).toContain('Ingen faktura skapades den 2026-08-06')
      expect(db.schedule).toMatchObject({ next_run_date: '2026-09-06', period_start: '2026-08-01' })
      // The person bills August from what the schedule says, and September comes on its date.
      await personActsOnTheSchedule('2026-08-10T10:00:00Z')
      await cronAt('2026-09-06T08:30:00Z')
      expect(periodsBilled()).toEqual(['2026-07-01', '2026-08-01', '2026-09-01'])
    })
  })

  describe('finding 3: the closing warning is written only while the schedule still holds this run\'s record', () => {
    it('"Skapa faktura nu" claims while the hourly run sends and is killed after its insert: its held warning stays, and August is not billed again', async () => {
      db.schedule.auto_send = true
      db.freezeLinesInsert = 2 // the click's invoice lines never answer: frozen, then killed
      db.duringSend = async () => {
        const frozen = new Promise<void>((resolve) => {
          db.onFrozen = resolve
        })
        void runNow()
        await frozen
      }

      await cronAt('2026-07-06T08:30:00Z')
      const nextDay = await cronAt('2026-07-07T08:30:00Z')
      const august = await cronAt('2026-08-06T08:30:00Z')

      // July from the hourly run; August as the click's draft, which its schedule does not record.
      expect(periodsBilled()).toEqual(['2026-07-01', '2026-08-01'])
      expect(says().endsWith(HELD)).toBe(true)
      expect(nextDay.results).toEqual([])
      expect(skips(august)).toEqual(['held_for_a_person'])
    })
  })

  describe('finding 4: "Skapa faktura nu" that loses its claim mid-run says a run is in progress', () => {
    it('two tabs: the one whose claim was taken while it created its invoice gets 409, not "try again", and nothing bills the next period early', async () => {
      let second: Response | undefined
      db.duringInsert.set(1, async () => {
        second = await runNow()
      })

      const first = await runNowAt('2026-07-05T08:00:00Z')
      const body = (await first.json()) as { error?: { code?: string } }
      // A person told the server failed tries again.
      if (first.status >= 500) await runNow()

      expect(periodsBilled()).toEqual(['2026-07-01'])
      expect(second!.status).toBe(200)
      expect(first.status).toBe(409)
      expect(body.error?.code).toBe('RECURRING_RUN_IN_PROGRESS')
    })
  })

  // A hold means the period's invoice may exist unrecorded. An edit cannot
  // tell, so it never lifts one: the first version of this fix lifted it on a
  // new run date, and the cron billed July again on that date (review round 2).
  // "Skapa faktura nu" and pausing and activating, the held text's two ways
  // out, are where a person says which case it is.
  describe('an edit never lifts a hold: the period\'s invoice may exist', () => {
    beforeEach(async () => {
      db.fates.set('insert#1', 'lost') // July's draft landed, its answer did not
      db.fates.set('readback#1', 'down') // and nobody could read it back
      await cronAt('2026-07-06T08:30:00Z')
      db.fates.clear()
      expectHeldForAPerson()
      expect(periodsBilled()).toEqual(['2026-07-01'])
    })

    it('the person moves "Nästa körning" to 6 August: held on that date too, July is not billed again', async () => {
      const res = await edit({ next_run_date: '2026-08-06' }, '2026-07-07T08:00:00Z')
      const august = await cronAt('2026-08-06T08:30:00Z')

      expect(periodsBilled()).toEqual(['2026-07-01'])
      expect(res.status).toBe(200)
      expect(says().endsWith(HELD)).toBe(true)
      expect(skips(august)).toEqual(['held_for_a_person'])
    })

    it('a new day of the month recomputes the run date: held on that date too', async () => {
      await edit({ day_of_month: 10 }, '2026-07-07T08:00:00Z')
      const tenth = await cronAt('2026-07-10T08:30:00Z')

      expect(periodsBilled()).toEqual(['2026-07-01'])
      expect(says().endsWith(HELD)).toBe(true)
      expect(skips(tenth)).toEqual(['held_for_a_person'])
    })

    it('a new period start or name keeps the hold', async () => {
      await edit({ period_start: '2026-08-01' }, '2026-07-07T08:00:00Z')
      await edit({ name: 'Förvaltning, nytt namn' }, '2026-07-07T08:01:00Z')
      const nextDay = await cronAt('2026-07-08T08:30:00Z')

      expect(says().endsWith(HELD)).toBe(true)
      expect(skips(nextDay)).toEqual(['held_for_a_person'])
      expect(periodsBilled()).toEqual(['2026-07-01'])
    })
  })

  describe('finding 6: the stale roll writes only while the schedule is as the cron read it', () => {
    it('"Skapa faktura nu" records between the cron\'s read and its roll: no "Ingen faktura skapades" over its record', async () => {
      // 6 June was missed (a cron outage); not held.
      Object.assign(db.schedule, { next_run_date: '2026-06-06', period_start: '2026-06-01', last_run_at: '2026-05-06T06:30:00.000Z' })
      // The cron's read just after midnight on 7 June; while it is on its way, a person bills June by hand.
      db.duringDueRead = async () => {
        await runNowAt('2026-06-06T22:00:01Z')
      }

      const body = await cronAt('2026-06-06T22:00:00Z')
      const afterTheCron = says()
      await personActsOnTheSchedule('2026-06-07T07:00:00Z')

      expect(periodsBilled()).toEqual(['2026-06-01'])
      expect(afterTheCron).not.toContain('Ingen faktura skapades')
      expect(db.schedule).toMatchObject({ next_run_date: '2026-07-06', period_start: '2026-07-01' })
      expect(skips(body)).toEqual(['claimed_by_concurrent_run'])
    })
  })
})
