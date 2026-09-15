import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { humanAgent, recordActivity, softwareAgent } from '../provenance'

const mock = createQueuedMockSupabase()
const { enqueue, reset, findCall } = mock
const supabase = mock.supabase as unknown as SupabaseClient

beforeEach(() => {
  reset()
})

describe('agents', () => {
  it('creates a software agent once per name and version and returns its id', async () => {
    enqueue({ error: null })
    enqueue({ data: { id: 'agent-1' } })
    await expect(softwareAgent(supabase, 'arkiv.extract', '1')).resolves.toBe('agent-1')
    expect(findCall('agents', 'upsert')).toEqual([{ kind: 'software', name: 'arkiv.extract', version: '1' }, { onConflict: 'kind,name,version', ignoreDuplicates: true }])
    expect(findCall('agents', 'match')).toEqual([{ kind: 'software', name: 'arkiv.extract', version: '1' }])
  })

  it('keys a person\'s agent on the user', async () => {
    enqueue({ error: null })
    enqueue({ data: { id: 'agent-2' } })
    await expect(humanAgent(supabase, 'user-1')).resolves.toBe('agent-2')
    expect(findCall('agents', 'upsert')?.[1]).toEqual({ onConflict: 'user_id', ignoreDuplicates: true })
  })

  it('throws when the agent cannot be written', async () => {
    enqueue({ error: { message: 'denied' } })
    await expect(softwareAgent(supabase, 'arkiv.extract', '1')).rejects.toThrow('agent upsert failed: denied')
  })
})

describe('recordActivity', () => {
  it('records the run with its start and ends it now', async () => {
    enqueue({ data: { id: 'act-1' } })
    const id = await recordActivity(supabase, {
      companyId: 'co-1',
      documentId: 'doc-1',
      agentId: 'agent-1',
      kind: 'extract',
      modelIds: ['sonnet', 'haiku'],
      startedAt: '2026-09-15T08:00:00.000Z',
      outcome: 'settled',
    })
    expect(id).toBe('act-1')
    const row = findCall('activities', 'insert')?.[0] as Record<string, unknown>
    expect(row).toMatchObject({ company_id: 'co-1', kind: 'extract', model_ids: ['sonnet', 'haiku'], started_at: '2026-09-15T08:00:00.000Z', schema_type: null, detail: {} })
    expect(Date.parse(row.ended_at as string)).toBeGreaterThanOrEqual(Date.parse(row.started_at as string))
  })

  it('throws when the insert fails', async () => {
    enqueue({ error: { message: 'check violation' } })
    await expect(recordActivity(supabase, { companyId: 'co-1', documentId: null, agentId: 'a', kind: 'review', outcome: 'settled' })).rejects.toThrow('activity insert failed')
  })
})
