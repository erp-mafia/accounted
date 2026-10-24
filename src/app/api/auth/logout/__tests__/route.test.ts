import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseJsonResponse } from '@/tests/helpers'

const signOutMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { signOut: signOutMock } })),
}))

const cookieState = vi.hoisted(() => ({ names: [] as string[] }))
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    getAll: () => cookieState.names.map((name) => ({ name, value: 'v' })),
  })),
}))

import { POST } from '../route'

function makeRequest(body: unknown = {}, headers: Record<string, string> = {}): Request {
  return new Request('https://app.accounted.se/api/auth/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co')
  cookieState.names = []
  signOutMock.mockResolvedValue({ error: null })
})

describe('POST /api/auth/logout', () => {
  it('revokes every session of the user by default (supabase-js signOut() semantics)', async () => {
    const res = await POST(makeRequest())
    const { body } = await parseJsonResponse<{ data: { revoked: boolean } }>(res)

    expect(res.status).toBe(200)
    expect(body.data.revoked).toBe(true)
    expect(signOutMock).toHaveBeenCalledWith({ scope: 'global' })
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('ends only this session with scope local (the session-timeout controller)', async () => {
    await POST(makeRequest({ scope: 'local' }))
    expect(signOutMock).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('400s on an unknown scope', async () => {
    const res = await POST(makeRequest({ scope: 'others' }))
    expect(res.status).toBe(400)
    expect(signOutMock).not.toHaveBeenCalled()
  })

  it('works without any session (nothing to revoke, nothing left behind)', async () => {
    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    expect(res.headers.getSetCookie()).toEqual([])
  })

  it('still deletes the session cookie, HttpOnly, when GoTrue refuses the revocation', async () => {
    signOutMock.mockResolvedValue({ error: { status: 500, code: 'unexpected_failure' } })
    cookieState.names = ['sb-project-auth-token.0', 'sb-project-auth-token.1', 'sb-project-auth-token-code-verifier', 'unrelated']

    const res = await POST(makeRequest())
    const { body } = await parseJsonResponse<{ data: { revoked: boolean } }>(res)

    expect(res.status).toBe(200)
    expect(body.data.revoked).toBe(false)
    for (const name of ['sb-project-auth-token.0', 'sb-project-auth-token.1', 'sb-project-auth-token-code-verifier']) {
      const cookie = res.cookies.get(name)
      expect(cookie?.value).toBe('')
      expect(cookie?.maxAge).toBe(0)
      expect(cookie?.httpOnly).toBe(true)
    }
    expect(res.cookies.get('unrelated')).toBeUndefined()
  })

  it('clears the session-bound helper cookies too, and keeps the language cookie', async () => {
    cookieState.names = ['gnubok-company-id', 'gnubok-home-ok', 'gnubok-session-timeout', 'gnubok-session-cookie', 'gnubok-locale']

    const res = await POST(makeRequest())

    for (const name of ['gnubok-company-id', 'gnubok-home-ok', 'gnubok-session-timeout', 'gnubok-session-cookie']) {
      expect(res.cookies.get(name)).toMatchObject({ value: '', maxAge: 0, httpOnly: true })
    }
    expect(res.cookies.get('gnubok-locale')).toBeUndefined()
    for (const header of res.headers.getSetCookie()) expect(header).toMatch(/HttpOnly/i)
  })

  it('refuses a cross-site request', async () => {
    const res = await POST(makeRequest({}, { 'sec-fetch-site': 'cross-site' }))
    expect(res.status).toBe(403)
    expect(signOutMock).not.toHaveBeenCalled()
  })
})
