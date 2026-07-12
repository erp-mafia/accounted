/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendEmail = vi.fn()
const isConfigured = vi.fn()

vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({ sendEmail, isConfigured }),
}))

import {
  shouldSendBackupAlert,
  sendBackupFailureAlert,
  ALERT_FAILURE_THRESHOLD,
  ALERT_THROTTLE_MS,
} from '../backup-alert'

const NOW = new Date('2026-07-12T04:00:00.000Z')

describe('shouldSendBackupAlert', () => {
  it('alerts immediately on needs_reauth regardless of failure count', () => {
    expect(
      shouldSendBackupAlert({
        kind: 'needs_reauth',
        consecutiveFailures: 1,
        lastAlertAt: null,
        now: NOW,
      })
    ).toBe(true)
  })

  it('requires the failure threshold for repeated_failures', () => {
    expect(
      shouldSendBackupAlert({
        kind: 'repeated_failures',
        consecutiveFailures: ALERT_FAILURE_THRESHOLD - 1,
        lastAlertAt: null,
        now: NOW,
      })
    ).toBe(false)
    expect(
      shouldSendBackupAlert({
        kind: 'repeated_failures',
        consecutiveFailures: ALERT_FAILURE_THRESHOLD,
        lastAlertAt: null,
        now: NOW,
      })
    ).toBe(true)
  })

  it('throttles both kinds against last_alert_at', () => {
    const recent = new Date(NOW.getTime() - ALERT_THROTTLE_MS + 60_000).toISOString()
    expect(
      shouldSendBackupAlert({
        kind: 'needs_reauth',
        consecutiveFailures: 0,
        lastAlertAt: recent,
        now: NOW,
      })
    ).toBe(false)
    expect(
      shouldSendBackupAlert({
        kind: 'repeated_failures',
        consecutiveFailures: 10,
        lastAlertAt: recent,
        now: NOW,
      })
    ).toBe(false)

    const stale = new Date(NOW.getTime() - ALERT_THROTTLE_MS - 60_000).toISOString()
    expect(
      shouldSendBackupAlert({
        kind: 'needs_reauth',
        consecutiveFailures: 0,
        lastAlertAt: stale,
        now: NOW,
      })
    ).toBe(true)
  })
})

/**
 * Supabase stub: company_members lookup resolves a member with an email,
 * company_settings resolves a company name.
 */
function makeSupabase(options: { member?: unknown; companyName?: string | null } = {}) {
  const from = vi.fn().mockImplementation((table: string) => {
    const chain: any = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockImplementation(() => {
        if (table === 'company_members') {
          return Promise.resolve({
            data:
              options.member !== undefined
                ? options.member
                : { user_id: 'u-1', profiles: { email: 'emil@example.com' } },
          })
        }
        return Promise.resolve({
          data: { company_name: options.companyName ?? 'Testbolag AB' },
        })
      }),
    }
    return chain
  })
  return { from } as any
}

const baseInput = {
  companyId: 'c-1',
  userId: 'u-1',
  consecutiveFailures: 3,
  errorMessage: 'Drive quota exceeded',
  origin: 'https://app.test',
} as const

describe('sendBackupFailureAlert', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isConfigured.mockReturnValue(true)
    sendEmail.mockResolvedValue({ success: true })
  })

  it('does nothing when the email service is not configured', async () => {
    isConfigured.mockReturnValue(false)
    const result = await sendBackupFailureAlert(makeSupabase(), {
      ...baseInput,
      kind: 'repeated_failures',
    })
    expect(result).toEqual({ sent: false, reason: 'email_not_configured' })
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('does not email a user who is no longer a company member', async () => {
    const result = await sendBackupFailureAlert(makeSupabase({ member: null }), {
      ...baseInput,
      kind: 'repeated_failures',
    })
    expect(result).toEqual({ sent: false, reason: 'no_recipient' })
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('sends a repeated-failures email with count, error and link', async () => {
    const result = await sendBackupFailureAlert(makeSupabase(), {
      ...baseInput,
      kind: 'repeated_failures',
    })
    expect(result).toEqual({ sent: true })
    expect(sendEmail).toHaveBeenCalledTimes(1)
    const options = sendEmail.mock.calls[0][0]
    expect(options.to).toBe('emil@example.com')
    expect(options.subject).toContain('misslyckas')
    expect(options.text).toContain('3 nätter i rad')
    expect(options.text).toContain('Drive quota exceeded')
    expect(options.text).toContain('https://app.test/import#cloud-backup')
    expect(options.html).toContain('Testbolag AB')
  })

  it('sends a needs_reauth email pointing at the reconnect flow', async () => {
    const result = await sendBackupFailureAlert(makeSupabase(), {
      ...baseInput,
      kind: 'needs_reauth',
      errorMessage: null,
    })
    expect(result).toEqual({ sent: true })
    const options = sendEmail.mock.calls[0][0]
    expect(options.subject).toContain('pausad')
    expect(options.text).toContain('Koppla om Google Drive')
    expect(options.text).toContain('https://app.test/import#cloud-backup')
  })

  it('reports send failures without throwing', async () => {
    sendEmail.mockResolvedValue({ success: false, error: 'smtp down' })
    const result = await sendBackupFailureAlert(makeSupabase(), {
      ...baseInput,
      kind: 'repeated_failures',
    })
    expect(result).toEqual({ sent: false, reason: 'send_failed' })
  })

  it('escapes HTML in the error message', async () => {
    await sendBackupFailureAlert(makeSupabase(), {
      ...baseInput,
      kind: 'repeated_failures',
      errorMessage: '<script>alert(1)</script>',
    })
    const options = sendEmail.mock.calls[0][0]
    expect(options.html).not.toContain('<script>')
    expect(options.html).toContain('&lt;script&gt;')
  })
})
