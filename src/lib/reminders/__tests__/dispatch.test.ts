import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import type { BankCheckResult } from '@/lib/collections/bank-check'
import { ReminderChannelError } from '../channel'
import { createFakeReminderChannel } from '../channels/fake'
import type { ReminderContext } from '../facts'
import type { ReminderInvoiceFacts } from '../policy'

vi.mock('../facts', () => ({ loadReminderContext: vi.fn() }))
vi.mock('@/lib/collections/bank-check', () => ({ runBankCheck: vi.fn() }))

const { loadReminderContext } = await import('../facts')
const { runBankCheck } = await import('@/lib/collections/bank-check')
const { dispatchReminder } = await import('../dispatch')

// 2026-12-17 at noon in Stockholm: level 1 of an invoice due 2026-12-02 is due today.
const NOW = new Date('2026-12-17T11:00:00Z')

function facts(overrides: Partial<ReminderInvoiceFacts> = {}): ReminderInvoiceFacts {
  return {
    kind: 'invoice',
    status: 'sent',
    invoiceDate: '2026-11-02',
    dueDate: '2026-12-02',
    remaining: 2500,
    credited: false,
    delivery: 'delivered',
    imported: false,
    autogiro: false,
    recipient: 'kund@example.se',
    customerExcluded: false,
    withCollections: false,
    ...overrides,
  }
}

function context(overrides: Partial<ReminderContext> = {}, factOverrides: Partial<ReminderInvoiceFacts> = {}): ReminderContext {
  return {
    invoice: makeInvoice({ id: 'inv-1', invoice_number: 'F-1042', invoice_date: '2026-11-02', due_date: '2026-12-02', status: 'sent' }),
    customer: makeCustomer({ email: 'kund@example.se', invoice_email_cc_addresses: ['ekonomi@kund.se'] }),
    company: makeCompanySettings({
      company_name: 'Säljaren AB',
      email: 'faktura@saljaren.se',
      send_invoice_reminders: true,
      reminders_enabled_at: '2026-11-01T09:00:00Z',
      reminder_days_level_1: 15,
      reminder_days_level_2: 30,
      reminder_days_level_3: 45,
    }),
    companyInactive: false,
    amount: 2500,
    facts: facts(factOverrides),
    history: [],
    ...overrides,
  }
}

function bank(outcome: BankCheckResult['outcome']): BankCheckResult {
  return { outcome, freshness: outcome === 'pass' || outcome === 'candidates' ? 'fresh' : outcome, checkedAt: NOW.toISOString(), payeeAccounts: [], candidates: [], lastSyncedAt: null }
}

/** invoice_reminders only: the reservation insert and the status updates. */
function fakeDb(options: { reserveError?: { code: string; message: string }; updateError?: { message: string } } = {}) {
  const inserts: Record<string, unknown>[] = []
  const updates: Record<string, unknown>[] = []
  const db = {
    from(table: string) {
      if (table !== 'invoice_reminders') throw new Error(`unexpected table ${table}`)
      return {
        insert(row: Record<string, unknown>) {
          inserts.push(row)
          return {
            select: () => ({
              single: async () =>
                options.reserveError ? { data: null, error: options.reserveError } : { data: { id: 'rem-1', action_token: 'tok-1' }, error: null },
            }),
          }
        },
        update(patch: Record<string, unknown>) {
          updates.push(patch)
          const chain = {
            eq: () => chain,
            then: (resolve: (value: { error: unknown }) => void) => resolve({ error: options.updateError ?? null }),
          }
          return chain
        },
      }
    },
  }
  return { db: db as unknown as SupabaseClient, inserts, updates }
}

const PDF = { filename: 'Faktura F-1042.pdf', content: Buffer.from('%PDF-1.7') }

function deps(db: SupabaseClient, channel = createFakeReminderChannel(), sendingEnabled = true) {
  return {
    db,
    channel,
    now: () => NOW,
    sendingEnabled,
    baseUrl: async () => 'https://app.accounted.se',
    sender: async () => ({}),
    invoicePdf: async (): Promise<typeof PDF | null> => PDF,
  }
}

const INPUT = { companyId: 'company-1', invoiceId: 'inv-1', level: 1 as const, actorUserId: 'user-1', mode: 'approved' as const }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadReminderContext).mockResolvedValue(context())
  vi.mocked(runBankCheck).mockResolvedValue(bank('pass'))
})

describe('dispatchReminder: gates', () => {
  it('sends nothing and reads nothing while the product switch is off', async () => {
    const { db, inserts } = fakeDb()
    expect(await dispatchReminder(deps(db, undefined, false), INPUT)).toEqual({ status: 'skipped', reason: 'sending_off' })
    expect(loadReminderContext).not.toHaveBeenCalled()
    expect(inserts).toHaveLength(0)
  })

  it('never reminds for an archived, reset or sandbox company', async () => {
    vi.mocked(loadReminderContext).mockResolvedValue(context({ companyInactive: true }))
    const { db } = fakeDb()
    for (const mode of ['approved', 'automatic', 'manual'] as const) {
      expect(await dispatchReminder(deps(db), { ...INPUT, mode })).toEqual({ status: 'skipped', reason: 'company_inactive' })
    }
  })

  it('runs the ladder only where the company turned reminders on; a pick needs only the product switch', async () => {
    vi.mocked(loadReminderContext).mockResolvedValue(
      context({ company: makeCompanySettings({ send_invoice_reminders: false, reminders_enabled_at: null }) }),
    )
    const { db } = fakeDb()
    expect(await dispatchReminder(deps(db), INPUT)).toEqual({ status: 'skipped', reason: 'reminders_off' })
    expect(await dispatchReminder(deps(db), { ...INPUT, mode: 'automatic' })).toEqual({ status: 'skipped', reason: 'reminders_off' })
    expect(await dispatchReminder(deps(db), { ...INPUT, mode: 'manual' })).toMatchObject({ status: 'sent' })
  })

  it('re-decides from fresh facts: a policy skip, or another level than approved', async () => {
    vi.mocked(loadReminderContext).mockResolvedValue(context({}, { status: 'paid', remaining: 0 }))
    const { db, inserts } = fakeDb()
    expect(await dispatchReminder(deps(db), INPUT)).toEqual({ status: 'skipped', reason: 'paid' })
    vi.mocked(loadReminderContext).mockResolvedValue(context())
    expect(await dispatchReminder(deps(db), { ...INPUT, level: 2 })).toEqual({ status: 'skipped', reason: 'changed' })
    expect(inserts).toHaveLength(0)
  })

  it('stops on a possible payment in the bank, whoever approved', async () => {
    vi.mocked(runBankCheck).mockResolvedValue(bank('candidates'))
    const { db } = fakeDb()
    expect(await dispatchReminder(deps(db), { ...INPUT, bankAttested: true })).toEqual({ status: 'skipped', reason: 'possible_payment' })
  })

  it('needs a fresh bank, or a person who approved with the stale bank shown, never in automatic mode', async () => {
    for (const outcome of ['stale', 'no_bank'] as const) {
      vi.mocked(runBankCheck).mockResolvedValue(bank(outcome))
      const { db } = fakeDb()
      expect(await dispatchReminder(deps(db), INPUT), outcome).toEqual({ status: 'skipped', reason: 'bank_not_fresh' })
      expect(await dispatchReminder(deps(db), { ...INPUT, mode: 'automatic', bankAttested: true }), outcome).toEqual({
        status: 'skipped',
        reason: 'bank_not_fresh',
      })
      expect(await dispatchReminder(deps(db), { ...INPUT, bankAttested: true }), outcome).toMatchObject({ status: 'sent' })
    }
  })

  it("sends the level the policy decides when a person's pick names none", async () => {
    const { db, inserts } = fakeDb()
    const { level: _level, ...pick } = INPUT
    expect(await dispatchReminder(deps(db), { ...pick, mode: 'manual' })).toMatchObject({ status: 'sent', level: 1 })
    expect(inserts[0]).toMatchObject({ reminder_level: 1, mode: 'manual' })
  })

  it('sends nothing when the level is already on record', async () => {
    const { db } = fakeDb({ reserveError: { code: '23505', message: 'duplicate key value violates unique constraint' } })
    const channel = createFakeReminderChannel()
    expect(await dispatchReminder(deps(db, channel), INPUT)).toEqual({ status: 'skipped', reason: 'already_sent' })
    expect(channel.sent).toHaveLength(0)
  })
})

describe('dispatchReminder: the send', () => {
  it('reserves the row, sends to the customer with the copies, and records it as sent', async () => {
    const { db, inserts, updates } = fakeDb()
    const channel = createFakeReminderChannel()

    const outcome = await dispatchReminder(deps(db, channel), INPUT)

    expect(outcome).toEqual({ status: 'sent', reminderId: 'rem-1', level: 1, providerMessageId: 'fake-1', recorded: true })
    expect(inserts).toEqual([
      expect.objectContaining({
        invoice_id: 'inv-1',
        company_id: 'company-1',
        user_id: 'user-1',
        reminder_level: 1,
        mode: 'approved',
        status: 'reserved',
        email_to: 'kund@example.se',
      }),
    ])
    const [message] = channel.sent
    expect(message).toMatchObject({ to: ['kund@example.se'], cc: ['ekonomi@kund.se'], replyTo: 'faktura@saljaren.se', fromName: 'Säljaren AB' })
    expect(message.subject).toMatch(/^Vänlig påminnelse: Faktura F-1042/)
    expect(message.html).toContain('https://app.accounted.se/invoice-action/tok-1')
    expect(message.attachments).toEqual([{ filename: 'Faktura F-1042.pdf', content: PDF.content, contentType: 'application/pdf' }])
    expect(updates).toEqual([
      expect.objectContaining({ status: 'sent', sent_at: NOW.toISOString(), provider: 'fake', provider_message_id: 'fake-1' }),
    ])
  })

  it('sends without the invoice PDF when the archive has none or cannot give it', async () => {
    for (const invoicePdf of [async () => null, async () => Promise.reject(new Error('storage down'))]) {
      const { db } = fakeDb()
      const channel = createFakeReminderChannel()
      expect(await dispatchReminder({ ...deps(db, channel), invoicePdf }, INPUT)).toMatchObject({ status: 'sent' })
      expect(channel.sent[0]!.attachments).toBeUndefined()
    }
  })

  it('asks for payment by its send date plus eight days in the final reminder', async () => {
    vi.mocked(loadReminderContext).mockResolvedValue(
      context({
        history: [
          { level: 1, status: 'sent', sentOn: '2026-11-17', providerStatus: 'delivered', responseType: null, legacy: false },
          { level: 2, status: 'sent', sentOn: '2026-12-02', providerStatus: 'delivered', responseType: null, legacy: false },
        ],
      }, { dueDate: '2026-11-02', invoiceDate: '2026-11-02' }),
    )
    const { db } = fakeDb()
    const channel = createFakeReminderChannel()
    expect(await dispatchReminder(deps(db, channel), { ...INPUT, level: 3 })).toMatchObject({ status: 'sent' })
    expect(channel.sent[0]!.text).toContain('senast den 2026-12-25')
  })

  it('records a failed send, and says when the outcome is unknown', async () => {
    const { db, updates } = fakeDb()
    const channel = createFakeReminderChannel()
    channel.fail(new ReminderChannelError('EMAIL_SEND_THREW', { outcomeUnknown: true }))

    expect(await dispatchReminder(deps(db, channel), INPUT)).toEqual({
      status: 'failed',
      reminderId: 'rem-1',
      code: 'EMAIL_SEND_THREW',
      outcomeUnknown: true,
    })
    expect(updates).toEqual([expect.objectContaining({ status: 'failed', failed_at: NOW.toISOString(), error_code: 'EMAIL_SEND_THREW' })])
  })

  it('says so when a sent reminder could not be recorded as sent', async () => {
    const { db } = fakeDb({ updateError: { message: 'connection reset' } })
    expect(await dispatchReminder(deps(db), INPUT)).toMatchObject({ status: 'sent', recorded: false })
  })
})
