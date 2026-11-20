import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const getBrowserAccessToken = vi.fn<() => Promise<string | null>>()
vi.mock('@/lib/supabase/browser-session-token', () => ({
  getBrowserAccessToken: () => getBrowserAccessToken(),
}))

import { subscribeAsUser } from '../realtime-subscribe'

function fakeClient(setAuth: () => Promise<void> = async () => {}) {
  const order: string[] = []
  const supabase = {
    realtime: {
      setAuth: vi.fn(async () => {
        order.push('setAuth')
        await setAuth()
      }),
    },
  }
  const channel = { subscribe: vi.fn(() => order.push('subscribe')) }
  return { supabase, channel, order }
}

async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('subscribeAsUser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('hands the user token to realtime before the channel joins', async () => {
    getBrowserAccessToken.mockResolvedValue('user-jwt')
    const { supabase, channel, order } = fakeClient()
    subscribeAsUser(supabase as never, channel as never)
    await settle()
    expect(order).toEqual(['setAuth', 'subscribe'])
  })

  it('never joins without a token (the join would run as anon)', async () => {
    getBrowserAccessToken.mockResolvedValue(null)
    const { supabase, channel } = fakeClient()
    subscribeAsUser(supabase as never, channel as never)
    await settle()
    expect(supabase.realtime.setAuth).not.toHaveBeenCalled()
    expect(channel.subscribe).not.toHaveBeenCalled()
  })

  it('does not join a channel the effect already cleaned up', async () => {
    let resolveToken: (token: string) => void = () => {}
    getBrowserAccessToken.mockReturnValue(new Promise((resolve) => { resolveToken = resolve }))
    const { supabase, channel } = fakeClient()
    const stop = subscribeAsUser(supabase as never, channel as never)
    stop()
    resolveToken('user-jwt')
    await settle()
    expect(channel.subscribe).not.toHaveBeenCalled()
  })

  it('does not join when handing over the token fails', async () => {
    getBrowserAccessToken.mockResolvedValue('user-jwt')
    const { supabase, channel } = fakeClient(async () => {
      throw new Error('socket closed')
    })
    subscribeAsUser(supabase as never, channel as never)
    await settle()
    expect(channel.subscribe).not.toHaveBeenCalled()
  })
})

const SRC = path.resolve(__dirname, '../../..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * Every postgres_changes channel joins through subscribeAsUser: a direct
 * .subscribe() can join with the anon key before the token arrives, and one
 * anon subscriber fails Realtime's WAL poll for the whole project.
 */
describe('postgres_changes channels', () => {
  const files = sourceFiles(SRC)
    .map((file) => ({ file: path.relative(SRC, file), src: readFileSync(file, 'utf8') }))
    .filter(({ src }) => src.includes("'postgres_changes'"))

  it('finds the subscribers it guards', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(files.map((f) => [f.file, f.src]))('%s joins through subscribeAsUser', (_file, src) => {
    expect(src).toContain('subscribeAsUser(')
    expect(src).not.toMatch(/\.subscribe\(\)/)
  })

  it('the dashboard nav holds no realtime channel (one per open tab kept the WAL poller running)', () => {
    const nav = readFileSync(path.join(SRC, 'components/dashboard/DashboardNav.tsx'), 'utf8')
    expect(nav).not.toContain("'postgres_changes'")
  })

  it('nothing listens to skattekonto_transactions (removed from the publication)', () => {
    for (const { src } of files) expect(src).not.toMatch(/table:\s*'skattekonto_transactions'/)
  })
})
