import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ExtensionContext } from '@/lib/extensions/types'
import { pushNotificationsApiRoutes } from '../api-routes'

/**
 * Consent polarity on the settings routes themselves.
 *
 * getSettings() returns null when the notification_settings row exists but
 * cannot be read; both routes must surface that as a 500 instead of showing
 * or merging into the mostly-enabled defaults. A genuinely absent row
 * (maybeSingle, no error) still yields the defaults.
 */

type Behavior = 'row' | 'absent' | 'unreadable'
let behavior: Behavior = 'absent'
const upserts: { payload: Record<string, unknown>; options?: Record<string, unknown> }[] = []

// A stored row that deviates from every default it can, so a response built
// from the row is distinguishable from one built from the defaults.
const STORED_ROW = {
  period_locked_enabled: false,
  period_year_closed_enabled: true,
  invoice_sent_enabled: true,
  receipt_extracted_enabled: true,
  receipt_matched_enabled: true,
  missing_underlag_enabled: false,
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (_table: string) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          if (behavior === 'unreadable') {
            return {
              data: null,
              error: { code: '42501', message: 'permission denied for table notification_settings' },
            }
          }
          if (behavior === 'absent') return { data: null, error: null }
          return { data: { ...STORED_ROW }, error: null }
        },
        upsert: (payload: Record<string, unknown>, options?: Record<string, unknown>) => {
          upserts.push({ payload, options })
          return chain
        },
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
      }
      /* eslint-enable @typescript-eslint/no-explicit-any */
      return chain
    },
  }),
}))

const USER_ID = '11111111-1111-4111-8111-111111111111'
const ctx = { userId: USER_ID } as unknown as ExtensionContext

const route = (method: string, path: string) =>
  pushNotificationsApiRoutes.find((r) => r.method === method && r.path === path)!.handler

const getRequest = () =>
  new Request('http://localhost/api/extensions/ext/push-notifications/settings')

const putRequest = (body: unknown) =>
  new Request('http://localhost/api/extensions/ext/push-notifications/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  behavior = 'absent'
  upserts.length = 0
  vi.clearAllMocks()
})

describe('GET /settings', () => {
  it('returns 500 when the settings row is unreadable (never the defaults)', async () => {
    behavior = 'unreadable'

    const response = await route('GET', '/settings')(getRequest(), ctx)

    expect(response.status).toBe(500)
  })

  it('returns the defaults when no row exists', async () => {
    behavior = 'absent'

    const response = await route('GET', '/settings')(getRequest(), ctx)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.invoiceSentEnabled).toBe(false)
    expect(body.data.missingUnderlagEnabled).toBe(true)
  })

  it('returns the stored values when a row exists', async () => {
    behavior = 'row'

    const response = await route('GET', '/settings')(getRequest(), ctx)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.periodLockedEnabled).toBe(false)
    expect(body.data.invoiceSentEnabled).toBe(true)
    expect(body.data.missingUnderlagEnabled).toBe(false)
  })
})

describe('PUT /settings', () => {
  it('returns 500 and writes NOTHING when the current row is unreadable', async () => {
    // Saving would merge the partial into the defaults and overwrite the
    // user's stored opt-outs with mostly-enabled values.
    behavior = 'unreadable'

    const response = await route('PUT', '/settings')(
      putRequest({ receiptMatchedEnabled: false }),
      ctx
    )

    expect(response.status).toBe(500)
    expect(upserts).toEqual([])
  })

  it('merges the partial into the STORED row, preserving existing opt-outs', async () => {
    behavior = 'row'

    const response = await route('PUT', '/settings')(
      putRequest({ receiptMatchedEnabled: false }),
      ctx
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.receiptMatchedEnabled).toBe(false)
    expect(upserts).toHaveLength(1)
    const written = upserts[0].payload
    // Untouched fields come from the stored row, not the defaults.
    expect(written.period_locked_enabled).toBe(false)
    expect(written.invoice_sent_enabled).toBe(true)
    expect(written.missing_underlag_enabled).toBe(false)
    expect(written.receipt_matched_enabled).toBe(false)
    expect(upserts[0].options?.onConflict).toBe('user_id')
  })

  it('accepts missingUnderlagEnabled: the mute switch for the weekly notification', async () => {
    behavior = 'row'

    const response = await route('PUT', '/settings')(
      putRequest({ missingUnderlagEnabled: true }),
      ctx
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.missingUnderlagEnabled).toBe(true)
    expect(upserts[0].payload.missing_underlag_enabled).toBe(true)
  })

  it('rejects a body with no recognised keys', async () => {
    const response = await route('PUT', '/settings')(putRequest({ nonsense: true }), ctx)

    expect(response.status).toBe(400)
    expect(upserts).toEqual([])
  })
})
