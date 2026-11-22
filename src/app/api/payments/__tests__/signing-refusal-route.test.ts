/**
 * A bank that refuses a payment signing (its own code: RESOURCE_BLOCKED,
 * FORMAT_ERROR, PSU_RIGHTS_MISSING, ...) answers the same on every try, so
 * PAYMENT_PROVIDER_REFUSED is a 4xx, as BANK_PROVIDER_REFUSED is for the bank
 * feed: a 422, logged at warn with the bank's code in the log line (it was a
 * 502 at error naming only the generic refusal). A bank that does not answer
 * stays a 5xx. The signing rules are the service's
 * (lib/payments/orders/__tests__/signing.test.ts); this pins what the doors
 * answer and log.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
  createServiceClient: () => mockSupabase,
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('@/lib/domains/trusted-app-origin', () => ({ resolveRequestAppOrigin: vi.fn().mockResolvedValue('https://app.accounted.se') }))

const signing = vi.hoisted(() => ({
  startPaymentSigning: vi.fn(),
  restartPaymentSigning: vi.fn(),
  startSecondSignature: vi.fn(),
  pollPaymentSigning: vi.fn(),
}))
vi.mock('@/lib/payments/orders/signing', () => signing)

// Every line the doors log, with its level: the test environment prints
// errors only, and the level is the point here.
const logged = vi.hoisted(() => [] as { level: 'info' | 'warn' | 'error'; text: string }[])
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>()
  type Logger = ReturnType<typeof actual.createLogger>
  const text = (msg: string, args: unknown[]) =>
    [msg, ...args.map((a) => (a instanceof Error ? a.message : JSON.stringify(a)))].join(' ')
  const wrap = (inner: Logger): Logger => ({
    info: (msg, ...args) => {
      logged.push({ level: 'info', text: text(msg, args) })
    },
    warn: (msg, ...args) => {
      logged.push({ level: 'warn', text: text(msg, args) })
    },
    error: (msg, ...args) => {
      logged.push({ level: 'error', text: text(msg, args) })
    },
    child: (extra) => wrap(inner.child(extra)),
  })
  return {
    ...actual,
    createLogger: (module: string, base?: Parameters<typeof actual.createLogger>[1]) => wrap(actual.createLogger(module, base)),
  }
})

import { POST as startSigning } from '../signing/route'
import { POST as restartSigning } from '../signing/[id]/restart/route'
import { POST as secondSignature } from '../signing/[id]/second-signature/route'
import { POST as pollSigning } from '../signing/[id]/poll/route'

const ORDER = '11111111-1111-4111-8111-111111111111'
const BATCH = '44444444-4444-4444-8444-444444444444'
const params = { params: Promise.resolve({ id: BATCH }) }
const post = (url: string, body: unknown) => createMockRequest(url, { method: 'POST', body })

type ErrorBody = { error: { code: string; message: string; details?: { provider_code?: string } } }

const DOORS = [
  { door: 'POST /api/payments/signing', service: signing.startPaymentSigning, call: () => startSigning(post('/api/payments/signing', { order_ids: [ORDER], method: 'qr' }), { params: Promise.resolve({}) }) },
  { door: 'POST /api/payments/signing/:id/restart', service: signing.restartPaymentSigning, call: () => restartSigning(post(`/api/payments/signing/${BATCH}/restart`, { method: 'qr' }), params) },
  { door: 'POST /api/payments/signing/:id/second-signature', service: signing.startSecondSignature, call: () => secondSignature(post(`/api/payments/signing/${BATCH}/second-signature`, { method: 'qr' }), params) },
  { door: 'POST /api/payments/signing/:id/poll', service: signing.pollPaymentSigning, call: () => pollSigning(post(`/api/payments/signing/${BATCH}/poll`, {}), params) },
] as const

const lines = (level: 'warn' | 'error') =>
  logged
    .filter((l) => l.level === level)
    .map((l) => l.text)
    .join('\n')

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  logged.length = 0
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
})

describe.each(DOORS)('$door', ({ service, call }) => {
  it("answers the bank's refusal as a 422 and logs it at warn with the bank's code", async () => {
    service.mockResolvedValue({ ok: false, code: 'PAYMENT_PROVIDER_REFUSED', details: { provider_code: 'RESOURCE_BLOCKED' } })

    const { status, body } = await parseJsonResponse<ErrorBody>(await call())

    expect(status).toBe(422)
    expect(body.error.code).toBe('PAYMENT_PROVIDER_REFUSED')
    // The screen still reads the bank's code from the body (refusalSentence).
    expect(body.error.details?.provider_code).toBe('RESOURCE_BLOCKED')
    expect(lines('warn')).toMatch(/PAYMENT_PROVIDER_REFUSED.*"provider_code":"RESOURCE_BLOCKED"/)
    expect(lines('error')).toBe('')
  })

  it('a bank that does not answer stays a 5xx', async () => {
    service.mockResolvedValue({ ok: false, code: 'PAYMENT_PROVIDER_UNAVAILABLE', details: { provider_code: 'CONNECTOR_PAYMENTS_PROVIDER_FAILED' } })

    const { status, body } = await parseJsonResponse<ErrorBody>(await call())

    expect(status).toBe(503)
    expect(body.error.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE')
    expect(lines('error')).toMatch(/PAYMENT_PROVIDER_UNAVAILABLE.*"provider_code":"CONNECTOR_PAYMENTS_PROVIDER_FAILED"/)
  })
})
