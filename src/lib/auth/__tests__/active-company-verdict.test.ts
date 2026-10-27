import { describe, expect, it } from 'vitest'
import { signActiveCompany, verifyActiveCompany } from '../active-company-verdict'

const ENV = { SESSION_TIMEOUT_SECRET: 'active-company-verdict-test-secret' }
const SESSION = { userId: 'user-1', sessionId: 'sess-1' }
const COMPANY = '0b7c6f6e-2f4a-4c1e-9d55-3a1f0c2b9e10'
const OTHER_COMPANY = '5d2e8a41-7c3b-4f0a-8e6d-1b9c4a7f2e33'

describe('the active-company verdict', () => {
  it('vouches for the company it was signed for, for that user and session, until it expires', async () => {
    const now = 1_800_000_000_000
    const verdict = await signActiveCompany({ ...SESSION, companyId: COMPANY, now }, ENV)
    expect(verdict).not.toBeNull()
    await expect(verifyActiveCompany(verdict, { ...SESSION, now }, ENV)).resolves.toBe(COMPANY)
    await expect(verifyActiveCompany(verdict, { ...SESSION, now: now + 29_000 }, ENV)).resolves.toBe(COMPANY)
    await expect(verifyActiveCompany(verdict, { ...SESSION, now: now + 30_000 }, ENV)).resolves.toBeNull()
  })

  it('tolerates a render clock a few seconds behind the proxy, never one minted far ahead', async () => {
    const now = 1_800_000_000_000
    const behind = await signActiveCompany({ ...SESSION, companyId: COMPANY, now }, ENV)
    await expect(verifyActiveCompany(behind, { ...SESSION, now: now - 4_000 }, ENV)).resolves.toBe(COMPANY)
    const ahead = await signActiveCompany({ ...SESSION, companyId: COMPANY, now: now + 60_000 }, ENV)
    await expect(verifyActiveCompany(ahead, { ...SESSION, now }, ENV)).resolves.toBeNull()
  })

  it('does not verify for another user, session or secret, or once the company or expiry is altered', async () => {
    const verdict = (await signActiveCompany({ ...SESSION, companyId: COMPANY }, ENV))!
    await expect(verifyActiveCompany(verdict, { userId: 'user-2', sessionId: 'sess-1' }, ENV)).resolves.toBeNull()
    await expect(verifyActiveCompany(verdict, { userId: 'user-1', sessionId: 'sess-2' }, ENV)).resolves.toBeNull()
    await expect(verifyActiveCompany(verdict, SESSION, { SESSION_TIMEOUT_SECRET: 'other' })).resolves.toBeNull()
    const [, expiresAt, signature] = verdict.split('.')
    // Swapping in another company keeps a well-formed value but breaks the signature.
    await expect(verifyActiveCompany(`${OTHER_COMPANY}.${expiresAt}.${signature}`, SESSION, ENV)).resolves.toBeNull()
    await expect(verifyActiveCompany(`${COMPANY}.${Number(expiresAt) + 1}.${signature}`, SESSION, ENV)).resolves.toBeNull()
    await expect(verifyActiveCompany(`${COMPANY}.${expiresAt}.${signature.slice(1)}A`, SESSION, ENV)).resolves.toBeNull()
  })

  it('reads anything else as no verdict', async () => {
    const future = Date.now() + 1000
    for (const value of [
      null,
      undefined,
      '',
      'x',
      `${COMPANY}.${future}`,
      `${COMPANY}.${future}.`,
      `not-a-uuid.${future}.abc`,
      `${COMPANY}.notanumber.abc`,
      `${COMPANY}.${future}.abc.extra`,
    ]) {
      await expect(verifyActiveCompany(value, SESSION, ENV)).resolves.toBeNull()
    }
  })

  it('signs nothing for a value that is not a company id, and nothing without a server secret', async () => {
    await expect(signActiveCompany({ ...SESSION, companyId: 'company-1' }, ENV)).resolves.toBeNull()
    await expect(signActiveCompany({ ...SESSION, companyId: COMPANY }, {})).resolves.toBeNull()
    const verdict = await signActiveCompany({ ...SESSION, companyId: COMPANY }, ENV)
    await expect(verifyActiveCompany(verdict, SESSION, {})).resolves.toBeNull()
  })

  it('never verifies as the MFA verdict, or the other way round: each signer has its own derived key', async () => {
    const { signNoVerifiedFactor, verifyNoVerifiedFactor } = await import('../mfa-assurance')
    const mfa = (await signNoVerifiedFactor(SESSION, ENV))!
    await expect(verifyActiveCompany(`${COMPANY}.${mfa}`, SESSION, ENV)).resolves.toBeNull()
    const verdict = (await signActiveCompany({ ...SESSION, companyId: COMPANY }, ENV))!
    await expect(verifyNoVerifiedFactor(verdict.slice(COMPANY.length + 1), SESSION, ENV)).resolves.toBe(false)
  })
})
