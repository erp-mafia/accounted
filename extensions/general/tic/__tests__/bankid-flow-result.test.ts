import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FLOW_WINDOW_SECONDS, type BankIdFlowState } from '../lib/bankid-flow-cookie'
import { openBankIdResult, sealBankIdResult } from '../lib/bankid-flow-result'
import type { BankIdUser } from '../lib/bankid-types'

const TEST_KEY = 'a'.repeat(64)
const T0 = 1_700_000_000_000

const USER: BankIdUser = {
  personalNumber: '199001011234',
  givenName: 'Anna',
  surname: 'Andersson',
  name: 'Anna Andersson',
}

const FLOW: BankIdFlowState = {
  version: 1,
  sessionId: 'sess-1',
  flowId: 'flow-1',
  mode: 'login',
  startedAt: T0,
  expiresAt: T0 + FLOW_WINDOW_SECONDS * 1000,
}

beforeEach(() => {
  vi.stubEnv('BANKID_ENCRYPTION_KEY', TEST_KEY)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('sealBankIdResult / openBankIdResult', () => {
  it('round-trips the identification through the cookie state', () => {
    const result = sealBankIdResult(USER, T0)
    expect(result.completedAt).toBe(T0)
    expect(openBankIdResult({ ...FLOW, result })).toEqual(USER)
  })

  it('keeps only the four fields the routes use, whatever TIC attached', () => {
    const noisy = { ...USER, extra: 'ignored' } as BankIdUser
    expect(openBankIdResult({ ...FLOW, result: sealBankIdResult(noisy) })).toEqual(USER)
  })

  it('never puts the personnummer or the name in the clear', () => {
    // The cookie payload is base64 JSON; only the signature protects it from
    // forgery, nothing protects it from reading. The seal must.
    const { enc } = sealBankIdResult(USER)
    const decoded = Buffer.from(enc, 'base64url').toString('latin1')
    expect(enc).not.toContain('199001011234')
    expect(decoded).not.toContain('199001011234')
    expect(decoded).not.toContain('Andersson')
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/u)
  })

  it('answers null for a flow that carries no seal, so the caller asks TIC', () => {
    expect(openBankIdResult(FLOW)).toBeNull()
  })

  it('answers null for a tampered seal instead of throwing', () => {
    const result = sealBankIdResult(USER)
    const bytes = Buffer.from(result.enc, 'base64url')
    bytes[bytes.length - 1] ^= 0xff
    expect(openBankIdResult({ ...FLOW, result: { ...result, enc: bytes.toString('base64url') } })).toBeNull()
    expect(openBankIdResult({ ...FLOW, result: { ...result, enc: 'not-ciphertext' } })).toBeNull()
  })

  it('answers null for a seal made under another key', () => {
    const result = sealBankIdResult(USER)
    vi.stubEnv('BANKID_ENCRYPTION_KEY', 'b'.repeat(64))
    expect(openBankIdResult({ ...FLOW, result })).toBeNull()
  })

  it('answers null when the plaintext is not a BankID user', () => {
    // A seal is only ever produced from a BankIdUser, so anything else that
    // opens under our key is a bug, not an identification.
    const result = sealBankIdResult({ ...USER, personalNumber: '' })
    expect(openBankIdResult({ ...FLOW, result })).toBeNull()
  })
})
