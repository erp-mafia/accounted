import { describe, expect, it } from 'vitest'
import { signNoVerifiedFactor, verifyNoVerifiedFactor } from '../mfa-assurance'

const ENV = { SESSION_TIMEOUT_SECRET: 'mfa-assurance-test-secret' }
const SESSION = { userId: 'user-1', sessionId: 'sess-1' }

describe('the no-verified-factor verdict', () => {
  it('verifies for the user and session it was signed for, until it expires', async () => {
    const now = 1_800_000_000_000
    const verdict = await signNoVerifiedFactor({ ...SESSION, now }, ENV)
    expect(verdict).not.toBeNull()
    await expect(verifyNoVerifiedFactor(verdict, { ...SESSION, now }, ENV)).resolves.toBe(true)
    await expect(verifyNoVerifiedFactor(verdict, { ...SESSION, now: now + 29_000 }, ENV)).resolves.toBe(true)
    await expect(verifyNoVerifiedFactor(verdict, { ...SESSION, now: now + 30_000 }, ENV)).resolves.toBe(false)
  })

  it('tolerates a route clock a few seconds behind the proxy, never one minted far ahead', async () => {
    const now = 1_800_000_000_000
    await expect(verifyNoVerifiedFactor(await signNoVerifiedFactor({ ...SESSION, now }, ENV), { ...SESSION, now: now - 4_000 }, ENV)).resolves.toBe(true)
    await expect(verifyNoVerifiedFactor(await signNoVerifiedFactor({ ...SESSION, now: now + 60_000 }, ENV), { ...SESSION, now }, ENV)).resolves.toBe(false)
  })

  it('does not verify for another user, session or secret, or once altered', async () => {
    const verdict = (await signNoVerifiedFactor(SESSION, ENV))!
    await expect(verifyNoVerifiedFactor(verdict, { userId: 'user-2', sessionId: 'sess-1' }, ENV)).resolves.toBe(false)
    await expect(verifyNoVerifiedFactor(verdict, { userId: 'user-1', sessionId: 'sess-2' }, ENV)).resolves.toBe(false)
    await expect(verifyNoVerifiedFactor(verdict, SESSION, { SESSION_TIMEOUT_SECRET: 'other' })).resolves.toBe(false)
    const [expiresAt, signature] = verdict.split('.')
    await expect(verifyNoVerifiedFactor(`${Number(expiresAt) + 1}.${signature}`, SESSION, ENV)).resolves.toBe(false)
    await expect(verifyNoVerifiedFactor(`${expiresAt}.${signature.slice(1)}A`, SESSION, ENV)).resolves.toBe(false)
  })

  it('reads anything else as no verdict', async () => {
    for (const value of [null, undefined, '', 'x', '1.2.3', 'notanumber.abc', `${Date.now() + 1000}.`]) {
      await expect(verifyNoVerifiedFactor(value, SESSION, ENV)).resolves.toBe(false)
    }
  })

  it('signs nothing and verifies nothing without a server secret', async () => {
    await expect(signNoVerifiedFactor(SESSION, {})).resolves.toBeNull()
    const verdict = await signNoVerifiedFactor(SESSION, ENV)
    await expect(verifyNoVerifiedFactor(verdict, SESSION, {})).resolves.toBe(false)
  })

  it('takes the service role key when there is no dedicated secret, under its own derived key', async () => {
    const serviceEnv = { SUPABASE_SERVICE_ROLE_KEY: 'service-role-key' }
    const verdict = await signNoVerifiedFactor(SESSION, serviceEnv)
    await expect(verifyNoVerifiedFactor(verdict, SESSION, serviceEnv)).resolves.toBe(true)
  })
})
