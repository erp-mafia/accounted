import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()

vi.mock('@/lib/company/entity-type', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/company/entity-type')>()),
  resolveCompanyEntityType: vi.fn().mockResolvedValue('aktiebolag'),
}))

import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import { bolagetGate, bolagetHubAccess } from '../gate'

const A = 'aaaaaaaa-0000-4000-8000-000000000001'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.mocked(resolveCompanyEntityType).mockResolvedValue('aktiebolag')
  reset()
})

describe('bolagetGate', () => {
  it('is closed for a company in neither list and not set up from a formation', async () => {
    vi.stubEnv('BOLAGET_COMPANY_IDS', '')
    vi.stubEnv('BOLAGET_REGISTERS_COMPANY_IDS', '')
    enqueue({ data: { bolaget_registers_enabled: false } })
    expect(await bolagetGate(supabase as never, A, 'registers')).toBe('BOLAGET_DISABLED')
    expect(await bolagetGate(supabase as never, A)).toBe('BOLAGET_DISABLED')
  })

  it('opens the registers, and only the registers, for a company BOLAGET_REGISTERS_COMPANY_IDS names', async () => {
    vi.stubEnv('BOLAGET_COMPANY_IDS', '')
    vi.stubEnv('BOLAGET_REGISTERS_COMPANY_IDS', '*')
    expect(await bolagetGate(supabase as never, A, 'registers')).toBeNull()
    // The list answers: the company row is not read.
    expect(findCall('companies', 'select')).toBeUndefined()
    expect(await bolagetGate(supabase as never, A, 'all')).toBe('BOLAGET_DISABLED')
    expect(await bolagetHubAccess(supabase as never, A)).toMatchObject({ registers: true, money: false })
  })

  it('still opens the registers for a company set up from a formation', async () => {
    vi.stubEnv('BOLAGET_COMPANY_IDS', '')
    vi.stubEnv('BOLAGET_REGISTERS_COMPANY_IDS', '')
    enqueue({ data: { bolaget_registers_enabled: true } })
    expect(await bolagetGate(supabase as never, A, 'registers')).toBeNull()
  })

  it('opens everything for a company in the whole rollout', async () => {
    vi.stubEnv('BOLAGET_COMPANY_IDS', A)
    vi.stubEnv('BOLAGET_REGISTERS_COMPANY_IDS', '')
    expect(await bolagetGate(supabase as never, A, 'registers')).toBeNull()
    expect(await bolagetGate(supabase as never, A, 'all')).toBeNull()
  })

  it('keeps the per-form rule: no aktiebok for a form that keeps none', async () => {
    vi.stubEnv('BOLAGET_REGISTERS_COMPANY_IDS', '*')
    vi.mocked(resolveCompanyEntityType).mockResolvedValue('enskild_firma')
    expect(await bolagetGate(supabase as never, A, 'registers')).toBe('BOLAGET_NOT_FOR_LEGAL_FORM')
  })
})
