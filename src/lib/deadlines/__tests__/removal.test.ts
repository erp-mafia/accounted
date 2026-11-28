/**
 * lib/deadlines/removal.ts: the one rule for taking a deadline off the
 * company's list. The dashboard route (DELETE /api/deadlines/:id) and the
 * operation deadlines.delete (gnubok_delete_deadline) both run it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { removeDeadline } from '../removal'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DEADLINE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const HAND_ADDED = {
  id: DEADLINE_ID,
  title: 'Skicka underlag till revisorn',
  due_date: '2026-11-20',
  source: 'user',
  is_completed: false,
  tax_deadline_type: null,
  tax_period: null,
}

const GENERATED = {
  id: DEADLINE_ID,
  title: 'Betala preliminärskatt december 2026',
  due_date: '2026-12-14',
  source: 'system',
  is_completed: false,
  tax_deadline_type: 'f_skatt',
  tax_period: '2026-12',
}

function setup() {
  const mock = createQueuedMockSupabase()
  return { ...mock, ctx: { supabase: mock.supabase as never, companyId: COMPANY_ID } }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-27T10:00:00Z'))
})

describe('removeDeadline', () => {
  it('deletes a deadline added by hand, scoped to the company and never a generated row', async () => {
    const { ctx, enqueueMany, findCall, findCalls } = setup()
    enqueueMany([{ data: HAND_ADDED }, { count: 1 }])

    const outcome = await removeDeadline(ctx, DEADLINE_ID, { dryRun: false })

    expect(outcome).toEqual({
      ok: true,
      data: { deadline_id: DEADLINE_ID, title: HAND_ADDED.title, source: 'user', effect: 'deleted' },
    })
    expect(findCall('deadlines', 'delete')).toEqual([{ count: 'exact' }])
    expect(findCall('deadlines', 'update')).toBeUndefined()
    expect(findCall('deadlines', 'neq')).toEqual(['source', 'system'])
    expect(findCalls('deadlines', 'eq').filter((args) => args[0] === 'company_id')).toEqual([
      ['company_id', COMPANY_ID],
      ['company_id', COMPANY_ID],
    ])
  })

  it('dismisses a generated deadline instead of deleting it, so the nightly repair does not bring it back', async () => {
    const { ctx, enqueueMany, findCall, findCalls } = setup()
    enqueueMany([{ data: GENERATED }, { data: [{ id: DEADLINE_ID }] }])

    const outcome = await removeDeadline(ctx, DEADLINE_ID, { dryRun: false })

    expect(outcome).toEqual({
      ok: true,
      data: { deadline_id: DEADLINE_ID, title: GENERATED.title, source: 'system', effect: 'dismissed' },
    })
    expect(findCall('deadlines', 'update')).toEqual([{ dismissed_at: '2026-11-27T10:00:00.000Z' }])
    expect(findCall('deadlines', 'delete')).toBeUndefined()
    expect(findCalls('deadlines', 'eq')).toContainEqual(['source', 'system'])
  })

  it('removes a ticked-off deadline too, as the app does', async () => {
    const { ctx, enqueueMany } = setup()
    enqueueMany([{ data: { ...GENERATED, is_completed: true } }, { data: [{ id: DEADLINE_ID }] }])

    const outcome = await removeDeadline(ctx, DEADLINE_ID, { dryRun: false })

    expect(outcome).toMatchObject({ ok: true, data: { effect: 'dismissed' } })
  })

  it('a dry run says what would happen and writes nothing', async () => {
    const { ctx, enqueueMany, findCall } = setup()
    enqueueMany([{ data: GENERATED }])

    const outcome = await removeDeadline(ctx, DEADLINE_ID, { dryRun: true })

    expect(outcome).toEqual({
      ok: true,
      dryRun: true,
      preview: {
        deadline_id: DEADLINE_ID,
        title: GENERATED.title,
        due_date: '2026-12-14',
        tax_deadline_type: 'f_skatt',
        tax_period: '2026-12',
        source: 'system',
        is_completed: false,
        effect: 'dismissed',
      },
    })
    expect(findCall('deadlines', 'update')).toBeUndefined()
    expect(findCall('deadlines', 'delete')).toBeUndefined()
  })

  it("is not found for another company's deadline, one already removed, or a malformed id", async () => {
    const { ctx, enqueueMany, findCall, findCalls } = setup()
    enqueueMany([{ data: null }])

    expect(await removeDeadline(ctx, DEADLINE_ID, { dryRun: false })).toEqual({
      ok: false,
      code: 'DEADLINE_NOT_FOUND',
      details: { deadline_id: DEADLINE_ID },
    })
    // The read leaves a dismissed row out, as every list does.
    expect(findCall('deadlines', 'is')).toEqual(['dismissed_at', null])
    expect(findCalls('deadlines', 'eq')).toContainEqual(['company_id', COMPANY_ID])

    const malformed = setup()
    expect(await removeDeadline(malformed.ctx, 'not-a-uuid', { dryRun: false })).toMatchObject({
      ok: false,
      code: 'DEADLINE_NOT_FOUND',
    })
    expect(malformed.findCall('deadlines', 'select')).toBeUndefined()
  })

  it('a row that vanished between the read and the write is not found, never a success', async () => {
    const generated = setup()
    generated.enqueueMany([{ data: GENERATED }, { data: [] }])
    expect(await removeDeadline(generated.ctx, DEADLINE_ID, { dryRun: false })).toMatchObject({
      ok: false,
      code: 'DEADLINE_NOT_FOUND',
    })

    const handAdded = setup()
    handAdded.enqueueMany([{ data: HAND_ADDED }, { count: 0 }])
    expect(await removeDeadline(handAdded.ctx, DEADLINE_ID, { dryRun: false })).toMatchObject({
      ok: false,
      code: 'DEADLINE_NOT_FOUND',
    })
  })

  it('a failed read or write is a failure', async () => {
    const read = setup()
    read.enqueueMany([{ error: { code: '57014', message: 'timeout' } }])
    expect(await removeDeadline(read.ctx, DEADLINE_ID, { dryRun: false })).toMatchObject({
      ok: false,
      code: 'UNKNOWN_ERROR',
    })

    const write = setup()
    write.enqueueMany([{ data: HAND_ADDED }, { error: { code: '57014', message: 'timeout' } }])
    expect(await removeDeadline(write.ctx, DEADLINE_ID, { dryRun: false })).toMatchObject({
      ok: false,
      code: 'UNKNOWN_ERROR',
    })
  })
})
