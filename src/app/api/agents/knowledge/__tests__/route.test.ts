import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-a') }))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: vi.fn() }))

import { requireAuth } from '@/lib/auth/require-auth'
import { requireWritePermission } from '@/lib/auth/require-write'
import { GET, PATCH } from '../route'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const ctx = { params: Promise.resolve({}) }
const patch = (body: unknown) => PATCH(new Request('http://localhost/api/agents/knowledge', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), ctx)
const OPTIONS = [
  { id: 'horizontal/swedish-vat', tier: 'horizontal', title: 'Swedish VAT', description: 'Moms.', version: 4, reviewed_at: null },
  { id: 'vertical/bygg-hantverk', tier: 'vertical', title: 'Bygg', description: 'Bygg.', version: 3, reviewed_at: null },
]

beforeEach(() => {
  vi.clearAllMocks(); reset()
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user' }, supabase, error: null } as never)
  vi.mocked(requireWritePermission).mockResolvedValue({ ok: true } as never)
})

describe('/api/agents/knowledge', () => {
  it('requires authentication', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ error: NextResponse.json({}, { status: 401 }) } as never)
    expect((await GET(new Request('http://localhost/api/agents/knowledge'), ctx)).status).toBe(401)
    expect((await patch({ action: 'reset', agent_id: 'bookkeep' })).status).toBe(401)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('keeps viewers from changing what an agent knows', async () => {
    vi.mocked(requireWritePermission).mockResolvedValue({ ok: false, response: NextResponse.json({}, { status: 403 }) } as never)
    expect((await patch({ action: 'reset', agent_id: 'bookkeep' })).status).toBe(403)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('lists the packs a company can give its agents', async () => {
    enqueue({ data: OPTIONS })
    const response = await GET(new Request('http://localhost/api/agents/knowledge'), ctx)
    expect(response.status).toBe(200)
    expect((await response.json()).data.map((o: { id: string }) => o.id)).toEqual(['horizontal/swedish-vat', 'vertical/bygg-hantverk'])
    expect(findCalls('agent_atom_registry', 'is')).toEqual([['parent_atom_id', null]])
  })

  it.each([
    [{ action: 'add', agent_id: 'bookkeep' }],
    [{ action: 'add', agent_id: 'Bad Agent', atom_id: 'vertical/bygg-hantverk' }],
    [{ action: 'wipe', agent_id: 'bookkeep' }],
  ])('rejects invalid input %j', async (body) => {
    expect((await patch(body)).status).toBe(400)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('answers 404 for an unknown agent or an unavailable pack', async () => {
    expect((await patch({ action: 'reset', agent_id: 'nope' })).status).toBe(404)
    enqueue({ data: OPTIONS })
    expect((await patch({ action: 'add', agent_id: 'bookkeep', atom_id: 'vertical/withdrawn' })).status).toBe(404)
  })

  it('adds a pack as a row and takes a default away as a row', async () => {
    enqueue({ data: OPTIONS }); enqueue({ data: null })
    expect((await patch({ action: 'add', agent_id: 'quarterly-vat-review', atom_id: 'vertical/bygg-hantverk' })).status).toBe(200)
    enqueue({ data: null })
    expect((await patch({ action: 'remove', agent_id: 'quarterly-vat-review', atom_id: 'horizontal/swedish-vat' })).status).toBe(200)
    expect(findCalls('company_agent_knowledge', 'upsert').map((c) => c[0])).toEqual([
      { company_id: 'company-a', agent_id: 'quarterly-vat-review', atom_id: 'vertical/bygg-hantverk', included: true },
      { company_id: 'company-a', agent_id: 'quarterly-vat-review', atom_id: 'horizontal/swedish-vat', included: false },
    ])
  })

  it('adding a default back deletes the row instead of storing it', async () => {
    enqueue({ data: OPTIONS }); enqueue({ data: null })
    expect((await patch({ action: 'add', agent_id: 'quarterly-vat-review', atom_id: 'horizontal/swedish-vat' })).status).toBe(200)
    expect(findCalls('company_agent_knowledge', 'upsert')).toEqual([])
    expect(findCalls('company_agent_knowledge', 'eq')).toEqual(expect.arrayContaining([['company_id', 'company-a'], ['agent_id', 'quarterly-vat-review'], ['atom_id', 'horizontal/swedish-vat']]))
  })

  it('lists the company\'s own knowledge and gives it to a flow as its own row', async () => {
    const rules = { id: '00000000-0000-4000-8000-0000000000aa', company_id: 'company-a', team_id: null, atom_id: null, name: 'Våra regler', description: 'Hur vi gör.', body: '# Regler', share_status: 'private', draft: false, kind: 'rules' }
    enqueue({ data: OPTIONS }); enqueue({ data: { team_id: null } }); enqueue({ data: [rules] })
    const listed = await (await GET(new Request('http://localhost/api/agents/knowledge'), ctx)).json()
    expect(listed.data.at(-1)).toMatchObject({ id: `own/${rules.id}`, tier: 'own', title: 'Våra regler' })

    enqueue({ data: OPTIONS }); enqueue({ data: { team_id: null } }); enqueue({ data: [rules] }); enqueue({ data: null })
    expect((await patch({ action: 'add', agent_id: 'bookkeep', atom_id: `own/${rules.id}` })).status).toBe(200)
    expect(findCalls('company_agent_knowledge', 'upsert').map((c) => c[0])).toEqual([
      { company_id: 'company-a', agent_id: 'bookkeep', own_skill_id: rules.id, included: true },
    ])
    enqueue({ data: OPTIONS }); enqueue({ data: { team_id: null } }); enqueue({ data: [] })
    expect((await patch({ action: 'add', agent_id: 'bookkeep', atom_id: 'own/00000000-0000-4000-8000-0000000000bb' })).status).toBe(404)
  })
})
