/**
 * The session routes of Avtal och åtaganden: GET /api/commitments and the
 * writes under it. The rules live in lib/commitments and are tested there;
 * here the doors: a session, a writing role, the body, the failures the
 * services answer and what reaches them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest } from '@/tests/helpers'

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: vi.fn().mockResolvedValue({ ok: true }) }))
const agreementsService = vi.hoisted(() => ({
  listAgreements: vi.fn(),
  listObligations: vi.fn(),
  createAgreement: vi.fn(),
  updateAgreement: vi.fn(),
  endAgreement: vi.fn(),
}))
vi.mock('@/lib/commitments/agreements', () => agreementsService)
const securitiesService = vi.hoisted(() => ({ listSecurities: vi.fn(), createSecurity: vi.fn(), updateSecurity: vi.fn() }))
vi.mock('@/lib/commitments/securities', () => securitiesService)
const groupService = vi.hoisted(() => ({ listGroupLinks: vi.fn(), createGroupLink: vi.fn(), updateGroupLink: vi.fn() }))
vi.mock('@/lib/commitments/group-links', () => groupService)

import { requireAuth } from '@/lib/auth/require-auth'
import { requireWritePermission } from '@/lib/auth/require-write'
import { GET as overview } from '../route'
import { POST as createAgreementRoute } from '../agreements/route'
import { PATCH as updateAgreementRoute } from '../agreements/[id]/route'
import { POST as endAgreementRoute } from '../agreements/[id]/end/route'
import { POST as createSecurityRoute } from '../securities/route'
import { PATCH as updateSecurityRoute } from '../securities/[id]/route'
import { POST as createGroupLinkRoute } from '../group-links/route'
import { PATCH as updateGroupLinkRoute } from '../group-links/[id]/route'

const supabase = {}
const noParams = { params: Promise.resolve({}) } as never
const idParams = (id: string) => ({ params: Promise.resolve({ id }) }) as never
const post = (url: string, body: unknown) => createMockRequest(url, { method: 'POST', body })
const patch = (url: string, body: unknown) => createMockRequest(url, { method: 'PATCH', body })
type ErrorBody = { error: { code: string } }

const view = { agreement_id: 'agr-1', title: 'Hyresavtal kontor', status: 'active' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null } as never)
  vi.mocked(requireWritePermission).mockResolvedValue({ ok: true } as never)
})

function signedOut() {
  vi.mocked(requireAuth).mockResolvedValue({
    user: null,
    supabase,
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  } as never)
}

describe('GET /api/commitments', () => {
  it('returns 401 without a session', async () => {
    signedOut()
    expect((await overview(createMockRequest('/api/commitments'), noParams)).status).toBe(401)
    expect(agreementsService.listAgreements).not.toHaveBeenCalled()
  })

  it('answers 404 COMMITMENTS_UNAVAILABLE outside the rollout', async () => {
    const unavailable = { ok: false, code: 'COMMITMENTS_UNAVAILABLE' }
    agreementsService.listAgreements.mockResolvedValue(unavailable)
    agreementsService.listObligations.mockResolvedValue(unavailable)
    securitiesService.listSecurities.mockResolvedValue(unavailable)
    groupService.listGroupLinks.mockResolvedValue(unavailable)
    const res = await overview(createMockRequest('/api/commitments'), noParams)
    expect(res.status).toBe(404)
    expect(((await res.json()) as ErrorBody).error.code).toBe('COMMITMENTS_UNAVAILABLE')
  })

  it('gathers the agreements, the payments that are due or missed, the securities and the group', async () => {
    agreementsService.listAgreements.mockResolvedValue({ ok: true, data: { agreements: [view] } })
    agreementsService.listObligations.mockResolvedValue({
      ok: true,
      data: {
        obligations: [
          { obligation_id: 'o-1', status: 'missed', due_on: '2000-01-01' },
          { obligation_id: 'o-2', status: 'matched', due_on: '2000-01-02' },
          { obligation_id: 'o-3', status: 'expected', due_on: '2999-01-01' },
        ],
      },
    })
    securitiesService.listSecurities.mockResolvedValue({ ok: true, data: { securities: [], balance_date: '2026-10-29', note_texts: { securities_pledged: null, contingent_liabilities: null } } })
    groupService.listGroupLinks.mockResolvedValue({ ok: true, data: { group_links: [], applies: true } })
    const res = await overview(createMockRequest('/api/commitments'), noParams)
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.agreements).toEqual([view])
    expect(data.upcoming_payments.map((o: { obligation_id: string }) => o.obligation_id)).toEqual(['o-1', 'o-3'])
    expect(data.group_structure_applies).toBe(true)
    expect(agreementsService.listAgreements).toHaveBeenCalledWith({ supabase, companyId: 'company-1', userId: 'user-1' }, {}, expect.any(String))
  })
})

describe('POST /api/commitments/agreements', () => {
  const body = { kind: 'rental', title: 'Hyresavtal kontor', amount: 12500, period: 'monthly', starts_on: '2026-01-01' }

  it('returns 401 without a session', async () => {
    signedOut()
    expect((await createAgreementRoute(post('/api/commitments/agreements', body), noParams)).status).toBe(401)
    expect(agreementsService.createAgreement).not.toHaveBeenCalled()
  })

  it('returns 403 for a member without a writing role', async () => {
    vi.mocked(requireWritePermission).mockResolvedValue({ ok: false, response: NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 }) } as never)
    expect((await createAgreementRoute(post('/api/commitments/agreements', body), noParams)).status).toBe(403)
    expect(agreementsService.createAgreement).not.toHaveBeenCalled()
  })

  it('returns 400 for an unknown kind, an amount without a period, an end before the start or an unknown field', async () => {
    for (const bad of [
      { ...body, kind: 'marriage' },
      { ...body, period: undefined },
      { ...body, ends_on: '2025-01-01' },
      { ...body, source_document_id: 'x' },
    ]) {
      expect((await createAgreementRoute(post('/api/commitments/agreements', bad), noParams)).status).toBe(400)
    }
    expect(agreementsService.createAgreement).not.toHaveBeenCalled()
  })

  it('registers the agreement and answers 201', async () => {
    agreementsService.createAgreement.mockResolvedValue({ ok: true, created: true, data: view })
    const res = await createAgreementRoute(post('/api/commitments/agreements', body), noParams)
    expect(res.status).toBe(201)
    expect((await res.json()).data).toEqual(view)
    expect(agreementsService.createAgreement).toHaveBeenCalledWith(
      { supabase, companyId: 'company-1', userId: 'user-1' },
      expect.objectContaining({ kind: 'rental', amount: 12500, period: 'monthly' }),
      { dryRun: false },
    )
  })
})

describe('PATCH /api/commitments/agreements/:id and POST .../end', () => {
  it('returns 401 without a session', async () => {
    signedOut()
    expect((await updateAgreementRoute(patch('/api/commitments/agreements/agr-1', { amount: 1 }), idParams('agr-1'))).status).toBe(401)
    expect((await endAgreementRoute(post('/api/commitments/agreements/agr-1/end', {}), idParams('agr-1'))).status).toBe(401)
  })

  it('returns 400 for a bad date', async () => {
    expect((await endAgreementRoute(post('/api/commitments/agreements/agr-1/end', { ended_on: '31/10/2026' }), idParams('agr-1'))).status).toBe(400)
  })

  it('answers 404 for an agreement the company does not have and 409 for a derived one', async () => {
    agreementsService.updateAgreement.mockResolvedValue({ ok: false, code: 'AGREEMENT_NOT_FOUND' })
    expect((await updateAgreementRoute(patch('/api/commitments/agreements/nope', { amount: 1, period: 'monthly' }), idParams('nope'))).status).toBe(404)
    agreementsService.endAgreement.mockResolvedValue({ ok: false, code: 'AGREEMENT_DERIVED' })
    const res = await endAgreementRoute(post('/api/commitments/agreements/agr-1/end', {}), idParams('agr-1'))
    expect(res.status).toBe(409)
    expect(((await res.json()) as ErrorBody).error.code).toBe('AGREEMENT_DERIVED')
  })

  it('passes the id and the changes on', async () => {
    agreementsService.updateAgreement.mockResolvedValue({ ok: true, data: view })
    agreementsService.endAgreement.mockResolvedValue({ ok: true, data: { ...view, status: 'ended' } })
    expect((await updateAgreementRoute(patch('/api/commitments/agreements/agr-1', { notice_months: 3 }), idParams('agr-1'))).status).toBe(200)
    expect(agreementsService.updateAgreement).toHaveBeenCalledWith(expect.anything(), 'agr-1', { notice_months: 3 }, { dryRun: false })
    expect((await endAgreementRoute(post('/api/commitments/agreements/agr-1/end', { ended_on: '2026-10-31' }), idParams('agr-1'))).status).toBe(200)
    expect(agreementsService.endAgreement).toHaveBeenCalledWith(expect.anything(), 'agr-1', { ended_on: '2026-10-31' }, { dryRun: false })
  })
})

describe('securities', () => {
  const body = { kind: 'foretagsinteckning', description: 'Företagsinteckning för checkkredit', amount: 500000 }

  it('returns 401 without a session', async () => {
    signedOut()
    expect((await createSecurityRoute(post('/api/commitments/securities', body), noParams)).status).toBe(401)
  })

  it('returns 400 for an unknown kind, a negative amount or a release before the start', async () => {
    expect((await createSecurityRoute(post('/api/commitments/securities', { ...body, kind: 'pant' }), noParams)).status).toBe(400)
    expect((await createSecurityRoute(post('/api/commitments/securities', { ...body, amount: -1 }), noParams)).status).toBe(400)
    expect((await updateSecurityRoute(patch('/api/commitments/securities/s-1', { valid_from: '2026-02-01', valid_to: '2026-01-01' }), idParams('s-1'))).status).toBe(400)
    expect(securitiesService.createSecurity).not.toHaveBeenCalled()
  })

  it('answers 404 for a security the company does not have', async () => {
    securitiesService.updateSecurity.mockResolvedValue({ ok: false, code: 'SECURITY_NOT_FOUND' })
    expect((await updateSecurityRoute(patch('/api/commitments/securities/nope', { amount: 1 }), idParams('nope'))).status).toBe(404)
  })

  it('registers a security and answers 201', async () => {
    securitiesService.createSecurity.mockResolvedValue({ ok: true, created: true, data: { security_id: 's-1' } })
    const res = await createSecurityRoute(post('/api/commitments/securities', body), noParams)
    expect(res.status).toBe(201)
    expect((await res.json()).data.security_id).toBe('s-1')
  })
})

describe('group links', () => {
  const body = { relation: 'parent', counterparty_name: 'Ägarbolaget AB', ownership_percent: 100 }

  it('returns 401 without a session', async () => {
    signedOut()
    expect((await createGroupLinkRoute(post('/api/commitments/group-links', body), noParams)).status).toBe(401)
  })

  it('returns 400 for a percent above 100 or an account outside 13xx', async () => {
    expect((await createGroupLinkRoute(post('/api/commitments/group-links', { ...body, ownership_percent: 120 }), noParams)).status).toBe(400)
    expect((await createGroupLinkRoute(post('/api/commitments/group-links', { ...body, bas_account: '1930' }), noParams)).status).toBe(400)
    expect(groupService.createGroupLink).not.toHaveBeenCalled()
  })

  it('answers 404 for a link the company does not have, 409 for an enskild firma', async () => {
    groupService.updateGroupLink.mockResolvedValue({ ok: false, code: 'GROUP_LINK_NOT_FOUND' })
    expect((await updateGroupLinkRoute(patch('/api/commitments/group-links/nope', { voting_percent: 50 }), idParams('nope'))).status).toBe(404)
    groupService.createGroupLink.mockResolvedValue({ ok: false, code: 'GROUP_LINKS_NOT_FOR_LEGAL_FORM' })
    expect((await createGroupLinkRoute(post('/api/commitments/group-links', body), noParams)).status).toBe(409)
  })

  it('registers a parent and answers 201', async () => {
    groupService.createGroupLink.mockResolvedValue({ ok: true, created: true, data: { group_link_id: 'g-1' } })
    const res = await createGroupLinkRoute(post('/api/commitments/group-links', body), noParams)
    expect(res.status).toBe(201)
    expect(groupService.createGroupLink).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ relation: 'parent', ownership_percent: 100 }), { dryRun: false })
  })
})
