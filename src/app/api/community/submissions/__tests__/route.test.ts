import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-a') }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn(() => ({})) }))
vi.mock('@/lib/agent-skills/community-review', () => ({ loadSubmissionsForReview: vi.fn(), sendBackSubmission: vi.fn(), loadPendingItems: vi.fn(), approveSubmission: vi.fn(), approvePendingItem: vi.fn() }))
import { requireAuth } from '@/lib/auth/require-auth'
import { approvePendingItem, approveSubmission, loadPendingItems, loadSubmissionsForReview, sendBackSubmission } from '@/lib/agent-skills/community-review'
import { GET } from '../route'
import { POST } from '../[id]/send-back/route'
import { POST as APPROVE } from '../[id]/approve/route'
import { POST as APPROVE_ITEM } from '../../items/[slug]/approve/route'

const { supabase } = createQueuedMockSupabase()
const id = '00000000-0000-4000-8000-000000000001'
const params = { params: Promise.resolve({ id }) }
const staticParams = { params: Promise.resolve({}) }
const slugParams = { params: Promise.resolve({ slug: 'fran-github' }) }
const itemPost = (body: unknown) => new Request('http://localhost/api/community/items/fran-github/approve', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
const post = (body: unknown) => new Request('http://localhost/api/community/submissions/x/send-back', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  vi.clearAllMocks()
  process.env.COMMUNITY_REVIEWER_USER_IDS = 'reviewer'
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'reviewer' }, supabase, error: null } as never)
  vi.mocked(loadSubmissionsForReview).mockResolvedValue([])
  vi.mocked(sendBackSubmission).mockResolvedValue(true)
  vi.mocked(loadPendingItems).mockResolvedValue([])
  vi.mocked(approveSubmission).mockResolvedValue(true)
  vi.mocked(approvePendingItem).mockResolvedValue(true)
})

describe('community review routes', () => {
  it('require authentication', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ error: NextResponse.json({}, { status: 401 }) } as never)
    expect((await GET(new Request('http://localhost/api/community/submissions'), staticParams)).status).toBe(401)
    expect((await POST(post({ reason: 'Ändra' }), params)).status).toBe(401)
  })

  it('are invisible to everyone but reviewers', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'someone' }, supabase, error: null } as never)
    expect((await GET(new Request('http://localhost/api/community/submissions'), staticParams)).status).toBe(404)
    expect((await POST(post({ reason: 'Ändra' }), params)).status).toBe(404)
    expect((await APPROVE(new Request('http://localhost/x', { method: 'POST' }), params)).status).toBe(404)
    expect((await APPROVE_ITEM(itemPost({ sha: 'a'.repeat(64) }), slugParams)).status).toBe(404)
    expect(loadSubmissionsForReview).not.toHaveBeenCalled()
    expect(approveSubmission).not.toHaveBeenCalled()
    expect(approvePendingItem).not.toHaveBeenCalled()
    expect(sendBackSubmission).not.toHaveBeenCalled()
  })

  it('list the submissions for a reviewer', async () => {
    const response = await GET(new Request('http://localhost/api/community/submissions'), staticParams)
    expect(response.status).toBe(200)
    expect((await response.json()).data).toEqual({ submissions: [], pending: [] })
  })

  it('send back with a reason, and validate it', async () => {
    expect((await POST(post({ reason: 'x' }), params)).status).toBe(400)
    expect((await POST(post({ reason: 'Ta bort telefonnumret' }), params)).status).toBe(200)
    expect(sendBackSubmission).toHaveBeenCalledWith({}, id, 'Ta bort telefonnumret')
    vi.mocked(sendBackSubmission).mockResolvedValue(false)
    expect((await POST(post({ reason: 'Ta bort telefonnumret' }), params)).status).toBe(404)
  })

  it('approve a submission when it is opened as a pull request', async () => {
    expect((await APPROVE(new Request('http://localhost/x', { method: 'POST' }), params)).status).toBe(200)
    expect(approveSubmission).toHaveBeenCalledWith({}, id)
    vi.mocked(approveSubmission).mockResolvedValue(false)
    expect((await APPROVE(new Request('http://localhost/x', { method: 'POST' }), params)).status).toBe(404)
  })

  it('approve a pending item only as the text the reviewer read', async () => {
    expect((await APPROVE_ITEM(itemPost({ sha: 'nope' }), slugParams)).status).toBe(400)
    expect((await APPROVE_ITEM(itemPost({ sha: 'a'.repeat(64) }), slugParams)).status).toBe(200)
    expect(approvePendingItem).toHaveBeenCalledWith({}, 'fran-github', 'a'.repeat(64))
    vi.mocked(approvePendingItem).mockResolvedValue(false)
    expect((await APPROVE_ITEM(itemPost({ sha: 'a'.repeat(64) }), slugParams)).status).toBe(409)
  })
})
