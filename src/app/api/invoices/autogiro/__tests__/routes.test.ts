/**
 * Tests for the Autogiro session routes under /api/invoices/autogiro. The
 * services (lib/invoices/autogiro/service.ts, import-report.ts) are tested on
 * their own; here: 401, the rollout gate on the start doors, validation 400,
 * the service's refusals mapped to their status (404, 409), and each happy
 * path's response shape.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { supabase, reset, enqueue } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  getCompanyRole: vi.fn().mockResolvedValue({ ok: true, role: 'owner', companyId: 'company-1' }),
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

const service = vi.hoisted(() => ({
  loadAutogiroOverview: vi.fn(),
  loadAutogiroSettings: vi.fn(),
  saveAutogiroSettings: vi.fn(),
  addExistingMandate: vi.fn(),
  linkMandate: vi.fn(),
  cancelMandate: vi.fn(),
  createDebitFile: vi.fn(),
  withdrawDebitFile: vi.fn(),
  loadStoredFile: vi.fn(),
}))
vi.mock('@/lib/invoices/autogiro/service', () => service)
const importAutogiroReport = vi.fn()
const depositsFromOwnDebits = vi.fn()
const markDebitsDebited = vi.fn()
vi.mock('@/lib/invoices/autogiro/import-report', () => ({
  importAutogiroReport: (...a: unknown[]) => importAutogiroReport(...a),
  depositsFromOwnDebits: (...a: unknown[]) => depositsFromOwnDebits(...a),
  markDebitsDebited: (...a: unknown[]) => markDebitsDebited(...a),
}))
const attachBgMaxDeposits = vi.fn()
vi.mock('@/lib/import/bgmax/attach', () => ({ attachBgMaxDeposits: (...a: unknown[]) => attachBgMaxDeposits(...a) }))

import { GET as getOverview } from '../route'
import { PUT as putSettings } from '../settings/route'
import { GET as getMandates, POST as postMandate } from '../mandates/route'
import { PATCH as patchMandate } from '../mandates/[id]/route'
import { POST as cancelMandateRoute } from '../mandates/[id]/cancel/route'
import { POST as postDebitFile } from '../debit-files/route'
import { POST as withdrawRoute } from '../debit-files/[id]/withdraw/route'
import { GET as downloadFile } from '../files/[id]/route'
import { POST as postReport } from '../reports/route'
import { POST as settleRoute } from '../settle/route'

const ID = '11111111-1111-4111-8111-111111111111'
const CUSTOMER = '22222222-2222-4222-8222-222222222222'
const noParams = { params: Promise.resolve({}) }
const idParams = (id = ID) => ({ params: Promise.resolve({ id }) })
const url = (path: string) => `http://localhost:3000/api/invoices/autogiro${path}`
const json = (path: string, method: string, body: unknown) =>
  new Request(url(path), { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const failure = (code: string) => ({ ok: false, code })

function unauthenticated() {
  requireAuthMock.mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.AUTOGIRO_COMPANY_IDS = 'company-1'
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('GET /api/invoices/autogiro', () => {
  it('returns 401 when unauthenticated', async () => {
    unauthenticated()
    expect((await getOverview(new Request(url('')), noParams)).status).toBe(401)
  })

  it('returns the overview and whether the company may start Autogiro work', async () => {
    service.loadAutogiroOverview.mockResolvedValue({ settings: null, mandates: [], due: [], debits: [], files: [] })
    const res = await getOverview(new Request(url('')), noParams)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { enabled: true, overview: { settings: null, mandates: [], due: [], debits: [], files: [] } } })
    expect(service.loadAutogiroOverview).toHaveBeenCalledWith(supabase, 'company-1', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/))

    delete process.env.AUTOGIRO_COMPANY_IDS
    expect((await (await getOverview(new Request(url('')), noParams)).json()).data.enabled).toBe(false)
  })
})

describe('PUT /api/invoices/autogiro/settings', () => {
  const body = { customer_number: '123456', bankgiro: '991-2346' }

  it('returns 401 when unauthenticated', async () => {
    unauthenticated()
    expect((await putSettings(json('/settings', 'PUT', body), noParams)).status).toBe(401)
  })

  it('is refused outside the rollout', async () => {
    delete process.env.AUTOGIRO_COMPANY_IDS
    const res = await putSettings(json('/settings', 'PUT', body), noParams)
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('AUTOGIRO_NOT_ENABLED')
    expect(service.saveAutogiroSettings).not.toHaveBeenCalled()
  })

  it('validates the body and maps the service refusal', async () => {
    expect((await putSettings(json('/settings', 'PUT', { customer_number: '' }), noParams)).status).toBe(400)
    service.saveAutogiroSettings.mockResolvedValue({ ok: false, code: 'AUTOGIRO_SETTINGS_INVALID', details: { field: 'bankgiro' } })
    const res = await putSettings(json('/settings', 'PUT', body), noParams)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('AUTOGIRO_SETTINGS_INVALID')
  })

  it('saves the agreement', async () => {
    service.saveAutogiroSettings.mockResolvedValue({ ok: true, settings: { customer_number: '123456', bankgiro: '9912346' } })
    const res = await putSettings(json('/settings', 'PUT', body), noParams)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { settings: { customer_number: '123456', bankgiro: '9912346' } } })
    expect(service.saveAutogiroSettings).toHaveBeenCalledWith(supabase, 'company-1', body)
  })
})

describe('/api/invoices/autogiro/mandates', () => {
  it('returns 401 when unauthenticated', async () => {
    unauthenticated()
    expect((await getMandates(new Request(url(`/mandates?customer_id=${CUSTOMER}`)), noParams)).status).toBe(401)
    expect((await postMandate(json('/mandates', 'POST', { customer_id: CUSTOMER, payer_number: '1' }), noParams)).status).toBe(401)
  })

  it('GET wants a customer and lists that customer\'s mandates', async () => {
    expect((await getMandates(new Request(url('/mandates')), noParams)).status).toBe(400)
    service.loadAutogiroSettings.mockResolvedValue({ customer_number: '1', bankgiro: '9912346' })
    enqueue({ data: [{ id: ID, payer_number: '5501', status: 'active' }] })
    const res = await getMandates(new Request(url(`/mandates?customer_id=${CUSTOMER}`)), noParams)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { enabled: true, settings_ready: true, mandates: [{ id: ID, payer_number: '5501', status: 'active' }] } })
  })

  it('POST registers an existing mandate, gated and validated, refusals mapped', async () => {
    expect((await postMandate(json('/mandates', 'POST', { customer_id: 'nope', payer_number: '1' }), noParams)).status).toBe(400)
    service.addExistingMandate.mockResolvedValueOnce(failure('AUTOGIRO_CUSTOMER_NOT_FOUND'))
    expect((await postMandate(json('/mandates', 'POST', { customer_id: CUSTOMER, payer_number: '1' }), noParams)).status).toBe(404)
    service.addExistingMandate.mockResolvedValueOnce(failure('AUTOGIRO_CUSTOMER_HAS_MANDATE'))
    expect((await postMandate(json('/mandates', 'POST', { customer_id: CUSTOMER, payer_number: '1' }), noParams)).status).toBe(409)
    service.addExistingMandate.mockResolvedValueOnce({ ok: true, mandate: { id: ID } })
    const res = await postMandate(json('/mandates', 'POST', { customer_id: CUSTOMER, payer_number: '5501' }), noParams)
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ data: { mandate: { id: ID } } })

    delete process.env.AUTOGIRO_COMPANY_IDS
    expect((await postMandate(json('/mandates', 'POST', { customer_id: CUSTOMER, payer_number: '1' }), noParams)).status).toBe(403)
  })
})

describe('PATCH /api/invoices/autogiro/mandates/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    unauthenticated()
    expect((await patchMandate(json(`/mandates/${ID}`, 'PATCH', { customer_id: null }), idParams())).status).toBe(401)
  })

  it('validates, maps a missing mandate to 404, and links', async () => {
    expect((await patchMandate(json('/mandates/x', 'PATCH', { customer_id: null }), idParams('x'))).status).toBe(400)
    expect((await patchMandate(json(`/mandates/${ID}`, 'PATCH', { customer_id: 'x' }), idParams())).status).toBe(400)
    service.linkMandate.mockResolvedValueOnce(failure('AUTOGIRO_MANDATE_NOT_FOUND'))
    expect((await patchMandate(json(`/mandates/${ID}`, 'PATCH', { customer_id: CUSTOMER }), idParams())).status).toBe(404)
    service.linkMandate.mockResolvedValueOnce({ ok: true, mandate: { id: ID, customer_id: CUSTOMER } })
    const res = await patchMandate(json(`/mandates/${ID}`, 'PATCH', { customer_id: CUSTOMER }), idParams())
    expect(res.status).toBe(200)
    expect(service.linkMandate).toHaveBeenLastCalledWith(supabase, 'company-1', ID, CUSTOMER)
  })
})

describe('POST /api/invoices/autogiro/mandates/[id]/cancel', () => {
  it('returns 401 when unauthenticated', async () => {
    unauthenticated()
    expect((await cancelMandateRoute(new Request(url(`/mandates/${ID}/cancel`), { method: 'POST' }), idParams())).status).toBe(401)
  })

  it('cancels outside the rollout too (a leaving customer must be able to stop), and maps 404', async () => {
    delete process.env.AUTOGIRO_COMPANY_IDS
    service.cancelMandate.mockResolvedValueOnce(failure('AUTOGIRO_MANDATE_NOT_FOUND'))
    expect((await cancelMandateRoute(new Request(url(`/mandates/${ID}/cancel`), { method: 'POST' }), idParams())).status).toBe(404)
    service.cancelMandate.mockResolvedValueOnce({ ok: true, mandate: { id: ID, status: 'cancelled' }, file: { id: 'f', filename: 'a.txt' } })
    const res = await cancelMandateRoute(new Request(url(`/mandates/${ID}/cancel`), { method: 'POST' }), idParams())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { mandate: { id: ID, status: 'cancelled' }, file: { id: 'f', filename: 'a.txt' } } })
    expect(service.cancelMandate).toHaveBeenLastCalledWith(supabase, 'company-1', 'user-1', ID, expect.any(String))
  })
})

describe('POST /api/invoices/autogiro/debit-files', () => {
  it('returns 401 when unauthenticated', async () => {
    unauthenticated()
    expect((await postDebitFile(json('/debit-files', 'POST', {}), noParams)).status).toBe(401)
  })

  it('is gated, validated, and maps nothing-to-debit', async () => {
    expect((await postDebitFile(json('/debit-files', 'POST', { invoice_ids: ['x'] }), noParams)).status).toBe(400)
    service.createDebitFile.mockResolvedValueOnce({ ok: false, code: 'AUTOGIRO_NOTHING_TO_DEBIT', details: { skipped: 2 } })
    const res = await postDebitFile(json('/debit-files', 'POST', {}), noParams)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('AUTOGIRO_NOTHING_TO_DEBIT')
    delete process.env.AUTOGIRO_COMPANY_IDS
    expect((await postDebitFile(json('/debit-files', 'POST', {}), noParams)).status).toBe(403)
  })

  it('writes the file for the chosen invoices', async () => {
    service.createDebitFile.mockResolvedValue({ ok: true, file: { id: 'f', filename: 'b.txt' }, debits: 1, total: 500, skipped: [] })
    const res = await postDebitFile(json('/debit-files', 'POST', { invoice_ids: [ID] }), noParams)
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ data: { file: { id: 'f', filename: 'b.txt' }, debits: 1, total: 500, skipped: [] } })
    expect(service.createDebitFile).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', { invoice_ids: [ID], today: expect.any(String) })
  })
})

describe('POST /api/invoices/autogiro/debit-files/[id]/withdraw', () => {
  it('returns 401 when unauthenticated', async () => {
    unauthenticated()
    expect((await withdrawRoute(new Request(url(`/debit-files/${ID}/withdraw`), { method: 'POST' }), idParams())).status).toBe(401)
  })

  it('maps 404 and 409, and withdraws', async () => {
    service.withdrawDebitFile.mockResolvedValueOnce(failure('AUTOGIRO_FILE_NOT_FOUND'))
    expect((await withdrawRoute(new Request(url(`/debit-files/${ID}/withdraw`), { method: 'POST' }), idParams())).status).toBe(404)
    service.withdrawDebitFile.mockResolvedValueOnce(failure('AUTOGIRO_FILE_ALREADY_REPORTED'))
    expect((await withdrawRoute(new Request(url(`/debit-files/${ID}/withdraw`), { method: 'POST' }), idParams())).status).toBe(409)
    service.withdrawDebitFile.mockResolvedValueOnce({ ok: true, cancelled: 3 })
    const res = await withdrawRoute(new Request(url(`/debit-files/${ID}/withdraw`), { method: 'POST' }), idParams())
    expect(await res.json()).toEqual({ data: { cancelled: 3 } })
  })
})

describe('GET /api/invoices/autogiro/files/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    unauthenticated()
    expect((await downloadFile(new Request(url(`/files/${ID}`)), idParams())).status).toBe(401)
  })

  it('maps a missing or unstored file, and downloads the ISO 8859-1 bytes', async () => {
    expect((await downloadFile(new Request(url('/files/x')), idParams('x'))).status).toBe(400)
    service.loadStoredFile.mockResolvedValueOnce(failure('AUTOGIRO_FILE_NOT_FOUND'))
    expect((await downloadFile(new Request(url(`/files/${ID}`)), idParams())).status).toBe(404)
    service.loadStoredFile.mockResolvedValueOnce(failure('AUTOGIRO_FILE_NOT_STORED'))
    expect((await downloadFile(new Request(url(`/files/${ID}`)), idParams())).status).toBe(409)
    service.loadStoredFile.mockResolvedValueOnce({ ok: true, filename: 'autogiro-betalningar-2026-11-20.txt', content: 'Å\r\n' })
    const res = await downloadFile(new Request(url(`/files/${ID}`)), idParams())
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=ISO-8859-1')
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="autogiro-betalningar-2026-11-20.txt"')
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0xc5, 0x0d, 0x0a])
  })
})

describe('POST /api/invoices/autogiro/reports', () => {
  function upload(fields: Record<string, string> = {}, withFile = true) {
    const form = new FormData()
    if (withFile) form.append('file', new File(['01...'], 'BET_SPEC.txt', { type: 'text/plain' }))
    for (const [k, v] of Object.entries(fields)) form.append(k, v)
    return new Request(url('/reports'), { method: 'POST', body: form })
  }
  const outcome = (over: Record<string, unknown> = {}) => ({
    ok: true,
    kind: 'payment_specification',
    applied: true,
    repeat: false,
    sealed: false,
    issues: [],
    debits: [],
    mandates: [],
    settlement: [],
    answer_file: null,
    file_id: 'r1',
    ...over,
  })

  it('returns 401 when unauthenticated', async () => {
    unauthenticated()
    expect((await postReport(upload(), noParams)).status).toBe(401)
  })

  it('refuses without a file, with bad decisions, and maps the service refusal', async () => {
    expect((await postReport(upload({}, false), noParams)).status).toBe(400)
    expect((await postReport(upload({ decisions: '{bad' }), noParams)).status).toBe(400)
    expect((await postReport(upload({ decisions: JSON.stringify({ '7001': 'maybe' }) }), noParams)).status).toBe(400)
    importAutogiroReport.mockResolvedValueOnce({ ok: false, code: 'AUTOGIRO_REPORT_OLD_LAYOUT' })
    const res = await postReport(upload({ apply: 'true' }), noParams)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('AUTOGIRO_REPORT_OLD_LAYOUT')
  })

  it('attaches the debited deposits to the bank rows when applying', async () => {
    const deposit = { bankgiro: '991-2346', date: '2026-11-30', amount: 1500, payments: [] }
    importAutogiroReport.mockResolvedValueOnce(outcome({ settlement: [deposit] }))
    attachBgMaxDeposits.mockResolvedValueOnce({ deposits: 1, matched_deposits: 1, matched_payments: 2, no_row: 0, ambiguous: 0, ready_rows: 1 })
    const res = await postReport(upload({ apply: 'true' }), noParams)
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data).toMatchObject({ kind: 'payment_specification', filename: 'BET_SPEC.txt', settlement: { matched_deposits: 1, ready_rows: 1 }, answer_file: null })
    expect(attachBgMaxDeposits).toHaveBeenCalledWith(supabase, { companyId: 'company-1', userId: 'user-1', deposits: [deposit], apply: true })
  })

  it('previews without attaching, and returns an answer file as base64 ISO 8859-1 bytes', async () => {
    importAutogiroReport.mockResolvedValueOnce(outcome({ applied: false, settlement: [{ amount: 1 }] }))
    await postReport(upload(), noParams)
    expect(attachBgMaxDeposits).not.toHaveBeenCalled()

    importAutogiroReport.mockResolvedValueOnce(
      outcome({ kind: 'internet_bank_mandates', answer_file: { filename: 'svar.txt', content: 'ÅÄ\r\n' } }),
    )
    const res = await postReport(upload({ apply: 'true', decisions: JSON.stringify({ '7001': 'approve' }) }), noParams)
    const { data } = await res.json()
    expect(data.answer_file).toEqual({ filename: 'svar.txt', content_base64: Buffer.from([0xc5, 0xc4, 0x0d, 0x0a]).toString('base64') })
    expect(importAutogiroReport).toHaveBeenLastCalledWith(supabase, expect.objectContaining({ apply: true, decisions: { '7001': 'approve' } }))
  })
})

describe('POST /api/invoices/autogiro/settle', () => {
  const settle = () => settleRoute(new Request(url('/settle'), { method: 'POST' }), noParams)

  it('returns 401 when unauthenticated', async () => {
    unauthenticated()
    expect((await settle()).status).toBe(401)
  })

  it('maps a missing agreement, and does nothing when no debit day has come', async () => {
    depositsFromOwnDebits.mockResolvedValueOnce({ ok: false, code: 'AUTOGIRO_SETTINGS_MISSING' })
    expect((await settle()).status).toBe(400)
    depositsFromOwnDebits.mockResolvedValueOnce({ deposits: [], debitIds: [] })
    expect((await (await settle()).json()).data).toMatchObject({ days: 0, debited: 0 })
    expect(attachBgMaxDeposits).not.toHaveBeenCalled()
  })

  it('marks a day debited only when its deposit found its bank row', async () => {
    depositsFromOwnDebits.mockResolvedValueOnce({
      deposits: [{ date: '2026-11-30', amount: 1500 }, { date: '2026-12-01', amount: 300 }],
      debitIds: [['deb-1', 'deb-2'], ['deb-3']],
    })
    attachBgMaxDeposits.mockResolvedValueOnce({
      deposits: 2,
      matched_deposits: 1,
      ready_rows: 1,
      no_row: 1,
      ambiguous: 0,
      outcomes: [{ status: 'matched' }, { status: 'no_row' }],
    })
    const res = await settle()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ days: 2, matched_days: 1, debited: 2, ready_rows: 1, no_row: 1, ambiguous: 0 })
    expect(markDebitsDebited).toHaveBeenCalledTimes(1)
    expect(markDebitsDebited).toHaveBeenCalledWith(supabase, 'company-1', ['deb-1', 'deb-2'], '2026-11-30')
  })
})
