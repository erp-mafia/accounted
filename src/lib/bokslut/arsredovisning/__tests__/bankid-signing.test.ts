/**
 * The board's BankID signing: a locked version, one signer per pending slot,
 * one track per version, one open request at a time; the e-signing copy is
 * rendered and archived only on the real call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { OperationContext } from '@/lib/operations/types'

const signing = vi.hoisted(() => ({
  signingStartRefusal: vi.fn(),
  checkSigners: vi.fn(),
  createSigningRequest: vi.fn(),
}))
const upload = vi.hoisted(() => vi.fn())
const pdf = vi.hoisted(() => vi.fn())
vi.mock('@/lib/signing/requests', () => signing)
vi.mock('@/lib/core/documents/document-service', () => ({ uploadDocument: upload }))
vi.mock('../file-service', () => ({ getArsredovisningESigningPdf: pdf }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn(() => ({})) }))

import { requestArsredovisningSignatures, slotCoveredByBankIdSigning } from '../bankid-signing'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never
const VERSION = { id: 'version-1', status: 'ready_for_signature', fiscal_period_id: 'period-1' }
const PERIOD = { period_start: '2026-01-01', period_end: '2026-12-31' }
const SLOT_A = { id: 'slot-a', role: 'Styrelseledamot', signer_name: 'Anna Svensson', status: 'pending', signing_method: null }
const SLOT_B = { id: 'slot-b', role: 'VD', signer_name: 'Bo Berg', status: 'pending', signing_method: null }

function ctx() {
  const mock = createQueuedMockSupabase()
  const c: OperationContext = { supabase: mock.supabase as never, companyId: 'company-1', userId: 'user-1', log }
  return { mock, ctx: c }
}

const input = {
  fiscalPeriodId: 'period-1',
  versionId: 'version-1',
  signers: [{ signatureId: 'slot-a', email: 'anna@example.se' }],
  createdVia: 'app' as const,
}

beforeEach(() => {
  vi.clearAllMocks()
  signing.signingStartRefusal.mockResolvedValue(null)
  signing.checkSigners.mockResolvedValue({ ok: true, signers: [] })
  signing.createSigningRequest.mockResolvedValue({ ok: true, data: { signing_request_id: 'request-1' } })
  pdf.mockResolvedValue({ ok: true, data: { filename: 'ar.pdf', bytes: new Uint8Array([37, 80, 68, 70]), contentType: 'application/pdf', versionId: 'version-1' } })
  upload.mockResolvedValue({ id: 'document-1' })
})

describe('requestArsredovisningSignatures', () => {
  it('refuses when signing is not open for the company, or not in its plan, asking for the årsredovisning rollout', async () => {
    const { ctx: c } = ctx()
    signing.signingStartRefusal.mockResolvedValue('SIGNING_UNAVAILABLE')
    expect(await requestArsredovisningSignatures(c, input, { dryRun: false })).toEqual({ ok: false, code: 'SIGNING_UNAVAILABLE' })
    expect(signing.signingStartRefusal).toHaveBeenCalledWith(c.supabase, 'company-1', { arsredovisning: true })
    signing.signingStartRefusal.mockResolvedValue('SIGNING_CAPABILITY_BLOCKED')
    expect(await requestArsredovisningSignatures(c, input, { dryRun: true })).toEqual({ ok: false, code: 'SIGNING_CAPABILITY_BLOCKED' })
    expect(signing.createSigningRequest).not.toHaveBeenCalled()
  })

  it('refuses a version that is not waiting for signatures', async () => {
    const { ctx: c, mock } = ctx()
    mock.enqueue({ data: { ...VERSION, status: 'signed' } })
    expect(await requestArsredovisningSignatures(c, input, { dryRun: false })).toMatchObject({ ok: false, code: 'ARSREDOVISNING_VERSION_NOT_SIGNABLE' })
  })

  it('keeps a version with a signature recorded by hand on that track', async () => {
    const { ctx: c, mock } = ctx()
    mock.enqueueMany([{ data: VERSION }, { data: PERIOD }, { data: [{ ...SLOT_A, status: 'signed', signing_method: 'paper_original' }, SLOT_B] }])
    expect(await requestArsredovisningSignatures(c, input, { dryRun: false })).toMatchObject({ ok: false, code: 'ARSREDOVISNING_SIGNING_TRACK_MIXED' })
  })

  it('refuses a second open request on the same version', async () => {
    const { ctx: c, mock } = ctx()
    mock.enqueueMany([{ data: VERSION }, { data: PERIOD }, { data: [SLOT_A, SLOT_B] }, { data: [{ id: 'request-0', expires_at: '2099-01-01T00:00:00.000Z' }] }])
    expect(await requestArsredovisningSignatures(c, input, { dryRun: false })).toMatchObject({
      ok: false,
      code: 'SIGNING_REQUEST_ALREADY_OPEN',
      details: { signing_request_id: 'request-0' },
    })
  })

  it('cancels an open request past its expiry and sends the version again', async () => {
    const { ctx: c, mock } = ctx()
    mock.enqueueMany([{ data: VERSION }, { data: PERIOD }, { data: [SLOT_A, SLOT_B] }, { data: [{ id: 'request-0', expires_at: '2020-01-01T00:00:00.000Z' }] }])
    const update = vi.fn(() => ({ eq: () => ({ in: () => ({ eq: async () => ({ error: null }) }) }) }))
    const { createServiceClient } = await import('@/lib/supabase/server')
    vi.mocked(createServiceClient).mockReturnValue({ from: () => ({ update }) } as never)
    const outcome = await requestArsredovisningSignatures(c, input, { dryRun: false })
    expect(outcome).toMatchObject({ ok: true })
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }))
    expect(signing.createSigningRequest).toHaveBeenCalled()
  })

  it('refuses a signer for a slot that is not pending on the version', async () => {
    const { ctx: c, mock } = ctx()
    mock.enqueueMany([{ data: VERSION }, { data: PERIOD }, { data: [SLOT_A] }, { data: [] }])
    expect(await requestArsredovisningSignatures(c, { ...input, signers: [{ signatureId: 'slot-x' }] }, { dryRun: false })).toMatchObject({
      ok: false,
      code: 'SIGNING_SIGNERS_INVALID',
    })
  })

  it('previews every pending slot, rendering and archiving nothing', async () => {
    const { ctx: c, mock } = ctx()
    mock.enqueueMany([{ data: VERSION }, { data: PERIOD }, { data: [SLOT_A, SLOT_B] }, { data: [] }])
    const outcome = await requestArsredovisningSignatures(c, input, { dryRun: true })
    expect(outcome).toMatchObject({
      ok: true,
      dryRun: true,
      preview: {
        title: 'Årsredovisning för räkenskapsåret 2026-01-01 till 2026-12-31',
        signers: [
          { signature_id: 'slot-a', name: 'Anna Svensson', email: 'anna@example.se', email_will_be_sent: true },
          { signature_id: 'slot-b', name: 'Bo Berg', email: null, email_will_be_sent: false },
        ],
        urls: null,
      },
    })
    expect(pdf).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    expect(signing.createSigningRequest).not.toHaveBeenCalled()
  })

  it('archives the e-signing copy and covers each pending slot with its own signer', async () => {
    const { ctx: c, mock } = ctx()
    mock.enqueueMany([{ data: VERSION }, { data: PERIOD }, { data: [SLOT_A, SLOT_B] }, { data: [] }])
    await requestArsredovisningSignatures(c, { ...input, signers: [{ signatureId: 'slot-a', email: 'anna@example.se', personalNumber: '199001011234' }] }, { dryRun: false })
    expect(upload).toHaveBeenCalledWith(expect.anything(), 'user-1', 'company-1', expect.objectContaining({ name: 'ar.pdf', type: 'application/pdf' }), { upload_source: 'system', extractionOwner: 'none' })
    expect(signing.createSigningRequest).toHaveBeenCalledWith(c, expect.objectContaining({
      documentId: 'document-1',
      annualReportVersionId: 'version-1',
      signers: [
        { name: 'Anna Svensson', roleLabel: 'Styrelseledamot', email: 'anna@example.se', userId: null, personalNumber: '199001011234', annualReportSignatureId: 'slot-a' },
        { name: 'Bo Berg', roleLabel: 'VD', email: null, userId: null, personalNumber: null, annualReportSignatureId: 'slot-b' },
      ],
    }))
  })
})

describe("the revisor's påteckning and the board's BankID request", () => {
  const REVISOR = { id: 'slot-r', role: 'Auktoriserad revisor', signer_name: 'Rita Revisor', status: 'pending', signing_method: null }

  it('leaves the revisor out of the request: the påteckning is recorded on its own', async () => {
    const { ctx: c, mock } = ctx()
    mock.enqueueMany([{ data: VERSION }, { data: PERIOD }, { data: [SLOT_A, REVISOR, SLOT_B] }, { data: [] }])
    await requestArsredovisningSignatures(c, input, { dryRun: false })
    const sent = signing.createSigningRequest.mock.calls[0][1] as { signers: Array<{ annualReportSignatureId: string }> }
    expect(sent.signers.map((signer) => signer.annualReportSignatureId)).toEqual(['slot-a', 'slot-b'])
  })

  it('does not count a påteckning recorded by hand as the board signing on paper', async () => {
    const { ctx: c, mock } = ctx()
    mock.enqueueMany([
      { data: VERSION },
      { data: PERIOD },
      { data: [SLOT_A, { ...REVISOR, status: 'signed', signing_method: 'paper_original' }, SLOT_B] },
      { data: [] },
    ])
    expect(await requestArsredovisningSignatures(c, input, { dryRun: false })).toMatchObject({ ok: true })
  })

  it('refuses a request for the revisor slot', async () => {
    const { ctx: c, mock } = ctx()
    mock.enqueueMany([{ data: VERSION }, { data: PERIOD }, { data: [SLOT_A, REVISOR] }, { data: [] }])
    expect(await requestArsredovisningSignatures(c, { ...input, signers: [{ signatureId: 'slot-r' }] }, { dryRun: false })).toMatchObject({
      ok: false,
      code: 'SIGNING_SIGNERS_INVALID',
    })
  })
})

describe('slotCoveredByBankIdSigning', () => {
  it('is covered by a signature, or by an open request, and free otherwise', async () => {
    const signed = ctx()
    signed.mock.enqueue({ data: [{ signing_request_id: 'request-1', status: 'signed' }] })
    expect(await slotCoveredByBankIdSigning(signed.ctx, 'slot-a')).toBe(true)

    const open = ctx()
    open.mock.enqueueMany([{ data: [{ signing_request_id: 'request-1', status: 'pending' }] }, { data: [{ id: 'request-1' }] }])
    expect(await slotCoveredByBankIdSigning(open.ctx, 'slot-a')).toBe(true)

    const cancelled = ctx()
    cancelled.mock.enqueueMany([{ data: [{ signing_request_id: 'request-1', status: 'pending' }] }, { data: [] }])
    expect(await slotCoveredByBankIdSigning(cancelled.ctx, 'slot-a')).toBe(false)

    const none = ctx()
    none.mock.enqueue({ data: [] })
    expect(await slotCoveredByBankIdSigning(none.ctx, 'slot-a')).toBe(false)
  })
})
