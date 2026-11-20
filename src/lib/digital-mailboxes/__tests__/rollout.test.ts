import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '@/lib/logger'
import { activateSending, connectBilloReceive, connectKivraReceive } from '../connect'
import {
  digitalMailboxAvailability,
  digitalMailboxRollout,
  isDigitalMailboxEnabled,
  resetDigitalMailboxProviders,
} from '../providers'

const log = createLogger('test')

/** A client that fails the test if the flow reaches the database. */
const untouchable = new Proxy({}, {
  get() {
    throw new Error('the database must not be read for a company outside the rollout')
  },
}) as unknown as SupabaseClient

beforeEach(() => {
  vi.stubEnv('KIVRA_CLIENT_ID', 'kc')
  vi.stubEnv('KIVRA_CLIENT_SECRET', 'ks')
  vi.stubEnv('KIVRA_PARTNER_CLIENT_ID', 'kp')
  vi.stubEnv('KIVRA_PARTNER_CLIENT_SECRET', 'kps')
  vi.stubEnv('KIVRA_ONBOARDING_URL', 'https://example.test/onboard')
  vi.stubEnv('BILLO_PARTNER_API_KEY', 'bk')
  vi.stubEnv('BILLO_SENDER_CLIENT_ID', 'bc')
  vi.stubEnv('BILLO_SENDER_CLIENT_SECRET', 'bs')
  resetDigitalMailboxProviders()
})

afterEach(() => {
  vi.unstubAllEnvs()
  resetDigitalMailboxProviders()
})

describe('digitalMailboxRollout', () => {
  it('is nobody when unset, everyone for *, else the listed companies', () => {
    vi.stubEnv('DIGITAL_MAILBOX_COMPANY_IDS', '')
    expect(digitalMailboxRollout()).toEqual([])
    vi.stubEnv('DIGITAL_MAILBOX_COMPANY_IDS', '*')
    expect(digitalMailboxRollout()).toBe('all')
    vi.stubEnv('DIGITAL_MAILBOX_COMPANY_IDS', ' company-a, company-b ,company-a,')
    expect(digitalMailboxRollout()).toEqual(['company-a', 'company-b'])
  })

  it('lets in only listed companies, and nobody without a company', () => {
    vi.stubEnv('DIGITAL_MAILBOX_COMPANY_IDS', 'company-a')
    expect(isDigitalMailboxEnabled('company-a')).toBe(true)
    expect(isDigitalMailboxEnabled('company-b')).toBe(false)
    expect(isDigitalMailboxEnabled(null)).toBe(false)
  })
})

describe('digitalMailboxAvailability', () => {
  it('offers the configured doors to a company in the rollout and none to the rest', () => {
    vi.stubEnv('DIGITAL_MAILBOX_COMPANY_IDS', 'company-a')
    expect(digitalMailboxAvailability('company-a')).toEqual({ kivra: { receive: true, send: true }, billo: { receive: true, send: true } })
    expect(digitalMailboxAvailability('company-b')).toEqual({ kivra: { receive: false, send: false }, billo: { receive: false, send: false } })
  })

  it('offers nothing while the rollout is unset, credentials or not', () => {
    expect(digitalMailboxAvailability('company-a')).toEqual({ kivra: { receive: false, send: false }, billo: { receive: false, send: false } })
  })
})

describe('connecting outside the rollout', () => {
  beforeEach(() => {
    vi.stubEnv('DIGITAL_MAILBOX_COMPANY_IDS', 'company-a')
  })

  it('refuses to connect a Kivra or Billo mailbox before reading anything', async () => {
    const args = { companyId: 'company-b', userId: 'user-1', log }
    await expect(connectKivraReceive(untouchable, args)).resolves.toEqual({ ok: false, code: 'DIGITAL_MAILBOX_NOT_CONFIGURED' })
    await expect(
      connectBilloReceive(untouchable, { ...args, representative: { email: 'test@example.test', phone: '+46701740605' } }),
    ).resolves.toEqual({ ok: false, code: 'DIGITAL_MAILBOX_NOT_CONFIGURED' })
  })

  it('refuses to start sending', async () => {
    await expect(activateSending(untouchable, { companyId: 'company-b', userId: 'user-1', provider: 'billo', log })).resolves.toEqual({
      ok: false,
      code: 'DIGITAL_MAILBOX_NOT_CONFIGURED',
    })
  })
})
