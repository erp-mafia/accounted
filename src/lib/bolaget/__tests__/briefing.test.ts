import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/company/entity-type', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/company/entity-type')>()),
  resolveCompanyEntityType: vi.fn(),
}))
vi.mock('../share-register', () => ({ loadShareRegisterData: vi.fn() }))
vi.mock('../roles', () => ({ loadRoles: vi.fn() }))

import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import type { OperationContext } from '@/lib/operations/types'
import { briefBolaget } from '../briefing'
import { loadRoles } from '../roles'
import { loadShareRegisterData } from '../share-register'

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
const ctx = { supabase: {}, companyId: A, userId: 'user-1', log } as unknown as OperationContext

const register = {
  summary: { total_shares: 500, holders: [{ party_id: 'p1', capital_pct: 100, votes_pct: 100 }] },
  parties: new Map([['p1', { name: 'Anna Ek' }]]),
}
const roles = { roles: [{}], board: [{ party: { name: 'Anna Ek' }, label_sv: 'Styrelseledamot' }], ceo: null, signatory_rule: 'Firman tecknas av styrelsen' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('BOLAGET_COMPANY_IDS', '')
  vi.stubEnv('BOLAGET_REGISTERS_COMPANY_IDS', '*')
  vi.mocked(resolveCompanyEntityType).mockResolvedValue('aktiebolag')
  vi.mocked(loadShareRegisterData).mockResolvedValue(register as never)
  vi.mocked(loadRoles).mockResolvedValue(roles as never)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('briefBolaget', () => {
  it('answers the owners and the board of an aktiebolag in the rollout', async () => {
    expect(await briefBolaget(ctx)).toMatchObject({
      total_shares: 500,
      owners: [{ name: 'Anna Ek', capital_pct: 100, votes_pct: 100 }],
      board: [{ name: 'Anna Ek', role: 'Styrelseledamot' }],
      signatory_rule: 'Firman tecknas av styrelsen',
    })
  })

  it.each(['enskild_firma', 'ideell_forening', 'ekonomisk_forening'] as const)(
    'answers nothing for a %s, and reads no register and seeds no roles for it',
    async (entityType) => {
      vi.mocked(resolveCompanyEntityType).mockResolvedValue(entityType)
      expect(await briefBolaget(ctx)).toBeNull()
      expect(loadShareRegisterData).not.toHaveBeenCalled()
      // The first read of the roles seeds them from the registry snapshot: it must not run.
      expect(loadRoles).not.toHaveBeenCalled()
    },
  )

  it('answers nothing outside the rollout, without asking for the legal form', async () => {
    vi.stubEnv('BOLAGET_REGISTERS_COMPANY_IDS', '')
    expect(await briefBolaget(ctx)).toBeNull()
    expect(resolveCompanyEntityType).not.toHaveBeenCalled()
  })

  it('answers nothing, and breaks nothing, when a read fails', async () => {
    vi.mocked(loadRoles).mockRejectedValue(new Error('relation does not exist'))
    expect(await briefBolaget(ctx)).toBeNull()
    expect(log.warn).toHaveBeenCalled()
  })
})
