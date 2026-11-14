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
type Fate = 'lands' | 'down' | 'lost'

const db = vi.hoisted(() => ({
  schedule: {} as Record<string, unknown>,
  invoices: new Map<string, Record<string, unknown>>(),
  /** Invoices mailed to the customer, by id. */
  sent: [] as string[],
  /** What happens to a statement, by `<kind>#<n>`: update#2 is the second UPDATE of the schedule. */
  fates: new Map<string, 'lands' | 'down' | 'lost'>(),
  counts: new Map<string, number>(),
  /** Run right after the n-th UPDATE of the schedule has applied. */
  afterUpdate: new Map<number, () => void>(),
  /** Run while the n-th invoice INSERT is on its way, before it applies. */
  duringInsert: new Map<number, () => Promise<void>>(),
  /** What run-now's next read of its schedule returns: a read taken earlier. */
  runNowSees: null as Record<string, unknown> | null,
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

function count(kind: string): number {
  const n = (db.counts.get(kind) ?? 0) + 1
  db.counts.set(kind, n)
  return n
}

const fateOf = (kind: string, n: number): Fate => db.fates.get(`${kind}#${n}`) ?? 'lands'

function matches(row: Row, calls: Call[]): boolean {
  return calls.every((c) => (c.method === 'eq' || c.method === 'is' ? row[c.args[0] as string] === c.args[1] : true))
}

function schedules(calls: Call[]): Answer {
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
    return ok(due ? [{ ...db.schedule, items: ITEMS }] : [])
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
  const insert = calls.find((c) => c.method === 'insert')
  if (insert) {
    const n = count('insert')
    await db.duringInsert.get(n)?.()
    const fate = fateOf('insert', n)
    if (fate === 'down') return DOWN
    // The database's own id, unless the run gave one.
    const row: Row = { id: `db-${n}`, status: 'draft', ...(insert.args[0] as Row) }
    db.invoices.set(row.id as string, row)
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
  // The reload, with its customer and lines.
  const row = [...db.invoices.values()].find((r) => matches(r, calls))
  return row ? ok({ ...row, customer: CUSTOMER, items: [] }) : { data: null, error: { code: 'PGRST116', message: 'no row' } }
}

// Every other table and RPC answers { data: null, error: null }.
const mock = createTableMockSupabase({
  recurring_invoice_schedules: schedules,
  invoices,
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
    db.sent.push(input.invoiceId)
    return { success: true, deliveryId: 'delivery-1', documentId: 'document-1' }
  },
}))

const { GET } = await import('../route')
const { POST } = await import('../../[id]/run/route')

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
  vi.setSystemTime(new Date(Date.now() + 1000))
  return POST(createMockRequest('/api/invoices/recurring/s-1/run', { method: 'POST' }), { params: Promise.resolve({ id: 's-1' }) })
}

/** The cron later the same day, the next day and the day after, with the database up. */
async function carryOn() {
  db.fates.clear()
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
    it('it landed: the draft is kept, the schedule waits for a person, and no run bills the period again', async () => {
      db.fates.set('insert#1', 'lost')

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
