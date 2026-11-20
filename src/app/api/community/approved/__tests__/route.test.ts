import { beforeEach, describe, expect, it, vi } from 'vitest'

const flags = vi.hoisted(() => ({ open: true }))
vi.mock('@/lib/agent-skills/agents', () => ({ get COMMUNITY_OPEN() { return flags.open } }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn(() => ({})) }))
vi.mock('@/lib/agent-skills/community-approved', () => ({ loadApprovedCommunityItems: vi.fn() }))
import { createClient } from '@/lib/supabase/server'
import { loadApprovedCommunityItems } from '@/lib/agent-skills/community-approved'
import { GET } from '../route'

const SHA = 'a'.repeat(64)

beforeEach(() => {
  vi.clearAllMocks()
  flags.open = true
  vi.mocked(loadApprovedCommunityItems).mockResolvedValue([{ slug: 'manadsavstamning', sha: SHA }])
})

describe('GET /api/community/approved', () => {
  it('answers without a login and never reads a session', async () => {
    const response = await GET()
    expect(response.status).toBe(200)
    expect(createClient).not.toHaveBeenCalled()
  })

  it('lists the approved items with the fingerprint of their approved text, cacheable by the CDN', async () => {
    const response = await GET()
    expect(await response.json()).toEqual({ data: { sharing_open: true, items: [{ slug: 'manadsavstamning', sha: SHA }] } })
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=300')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('lists nothing and says sharing is closed until the community launches', async () => {
    flags.open = false
    const response = await GET()
    expect(await response.json()).toEqual({ data: { sharing_open: false, items: [] } })
    expect(loadApprovedCommunityItems).not.toHaveBeenCalled()
  })

  it('fails loudly and uncached when the registry cannot be read', async () => {
    vi.mocked(loadApprovedCommunityItems).mockRejectedValue(new Error('connection reset'))
    const response = await GET()
    expect(response.status).toBe(500)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const body = await response.json()
    expect(body.error.code).toEqual(expect.any(String))
    expect(JSON.stringify(body)).not.toContain('connection reset')
  })
})
