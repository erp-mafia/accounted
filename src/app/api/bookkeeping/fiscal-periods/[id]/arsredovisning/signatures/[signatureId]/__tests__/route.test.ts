import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

// Route path ids are uuids: the route answers its 404 to anything else before it reads.
const PERIOD_1 = '967b285e-2dcb-5661-91f6-68a799845858'
const SIGNATURE_1 = '81428555-f869-5e97-a025-1eada1aef99b'

const requireAuthMock = vi.fn()
const requireWriteMock = vi.fn()
const createServiceClientMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => createServiceClientMock(),
}))

import { DELETE, PATCH } from '../route'

const versionId = '123e4567-e89b-12d3-a456-426614174000'
const params = {
  params: Promise.resolve({ id: PERIOD_1, signatureId: SIGNATURE_1 }),
}
const signedBody = {
  status: 'signed',
  annual_report_version_id: versionId,
  signing_method: 'paper_original',
  evidence_reference: 'archive:A-1',
  signed_at: '2026-03-01T10:00:00.000Z',
}

function setup() {
  const mock = createQueuedMockSupabase()
  requireAuthMock.mockResolvedValue({
    user: { id: 'user-1' },
    supabase: mock.supabase,
    error: null,
  })
  createServiceClientMock.mockReturnValue(mock.supabase)
  return mock
}

beforeEach(() => {
  vi.clearAllMocks()
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('annual report signature transition', () => {
  it('returns 401 without authentication', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect(
      (
        await PATCH(
          createMockRequest('/x', { method: 'PATCH', body: signedBody }),
          params,
        )
      ).status,
    ).toBe(401)
  })

  it('returns 400 when signed evidence is missing', async () => {
    setup()
    const response = await PATCH(
      createMockRequest('/x', { method: 'PATCH', body: { status: 'signed' } }),
      params,
    )
    expect(response.status).toBe(400)
  })

  it('returns 400 for a free-text evidence reference', async () => {
    setup()
    const response = await PATCH(
      createMockRequest('/x', {
        method: 'PATCH',
        body: { ...signedBody, evidence_reference: 'Original i arkiv A-1' },
      }),
      params,
    )
    expect(response.status).toBe(400)
  })

  it('returns 409 when the version is not ready for signature', async () => {
    const { enqueue } = setup()
    enqueue({ data: null })
    const response = await PATCH(
      createMockRequest('/x', { method: 'PATCH', body: signedBody }),
      params,
    )
    expect(response.status).toBe(409)
  })

  it('refuses bankid typed by hand: only the BankID signing in Accounted sets it', async () => {
    setup()
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await PATCH(createMockRequest('/x', { method: 'PATCH', body: { ...signedBody, signing_method: 'bankid' } }), params),
    )
    expect(status).toBe(422)
    expect(body.error.code).toBe('SIGNING_METHOD_RESERVED')
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })

  it('refuses evidence by hand on a version that already carries a BankID signature, also after its request was cancelled', async () => {
    const { enqueue } = setup()
    enqueue({ data: [] })
    enqueue({ data: { id: versionId, status: 'ready_for_signature', finalized_at: '2026-03-01T08:00:00.000Z' } })
    enqueue({ data: { id: SIGNATURE_1, annual_report_version_id: versionId, status: 'pending', role: 'Styrelseledamot' } })
    enqueue({ data: [{ id: 'signature-2' }] })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await PATCH(createMockRequest('/x', { method: 'PATCH', body: signedBody }), params),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('ARSREDOVISNING_SIGNING_TRACK_MIXED')
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })

  describe("the revisor's påteckning", () => {
    const pendingRevisor = { id: SIGNATURE_1, annual_report_version_id: versionId, status: 'pending', role: 'Auktoriserad revisor' }
    const bankidBoard = [
      { role: 'Styrelseledamot', status: 'signed', signing_method: 'bankid', pateckning_opinion: null, pateckning_firm_name: null },
      { role: 'Verkställande direktör', status: 'signed', signing_method: 'bankid', pateckning_opinion: null, pateckning_firm_name: null },
      { role: 'Auktoriserad revisor', status: 'pending', signing_method: null, pateckning_opinion: null, pateckning_firm_name: null },
    ]
    const electronicBody = { ...signedBody, signing_method: 'advanced_e_signature', evidence_reference: 'receipt:esign-1' }

    /** Up to the påteckning gate: no BankID request covers the slot, the version, the revisor's slot. */
    function revisorSlot(enqueue: (result: { data?: unknown }) => void) {
      enqueue({ data: [] })
      enqueue({ data: { id: versionId, status: 'ready_for_signature', finalized_at: '2026-03-01T08:00:00.000Z' } })
      enqueue({ data: pendingRevisor })
    }

    it('records an electronic påteckning on a version the board signed with BankID, and freezes the opinion on the slot', async () => {
      const { enqueue, findCall } = setup()
      revisorSlot(enqueue)
      // No BankID-track query for a revisor: the next result is the gate's read of the version's slots.
      enqueue({ data: bankidBoard })
      enqueue({ data: { auditor_report_required: true, auditor_firm_name: ' Revisionsbyrån AB ', auditor_opinion: 'unmodified' } })
      enqueue({
        data: { id: SIGNATURE_1, company_id: 'company-1', fiscal_period_id: PERIOD_1, status: 'signed', signing_method: 'advanced_e_signature' },
      })
      const { status, body } = await parseJsonResponse<{ data: { status: string } }>(
        await PATCH(createMockRequest('/x', { method: 'PATCH', body: electronicBody }), params),
      )
      expect(status).toBe(200)
      expect(body.data.status).toBe('signed')
      expect(findCall('arsredovisning_signature_requests', 'update')?.[0]).toMatchObject({
        status: 'signed',
        signing_method: 'advanced_e_signature',
        pateckning_opinion: 'unmodified',
        pateckning_firm_name: 'Revisionsbyrån AB',
      })
    })

    it('refuses a paper påteckning on a version the board signed electronically (ÅRL 2 kap. 5 och 7 §§)', async () => {
      const { enqueue } = setup()
      revisorSlot(enqueue)
      enqueue({ data: bankidBoard })
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
        await PATCH(createMockRequest('/x', { method: 'PATCH', body: signedBody }), params),
      )
      expect(status).toBe(409)
      expect(body.error.code).toBe('ARSREDOVISNING_PATECKNING_MEDIUM_MIXED')
      expect(createServiceClientMock).not.toHaveBeenCalled()
    })

    it('refuses an electronic påteckning on a paper original', async () => {
      const { enqueue } = setup()
      revisorSlot(enqueue)
      enqueue({
        data: [
          { role: 'Styrelseledamot', status: 'signed', signing_method: 'paper_original', pateckning_opinion: null, pateckning_firm_name: null },
          { role: 'Auktoriserad revisor', status: 'pending', signing_method: null, pateckning_opinion: null, pateckning_firm_name: null },
        ],
      })
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
        await PATCH(createMockRequest('/x', { method: 'PATCH', body: electronicBody }), params),
      )
      expect(status).toBe(409)
      expect(body.error.code).toBe('ARSREDOVISNING_PATECKNING_MEDIUM_MIXED')
    })

    it('refuses the påteckning before the whole board has signed', async () => {
      const { enqueue } = setup()
      revisorSlot(enqueue)
      enqueue({
        data: [
          { role: 'Styrelseledamot', status: 'signed', signing_method: 'paper_original', pateckning_opinion: null, pateckning_firm_name: null },
          { role: 'Styrelseledamot', status: 'pending', signing_method: null, pateckning_opinion: null, pateckning_firm_name: null },
          { role: 'Auktoriserad revisor', status: 'pending', signing_method: null, pateckning_opinion: null, pateckning_firm_name: null },
        ],
      })
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
        await PATCH(createMockRequest('/x', { method: 'PATCH', body: signedBody }), params),
      )
      expect(status).toBe(409)
      expect(body.error.code).toBe('ARSREDOVISNING_PATECKNING_BEFORE_BOARD')
    })

    it('refuses the påteckning while the revisionsberättelse\'s opinion is unanswered', async () => {
      const { enqueue } = setup()
      revisorSlot(enqueue)
      enqueue({ data: bankidBoard })
      enqueue({ data: { auditor_report_required: true, auditor_firm_name: null, auditor_opinion: null } })
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
        await PATCH(createMockRequest('/x', { method: 'PATCH', body: electronicBody }), params),
      )
      expect(status).toBe(409)
      expect(body.error.code).toBe('ARSREDOVISNING_PATECKNING_OPINION_MISSING')
      expect(createServiceClientMock).not.toHaveBeenCalled()
    })

    it("gives a second revisor the påteckning the first one froze, not the profile's", async () => {
      const { enqueue, findCall } = setup()
      revisorSlot(enqueue)
      enqueue({
        data: [
          { role: 'Styrelseledamot', status: 'signed', signing_method: 'paper_original', pateckning_opinion: null, pateckning_firm_name: null },
          { role: 'Huvudansvarig revisor', status: 'signed', signing_method: 'paper_original', pateckning_opinion: 'modified', pateckning_firm_name: 'Revisionsbyrån AB' },
          { role: 'Auktoriserad revisor', status: 'pending', signing_method: null, pateckning_opinion: null, pateckning_firm_name: null },
        ],
      })
      // No profile read: the next result is the recorded slot.
      enqueue({ data: { id: SIGNATURE_1, status: 'signed', signing_method: 'paper_original' } })
      const { status } = await parseJsonResponse(await PATCH(createMockRequest('/x', { method: 'PATCH', body: signedBody }), params))
      expect(status).toBe(200)
      expect(findCall('arsredovisning_signature_requests', 'update')?.[0]).toMatchObject({
        pateckning_opinion: 'modified',
        pateckning_firm_name: 'Revisionsbyrån AB',
      })
    })
  })

  it('refuses evidence by hand on a slot a BankID signing request covers', async () => {
    const { enqueue } = setup()
    enqueue({ data: [{ signing_request_id: 'request-1', status: 'pending' }] })
    enqueue({ data: [{ id: 'request-1' }] })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await PATCH(createMockRequest('/x', { method: 'PATCH', body: signedBody }), params),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('ARSREDOVISNING_SIGNING_TRACK_MIXED')
  })

  it('stores version-bound signature evidence', async () => {
    const { enqueue } = setup()
    // No BankID signing request covers the slot (slotCoveredByBankIdSigning).
    enqueue({ data: [] })
    enqueue({
      data: {
        id: versionId,
        status: 'ready_for_signature',
        finalized_at: '2026-03-01T08:00:00.000Z',
      },
    })
    enqueue({ data: { id: SIGNATURE_1, annual_report_version_id: versionId, status: 'pending', role: 'Styrelseledamot' } })
    // No slot of the version carries a BankID signature.
    enqueue({ data: [] })
    enqueue({
      data: {
        id: SIGNATURE_1,
        company_id: 'company-1',
        fiscal_period_id: PERIOD_1,
        status: 'signed',
        signing_method: 'paper_original',
        evidence_reference: 'archive:A-1',
      },
    })
    const { status, body } = await parseJsonResponse<{
      data: { status: string; evidence_reference: string }
    }>(
      await PATCH(
        createMockRequest('/x', { method: 'PATCH', body: signedBody }),
        params,
      ),
    )
    expect(status).toBe(200)
    expect(body.data.status).toBe('signed')
    expect(body.data.evidence_reference).toBe('archive:A-1')
    expect(createServiceClientMock).toHaveBeenCalledOnce()
  })

  it('rejects a signature date before the version was finalized', async () => {
    const { enqueue } = setup()
    // No BankID signing request covers the slot (slotCoveredByBankIdSigning).
    enqueue({ data: [] })
    enqueue({
      data: {
        id: versionId,
        status: 'ready_for_signature',
        finalized_at: '2026-03-02T08:00:00.000Z',
      },
    })
    enqueue({ data: { id: SIGNATURE_1, annual_report_version_id: versionId, status: 'pending', role: 'Styrelseledamot' } })
    // No slot of the version carries a BankID signature.
    enqueue({ data: [] })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await PATCH(
        createMockRequest('/x', { method: 'PATCH', body: signedBody }),
        params,
      ),
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('ARSREDOVISNING_SIGNATURE_DATE_INVALID')
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })

  it('rejects a future signature date', async () => {
    const { enqueue } = setup()
    // No BankID signing request covers the slot (slotCoveredByBankIdSigning).
    enqueue({ data: [] })
    enqueue({
      data: {
        id: versionId,
        status: 'ready_for_signature',
        finalized_at: '2026-03-01T08:00:00.000Z',
      },
    })
    enqueue({ data: { id: SIGNATURE_1, annual_report_version_id: versionId, status: 'pending', role: 'Styrelseledamot' } })
    // No slot of the version carries a BankID signature.
    enqueue({ data: [] })
    const response = await PATCH(
      createMockRequest('/x', {
        method: 'PATCH',
        body: { ...signedBody, signed_at: '2999-03-01T10:00:00.000Z' },
      }),
      params,
    )
    expect(response.status).toBe(400)
  })
})

describe('annual report draft signer removal', () => {
  it('returns 401 without authentication', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await DELETE(createMockRequest('/x', { method: 'DELETE' }), params)).status).toBe(401)
  })

  it('returns 409 when the signer is already bound to a version', async () => {
    const { enqueue } = setup()
    enqueue({ data: null, error: null })
    expect((await DELETE(createMockRequest('/x', { method: 'DELETE' }), params)).status).toBe(409)
  })

  it('removes an unbound pending signer', async () => {
    const { enqueue } = setup()
    enqueue({ data: { id: SIGNATURE_1 }, error: null })
    expect((await DELETE(createMockRequest('/x', { method: 'DELETE' }), params)).status).toBe(204)
  })
})
