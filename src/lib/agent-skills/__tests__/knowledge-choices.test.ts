import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { agentDefaults } from '../knowledge-choices'
import { AGENTS, OWN_AGENT_KNOWLEDGE } from '../agents'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
const row = { id: 'own-id', company_id: 'company-a', team_id: null, atom_id: null, name: 'Own', description: 'D', body: 'B', share_status: 'private', draft: false }
beforeEach(() => { vi.clearAllMocks(); reset() })

describe('agentDefaults', () => {
  it('gives a curated agent its declared knowledge', async () => {
    expect(await agentDefaults(supabase as never, 'company-a', 'bookkeep')).toEqual(AGENTS.bookkeep.knowledge)
  })
  it('gives an own agent the accounting law by default', async () => {
    enqueue({ data: { team_id: null } }); enqueue({ data: [row] })
    expect(await agentDefaults(supabase as never, 'company-a', 'own/own-id')).toEqual(OWN_AGENT_KNOWLEDGE)
    expect(OWN_AGENT_KNOWLEDGE).toEqual(['horizontal/swedish-accounting-compliance'])
  })
  it('knows no draft or unknown agent', async () => {
    enqueue({ data: { team_id: null } }); enqueue({ data: [{ ...row, draft: true }] })
    expect(await agentDefaults(supabase as never, 'company-a', 'own/own-id')).toBeNull()
    expect(await agentDefaults(supabase as never, 'company-a', 'nope')).toBeNull()
  })
})
