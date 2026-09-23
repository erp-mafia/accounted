import { describe, it, expect, beforeAll, beforeEach, vi, type Mock } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Consent polarity for the cron send pipeline.
 *
 * The invariant under test: a notification_settings row that CANNOT BE READ
 * (RLS failure, network error, schema drift) must mean DO NOT SEND, while a
 * row that genuinely DOES NOT EXIST means the user never touched the toggles
 * and the defaults apply. PostgREST distinguishes the two: `.maybeSingle()`
 * yields `{ data: null, error: null }` for zero rows and a non-null `error`
 * for a failed read. Collapsing both into "settings undefined" made every
 * gate of the form `if (settings && !settings.x_enabled)` fail open: a user
 * who had opted out would be notified anyway whenever the read failed.
 *
 * The stub below emulates PostgREST semantics (not the implementation) so the
 * same tests are meaningful against both the old `.single()` reads and the
 * shared readNotificationSettings() helper.
 */

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn().mockResolvedValue(undefined),
  },
}))

const USER_ID = '11111111-1111-4111-8111-111111111111'
const SUBSCRIPTION = {
  endpoint: 'https://push.example.test/v1/synthetic-endpoint',
  p256dh: 'synthetic-p256dh',
  auth: 'synthetic-auth',
}

const todayStr = () => {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return today.toISOString().split('T')[0]
}

/** A full notification_settings row; quiet window is zero-length so time of day never skips a send. */
function settingsRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    user_id: USER_ID,
    tax_deadlines_enabled: true,
    invoice_reminders_enabled: true,
    quiet_start: '00:00',
    quiet_end: '00:00',
    email_enabled: true,
    push_enabled: true,
    period_locked_enabled: true,
    period_year_closed_enabled: true,
    invoice_sent_enabled: false,
    receipt_extracted_enabled: true,
    receipt_matched_enabled: true,
    missing_underlag_enabled: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

interface StubConfig {
  /** Rows in notification_settings for this user, or 'unreadable' to fail the read. */
  settings: Record<string, unknown>[] | 'unreadable'
  /** Rows the dedup check finds in notification_log, or 'unreadable' to fail the read. */
  notificationLog?: Record<string, unknown>[] | 'unreadable'
  deadlines?: Record<string, unknown>[]
  invoices?: Record<string, unknown>[]
  journalEntries?: Record<string, unknown>[]
  subscriptions?: Record<string, unknown>[]
}

type Result = { data: unknown; error: unknown }

const READ_ERROR = {
  code: '42501',
  message: 'permission denied for table notification_settings',
}
const PGRST116 = {
  code: 'PGRST116',
  message: 'JSON object requested, multiple (or no) rows returned',
}

/** Every eq/in filter the stub saw, so tests can assert on query scope. */
let recordedFilters: Array<{ table: string; method: string; args: unknown[] }> = []

function makeSupabaseStub(config: StubConfig): SupabaseClient {
  const rowsResult = (
    rows: Record<string, unknown>[] | 'unreadable' | undefined,
    method: 'single' | 'maybeSingle' | 'list'
  ): Result => {
    if (rows === 'unreadable') return { data: null, error: READ_ERROR }
    const list = rows ?? []
    if (method === 'list') return { data: list, error: null }
    if (list.length === 0) {
      // PostgREST: .single() errors on zero rows, .maybeSingle() does not.
      return method === 'single'
        ? { data: null, error: PGRST116 }
        : { data: null, error: null }
    }
    return { data: list[0], error: null }
  }

  const from = vi.fn().mockImplementation((table: string) => {
    let isWrite = false
    const resultFor = (method: 'single' | 'maybeSingle' | 'list'): Result => {
      if (isWrite) return { data: null, error: null }
      switch (table) {
        case 'notification_settings':
          return rowsResult(config.settings, method)
        case 'notification_log':
          return rowsResult(config.notificationLog, method)
        case 'deadlines':
          return rowsResult(config.deadlines, 'list')
        case 'invoices':
          return rowsResult(config.invoices, 'list')
        case 'journal_entries':
          return rowsResult(config.journalEntries, 'list')
        case 'push_subscriptions':
          return rowsResult(config.subscriptions ?? [SUBSCRIPTION], 'list')
        default:
          // document_attachments, supplier_invoices, supplier_invoice_payments,
          // journal_entry_no_doc_required: empty is the neutral answer.
          return { data: [], error: null }
      }
    }
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const chain: any = {
      select: () => chain,
      insert: () => {
        isWrite = true
        return chain
      },
      update: () => {
        isWrite = true
        return chain
      },
      eq: (...args: unknown[]) => {
        recordedFilters.push({ table, method: 'eq', args })
        return chain
      },
      in: (...args: unknown[]) => {
        recordedFilters.push({ table, method: 'in', args })
        return chain
      },
      not: () => chain,
      order: () => chain,
      range: () => chain,
      limit: () => chain,
      single: async () => resultFor('single'),
      maybeSingle: async () => resultFor('maybeSingle'),
      then: (resolve: (v: unknown) => void) => resolve(resultFor('list')),
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return chain
  })

  return { from } as unknown as SupabaseClient
}

let sendTaxDeadlineNotifications: typeof import('../notification-scheduler').sendTaxDeadlineNotifications
let sendInvoiceNotifications: typeof import('../notification-scheduler').sendInvoiceNotifications
let sendMissingUnderlagNotifications: typeof import('../notification-scheduler').sendMissingUnderlagNotifications
let webpushSend: Mock

beforeAll(async () => {
  // The sender module captures the VAPID keys at import time: set them before
  // the dynamic import so the send path is actually exercised.
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = 'synthetic-vapid-public-key'
  process.env.VAPID_PRIVATE_KEY = 'synthetic-vapid-private-key'
  const scheduler = await import('../notification-scheduler')
  sendTaxDeadlineNotifications = scheduler.sendTaxDeadlineNotifications
  sendInvoiceNotifications = scheduler.sendInvoiceNotifications
  sendMissingUnderlagNotifications = scheduler.sendMissingUnderlagNotifications
  webpushSend = vi.mocked((await import('web-push')).default.sendNotification) as unknown as Mock
})

beforeEach(() => {
  vi.clearAllMocks()
  recordedFilters = []
})

const oneDeadline = () => [
  { id: 'dl-1', user_id: USER_ID, title: 'Momsdeklaration', due_date: todayStr() },
]

describe('tax deadline gate polarity', () => {
  it('does NOT send when the settings read fails (unreadable means no consent)', async () => {
    const supabase = makeSupabaseStub({ settings: 'unreadable', deadlines: oneDeadline() })

    const result = await sendTaxDeadlineNotifications(supabase)

    expect(webpushSend).not.toHaveBeenCalled()
    expect(result.sent).toBe(0)
    expect(result.skipped).toBe(1)
  })

  it('sends with defaults when no settings row exists', async () => {
    const supabase = makeSupabaseStub({ settings: [], deadlines: oneDeadline() })

    const result = await sendTaxDeadlineNotifications(supabase)

    expect(webpushSend).toHaveBeenCalledTimes(1)
    expect(result.sent).toBe(1)
  })

  it('honours an explicit opt-out', async () => {
    const supabase = makeSupabaseStub({
      settings: [settingsRow({ tax_deadlines_enabled: false })],
      deadlines: oneDeadline(),
    })

    const result = await sendTaxDeadlineNotifications(supabase)

    expect(webpushSend).not.toHaveBeenCalled()
    expect(result.sent).toBe(0)
    expect(result.skipped).toBe(1)
  })

  it('honours push_enabled = false even when the category is on', async () => {
    const supabase = makeSupabaseStub({
      settings: [settingsRow({ push_enabled: false })],
      deadlines: oneDeadline(),
    })

    const result = await sendTaxDeadlineNotifications(supabase)

    expect(webpushSend).not.toHaveBeenCalled()
    expect(result.sent).toBe(0)
  })

  it('still sends for an opted-in row', async () => {
    const supabase = makeSupabaseStub({
      settings: [settingsRow()],
      deadlines: oneDeadline(),
    })

    const result = await sendTaxDeadlineNotifications(supabase)

    expect(webpushSend).toHaveBeenCalledTimes(1)
    expect(result.sent).toBe(1)
  })

  it('does NOT send when the dedup log read fails (cannot prove not-a-duplicate)', async () => {
    const supabase = makeSupabaseStub({
      settings: [settingsRow()],
      notificationLog: 'unreadable',
      deadlines: oneDeadline(),
    })

    const result = await sendTaxDeadlineNotifications(supabase)

    expect(webpushSend).not.toHaveBeenCalled()
    expect(result.sent).toBe(0)
  })
})

describe('invoice gate polarity', () => {
  it('does NOT send when the settings read fails', async () => {
    const supabase = makeSupabaseStub({
      settings: 'unreadable',
      invoices: [
        {
          id: 'inv-1',
          user_id: USER_ID,
          invoice_number: 1001,
          total: 1250,
          currency: 'SEK',
          due_date: todayStr(),
          customer: { name: 'Synthetic Kund AB' },
        },
      ],
    })

    const result = await sendInvoiceNotifications(supabase)

    expect(webpushSend).not.toHaveBeenCalled()
    expect(result.sent).toBe(0)
    expect(result.skipped).toBe(1)
  })

  it('only notifies on fakturor: proformas, delivery notes and quotes are never due', async () => {
    const supabase = makeSupabaseStub({ settings: [settingsRow()], invoices: [] })

    await sendInvoiceNotifications(supabase)

    expect(recordedFilters).toContainEqual({
      table: 'invoices',
      method: 'eq',
      args: ['document_type', 'invoice'],
    })
  })
})

describe('missing underlag gate polarity', () => {
  it('does NOT send when the settings read fails', async () => {
    const supabase = makeSupabaseStub({
      settings: 'unreadable',
      journalEntries: [{ id: 'je-1', user_id: USER_ID }],
    })

    const result = await sendMissingUnderlagNotifications(supabase)

    expect(webpushSend).not.toHaveBeenCalled()
    expect(result.sent).toBe(0)
    expect(result.skipped).toBe(1)
  })
})
