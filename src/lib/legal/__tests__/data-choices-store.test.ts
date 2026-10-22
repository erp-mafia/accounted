import { beforeEach, describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  companiesWithPoolingOff,
  forgetAiSwitch,
  isAiSwitchedOff,
  isPoolingOn,
  readCompanyDataChoices,
  setCompanyDataChoice,
} from '../data-choices-store'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()

beforeEach(() => {
  reset()
  forgetAiSwitch()
})

describe('readCompanyDataChoices', () => {
  it('fills the defaults: AI and pooling on, contribution off', async () => {
    enqueue({ data: [] })
    expect(await readCompanyDataChoices(supabase as never, COMPANY)).toEqual({ ai: true, pooling: true, contribution: false })
  })

  it('reads the stored rows under their config keys', async () => {
    enqueue({
      data: [
        { capability_key: 'ai', enabled: false },
        { capability_key: 'data:pooling', enabled: false },
        { capability_key: 'data:contribution', enabled: true },
      ],
    })
    expect(await readCompanyDataChoices(supabase as never, COMPANY)).toEqual({ ai: false, pooling: false, contribution: true })
    expect(findCall('company_capability_config', 'in')).toEqual(['capability_key', ['ai', 'data:pooling', 'data:contribution']])
  })

  it('throws on a failed read instead of showing a guess', async () => {
    enqueue({ error: { message: 'down' } })
    await expect(readCompanyDataChoices(supabase as never, COMPANY)).rejects.toThrow(/down/)
  })
})

describe('pooling', () => {
  it('names the companies that opted out', async () => {
    enqueue({ data: [{ company_id: OTHER }] })
    expect(await companiesWithPoolingOff(supabase as never, [COMPANY, OTHER, 'not-a-uuid'])).toEqual(new Set([OTHER]))
    expect(findCall('company_capability_config', 'in')).toEqual(['company_id', [COMPANY, OTHER]])
  })

  it('isPoolingOn is false for an opted-out company and false when the read fails', async () => {
    enqueue({ data: [{ company_id: COMPANY }] })
    expect(await isPoolingOn(supabase as never, COMPANY)).toBe(false)
    enqueue({ error: { message: 'down' } })
    expect(await isPoolingOn(supabase as never, COMPANY)).toBe(false)
    enqueue({ data: [] })
    expect(await isPoolingOn(supabase as never, COMPANY)).toBe(true)
  })
})

describe('isAiSwitchedOff', () => {
  it('is true only for a stored enabled = false, and caches the answer', async () => {
    enqueue({ data: { enabled: false } })
    expect(await isAiSwitchedOff(supabase as never, COMPANY, 1_000)).toBe(true)
    // Cached: no second read inside the TTL.
    expect(await isAiSwitchedOff(supabase as never, COMPANY, 2_000)).toBe(true)
    enqueue({ data: null })
    expect(await isAiSwitchedOff(supabase as never, COMPANY, 40_000)).toBe(false)
  })

  it('answers off when the read fails, and does not cache that', async () => {
    enqueue({ error: { message: 'down' } })
    expect(await isAiSwitchedOff(supabase as never, COMPANY, 1_000)).toBe(true)
    enqueue({ data: null })
    expect(await isAiSwitchedOff(supabase as never, COMPANY, 1_001)).toBe(false)
  })
})

describe('setCompanyDataChoice', () => {
  it('writes through the RPC with the config key and who decided', async () => {
    enqueue({ data: { ok: true, unchanged: false, enabled: false } })
    const result = await setCompanyDataChoice(supabase as never, { companyId: COMPANY, choice: 'pooling', enabled: false, decidedBy: 'user-1' })
    expect(result).toEqual({ ok: true, unchanged: false, enabled: false })
    expect(supabase.rpc).toHaveBeenCalledWith('set_company_data_choice', {
      p_company_id: COMPANY,
      p_key: 'data:pooling',
      p_enabled: false,
      p_decided_by: 'user-1',
      p_actor_type: 'user',
      p_actor_label: null,
    })
  })

  it('passes a refusal on, and throws on an RPC error', async () => {
    enqueue({ data: { ok: false, code: 'DATA_CHOICE_ADMIN_REQUIRED' } })
    expect(await setCompanyDataChoice(supabase as never, { companyId: COMPANY, choice: 'ai', enabled: false, decidedBy: 'user-1' })).toEqual({
      ok: false,
      code: 'DATA_CHOICE_ADMIN_REQUIRED',
    })
    enqueue({ error: { message: 'boom' } })
    await expect(setCompanyDataChoice(supabase as never, { companyId: COMPANY, choice: 'ai', enabled: false, decidedBy: 'user-1' })).rejects.toThrow(/boom/)
  })

  it('switching AI drops the cached answer, so this process sees it at once', async () => {
    enqueue({ data: null })
    expect(await isAiSwitchedOff(supabase as never, COMPANY, 1_000)).toBe(false)
    enqueue({ data: { ok: true, unchanged: false, enabled: false } })
    await setCompanyDataChoice(supabase as never, { companyId: COMPANY, choice: 'ai', enabled: false, decidedBy: 'user-1' })
    enqueue({ data: { enabled: false } })
    expect(await isAiSwitchedOff(supabase as never, COMPANY, 1_001)).toBe(true)
  })
})
