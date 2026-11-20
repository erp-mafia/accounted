import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/bolaget/gate', () => ({ bolagetGate: vi.fn() }))
vi.mock('@/lib/bolaget/meetings/store', () => ({
  createMeeting: vi.fn(),
  updateMeeting: vi.fn(),
  recordDecision: vi.fn(),
  holdMeeting: vi.fn(),
}))
vi.mock('@/lib/bolaget/meetings/view', () => ({ listMeetingsView: vi.fn(), getMeetingView: vi.fn() }))

import { bolagetGate } from '@/lib/bolaget/gate'
import { createMeeting, holdMeeting, updateMeeting } from '@/lib/bolaget/meetings/store'
import { getMeetingView, listMeetingsView } from '@/lib/bolaget/meetings/view'
import { operationForPendingType } from '../registry'
import {
  CORPORATE_MEETING_OPERATIONS,
  corporateMeetingsCreate,
  corporateMeetingsDecisionsRecord,
  corporateMeetingsGet,
  corporateMeetingsHold,
  corporateMeetingsList,
  corporateMeetingsUpdate,
} from '../corporate-meetings'
import type { OperationContext } from '../types'

const ctx = { supabase: {}, companyId: 'company-1', userId: 'user-1', log: { warn: vi.fn() } } as unknown as OperationContext
const MEETING = '66666666-6666-4666-8666-666666666666'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(bolagetGate).mockResolvedValue(null)
})

describe('corporate meeting operations', () => {
  it('are dark outside the rollout and for a form without an aktiebok', async () => {
    vi.mocked(bolagetGate).mockResolvedValueOnce('BOLAGET_DISABLED')
    expect(await corporateMeetingsList.run(ctx, {}, { dryRun: false })).toEqual({ ok: false, code: 'BOLAGET_DISABLED' })
    vi.mocked(bolagetGate).mockResolvedValueOnce('BOLAGET_NOT_FOR_LEGAL_FORM')
    expect(await corporateMeetingsCreate.run(ctx, { kind: 'styrelsemote', meeting_date: '2027-05-10' }, { dryRun: true })).toEqual({ ok: false, code: 'BOLAGET_NOT_FOR_LEGAL_FORM' })
    expect(createMeeting).not.toHaveBeenCalled()
    expect(listMeetingsView).not.toHaveBeenCalled()
  })

  it('answers a meeting that is not the company\'s as not found', async () => {
    vi.mocked(getMeetingView).mockResolvedValueOnce(null)
    expect(await corporateMeetingsGet.run(ctx, { corporate_meeting_id: MEETING }, { dryRun: false })).toEqual({ ok: false, code: 'CORPORATE_MEETING_NOT_FOUND' })
  })

  it('never takes a personnummer: every write input is strict', () => {
    expect(corporateMeetingsCreate.input.safeParse({ kind: 'arsstamma', meeting_date: '2027-05-10', personnummer: '198001011234' }).success).toBe(false)
    expect(corporateMeetingsUpdate.input.safeParse({ corporate_meeting_id: MEETING, pnr: '198001011234' }).success).toBe(false)
    expect(corporateMeetingsDecisionsRecord.input.safeParse({ corporate_meeting_id: MEETING, kind: 'ovrigt', ssn: 'x' }).success).toBe(false)
    expect(corporateMeetingsHold.input.safeParse({ corporate_meeting_id: MEETING, extra: true }).success).toBe(false)
    expect(corporateMeetingsCreate.input.safeParse({ kind: 'per_capsulam', organ: 'styrelse', meeting_date: '2027-05-10', chair_name: 'Anna Ek' }).success).toBe(true)
  })

  it('stages every write with a Swedish title and finds it again by pending type', () => {
    expect(corporateMeetingsCreate.mcp?.stage?.title({ kind: 'arsstamma', meeting_date: '2027-05-10' })).toBe('Årsstämma 2027-05-10')
    expect(corporateMeetingsDecisionsRecord.mcp?.stage?.title({ kind: 'utdelning' })).toBe('Beslut: utdelning')
    expect(corporateMeetingsHold.mcp?.stage?.title({})).toBe('Markera mötet som hållet')
    for (const op of CORPORATE_MEETING_OPERATIONS.filter((o) => o.kind === 'write')) {
      expect(operationForPendingType(op.mcp!.stage!.pendingType)).toBe(op)
    }
  })

  it('passes the update and the hold through to the services', async () => {
    vi.mocked(updateMeeting).mockResolvedValueOnce({ ok: true, data: { corporate_meeting_id: MEETING, status: 'draft' } })
    await corporateMeetingsUpdate.run(ctx, { corporate_meeting_id: MEETING, attendees: [{ name: 'Anna Ek', capacity: 'vd', present: true }] }, { dryRun: true })
    expect(vi.mocked(updateMeeting).mock.calls[0]).toEqual([ctx, MEETING, { attendees: [{ name: 'Anna Ek', capacity: 'vd', present: true, party_id: null }] }, { dryRun: true }])
    vi.mocked(holdMeeting).mockResolvedValueOnce({ ok: true, dryRun: true, preview: {} })
    await corporateMeetingsHold.run(ctx, { corporate_meeting_id: MEETING }, { dryRun: true })
    expect(vi.mocked(holdMeeting).mock.calls[0]).toEqual([ctx, MEETING, { dryRun: true }])
  })
})
