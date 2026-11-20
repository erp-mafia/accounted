import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest } from '@/tests/helpers'

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
  getCompanyRole: vi.fn().mockResolvedValue({ ok: true, role: 'member' }),
}))
vi.mock('@/lib/bolaget/gate', () => ({ bolagetGate: vi.fn() }))
vi.mock('@/lib/bolaget/meetings/store', () => ({
  createMeeting: vi.fn(),
  updateMeeting: vi.fn(),
  deleteMeeting: vi.fn(),
  recordDecision: vi.fn(),
  deleteDecision: vi.fn(),
  holdMeeting: vi.fn(),
}))
vi.mock('@/lib/bolaget/meetings/view', () => ({ listMeetingsView: vi.fn(), getMeetingView: vi.fn() }))
vi.mock('@/lib/bolaget/meetings/signing', () => ({ signMeetingManually: vi.fn(), requestMeetingSignatures: vi.fn(), renderMeetingPdf: vi.fn() }))

import { requireAuth } from '@/lib/auth/require-auth'
import { bolagetGate } from '@/lib/bolaget/gate'
import { createMeeting, holdMeeting, recordDecision, updateMeeting, deleteMeeting } from '@/lib/bolaget/meetings/store'
import { getMeetingView, listMeetingsView } from '@/lib/bolaget/meetings/view'
import { signMeetingManually } from '@/lib/bolaget/meetings/signing'
import { GET as list, POST as create } from '../route'
import { GET as get, PATCH as patch, DELETE as remove } from '../[id]/route'
import { POST as decide } from '../[id]/decisions/route'
import { POST as hold } from '../[id]/hold/route'
import { POST as sign } from '../[id]/sign/route'

const supabase = {}
const MEETING = '66666666-6666-4666-8666-666666666666'
const noParams = { params: Promise.resolve({}) } as never
const idParams = { params: Promise.resolve({ id: MEETING }) } as never

function unauthenticated() {
  vi.mocked(requireAuth).mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null } as never)
  vi.mocked(bolagetGate).mockResolvedValue(null)
})

describe('GET /api/bolaget/meetings', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await list(createMockRequest('/api/bolaget/meetings'), noParams)).status).toBe(401)
    expect(listMeetingsView).not.toHaveBeenCalled()
  })

  it('answers 404 outside the rollout and 409 for a form without an aktiebok', async () => {
    vi.mocked(bolagetGate).mockResolvedValueOnce('BOLAGET_DISABLED')
    const off = await list(createMockRequest('/api/bolaget/meetings'), noParams)
    expect(off.status).toBe(404)
    expect((await off.json()).error.code).toBe('BOLAGET_DISABLED')
    vi.mocked(bolagetGate).mockResolvedValueOnce('BOLAGET_NOT_FOR_LEGAL_FORM')
    expect((await list(createMockRequest('/api/bolaget/meetings'), noParams)).status).toBe(409)
  })

  it('refuses an unknown kind', async () => {
    expect((await list(createMockRequest('/api/bolaget/meetings?kind=fest'), noParams)).status).toBe(400)
  })

  it('lists the meetings', async () => {
    vi.mocked(listMeetingsView).mockResolvedValueOnce([{ corporate_meeting_id: MEETING, kind: 'arsstamma' } as never])
    const res = await list(createMockRequest('/api/bolaget/meetings?kind=arsstamma'), noParams)
    expect(res.status).toBe(200)
    expect((await res.json()).data.meetings).toHaveLength(1)
    expect(vi.mocked(listMeetingsView).mock.calls[0]![1]).toEqual({ kind: 'arsstamma', fiscal_period_id: null })
  })
})

describe('POST /api/bolaget/meetings', () => {
  const post = (body: unknown) => create(createMockRequest('/api/bolaget/meetings', { method: 'POST', body }), noParams)

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await post({ kind: 'styrelsemote', meeting_date: '2027-05-10' })).status).toBe(401)
  })

  it('refuses an unknown field (a personnummer never rides along) and a bad date', async () => {
    expect((await post({ kind: 'styrelsemote', meeting_date: '2027-05-10', personnummer: '198001011234' })).status).toBe(400)
    expect((await post({ kind: 'styrelsemote', meeting_date: '2027-13-40' })).status).toBe(400)
    expect(createMeeting).not.toHaveBeenCalled()
  })

  it('answers the service refusal in Swedish', async () => {
    vi.mocked(createMeeting).mockResolvedValueOnce({ ok: false, code: 'CORPORATE_MEETING_FISCAL_PERIOD_REQUIRED' })
    const res = await post({ kind: 'arsstamma', meeting_date: '2027-05-10' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toContain('räkenskapsåret')
  })

  it('creates the meeting', async () => {
    vi.mocked(createMeeting).mockResolvedValueOnce({ ok: true, data: { corporate_meeting_id: MEETING, kind: 'styrelsemote', organ: 'styrelse', meeting_date: '2027-05-10', status: 'draft', decisions_count: 4 }, created: true })
    const res = await post({ kind: 'styrelsemote', meeting_date: '2027-05-10' })
    expect(res.status).toBe(201)
    expect((await res.json()).data.corporate_meeting_id).toBe(MEETING)
  })
})

describe('/api/bolaget/meetings/{id}', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await get(createMockRequest(`/api/bolaget/meetings/${MEETING}`), idParams)).status).toBe(401)
  })

  it('answers 404 for a meeting that is not the company\'s', async () => {
    vi.mocked(getMeetingView).mockResolvedValueOnce(null)
    const res = await get(createMockRequest(`/api/bolaget/meetings/${MEETING}`), idParams)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('CORPORATE_MEETING_NOT_FOUND')
  })

  it('answers the meeting', async () => {
    vi.mocked(getMeetingView).mockResolvedValueOnce({ corporate_meeting_id: MEETING, decisions: [] } as never)
    const res = await get(createMockRequest(`/api/bolaget/meetings/${MEETING}`), idParams)
    expect(res.status).toBe(200)
    expect((await res.json()).data.corporate_meeting_id).toBe(MEETING)
  })

  it('refuses an attendee without a capacity, and a change to signed minutes', async () => {
    expect((await patch(createMockRequest(`/api/bolaget/meetings/${MEETING}`, { method: 'PATCH', body: { attendees: [{ name: 'Anna' }] } }), idParams)).status).toBe(400)
    vi.mocked(updateMeeting).mockResolvedValueOnce({ ok: false, code: 'CORPORATE_MEETING_LOCKED' })
    const res = await patch(createMockRequest(`/api/bolaget/meetings/${MEETING}`, { method: 'PATCH', body: { place: 'Kontoret' } }), idParams)
    expect(res.status).toBe(409)
  })

  it('keeps a held meeting and deletes a draft', async () => {
    vi.mocked(deleteMeeting).mockResolvedValueOnce({ ok: false, code: 'CORPORATE_MEETING_NOT_DRAFT' })
    expect((await remove(createMockRequest(`/api/bolaget/meetings/${MEETING}`, { method: 'DELETE' }), idParams)).status).toBe(409)
    vi.mocked(deleteMeeting).mockResolvedValueOnce({ ok: true, data: { corporate_meeting_id: MEETING } })
    expect((await remove(createMockRequest(`/api/bolaget/meetings/${MEETING}`, { method: 'DELETE' }), idParams)).status).toBe(200)
  })
})

describe('POST /api/bolaget/meetings/{id}/decisions', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await decide(createMockRequest(`/api/bolaget/meetings/${MEETING}/decisions`, { method: 'POST', body: { kind: 'ovrigt' } }), idParams)).status).toBe(401)
  })

  it('refuses an unknown kind', async () => {
    expect((await decide(createMockRequest(`/api/bolaget/meetings/${MEETING}/decisions`, { method: 'POST', body: { kind: 'fest' } }), idParams)).status).toBe(400)
  })

  it('answers 404 for an unknown decision', async () => {
    vi.mocked(recordDecision).mockResolvedValueOnce({ ok: false, code: 'CORPORATE_DECISION_NOT_FOUND' })
    const res = await decide(createMockRequest(`/api/bolaget/meetings/${MEETING}/decisions`, { method: 'POST', body: { corporate_decision_id: MEETING, outcome: 'avslagen' } }), idParams)
    expect(res.status).toBe(404)
  })

  it('records the decision on the meeting in the path', async () => {
    vi.mocked(recordDecision).mockResolvedValueOnce({ ok: true, data: { corporate_decision_id: 'd1', corporate_meeting_id: MEETING, item_number: 9, kind: 'utdelning' }, created: true })
    const res = await decide(
      createMockRequest(`/api/bolaget/meetings/${MEETING}/decisions`, { method: 'POST', body: { kind: 'utdelning', payload: { amount_per_share: 50, share_count: 1000, total_amount: 50000 } } }),
      idParams,
    )
    expect(res.status).toBe(201)
    expect(vi.mocked(recordDecision).mock.calls[0]![1]).toMatchObject({ corporate_meeting_id: MEETING, kind: 'utdelning' })
  })
})

describe('POST /api/bolaget/meetings/{id}/hold', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await hold(createMockRequest(`/api/bolaget/meetings/${MEETING}/hold`, { method: 'POST' }), idParams)).status).toBe(401)
  })

  it('answers 404 and 409 from the service', async () => {
    vi.mocked(holdMeeting).mockResolvedValueOnce({ ok: false, code: 'CORPORATE_MEETING_NOT_FOUND' })
    expect((await hold(createMockRequest(`/api/bolaget/meetings/${MEETING}/hold`, { method: 'POST' }), idParams)).status).toBe(404)
    vi.mocked(holdMeeting).mockResolvedValueOnce({ ok: false, code: 'CORPORATE_MEETING_IN_FUTURE' })
    expect((await hold(createMockRequest(`/api/bolaget/meetings/${MEETING}/hold`, { method: 'POST' }), idParams)).status).toBe(409)
  })

  it('holds the meeting, or previews it on dry_run', async () => {
    vi.mocked(holdMeeting).mockResolvedValueOnce({ ok: true, dryRun: true, preview: { sequence_number: 4 } })
    const preview = await hold(createMockRequest(`/api/bolaget/meetings/${MEETING}/hold?dry_run=true`, { method: 'POST' }), idParams)
    expect((await preview.json()).data.sequence_number).toBe(4)
    expect(vi.mocked(holdMeeting).mock.calls[0]![2]).toEqual({ dryRun: true })
    vi.mocked(holdMeeting).mockResolvedValueOnce({ ok: true, data: { corporate_meeting_id: MEETING, status: 'held', sequence_number: 4, agm_recorded: false } })
    const res = await hold(createMockRequest(`/api/bolaget/meetings/${MEETING}/hold`, { method: 'POST' }), idParams)
    expect(res.status).toBe(200)
  })
})

describe('POST /api/bolaget/meetings/{id}/sign', () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData()
    for (const [k, v] of Object.entries(fields)) data.set(k, v)
    return new Request(`http://localhost/api/bolaget/meetings/${MEETING}/sign`, { method: 'POST', body: data }) as never
  }

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await sign(form({ signed_on: '2027-05-12', signature_names: 'Anna Ek' }), idParams)).status).toBe(401)
  })

  it('refuses a missing signer name', async () => {
    expect((await sign(form({ signed_on: '2027-05-12' }), idParams)).status).toBe(400)
    expect(signMeetingManually).not.toHaveBeenCalled()
  })

  it('signs the minutes by hand', async () => {
    vi.mocked(signMeetingManually).mockResolvedValueOnce({ ok: true, data: { corporate_meeting_id: MEETING, status: 'signed', signed_document_id: null, roles_added: [], roles_ended: [] } })
    const res = await sign(form({ signed_on: '2027-05-12', signature_names: 'Anna Ek' }), idParams)
    expect(res.status).toBe(200)
    expect(vi.mocked(signMeetingManually).mock.calls[0]![2]).toEqual({ signedOn: '2027-05-12', signatureNames: 'Anna Ek', file: null })
  })
})
