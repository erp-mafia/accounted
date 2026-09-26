import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-a') }))
vi.mock('@/lib/agent-skills/catalog', () => ({ loadSkillCatalog: vi.fn(), loadCatalogSkill: vi.fn() }))
vi.mock('@/lib/agent-skills/company-skills', () => ({ loadCompanySkillRows: vi.fn() }))
// Sharing is held back from release by COMMUNITY_OPEN; the submit tests below run with it open.
const community = vi.hoisted(() => ({ open: true }))
vi.mock('@/lib/agent-skills/agents', async (original) => ({ ...(await original<object>()), get COMMUNITY_OPEN() { return community.open } }))
import { requireAuth } from '@/lib/auth/require-auth'
import { requireWritePermission } from '@/lib/auth/require-write'
import { loadSkillCatalog, loadCatalogSkill } from '@/lib/agent-skills/catalog'
import { loadCompanySkillRows } from '@/lib/agent-skills/company-skills'
import { GET, POST } from '../route'
import { PATCH, DELETE } from '../[id]/route'

const { supabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()
const id = '00000000-0000-4000-8000-000000000001'
const params = { params: Promise.resolve({ id }) }
const staticParams = { params: Promise.resolve({}) }
const request = (method: string, body?: unknown, query = '') => new Request(`http://localhost/api/skills${query}`, { method, ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) })
const privateSkill = { id, company_id: 'company-a', team_id: null, atom_id: null, name: 'Own', description: 'D', body: 'Review first.', share_status: 'private', created_by: 'user', updated_at: '', reviewed_at: null, published_atom_id: null } as const

beforeEach(() => {
  vi.clearAllMocks(); reset(); eventBus.clear()
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user' }, supabase, error: null } as never)
  vi.mocked(requireWritePermission).mockResolvedValue({ ok: true } as never)
  vi.mocked(loadSkillCatalog).mockResolvedValue([])
  vi.mocked(loadCatalogSkill).mockResolvedValue(null)
  vi.mocked(loadCompanySkillRows).mockResolvedValue([privateSkill])
  community.open = true
})

describe('skills HTTP routes', () => {
  it.each([
    () => GET(request('GET'), staticParams),
    () => POST(request('POST'), staticParams),
    () => PATCH(request('PATCH'), params),
    () => DELETE(request('DELETE'), params),
  ])('requires authentication', async (call) => {
    vi.mocked(requireAuth).mockResolvedValue({ error: NextResponse.json({}, { status: 401 }) } as never)
    expect((await call()).status).toBe(401)
    expect(supabase.from).not.toHaveBeenCalled()
  })
  it('lists metadata, not private bodies, with no-store caching', async () => {
    vi.mocked(loadSkillCatalog).mockResolvedValue([{ slug: `own/${id}`, body: 'Private secret', name: 'Own' }] as never)
    const result = await GET(request('GET'), staticParams)
    expect(result.status).toBe(200)
    expect(result.headers.get('Cache-Control')).toContain('no-store')
    expect(JSON.stringify(await result.json())).not.toContain('Private secret')
    expect(loadSkillCatalog).toHaveBeenCalledWith(supabase, 'company-a')
  })
  it('returns 404 for a private slug outside the active catalog', async () => {
    expect((await GET(request('GET', undefined, '?slug=own/other'), staticParams)).status).toBe(404)
    expect(loadCatalogSkill).toHaveBeenCalledWith(supabase, 'company-a', 'own/other', true)
  })
  it('rejects unknown query parameters', async () => {
    expect((await GET(request('GET', undefined, '?company_id=other'), staticParams)).status).toBe(400)
  })
  it('rejects executable Markdown before writing', async () => {
    expect((await POST(request('POST', { kind: 'own', name: 'Name', description: 'Desc', body: '<script />' }), staticParams)).status).toBe(400)
    expect(supabase.from).not.toHaveBeenCalled()
  })
  it('creates private instructions under the resolved company and user', async () => {
    enqueue({ data: { id } })
    expect((await POST(request('POST', { kind: 'own', name: 'Name', description: 'Desc', body: 'Use mappings.' }), staticParams)).status).toBe(201)
    expect(findCall('company_skills', 'insert')?.[0]).toMatchObject({ company_id: 'company-a', team_id: null, created_by: 'user', kind: 'workflow' })
  })
  it('stores what an own item is when it is written by hand', async () => {
    enqueue({ data: { id } })
    expect((await POST(request('POST', { kind: 'own', item_kind: 'rules', name: 'Name', description: 'Desc', body: 'Vidarefakturering: med moms.' }), staticParams)).status).toBe(201)
    expect(findCall('company_skills', 'insert')?.[0]).toMatchObject({ kind: 'rules' })
  })
  it('rejects an unknown kind of item', async () => {
    expect((await POST(request('POST', { kind: 'own', item_kind: 'connection', name: 'Name', description: 'Desc', body: 'B' }), staticParams)).status).toBe(400)
    expect(supabase.from).not.toHaveBeenCalled()
  })
  it('does not add a withdrawn catalog skill', async () => {
    enqueue({ data: null })
    expect((await POST(request('POST', { kind: 'catalog', atom_id: 'community/withdrawn' }), staticParams)).status).toBe(404)
    expect(findCalls('agent_atom_registry', 'eq')).toContainEqual(['is_active', true])
  })
  it('requires firm administration for firm-wide instructions', async () => {
    enqueue({ data: { team_id: 'firm' } }); enqueue({ data: { role: 'member' } })
    expect((await POST(request('POST', { kind: 'own', scope: 'team', name: 'N', description: 'D', body: 'B' }), staticParams)).status).toBe(403)
    expect(findCall('company_skills', 'insert')).toBeUndefined()
  })
  it('refuses to share while community is not open', async () => {
    community.open = false
    expect((await PATCH(request('PATCH', { action: 'submit', author_handle: 'author', confirmed_no_customer_data: true }), params)).status).toBe(403)
    expect(findCall('company_skills', 'update')).toBeUndefined()
  })
  it('rejects missing sharing consent', async () => {
    expect((await PATCH(request('PATCH', { action: 'submit', author_handle: 'author' }), params)).status).toBe(400)
  })
  it('submits only the scoped private row with consent evidence', async () => {
    enqueue({ data: { id } })
    expect((await PATCH(request('PATCH', { action: 'submit', author_handle: 'author', confirmed_no_customer_data: true }), params)).status).toBe(200)
    expect(findCall('company_skills', 'update')?.[0]).toMatchObject({ share_status: 'submitted', author_handle: 'author', share_confirmed_at: expect.any(String) })
    expect(findCalls('company_skills', 'eq')).toContainEqual(['company_id', 'company-a'])
    expect(findCalls('company_skills', 'eq')).toContainEqual(['share_status', 'private'])
  })
  it('stores the kind the author gives a shared item, and keeps the saved kind when none is given', async () => {
    enqueue({ data: { id } })
    expect((await PATCH(request('PATCH', { action: 'submit', author_handle: 'author', confirmed_no_customer_data: true, kind: 'analysis' }), params)).status).toBe(200)
    expect(findCall('company_skills', 'update')?.[0]).toMatchObject({ kind: 'analysis' })
    reset(); enqueue({ data: { id } })
    expect((await PATCH(request('PATCH', { action: 'submit', author_handle: 'author', confirmed_no_customer_data: true }), params)).status).toBe(200)
    expect(findCall('company_skills', 'update')?.[0]).not.toHaveProperty('kind')
  })
  it.each([{ kind: 'connection' }, { area: 'moms' }, { industries: ['vertical/restaurang-cafe'] }])('rejects an unknown kind or field %j', async (extra) => {
    expect((await PATCH(request('PATCH', { action: 'submit', author_handle: 'author', confirmed_no_customer_data: true, ...extra }), params)).status).toBe(400)
    expect(findCall('company_skills', 'update')).toBeUndefined()
  })
  it('sends community counts and the caller\'s own vote on community items only', async () => {
    vi.mocked(loadSkillCatalog).mockResolvedValue([
      { slug: 'community/stang-dagskassan', tier: 'community', name: 'Stäng dagskassan', body: 'B', reviewedAt: '2026-09-18' },
      { slug: 'bookkeep', tier: 'workflow', name: 'Bokför', body: 'B' },
    ] as never)
    enqueue({ data: [{ atom_id: 'community/stang-dagskassan', kind: 'workflow', author: 'kafe-norr', author_shared: 4, author_verified: false, votes: 48, used_by: 12, industries: ['restaurang-cafe'] }] })
    enqueue({ data: [{ id: 'f1', atom_id: 'community/stang-dagskassan', vote: true }] })
    const data = (await (await GET(request('GET'), staticParams)).json()).data
    expect(data[0].community).toEqual({
      kind: 'workflow', author: 'kafe-norr', author_shared: 4, author_verified: false, votes: 48, voted: true,
      reviewed_at: '2026-09-18', used_by: 12, industries: ['restaurang-cafe'],
    })
    expect(data[1].community).toBeUndefined()
    expect(supabase.rpc).toHaveBeenCalledWith('community_item_stats')
    expect(findCalls('community_feedback', 'eq')).toEqual([['user_id', 'user']])
  })
  it('freezes submitted text', async () => {
    vi.mocked(loadCompanySkillRows).mockResolvedValue([{ ...privateSkill, share_status: 'submitted' }])
    expect((await PATCH(request('PATCH', { action: 'edit', name: 'N', description: 'D', body: 'Changed' }), params)).status).toBe(409)
  })
  it.each(['published', 'withdrawn'] as const)('freezes %s text too', async (share_status) => {
    vi.mocked(loadCompanySkillRows).mockResolvedValue([{ ...privateSkill, share_status }])
    expect((await PATCH(request('PATCH', { action: 'edit', name: 'N', description: 'D', body: 'Changed' }), params)).status).toBe(409)
    expect(findCall('company_skills', 'update')).toBeUndefined()
  })
  it('edits a private item in place, so its id (and every routine using it) stays', async () => {
    enqueue({ data: { id } })
    const response = await PATCH(request('PATCH', { action: 'edit', name: ' Påminn ', description: 'Efter 14 dagar', body: '# Påminn\n\n1. Hämta fakturorna\n' }), params)
    expect(response.status).toBe(200)
    expect((await response.json()).data).toEqual({ id })
    expect(findCall('company_skills', 'update')?.[0]).toEqual({ name: 'Påminn', description: 'Efter 14 dagar', body: '# Påminn\n\n1. Hämta fakturorna' })
    expect(findCalls('company_skills', 'eq')).toEqual(expect.arrayContaining([['id', id], ['company_id', 'company-a'], ['share_status', 'private']]))
  })
  it('edits a firm-wide item under its team', async () => {
    vi.mocked(loadCompanySkillRows).mockResolvedValue([{ ...privateSkill, company_id: null, team_id: 'team-1' } as never])
    enqueue({ data: { id } })
    expect((await PATCH(request('PATCH', { action: 'edit', name: 'N', description: 'D', body: 'Changed' }), params)).status).toBe(200)
    expect(findCalls('company_skills', 'eq')).toContainEqual(['team_id', 'team-1'])
    expect(findCalls('company_skills', 'eq')).not.toContainEqual(['company_id', 'company-a'])
  })
  it('lets a person edit an AI-saved draft before adding it', async () => {
    vi.mocked(loadCompanySkillRows).mockResolvedValue([{ ...privateSkill, draft: true }])
    enqueue({ data: { id } })
    expect((await PATCH(request('PATCH', { action: 'edit', name: 'N', description: 'D', body: 'Changed' }), params)).status).toBe(200)
    expect(findCall('company_skills', 'update')?.[0]).not.toHaveProperty('draft')
  })
  it.each([
    { name: 'N', description: 'D', body: '<script />' },
    { name: '', description: 'D', body: 'Changed' },
    { name: 'N', description: '', body: 'Changed' },
    { name: 'N', description: 'D', body: 'Changed', kind: 'rules' },
  ])('rejects an edit that would not be saved: %j', async (edit) => {
    expect((await PATCH(request('PATCH', { action: 'edit', ...edit }), params)).status).toBe(400)
    expect(findCall('company_skills', 'update')).toBeUndefined()
  })
  it('answers 409 when the row changed under the edit', async () => {
    enqueue({ data: null })
    expect((await PATCH(request('PATCH', { action: 'edit', name: 'N', description: 'D', body: 'Changed' }), params)).status).toBe(409)
  })
  it('blocks viewer edits', async () => {
    vi.mocked(requireWritePermission).mockResolvedValue({ ok: false, response: NextResponse.json({}, { status: 403 }) })
    expect((await PATCH(request('PATCH', { action: 'edit', name: 'N', description: 'D', body: 'Changed' }), params)).status).toBe(403)
    expect(findCall('company_skills', 'update')).toBeUndefined()
  })
  it('adds an AI-saved draft so agents can load it', async () => {
    vi.mocked(loadCompanySkillRows).mockResolvedValue([{ ...privateSkill, draft: true }])
    enqueue({ data: { id } })
    expect((await PATCH(request('PATCH', { action: 'add' }), params)).status).toBe(200)
    expect(findCall('company_skills', 'update')?.[0]).toEqual({ draft: false })
    expect(findCalls('company_skills', 'eq')).toContainEqual(['company_id', 'company-a'])
  })
  it('refuses to add a skill that is not a draft', async () => {
    expect((await PATCH(request('PATCH', { action: 'add' }), params)).status).toBe(409)
    expect(findCall('company_skills', 'update')).toBeUndefined()
  })
  it('withdraws without deleting submission evidence', async () => {
    vi.mocked(loadCompanySkillRows).mockResolvedValue([{ ...privateSkill, share_status: 'submitted' }])
    enqueue({ data: { id } })
    expect((await PATCH(request('PATCH', { action: 'withdraw' }), params)).status).toBe(200)
    expect(findCall('company_skills', 'update')?.[0]).toEqual({ share_status: 'withdrawn' })
  })
  it.each([PATCH, DELETE])('returns 404 for an out-of-tenant record', async (handler) => {
    vi.mocked(loadCompanySkillRows).mockResolvedValue([])
    expect((await handler(request('PATCH', { action: 'withdraw' }), params)).status).toBe(404)
  })
  it('removes a private installation with both scope and status filters', async () => {
    enqueue({ data: { id } })
    expect((await DELETE(request('DELETE'), params)).status).toBe(200)
    expect(findCalls('company_skills', 'eq')).toEqual(expect.arrayContaining([['id', id], ['company_id', 'company-a'], ['share_status', 'private']]))
  })
  it('takes the knowledge chosen for the deleted flow with it', async () => {
    enqueue({ data: { id } })
    enqueue({ data: null })
    expect((await DELETE(request('DELETE'), params)).status).toBe(200)
    expect(findCall('company_agent_knowledge', 'delete')).toBeDefined()
    expect(findCalls('company_agent_knowledge', 'eq')).toEqual(expect.arrayContaining([['agent_id', `own/${id}`], ['company_id', 'company-a']]))
  })
  it('still answers 200 when the knowledge clean-up fails, since the flow is gone', async () => {
    enqueue({ data: { id } })
    enqueue({ data: null, error: { message: 'boom' } })
    expect((await DELETE(request('DELETE'), params)).status).toBe(200)
  })
  it('blocks viewer writes', async () => {
    vi.mocked(requireWritePermission).mockResolvedValue({ ok: false, response: NextResponse.json({}, { status: 403 }) })
    expect((await POST(request('POST', {}), staticParams)).status).toBe(403)
  })
})
