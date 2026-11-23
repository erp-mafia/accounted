/**
 * resolveUserLabelsFromProfiles: the names the processing history, the
 * bokslutsbilagor, the systemdokumentation and the rättelse log give a user
 * id. A live profile names the person; a deleted account is named from the
 * names kept for the company whose entries the person corrected
 * (rattelse_actor_names, BFL 5 kap. 5 §).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { resolveUserLabelsFromProfiles } from '../behandlingshistorik'

const service = createQueuedMockSupabase()

beforeEach(() => {
  service.reset()
})

describe('resolveUserLabelsFromProfiles', () => {
  it('labels live profiles by e-mail, else full name, and reads nothing more when all are named', async () => {
    service.enqueue({
      data: [
        { id: 'u1', email: 'anna@example.se', full_name: 'Anna Andersson' },
        { id: 'u2', email: null, full_name: 'Bo Berg' },
      ],
      error: null,
    })

    const labels = await resolveUserLabelsFromProfiles(service.supabase, ['u1', 'u2'], 'company-1')

    expect(labels).toEqual(new Map([['u1', 'anna@example.se'], ['u2', 'Bo Berg']]))
    expect(service.findCalls('rattelse_actor_names', 'in')).toEqual([])
  })

  it('names a deleted account from the names kept for this company only', async () => {
    service.enqueue({
      data: [
        { id: 'u1', email: 'anna@example.se', full_name: null },
        { id: 'u3', email: null, full_name: null },
      ],
      error: null,
    })
    service.enqueue({ data: [{ user_id: 'u3', email: null, full_name: 'Cecilia Carlsson' }], error: null })

    const labels = await resolveUserLabelsFromProfiles(service.supabase, ['u1', 'u3', 'u4'], 'company-1')

    expect(labels).toEqual(new Map([['u1', 'anna@example.se'], ['u3', 'Cecilia Carlsson']]))
    expect(service.findCalls('rattelse_actor_names', 'eq')).toEqual([['company_id', 'company-1']])
    expect(service.findCalls('rattelse_actor_names', 'in')).toEqual([['user_id', ['u3', 'u4']]])
  })

  it('leaves an id unlabelled when neither lookup names it', async () => {
    service.enqueue({ data: [{ id: 'u5', email: null, full_name: null }], error: null })
    service.enqueue({ data: [], error: null })

    const labels = await resolveUserLabelsFromProfiles(service.supabase, ['u5'], 'company-1')

    expect(labels.size).toBe(0)
  })
})
