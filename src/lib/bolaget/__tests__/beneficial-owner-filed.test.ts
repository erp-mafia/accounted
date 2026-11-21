import { describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { beneficialOwnerReminderKey, withFiled, type BoAssessment } from '../beneficial-owners'

function assessment(id: string, changed: boolean): BoAssessment {
  return {
    beneficial_owner_assessment_id: id,
    assessed_on: '2026-11-20',
    basis: 'Aktieboken',
    conclusion: 'owners_identified',
    owners: [],
    family_aggregation_checked: true,
    family_note: null,
    control_agreements: false,
    control_note: null,
    changed,
    created_at: '2026-11-20T10:00:00Z',
  }
}

describe('withFiled', () => {
  it('marks a changed assessment filed when its reminder is done', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: [{ source_key: beneficialOwnerReminderKey('a-1') }] })
    const out = await withFiled({ supabase: supabase as never, companyId: 'c-1', userId: 'u-1', log: console as never }, [assessment('a-1', true), assessment('a-2', false)])
    expect(out[0].filed).toBe(true)
    expect(out[1].filed).toBeUndefined()
    expect(findCall('deadlines', 'in')?.[1]).toEqual([beneficialOwnerReminderKey('a-1')])
  })

  it('leaves a changed assessment unfiled while its reminder is open, and reads nothing without changes', async () => {
    const { supabase, enqueue, findCall, reset } = createQueuedMockSupabase()
    enqueue({ data: [] })
    const out = await withFiled({ supabase: supabase as never, companyId: 'c-1', userId: 'u-1', log: console as never }, [assessment('a-1', true)])
    expect(out[0].filed).toBe(false)
    reset()
    await withFiled({ supabase: supabase as never, companyId: 'c-1', userId: 'u-1', log: console as never }, [assessment('a-2', false)])
    expect(findCall('deadlines', 'select')).toBeUndefined()
  })
})
