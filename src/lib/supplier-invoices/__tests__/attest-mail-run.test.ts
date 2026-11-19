import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'

/**
 * The jobs of the batched attest mail (crm#1569), against a table mock: the
 * byrå (Alex) registered three invoices for its client, whose owner Kim and
 * admin Robin attest. Before this, Kim got three mails; now one. A mail that
 * may have gone out counts as sent (never twice); only one that certainly
 * did not go is tried again, on the same row with a fresh token.
 */

const sendAttestBatchMail = vi.fn()
const sendAttestNoticeMail = vi.fn()
vi.mock('@/lib/email/send-attest-batch', () => ({
  sendAttestBatchMail: (...args: unknown[]) => sendAttestBatchMail(...args),
  sendAttestNoticeMail: (...args: unknown[]) => sendAttestNoticeMail(...args),
}))
vi.mock('@/lib/email/brand-sender', () => ({ getBaseUrlForCompany: async () => 'https://byra.accounted.se/' }))

import { ATTEST_RUN_CLAIM_BUDGET_MS, ATTEST_RUN_SEND_BUDGET_MS, runAttestFollowUps, runAttestRequestRound } from '../attest-mail-run'

const NOW = Date.parse('2026-10-31T12:00:00Z')
const AT = new Date(NOW).toISOString()
const LEASE = new Date(NOW + 15 * 60_000).toISOString()
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()
const SENT = { outcome: 'sent' }
const UNKNOWN = { outcome: 'unknown' }
const REFUSED = { outcome: 'refused' }
const NO_MAIL_SERVICE = { outcome: 'unavailable' }

const POLICY = { company_id: 'c1', enabled: true, threshold_amount: null, mode: 'any', attesters: ['kim', 'robin'], preparer_may_attest: false, two_step_from_sek: null, updated_by: null, updated_at: null }

const invoice = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  user_id: 'alex',
  status: 'registered',
  approved_at: null,
  is_credit_note: false,
  currency: 'SEK',
  total: 29625,
  total_sek: null,
  exchange_rate: null,
  supplier_invoice_number: `F-${id}`,
  arrival_number: 7,
  due_date: '2026-11-19',
  supplier: { name: 'Möbelfirman AB' },
  ...overrides,
})

type Call = { method: string; args: unknown[] }
const called = (calls: Call[], method: string) => calls.some((c) => c.method === method)

/**
 * supplier_invoice_attest_batches as the jobs use it: the retry reads the
 * free unsent rows, an insert answers each row by its token hash, a
 * conditional update that selects (a retry's lease, a retire) answers
 * whether it took the row, and a plain update (finishing a send) answers
 * nothing.
 */
function batchesTable(options: { unsent?: unknown[]; takes?: (id: string) => boolean } = {}) {
  let inserted = 0
  return (calls: Call[]) => {
    if (called(calls, 'insert')) {
      const rows = (calls.find((c) => c.method === 'insert')!.args[0] as Array<{ token_hash: string }>) ?? []
      return { data: rows.map((row) => ({ id: `batch-${++inserted}`, token_hash: row.token_hash })) }
    }
    if (called(calls, 'update')) {
      const id = String(calls.find((c) => c.method === 'eq' && c.args[0] === 'id')?.args[1])
      return { data: called(calls, 'select') ? ((options.takes ?? (() => true))(id) ? [{ id }] : []) : null }
    }
    return { data: options.unsent ?? [] }
  }
}

const service = createTableMockSupabase()
const supabase = () => service.supabase as unknown as SupabaseClient

function seed(tables: Record<string, unknown>) {
  service.reset()
  const all: Record<string, unknown> = {
    company_attest_policies: { data: POLICY },
    company_attest_limits: { data: [] },
    company_settings: { data: { accounting_method: 'accrual' } },
    company_members: {
      data: [
        { user_id: 'alex', role: 'admin' },
        { user_id: 'kim', role: 'owner' },
        { user_id: 'robin', role: 'admin' },
      ],
    },
    supplier_invoice_attestations: { data: [] },
    notification_settings: { data: [] },
    companies: { data: { name: 'Kundbolaget AB', team_id: null } },
    profiles: {
      data: [
        { id: 'alex', email: 'alex@byra.example', full_name: 'Alex' },
        { id: 'kim', email: 'kim@client.example', full_name: 'Kim' },
        { id: 'robin', email: 'robin@client.example', full_name: 'Robin' },
      ],
    },
    supplier_invoice_attest_batches: batchesTable(),
    ...tables,
  }
  for (const [key, value] of Object.entries(all)) service.setTable(key, value as never)
}

type MailCall = { email: string; data: { kind: string; invoices: Array<{ supplierName: string; dueDate: string }>; url: string; registeredBy: string | null } }
const mailCalls = () => sendAttestBatchMail.mock.calls.map(([call]) => call as MailCall)
const stateUpdates = () => service.payloads('supplier_invoice_attest_mail_state', 'update')
const batchUpdates = () => service.payloads('supplier_invoice_attest_batches', 'update')
const batchInserts = () => service.payloads('supplier_invoice_attest_batches', 'insert') as Array<Array<Record<string, unknown>>>
const FREE = '-infinity'
const sentMark = { mail_sent_at: AT, send_lease_until: FREE }
/** A refusal's give-back: the mark cleared and the next try held off by the backoff of the try that was refused. */
const refusedBack = (now: number, waitMs: number) => ({ mail_sent_at: null, send_lease_until: new Date(now + waitMs).toISOString() })
/** A wall clock that reads 0 for the first `inTime` reads and `late` after: the run's budget runs out on cue. */
const clockAfter = (inTime: number, late: number) => {
  let reads = 0
  return () => (reads++ < inTime ? 0 : late)
}

const ROUND_QUEUE = [
  { data: [{ supplier_invoice_id: 'mf-1' }] },
  {
    data: [
      { supplier_invoice_id: 'mf-1', company_id: 'c1', queued_at: minutesAgo(30) },
      { supplier_invoice_id: 'mf-2', company_id: 'c1', queued_at: minutesAgo(20) },
      { supplier_invoice_id: 'kb', company_id: 'c1', queued_at: minutesAgo(16) },
      // Another company still registering: its round is not complete.
      { supplier_invoice_id: 'other', company_id: 'c2', queued_at: minutesAgo(5) },
    ],
  },
  { data: [{ supplier_invoice_id: 'mf-1' }, { supplier_invoice_id: 'mf-2' }, { supplier_invoice_id: 'kb' }] },
]
const ROUND_INVOICES = {
  data: [
    invoice('kb', { supplier: { name: 'Konsultbolaget AB' }, total: 11250, due_date: '2026-11-19' }),
    invoice('mf-1', { due_date: '2026-11-05' }),
    invoice('mf-2', { total: 24375, due_date: '2026-11-05' }),
  ],
}

describe('runAttestRequestRound', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendAttestBatchMail.mockResolvedValue(SENT)
    sendAttestNoticeMail.mockResolvedValue(SENT)
  })

  it('answers skipped and sends nothing while the migration has not reached the database', async () => {
    seed({ supplier_invoice_attest_mail_state: { error: { code: 'PGRST205', message: "Could not find the table 'public.supplier_invoice_attest_mail_state'" } } })
    const result = await runAttestRequestRound(supabase(), undefined, { now: NOW })
    expect(result.skipped).toBe('schema_missing')
    expect(sendAttestBatchMail).not.toHaveBeenCalled()
  })

  it('sends each attester ONE mail with every invoice of the round, once the company is quiet for 15 minutes', async () => {
    seed({ supplier_invoice_attest_mail_state: ROUND_QUEUE, supplier_invoices: ROUND_INVOICES })
    const result = await runAttestRequestRound(supabase(), undefined, { now: NOW })
    expect(result).toMatchObject({ queued: 4, companies: 1, invoices_asked: 3, request_mails_sent: 2, request_mails_failed: 0, failed_companies: 0 })
    const calls = mailCalls()
    expect(calls.map((c) => c.email).sort()).toEqual(['kim@client.example', 'robin@client.example'])
    for (const call of calls) {
      expect(call.data.kind).toBe('request')
      expect(call.data.invoices.map((i) => i.supplierName)).toEqual(['Möbelfirman AB', 'Möbelfirman AB', 'Konsultbolaget AB'])
      expect(call.data.registeredBy).toBe('Alex')
      expect(call.data.url).toMatch(/^https:\/\/byra\.accounted\.se\/attest\/lista\/[A-Za-z0-9_-]{43}$/)
    }
    // The queue rows are claimed (marked asked) before anything is sent, guarded on not asked yet.
    expect(stateUpdates()).toEqual([{ asked_at: AT }])
    expect(service.findCalls('supplier_invoice_attest_mail_state', 'is')).toContainEqual(['asked_at', null])
    // Every mail of the round is stored, leased to this run, in ONE insert before the first is sent.
    expect(batchInserts()).toHaveLength(1)
    expect(batchInserts()[0]!.map((row) => row.attester_user_id).sort()).toEqual(['kim', 'robin'])
    expect(batchInserts()[0]![0]).toMatchObject({ company_id: 'c1', kind: 'request', invoice_ids: ['mf-1', 'mf-2', 'kb'], send_lease_until: LEASE })
    expect(String(batchInserts()[0]![0]!.token_hash)).toMatch(/^[0-9a-f]{64}$/)
    expect(calls.some((c) => c.data.url.includes(String(batchInserts()[0]![0]!.token_hash)))).toBe(false)
    // Both taken (marked sent) under the lease this run holds, and nothing more to write after the send.
    expect(batchUpdates()).toEqual([sentMark, sentMark])
    expect(service.findCalls('supplier_invoice_attest_batches', 'eq')).toContainEqual(['send_lease_until', LEASE])
    expect(service.findCalls('supplier_invoice_attest_batches', 'is')).toContainEqual(['mail_sent_at', null])
  })

  it('marks each mail sent before handing it to the provider, so a run that dies mid-send never sends it twice', async () => {
    seed({ supplier_invoice_attest_mail_state: ROUND_QUEUE, supplier_invoices: ROUND_INVOICES })
    const marksAtSend: number[] = []
    sendAttestBatchMail.mockImplementation(async () => {
      marksAtSend.push(batchUpdates().filter((u) => (u as Record<string, unknown>).mail_sent_at === AT).length)
      return SENT
    })
    await runAttestRequestRound(supabase(), undefined, { now: NOW })
    expect(marksAtSend).toEqual([1, 2])
  })

  it('records a mail that may have gone out as sent, so it is never sent twice', async () => {
    seed({ supplier_invoice_attest_mail_state: ROUND_QUEUE, supplier_invoices: ROUND_INVOICES })
    sendAttestBatchMail.mockResolvedValue(UNKNOWN)
    const result = await runAttestRequestRound(supabase(), undefined, { now: NOW })
    expect(result).toMatchObject({ request_mails_sent: 2, request_mails_failed: 0 })
    expect(batchUpdates()).toEqual([sentMark, sentMark])
  })

  it('gives a refused mail its lease back for a later try, and still mails the other attesters', async () => {
    seed({ supplier_invoice_attest_mail_state: ROUND_QUEUE, supplier_invoices: ROUND_INVOICES })
    sendAttestBatchMail.mockImplementation(async ({ email }: { email: string }) => (email.startsWith('kim') ? REFUSED : SENT))
    let result = await runAttestRequestRound(supabase(), undefined, { now: NOW })
    expect(result).toMatchObject({ request_mails_sent: 1, request_mails_failed: 1 })
    // Kim's mark is cleared (only that mark), so a later run tries her mail again; Robin's stays sent.
    expect(batchUpdates()).toEqual(expect.arrayContaining([refusedBack(NOW, 5 * 60_000), sentMark]))
    expect(service.findCalls('supplier_invoice_attest_batches', 'eq')).toContainEqual(['mail_sent_at', AT])

    // A throw after the mail was taken keeps it marked sent (never twice): unconfirmed, not on record for a
    // later try. The next attester is still mailed.
    seed({ supplier_invoice_attest_mail_state: ROUND_QUEUE, supplier_invoices: ROUND_INVOICES })
    sendAttestBatchMail.mockImplementation(async ({ email }: { email: string }) => {
      if (email.startsWith('kim')) throw new Error('render failed')
      return SENT
    })
    result = await runAttestRequestRound(supabase(), undefined, { now: NOW })
    expect(result).toMatchObject({ request_mails_sent: 1, request_mails_failed: 0, request_mails_unconfirmed: 1, failed_companies: 0 })
    expect(batchUpdates()).toEqual([sentMark, sentMark])
    expect(mailCalls().map((c) => c.email)).toContain('robin@client.example')
  })

  it('retires a link whose mail can never go here (no mail service)', async () => {
    seed({ supplier_invoice_attest_mail_state: ROUND_QUEUE, supplier_invoices: ROUND_INVOICES })
    sendAttestBatchMail.mockResolvedValue(NO_MAIL_SERVICE)
    const result = await runAttestRequestRound(supabase(), undefined, { now: NOW })
    expect(result).toMatchObject({ request_mails_sent: 0, request_mails_failed: 0 })
    expect(batchUpdates()).toEqual([sentMark, { consumed_at: AT, send_lease_until: FREE }, sentMark, { consumed_at: AT, send_lease_until: FREE }])
  })

  it('reads the decisions on the invoices paged and oldest first, so a long trail keeps its latest rejection', async () => {
    seed({ supplier_invoice_attest_mail_state: ROUND_QUEUE, supplier_invoices: ROUND_INVOICES })
    await runAttestRequestRound(supabase(), undefined, { now: NOW })
    expect(service.findCalls('supplier_invoice_attestations', 'order')).toContainEqual(['decided_at', { ascending: true }])
    expect(service.findCalls('supplier_invoice_attestations', 'range')).toContainEqual([0, 999])
  })

  it('puts the claimed rows back in the queue when the round cannot be stored, before anything is sent', async () => {
    seed({
      supplier_invoice_attest_mail_state: ROUND_QUEUE,
      supplier_invoices: ROUND_INVOICES,
      supplier_invoice_attest_batches: (calls: Call[]) =>
        called(calls, 'insert') ? { error: { code: '57014', message: 'canceling statement due to statement timeout' } } : { data: [] },
    })
    const result = await runAttestRequestRound(supabase(), undefined, { now: NOW })
    expect(result).toMatchObject({ invoices_asked: 0, request_mails_sent: 0, failed_companies: 1 })
    expect(stateUpdates()).toEqual([{ asked_at: AT }, { asked_at: null }])
    // Only what this run marked goes back.
    expect(service.findCalls('supplier_invoice_attest_mail_state', 'eq')).toContainEqual(['asked_at', AT])
    expect(sendAttestBatchMail).not.toHaveBeenCalled()
  })

  it('retires whatever a failed insert may have written before giving the claims back, and keeps them when that is impossible', async () => {
    // The insert committed but its reply was lost: the rows exist, leased and unsent.
    const lostReply = (retire: { error?: unknown }) => (calls: Call[]) => {
      if (called(calls, 'insert')) return { error: { code: '', message: 'fetch failed' } }
      if (called(calls, 'update')) return retire
      return { data: [] }
    }
    seed({ supplier_invoice_attest_mail_state: [...ROUND_QUEUE, { data: null }], supplier_invoices: ROUND_INVOICES, supplier_invoice_attest_batches: lostReply({}) })
    let result = await runAttestRequestRound(supabase(), undefined, { now: NOW })
    expect(result).toMatchObject({ invoices_asked: 0, failed_companies: 1 })
    const [inserted] = batchInserts()
    expect(batchUpdates()).toEqual([{ consumed_at: AT, send_lease_until: FREE }])
    expect(service.findCalls('supplier_invoice_attest_batches', 'in')).toContainEqual(['token_hash', inserted!.map((row) => row.token_hash)])
    expect(service.findCalls('supplier_invoice_attest_batches', 'is')).toContainEqual(['mail_sent_at', null])
    expect(stateUpdates()).toEqual([{ asked_at: AT }, { asked_at: null }])

    // Not even the retire went through: the claims stay, so the rows and a re-claimed round can never both be mailed.
    seed({
      supplier_invoice_attest_mail_state: ROUND_QUEUE,
      supplier_invoices: ROUND_INVOICES,
      supplier_invoice_attest_batches: lostReply({ error: { code: '', message: 'fetch failed' } }),
    })
    result = await runAttestRequestRound(supabase(), undefined, { now: NOW })
    expect(result).toMatchObject({ failed_companies: 1 })
    expect(stateUpdates()).toEqual([{ asked_at: AT }])
    expect(sendAttestBatchMail).not.toHaveBeenCalled()
  })

  it('gives back the chunks it claimed when a later chunk of the claim fails', async () => {
    const many = Array.from({ length: 151 }, (_, i) => `inv-${String(i).padStart(3, '0')}`)
    seed({
      supplier_invoice_attest_mail_state: [
        { data: [{ supplier_invoice_id: many[0] }] },
        { data: many.map((id) => ({ supplier_invoice_id: id, company_id: 'c1', queued_at: minutesAgo(30) })) },
        { data: many.slice(0, 150).map((id) => ({ supplier_invoice_id: id })) },
        { error: { code: '57014', message: 'canceling statement due to statement timeout' } },
        { data: null },
      ],
    })
    const result = await runAttestRequestRound(supabase(), undefined, { now: NOW })
    expect(result).toMatchObject({ invoices_asked: 0, failed_companies: 1 })
    expect(stateUpdates()).toEqual([{ asked_at: AT }, { asked_at: AT }, { asked_at: null }])
    expect(service.findCalls('supplier_invoice_attest_mail_state', 'in')).toContainEqual(['supplier_invoice_id', many.slice(0, 150)])
  })

  it('spreads the tries of a refused mail over the day: each refusal holds the next try off longer', async () => {
    seed({ supplier_invoice_attest_mail_state: ROUND_QUEUE, supplier_invoices: ROUND_INVOICES })
    sendAttestBatchMail.mockResolvedValue(REFUSED)
    await runAttestRequestRound(supabase(), undefined, { now: NOW })
    // The first try was refused: the row waits 5 minutes before the next.
    expect(batchUpdates()).toEqual([sentMark, refusedBack(NOW, 5 * 60_000), sentMark, refusedBack(NOW, 5 * 60_000)])
  })

  it('claims no notice once the run is out of time: the step is left for the next run', async () => {
    seed({
      company_attest_policies: { data: { ...POLICY, attesters: ['kim'] } },
      supplier_invoice_attest_mail_state: [
        { data: [{ supplier_invoice_id: 'by-kim' }] },
        { data: [{ supplier_invoice_id: 'by-kim', company_id: 'c1', queued_at: minutesAgo(20) }] },
        { data: [{ supplier_invoice_id: 'by-kim' }] },
      ],
      supplier_invoices: { data: [invoice('by-kim', { user_id: 'kim' })] },
    })
    // In time to take the company, out of time by the notice.
    const result = await runAttestRequestRound(supabase(), undefined, { now: NOW, clock: clockAfter(2, ATTEST_RUN_SEND_BUDGET_MS) })
    expect(result).toMatchObject({ invoices_asked: 1, blocked_notices_sent: 0 })
    expect(stateUpdates()).toEqual([{ asked_at: AT }])
    expect(sendAttestNoticeMail).not.toHaveBeenCalled()
  })

  it('takes no new company once the run is out of time: the round stays queued, unclaimed, for the next run', async () => {
    seed({ supplier_invoice_attest_mail_state: ROUND_QUEUE, supplier_invoices: ROUND_INVOICES })
    // The run starts at 0; by the time it reaches the company the claim budget is spent.
    const result = await runAttestRequestRound(supabase(), undefined, { now: NOW, clock: clockAfter(1, ATTEST_RUN_CLAIM_BUDGET_MS) })
    expect(result).toMatchObject({ companies: 0, companies_deferred: 1, invoices_asked: 0 })
    expect(stateUpdates()).toEqual([])
    expect(batchInserts()).toEqual([])
    expect(sendAttestBatchMail).not.toHaveBeenCalled()
  })

  it('starts no send past the send budget: the stored mails get their lease back untried', async () => {
    seed({ supplier_invoice_attest_mail_state: ROUND_QUEUE, supplier_invoices: ROUND_INVOICES })
    // In time to take the company, out of time by the first send.
    const result = await runAttestRequestRound(supabase(), undefined, { now: NOW, clock: clockAfter(2, ATTEST_RUN_SEND_BUDGET_MS) })
    expect(result).toMatchObject({ companies: 1, request_mails_sent: 0, request_mails_failed: 2 })
    expect(sendAttestBatchMail).not.toHaveBeenCalled()
    expect(batchUpdates()).toEqual([{ send_lease_until: FREE }, { send_lease_until: FREE }])
  })

  it('tells the registrant instead when nobody can attest, and counts a notice that may have gone out as told', async () => {
    const blockedSeed = () =>
      seed({
        company_attest_policies: { data: { ...POLICY, attesters: ['kim'] } },
        supplier_invoice_attest_mail_state: [
          { data: [{ supplier_invoice_id: 'by-kim' }] },
          { data: [{ supplier_invoice_id: 'by-kim', company_id: 'c1', queued_at: minutesAgo(20) }] },
          { data: [{ supplier_invoice_id: 'by-kim' }] },
          { data: [{ supplier_invoice_id: 'by-kim' }] },
          { data: null },
        ],
        supplier_invoices: { data: [invoice('by-kim', { user_id: 'kim' })] },
      })
    blockedSeed()
    const result = await runAttestRequestRound(supabase(), undefined, { now: NOW })
    expect(result).toMatchObject({ invoices_asked: 1, request_mails_sent: 0, blocked_notices_sent: 1 })
    expect(sendAttestBatchMail).not.toHaveBeenCalled()
    const [{ email, data }] = sendAttestNoticeMail.mock.calls[0] as [{ email: string; data: { kind: string; url: string; reason: string } }]
    expect(email).toBe('kim@client.example')
    expect(data).toMatchObject({ kind: 'blocked', url: 'https://byra.accounted.se/settings/attest', reason: 'registrant' })
    expect(stateUpdates()).toEqual([{ asked_at: AT }, { blocked_told_at: AT }])

    blockedSeed()
    sendAttestNoticeMail.mockResolvedValue(UNKNOWN)
    await runAttestRequestRound(supabase(), undefined, { now: NOW })
    expect(stateUpdates()).toEqual([{ asked_at: AT }, { blocked_told_at: AT }])

    blockedSeed()
    sendAttestNoticeMail.mockResolvedValue(REFUSED)
    await runAttestRequestRound(supabase(), undefined, { now: NOW })
    expect(stateUpdates()).toEqual([{ asked_at: AT }, { blocked_told_at: AT }, { blocked_told_at: null }])
  })
})

describe('trying again what certainly did not go', () => {
  const UNSENT = { id: 'old-1', company_id: 'c1', attester_user_id: 'kim', kind: 'request', invoice_ids: ['mf-1', 'mf-2'], send_attempts: 2 }

  beforeEach(() => {
    vi.clearAllMocks()
    sendAttestBatchMail.mockResolvedValue(SENT)
    sendAttestNoticeMail.mockResolvedValue(SENT)
  })

  function seedRetry(batches: ReturnType<typeof batchesTable>, invoices = [invoice('mf-1'), invoice('mf-2', { approved_at: '2026-10-31T11:00:00Z', status: 'approved' })]) {
    seed({
      supplier_invoice_attest_mail_state: [{ data: [{ supplier_invoice_id: 'x' }] }, { data: [] }],
      supplier_invoices: { data: invoices },
      supplier_invoice_attest_batches: batches,
    })
  }

  it('tries the same row again: one conditional update rotates its token and leases it, nothing new is stored', async () => {
    seedRetry(batchesTable({ unsent: [UNSENT] }))
    const result = await runAttestRequestRound(supabase(), undefined, { now: NOW })
    expect(result.retry).toEqual({ unsent: 1, resent: 1, retired: 0, failed: 0 })
    // Only free rows under six tries stored within the day.
    expect(service.findCalls('supplier_invoice_attest_batches', 'gte')).toContainEqual(['created_at', new Date(NOW - 24 * 60 * 60_000).toISOString()])
    expect(service.findCalls('supplier_invoice_attest_batches', 'lt')).toContainEqual(['send_attempts', 6])
    expect(service.findCalls('supplier_invoice_attest_batches', 'lt')).toContainEqual(['send_lease_until', AT])
    expect(batchInserts()).toEqual([])
    const [rotate, finish] = batchUpdates() as Array<Record<string, unknown>>
    // The token changes in the same statement that takes the try: the old link stops working, no second row exists.
    expect(rotate).toMatchObject({ invoice_ids: ['mf-1'], send_attempts: 3, send_lease_until: LEASE })
    expect(String(rotate!.token_hash)).toMatch(/^[0-9a-f]{64}$/)
    expect(service.findCalls('supplier_invoice_attest_batches', 'eq')).toContainEqual(['send_attempts', 2])
    expect(finish).toEqual(sentMark)
    expect(mailCalls()).toHaveLength(1)
    expect(mailCalls()[0]!.email).toBe('kim@client.example')
  })

  it('holds the next try off by the backoff of the try that was refused', async () => {
    seedRetry(batchesTable({ unsent: [UNSENT] }))
    sendAttestBatchMail.mockResolvedValue(REFUSED)
    await runAttestRequestRound(supabase(), undefined, { now: NOW })
    // Rotated to try 3, taken, refused: the next try waits 2 hours.
    const [rotate, take, giveBack] = batchUpdates() as Array<Record<string, unknown>>
    expect(rotate).toMatchObject({ send_attempts: 3 })
    expect(take).toEqual(sentMark)
    expect(giveBack).toEqual(refusedBack(NOW, 2 * 60 * 60_000))
  })

  it('takes no try once the run is out of time, so none is spent untried', async () => {
    seedRetry(batchesTable({ unsent: [UNSENT] }))
    // The company is taken in time; by the row the send budget is spent.
    const result = await runAttestRequestRound(supabase(), undefined, { now: NOW, clock: clockAfter(2, ATTEST_RUN_SEND_BUDGET_MS) })
    expect(result.retry).toMatchObject({ unsent: 1, resent: 0, retired: 0 })
    expect(batchUpdates()).toEqual([])
    expect(sendAttestBatchMail).not.toHaveBeenCalled()
  })

  it('sends nothing when another run took the try first', async () => {
    seedRetry(batchesTable({ unsent: [UNSENT], takes: () => false }))
    const result = await runAttestRequestRound(supabase(), undefined, { now: NOW })
    expect(result.retry).toEqual({ unsent: 1, resent: 0, retired: 0, failed: 1 })
    expect(sendAttestBatchMail).not.toHaveBeenCalled()
    expect(batchInserts()).toEqual([])
  })

  it('retires the row when nothing it listed waits on the attester any more', async () => {
    seedRetry(batchesTable({ unsent: [UNSENT] }), [invoice('mf-1', { status: 'paid' }), invoice('mf-2', { approved_at: '2026-10-31T11:00:00Z', status: 'approved' })])
    const result = await runAttestRequestRound(supabase(), undefined, { now: NOW })
    expect(result.retry).toEqual({ unsent: 1, resent: 0, retired: 1, failed: 0 })
    expect(batchUpdates()).toEqual([{ consumed_at: AT }])
    expect(sendAttestBatchMail).not.toHaveBeenCalled()
  })
})

describe('runAttestFollowUps', () => {
  const MORNING = Date.parse('2026-10-31T06:15:00Z')
  const MORNING_AT = new Date(MORNING).toISOString()
  const asked = { asked_at: '2026-10-20T09:00:00Z', reminded_early_at: null, reminded_last_at: null, overdue_told_at: null, blocked_told_at: null }
  const followUpRows = [
    { data: [{ supplier_invoice_id: 'soon' }] },
    {
      data: [
        { supplier_invoice_id: 'soon', company_id: 'c1', ...asked },
        { supplier_invoice_id: 'late', company_id: 'c1', ...asked },
      ],
    },
  ]
  const followUpInvoices = { data: [invoice('soon', { due_date: '2026-11-03' }), invoice('late', { due_date: '2026-10-25', status: 'overdue' })] }

  beforeEach(() => {
    vi.clearAllMocks()
    sendAttestBatchMail.mockResolvedValue(SENT)
    sendAttestNoticeMail.mockResolvedValue(SENT)
  })

  it('answers skipped while the migration has not reached the database', async () => {
    seed({ supplier_invoice_attest_mail_state: { error: { code: '42P01', message: 'relation does not exist' } } })
    expect((await runAttestFollowUps(supabase(), undefined, { now: MORNING })).skipped).toBe('schema_missing')
  })

  it('reminds the attesters 3 days before the due date and tells the registrant once about a due date that passed after the ask', async () => {
    seed({
      supplier_invoice_attest_mail_state: [...followUpRows, { data: [{ supplier_invoice_id: 'soon' }] }, { data: [{ supplier_invoice_id: 'late' }] }],
      supplier_invoices: followUpInvoices,
    })
    const result = await runAttestFollowUps(supabase(), undefined, { now: MORNING })
    expect(result).toEqual({
      skipped: null,
      waiting: 2,
      companies_deferred: 0,
      reminder_mails_sent: 2,
      reminder_mails_failed: 0,
      reminder_mails_unconfirmed: 0,
      overdue_notices_sent: 1,
      blocked_notices_sent: 0,
      failed_companies: 0,
    })

    const calls = mailCalls()
    expect(calls.map((c) => c.email).sort()).toEqual(['kim@client.example', 'robin@client.example'])
    expect(calls.every((c) => c.data.kind === 'reminder' && c.data.invoices.length === 1 && c.data.invoices[0]!.dueDate === '2026-11-03')).toBe(true)
    expect(batchInserts()[0]!.every((row) => row.kind === 'reminder' && JSON.stringify(row.invoice_ids) === '["soon"]')).toBe(true)

    const [{ email, data }] = sendAttestNoticeMail.mock.calls[0] as [{ email: string; data: { kind: string; url: string } }]
    expect(email).toBe('alex@byra.example')
    expect(data).toMatchObject({ kind: 'overdue', url: 'https://byra.accounted.se/supplier-invoices?tab=registered' })
    expect(stateUpdates()).toEqual([{ reminded_early_at: MORNING_AT }, { overdue_told_at: MORNING_AT }])
  })

  it('gives every reminder slot it took back when a later claim fails', async () => {
    const lastSlot = { asked_at: '2026-10-20T09:00:00Z', reminded_early_at: null, reminded_last_at: null, overdue_told_at: null, blocked_told_at: null }
    seed({
      supplier_invoice_attest_mail_state: [
        { data: [{ supplier_invoice_id: 'soon' }] },
        {
          data: [
            { supplier_invoice_id: 'soon', company_id: 'c1', ...asked },
            { supplier_invoice_id: 'tomorrow', company_id: 'c1', ...lastSlot },
          ],
        },
        { data: [{ supplier_invoice_id: 'soon' }] },
        { error: { code: '57014', message: 'canceling statement due to statement timeout' } },
        { data: null },
      ],
      supplier_invoices: { data: [invoice('soon', { due_date: '2026-11-03' }), invoice('tomorrow', { due_date: '2026-11-01' })] },
    })
    const result = await runAttestFollowUps(supabase(), undefined, { now: MORNING })
    expect(result).toMatchObject({ failed_companies: 1, reminder_mails_sent: 0 })
    expect(stateUpdates()).toEqual([{ reminded_early_at: MORNING_AT }, { reminded_last_at: MORNING_AT }, { reminded_early_at: null }])
    expect(sendAttestBatchMail).not.toHaveBeenCalled()
  })

  it('gives a refused notice back for the next run, and a refused reminder back for the request job to try again', async () => {
    seed({
      supplier_invoice_attest_mail_state: [...followUpRows, { data: [{ supplier_invoice_id: 'soon' }] }, { data: [{ supplier_invoice_id: 'late' }] }, { data: null }],
      supplier_invoices: followUpInvoices,
    })
    sendAttestBatchMail.mockResolvedValue(REFUSED)
    sendAttestNoticeMail.mockResolvedValue(REFUSED)
    const result = await runAttestFollowUps(supabase(), undefined, { now: MORNING })
    expect(result).toMatchObject({ reminder_mails_sent: 0, reminder_mails_failed: 2, overdue_notices_sent: 0 })
    // The reminder slot stays used: its stored mails are tried again by the request job.
    expect(stateUpdates()).toEqual([{ reminded_early_at: MORNING_AT }, { overdue_told_at: MORNING_AT }, { overdue_told_at: null }])
    const morningMark = { mail_sent_at: MORNING_AT, send_lease_until: FREE }
    expect(batchUpdates()).toEqual([morningMark, refusedBack(MORNING, 5 * 60_000), morningMark, refusedBack(MORNING, 5 * 60_000)])
  })
})
