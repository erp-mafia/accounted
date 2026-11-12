import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  configured: vi.fn(),
  recipients: vi.fn(),
  sender: vi.fn(),
  states: vi.fn(),
  totals: vi.fn(),
}))
vi.mock('@/lib/email/service', () => ({
  getEmailService: async () => ({ sendEmail: (...a: unknown[]) => mocks.sendEmail(...a), isConfigured: () => mocks.configured() }),
}))
vi.mock('@/lib/email/brand-sender', () => ({
  getSenderForCompany: (...a: unknown[]) => mocks.sender(...a),
  getBaseUrlForBrand: (brand: { domain: string } | null) => (brand ? `https://${brand.domain}` : 'https://app.gnubok.se'),
}))
vi.mock('@/lib/notifications/member-email', () => ({
  resolveCompanyAdminEmails: (...a: unknown[]) => mocks.recipients(...a),
}))
vi.mock('../switch-campaign', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../switch-campaign')>()),
  switchStatesForCompanies: (...a: unknown[]) => mocks.states(...a),
  bankSwitchProgressTotals: (...a: unknown[]) => mocks.totals(...a),
}))

import { createTableMockSupabase, type TableMockResolver, type TableMockResult } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CompanySwitchState } from '../switch-campaign'
import {
  BYRA_NUDGE_COOLDOWN_DAYS,
  byraNudgeAllowed,
  campaignMailDue,
  isByraManaged,
  reminderKindDue,
  runBankSwitchReminderCron,
  sendBankSwitchMail,
  sendByraNudge,
  SWITCH_REMINDER_RUN_BUDGET_MS,
} from '../switch-notifications'

const NOW = new Date('2026-10-26T06:30:00Z')
const DEADLINE = '2026-11-09'
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never

function state(overrides: Partial<CompanySwitchState> = {}): CompanySwitchState {
  return {
    state: 'pending',
    pending: [{ connection_id: '11111111-1111-4111-8111-111111111111', bank_name: 'Swedbank' }],
    uncovered: [],
    open_payments: 0,
    deadline: DEADLINE,
    days_left: 14,
    passed: false,
    urgent: true,
    ...overrides,
  }
}

/**
 * The send log, answering by what is asked: the insert of a log row answers
 * its id, a delete nothing, and a read `reads` (the rows already logged, or
 * the last nudge).
 */
function sendLog(reads: TableMockResult = { data: [] }): TableMockResolver {
  return (chain) => {
    if (chain.some((c) => c.method === 'insert')) return { data: { id: 'log-1' } }
    if (chain.some((c) => c.method === 'delete')) return { data: null }
    return reads
  }
}

function stub(tables: Record<string, TableMockResult | TableMockResult[] | TableMockResolver> = {}) {
  const mock = createTableMockSupabase({
    companies: { data: { team_id: null } },
    teams: { data: null },
    company_settings: { data: { company_name: 'Exempelbolaget AB' } },
    bank_switch_notifications: sendLog(),
    ...tables,
  })
  return { ...mock, service: mock.supabase as unknown as SupabaseClient }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.configured.mockReturnValue(true)
  mocks.sendEmail.mockResolvedValue({ success: true, messageId: 'm-1' })
  mocks.recipients.mockResolvedValue(['anna@example.se', 'bo@example.se'])
  mocks.sender.mockResolvedValue({ fromName: null, fromAddress: null, replyTo: null, brand: null })
  mocks.states.mockResolvedValue(new Map())
  mocks.totals.mockResolvedValue({ companies: { pending: 0, uncovered: 0, done: 0 }, connections: { pending: 0, uncovered: 0, switched: 0 }, banks: [] })
})
afterEach(() => vi.unstubAllEnvs())

describe('reminderKindDue', () => {
  it('is null more than 14 days out, then the reminder of the smallest threshold the day is inside', () => {
    const none = new Set<string>()
    expect(reminderKindDue(20, none)).toBeNull()
    expect(reminderKindDue(14, none)).toBe('reminder_14')
    expect(reminderKindDue(10, none)).toBe('reminder_14')
    expect(reminderKindDue(7, none)).toBe('reminder_7')
    expect(reminderKindDue(3, none)).toBe('reminder_3')
    expect(reminderKindDue(2, none)).toBe('reminder_3')
    expect(reminderKindDue(1, none)).toBe('reminder_1')
    expect(reminderKindDue(0, none)).toBe('reminder_1')
    expect(reminderKindDue(-3, none)).toBe('reminder_1')
  })

  it('never repeats a reminder and never sends two for one day', () => {
    expect(reminderKindDue(10, new Set(['reminder_14']))).toBeNull()
    expect(reminderKindDue(5, new Set(['reminder_14']))).toBe('reminder_7')
    expect(reminderKindDue(5, new Set(['reminder_7']))).toBeNull()
    expect(reminderKindDue(1, new Set(['reminder_14', 'reminder_7', 'reminder_3', 'reminder_1']))).toBeNull()
  })
})

describe('campaignMailDue', () => {
  it('announces first, then the reminders through the deadline day, then only the one sunset mail', () => {
    expect(campaignMailDue(20, new Set())).toBe('announcement')
    expect(campaignMailDue(10, new Set(['announcement']))).toBe('reminder_14')
    expect(campaignMailDue(1, new Set(['announcement', 'reminder_14', 'reminder_7', 'reminder_3']))).toBe('reminder_1')
    // The deadline day itself: the feed still runs, so it is still "i dag är sista dagen".
    expect(campaignMailDue(0, new Set(['announcement', 'reminder_14', 'reminder_7', 'reminder_3']))).toBe('reminder_1')
    expect(campaignMailDue(0, new Set(['announcement', 'reminder_1']))).toBeNull()
    // The day the feed stops: the sunset mail, whatever went before.
    expect(campaignMailDue(-1, new Set(['announcement', 'reminder_14', 'reminder_7', 'reminder_3', 'reminder_1']))).toBe('sunset')
    expect(campaignMailDue(-1, new Set())).toBe('sunset')
    // A run that missed the day sends it later; once sent, nothing more ever.
    expect(campaignMailDue(-3, new Set(['announcement']))).toBe('sunset')
    expect(campaignMailDue(-1, new Set(['sunset']))).toBeNull()
    expect(campaignMailDue(-30, new Set(['announcement', 'sunset']))).toBeNull()
  })
})

describe('byraNudgeAllowed', () => {
  it('allows the first nudge and one every seven days', () => {
    expect(byraNudgeAllowed(null, NOW)).toBe(true)
    expect(byraNudgeAllowed(new Date(NOW.getTime() - 6 * 86_400_000).toISOString(), NOW)).toBe(false)
    expect(byraNudgeAllowed(new Date(NOW.getTime() - BYRA_NUDGE_COOLDOWN_DAYS * 86_400_000).toISOString(), NOW)).toBe(true)
    expect(byraNudgeAllowed('not a date', NOW)).toBe(true)
  })
})

describe('isByraManaged', () => {
  it('is true for a company on a byrå team only', async () => {
    expect(await isByraManaged(stub({ companies: { data: { team_id: 't-1' } }, teams: { data: { kind: 'byra' } } }).service, 'co-1')).toBe(true)
    expect(await isByraManaged(stub({ companies: { data: { team_id: 't-1' } }, teams: { data: { kind: 'personal' } } }).service, 'co-1')).toBe(false)
    expect(await isByraManaged(stub().service, 'co-1')).toBe(false)
  })
})

describe('sendBankSwitchMail', () => {
  it('mails the owners and admins in one send, in the company\'s brand, and logs the kind', async () => {
    mocks.sender.mockResolvedValue({ fromName: 'Siffra', fromAddress: 'noreply@post.siffra.se', replyTo: 'support@siffra.se', brand: { domain: 'app.siffra.se' } })
    const { service, payloads } = stub({ companies: { data: { team_id: 't-1' } }, teams: { data: { kind: 'byra' } } })
    const result = await sendBankSwitchMail(service, { companyId: 'co-1', kind: 'announcement', state: state(), log })
    expect(result).toEqual({ outcome: 'sent', recipients: 2 })
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1)
    const mail = mocks.sendEmail.mock.calls[0][0] as { to: string[]; subject: string; html: string; text: string; fromName: string; fromAddress: string; replyTo: string }
    expect(mail.to).toEqual(['anna@example.se', 'bo@example.se'])
    expect(mail.fromName).toBe('Siffra')
    expect(mail.fromAddress).toBe('noreply@post.siffra.se')
    expect(mail.replyTo).toBe('support@siffra.se')
    expect(mail.subject).toContain('Swedbank')
    expect(mail.subject).toContain('Exempelbolaget AB')
    // The deep link in the brand's domain, and the byrå note since the company is a client.
    expect(mail.html).toContain('https://app.siffra.se/settings/connections?bank_connect_switch=11111111-1111-4111-8111-111111111111')
    expect(mail.text).toContain('inte av byrån')
    expect(payloads('bank_switch_notifications', 'insert')).toEqual([{ company_id: 'co-1', kind: 'announcement', recipient_count: 2 }])
  })

  it('answers no_recipient without sending, and not_configured without the email extension', async () => {
    const { service } = stub()
    mocks.recipients.mockResolvedValue([])
    expect(await sendBankSwitchMail(service, { companyId: 'co-1', kind: 'reminder_7', state: state() })).toEqual({ outcome: 'no_recipient', recipients: 0 })
    mocks.recipients.mockResolvedValue(['a@b.se'])
    mocks.configured.mockReturnValue(false)
    expect(await sendBankSwitchMail(service, { companyId: 'co-1', kind: 'reminder_7', state: state() })).toEqual({ outcome: 'not_configured', recipients: 0 })
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it('writes the log row before the mail is handed over, so a run killed or started again in between finds it', async () => {
    // The row used to be written after the send: the one job here that could mail the same people twice.
    const { service, calls } = stub()
    mocks.sendEmail.mockImplementation(async () => {
      expect(calls.some((c) => c.table === 'bank_switch_notifications' && c.method === 'insert')).toBe(true)
      return { success: true }
    })
    expect(await sendBankSwitchMail(service, { companyId: 'co-1', kind: 'reminder_7', state: state(), log })).toEqual({ outcome: 'sent', recipients: 2 })
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1)
    // Two runs at the same moment are one mail at the provider: same company, kind and day.
    expect(mocks.sendEmail.mock.calls[0][0]).toMatchObject({ idempotencyKey: 'bank-switch:co-1:reminder_7:14' })
  })

  it('takes the log row off again when the provider refused the mail, so the next run tries again', async () => {
    mocks.sendEmail.mockResolvedValue({ success: false, error: 'invalid recipient', outcomeUnknown: false })
    const { service, payloads, findCalls } = stub()
    expect(await sendBankSwitchMail(service, { companyId: 'co-1', kind: 'reminder_3', state: state(), log })).toEqual({ outcome: 'failed', recipients: 2, reason: 'invalid recipient' })
    expect(payloads('bank_switch_notifications', 'insert')).toHaveLength(1)
    expect(findCalls('bank_switch_notifications', 'delete')).toHaveLength(1)
    expect(findCalls('bank_switch_notifications', 'eq')).toContainEqual(['id', 'log-1'])
  })

  const unclearAnswers = [
    async () => ({ success: false, error: 'socket hang up', outcomeUnknown: true }),
    // A service that cannot tell is read as unknown too.
    async () => ({ success: false, error: 'boom' }),
    async () => {
      throw new Error('timeout')
    },
  ]

  it('asks once more with the same key on an unclear answer, and a clear second answer settles it', async () => {
    mocks.sendEmail.mockImplementationOnce(unclearAnswers[0]!).mockResolvedValueOnce({ success: true, messageId: 'm-1' })
    const { service, findCalls } = stub()
    expect(await sendBankSwitchMail(service, { companyId: 'co-1', kind: 'reminder_7', state: state(), log })).toEqual({ outcome: 'sent', recipients: 2 })
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2)
    // The provider answers a key it has seen with the first request's result: never a second mail.
    const keys = mocks.sendEmail.mock.calls.map((c) => (c[0] as { idempotencyKey: string }).idempotencyKey)
    expect(keys).toEqual(['bank-switch:co-1:reminder_7:14', 'bank-switch:co-1:reminder_7:14'])
    expect(findCalls('bank_switch_notifications', 'delete')).toEqual([])
  })

  it('keeps the log row of the announcement and the 14, 7 and 3 day reminders when the answer stays unclear: a later mail follows', async () => {
    const errors = (log as unknown as { error: ReturnType<typeof vi.fn> }).error
    for (const kind of ['announcement', 'reminder_14', 'reminder_7', 'reminder_3'] as const) {
      for (const answer of unclearAnswers) {
        errors.mockClear()
        mocks.sendEmail.mockReset().mockImplementation(answer)
        const { service, payloads, findCalls } = stub()
        expect(await sendBankSwitchMail(service, { companyId: 'co-1', kind, state: state(), log })).toMatchObject({ outcome: 'failed', recipients: 2 })
        expect(mocks.sendEmail).toHaveBeenCalledTimes(2)
        expect(payloads('bank_switch_notifications', 'insert')).toHaveLength(1)
        expect(findCalls('bank_switch_notifications', 'delete')).toEqual([])
        // A mail that may be missing is an error, not a warning.
        expect(errors).toHaveBeenCalledTimes(1)
      }
    }
  })

  it('takes the log row off the last day\'s reminder and the sunset mail when the answer stays unclear: nothing follows them', async () => {
    // A duplicate costs less than a company never told its bank feed stops.
    const errors = (log as unknown as { error: ReturnType<typeof vi.fn> }).error
    for (const kind of ['reminder_1', 'sunset'] as const) {
      for (const answer of unclearAnswers) {
        errors.mockClear()
        mocks.sendEmail.mockReset().mockImplementation(answer)
        const { service, findCalls } = stub()
        expect(await sendBankSwitchMail(service, { companyId: 'co-1', kind, state: state({ days_left: kind === 'sunset' ? -1 : 1 }), log })).toMatchObject({ outcome: 'failed' })
        expect(mocks.sendEmail).toHaveBeenCalledTimes(2)
        expect(findCalls('bank_switch_notifications', 'delete')).toHaveLength(1)
        expect(errors).toHaveBeenCalledWith('bank switch mail got no clear answer twice; the next run sends it again, so it may arrive twice', expect.objectContaining({ companyId: 'co-1', kind }))
      }
    }
  })

  it('does not send when the log row cannot be written', async () => {
    const { service } = stub({ bank_switch_notifications: { error: { message: 'insert refused' } } })
    expect(await sendBankSwitchMail(service, { companyId: 'co-1', kind: 'announcement', state: state(), log })).toEqual({ outcome: 'failed', recipients: 2, reason: 'insert refused' })
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it('links to Kopplingar, not a connection, when several banks wait', async () => {
    const { service } = stub()
    await sendBankSwitchMail(service, {
      companyId: 'co-1',
      kind: 'announcement',
      state: state({ pending: [{ connection_id: 'a', bank_name: 'Swedbank' }, { connection_id: 'b', bank_name: 'SEB' }] }),
    })
    const mail = mocks.sendEmail.mock.calls[0][0] as { html: string }
    expect(mail.html).toContain('https://app.gnubok.se/settings/connections"')
    expect(mail.html).not.toContain('bank_connect_switch')
  })
})

describe('sendByraNudge', () => {
  it('refuses a client with nothing pending, and one nudged within seven days', async () => {
    const { service } = stub()
    expect(await sendByraNudge(service, { companyId: 'co-1', state: state({ state: 'done', pending: [] }), now: NOW })).toMatchObject({ outcome: 'not_pending' })
    expect(await sendByraNudge(service, { companyId: 'co-1', state: null, now: NOW })).toMatchObject({ outcome: 'not_pending' })
    const recent = stub({ bank_switch_notifications: sendLog({ data: { sent_at: new Date(NOW.getTime() - 86_400_000).toISOString() } }) })
    expect(await sendByraNudge(recent.service, { companyId: 'co-1', state: state(), now: NOW })).toMatchObject({ outcome: 'recently_sent', recipients: 0 })
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it('does not block the byrå for a week after a nudge whose answer stayed unclear', async () => {
    mocks.sendEmail.mockResolvedValue({ success: false, error: 'socket hang up', outcomeUnknown: true })
    const { service, findCalls } = stub({ bank_switch_notifications: sendLog({ data: null }) })
    expect(await sendByraNudge(service, { companyId: 'co-1', state: state(), now: NOW })).toMatchObject({ outcome: 'failed' })
    expect(findCalls('bank_switch_notifications', 'delete')).toHaveLength(1)
  })

  it('sends the announcement as a byra_nudge and logs it under that kind', async () => {
    const { service, payloads, findCalls } = stub({ bank_switch_notifications: sendLog({ data: null }) })
    const result = await sendByraNudge(service, { companyId: 'co-1', state: state(), now: NOW })
    expect(result).toMatchObject({ outcome: 'sent', recipients: 2, last_sent_at: null })
    expect(findCalls('bank_switch_notifications', 'eq')).toContainEqual(['kind', 'byra_nudge'])
    expect(payloads('bank_switch_notifications', 'insert')).toEqual([{ company_id: 'co-1', kind: 'byra_nudge', recipient_count: 2 }])
  })
})

describe('runBankSwitchReminderCron', () => {
  const env = { OPENPAYMENTS_SWITCH_DEADLINE: DEADLINE, OPENPAYMENTS_SWITCH_MAILS: 'true' }

  it('does nothing while the campaign is off', async () => {
    const { service, tables } = stub()
    const result = await runBankSwitchReminderCron(service, log, { now: NOW, env: {} })
    expect(result).toMatchObject({ campaign: false, mails: false, deadline: null, sent: { announcement: 0, reminder: 0 } })
    expect(mocks.states).not.toHaveBeenCalled()
    expect(tables()).toEqual([])
  })

  it('counts but sends nothing while the mails are off', async () => {
    mocks.states.mockResolvedValue(new Map([['co-1', state()], ['co-2', state({ state: 'done', pending: [] })], ['co-3', state({ state: 'uncovered', pending: [] })]]))
    const { service } = stub()
    const result = await runBankSwitchReminderCron(service, log, { now: NOW, env: { OPENPAYMENTS_SWITCH_DEADLINE: DEADLINE } })
    expect(result).toMatchObject({ campaign: true, mails: false, deadline: DEADLINE, days_left: 14, companies: { pending: 1, uncovered: 1, done: 1 }, sent: { announcement: 0, reminder: 0 } })
    expect(result.totals).not.toBeNull()
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it('sends the announcement once per pending company, and only that on the first day', async () => {
    mocks.states.mockResolvedValue(new Map([['co-1', state()], ['co-2', state({ state: 'done', pending: [] })]]))
    const { service, payloads } = stub()
    const result = await runBankSwitchReminderCron(service, log, { now: NOW, env })
    expect(result.sent).toEqual({ announcement: 1, reminder: 0, sunset: 0 })
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1)
    expect(payloads('bank_switch_notifications', 'insert')).toEqual([{ company_id: 'co-1', kind: 'announcement', recipient_count: 2 }])
  })

  it('sends the reminders at 14, 7, 3 and 1 days, each once, and nothing on the other days', async () => {
    const days = [20, 14, 10, 7, 5, 3, 2, 1, 0]
    const sent = new Set<string>(['announcement'])
    const kinds: Array<string | null> = []
    for (const daysLeft of days) {
      mocks.states.mockResolvedValue(new Map([['co-1', state({ days_left: daysLeft, urgent: daysLeft <= 14 })]]))
      const { service } = stub({ bank_switch_notifications: sendLog({ data: [...sent].map((kind) => ({ company_id: 'co-1', kind })) }) })
      mocks.sendEmail.mockClear()
      const result = await runBankSwitchReminderCron(service, log, { now: NOW, env })
      if (result.sent.reminder === 1) {
        const mail = mocks.sendEmail.mock.calls[0][0] as { subject: string }
        const kind = `reminder_${[1, 3, 7, 14].find((t) => daysLeft <= t)}`
        sent.add(kind)
        kinds.push(kind)
        expect(mail.subject).toMatch(/Påminnelse/)
      } else {
        kinds.push(null)
        expect(result.skipped.already).toBe(1)
      }
    }
    expect(kinds).toEqual([null, 'reminder_14', null, 'reminder_7', null, 'reminder_3', null, 'reminder_1', null])
  })

  it('catches up on a missed day with the current threshold only, and sends the sunset mail after the deadline', async () => {
    mocks.states.mockResolvedValue(new Map([['co-1', state({ days_left: 5 })]]))
    let { service } = stub({ bank_switch_notifications: sendLog({ data: [{ company_id: 'co-1', kind: 'announcement' }] }) })
    expect((await runBankSwitchReminderCron(service, log, { now: NOW, env })).sent.reminder).toBe(1)
    expect((mocks.sendEmail.mock.calls[0][0] as { text: string }).text).toMatch(/5 dagar kvar/)
    mocks.sendEmail.mockClear()
    mocks.states.mockResolvedValue(new Map([['co-1', state({ days_left: -2, passed: true })]]))
    ;({ service } = stub({ bank_switch_notifications: sendLog({ data: [{ company_id: 'co-1', kind: 'announcement' }, { company_id: 'co-1', kind: 'reminder_7' }] }) }))
    const result = await runBankSwitchReminderCron(service, log, { now: NOW, env })
    expect(result.sent).toEqual({ announcement: 0, reminder: 0, sunset: 1 })
    expect((mocks.sendEmail.mock.calls[0][0] as { subject: string }).subject).toMatch(/Från i dag hämtar den gamla kopplingen inga transaktioner/)
  })

  it('sends the sunset mail once per pending company on the day the feed stops, logged as sunset, and nothing after', async () => {
    mocks.states.mockResolvedValue(new Map([
      ['co-1', state({ days_left: -1, passed: true })],
      ['co-2', state({ days_left: -1, passed: true })],
      ['co-3', state({ state: 'uncovered', pending: [], uncovered: [{ connection_id: 'w', bank_name: 'Wise' }], days_left: -1, passed: true })],
    ]))
    // co-1 got every reminder, co-2 never even the announcement: both get the one final mail.
    const everyReminder = ['announcement', 'reminder_14', 'reminder_7', 'reminder_3', 'reminder_1'].map((kind) => ({ company_id: 'co-1', kind }))
    let { service, payloads } = stub({ bank_switch_notifications: sendLog({ data: everyReminder }) })
    const day = await runBankSwitchReminderCron(service, log, { now: NOW, env })
    expect(day.sent).toEqual({ announcement: 0, reminder: 0, sunset: 2 })
    expect(payloads('bank_switch_notifications', 'insert')).toEqual([
      { company_id: 'co-1', kind: 'sunset', recipient_count: 2 },
      { company_id: 'co-2', kind: 'sunset', recipient_count: 2 },
    ])
    for (const call of mocks.sendEmail.mock.calls) {
      expect((call[0] as { subject: string }).subject).toMatch(/Från i dag hämtar den gamla kopplingen inga transaktioner/)
    }
    // The day after: the log holds the sunset mail, nothing goes again.
    mocks.sendEmail.mockClear()
    mocks.states.mockResolvedValue(new Map([['co-1', state({ days_left: -2, passed: true })], ['co-2', state({ days_left: -2, passed: true })]]))
    ;({ service, payloads } = stub({ bank_switch_notifications: sendLog({ data: [...everyReminder, { company_id: 'co-1', kind: 'sunset' }, { company_id: 'co-2', kind: 'sunset' }] }) }))
    const after = await runBankSwitchReminderCron(service, log, { now: NOW, env })
    expect(after.sent).toEqual({ announcement: 0, reminder: 0, sunset: 0 })
    expect(after.skipped.already).toBe(2)
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it('counts companies without recipients and failed sends without stopping the run', async () => {
    mocks.states.mockResolvedValue(new Map([['co-1', state()], ['co-2', state()], ['co-3', state()]]))
    mocks.recipients.mockImplementation(async (_s: unknown, companyId: string) => (companyId === 'co-2' ? [] : ['x@y.se']))
    mocks.sendEmail.mockResolvedValueOnce({ success: false, error: 'boom', outcomeUnknown: false }).mockResolvedValue({ success: true })
    const { service } = stub()
    const result = await runBankSwitchReminderCron(service, log, { now: NOW, env })
    expect(result.sent.announcement).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.skipped.no_recipient).toBe(1)
  })

  it('stops starting companies at the run\'s deadline, before writing any log row, and reports the ones it did not reach', async () => {
    // A kill between writing a company's log row and handing its mail over would lose that mail without a trace.
    mocks.states.mockResolvedValue(new Map([['co-1', state()], ['co-2', state()], ['co-3', state()]]))
    const errors = (log as unknown as { error: ReturnType<typeof vi.fn> }).error
    errors.mockClear()
    const startedAt = Date.now()
    const clock = vi.spyOn(Date, 'now')
    try {
      mocks.sendEmail.mockImplementation(async () => {
        // The first company's mail used up the run.
        clock.mockReturnValue(startedAt + SWITCH_REMINDER_RUN_BUDGET_MS)
        return { success: true }
      })
      const { service, payloads } = stub()
      const result = await runBankSwitchReminderCron(service, log, { now: NOW, env, startedAt })
      expect(result).toMatchObject({ sent: { announcement: 1 }, not_reached: 2 })
      expect(payloads('bank_switch_notifications', 'insert')).toHaveLength(1)
      expect(errors).toHaveBeenCalledWith('bank switch reminders ran out of time before every company was reached', { notReached: 2, reached: 1 })
    } finally {
      clock.mockRestore()
    }
  })

  it('survives a counter RPC that is not there yet', async () => {
    mocks.totals.mockRejectedValue(new Error('function does not exist'))
    mocks.states.mockResolvedValue(new Map())
    const { service } = stub()
    const result = await runBankSwitchReminderCron(service, log, { now: NOW, env })
    expect(result.totals).toBeNull()
    expect(result.campaign).toBe(true)
  })
})
