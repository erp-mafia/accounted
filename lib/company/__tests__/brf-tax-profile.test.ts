import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/company/entity-type', async () => {
  const actual = await vi.importActual<typeof import('@/lib/company/entity-type')>('@/lib/company/entity-type')
  return { ...actual, resolveCompanyEntityType: vi.fn() }
})

import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import {
  PRIVATBOSTADSFORETAG_QUALIFIED_SHARE_MIN,
  getTaxProfile,
  isPrivatbostadsforetag,
  qualifiesAsPrivatbostadsforetag,
  requireBrfForm,
  upsertPropertyFacts,
  upsertTaxProfile,
} from '../brf-tax-profile'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
const client = supabase as unknown as Parameters<typeof requireBrfForm>[0]

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

describe('requireBrfForm', () => {
  it('admits a bostadsrättsförening and refuses every other form with BRF_FORM_REQUIRED', async () => {
    vi.mocked(resolveCompanyEntityType).mockResolvedValue('bostadsrattsforening')
    await expect(requireBrfForm(client, 'company-1')).resolves.toBeUndefined()
    for (const form of ['aktiebolag', 'enskild_firma', 'ideell_forening', 'ekonomisk_forening'] as const) {
      vi.mocked(resolveCompanyEntityType).mockResolvedValue(form)
      await expect(requireBrfForm(client, 'company-1')).rejects.toMatchObject({ code: 'BRF_FORM_REQUIRED' })
    }
  })
})

describe('qualifiesAsPrivatbostadsforetag (IL 2 kap. 17 §)', () => {
  it('needs at least 60 % qualified activity and never says yes to a missing share', () => {
    expect(PRIVATBOSTADSFORETAG_QUALIFIED_SHARE_MIN).toBe(0.6)
    expect(qualifiesAsPrivatbostadsforetag(0.6)).toBe(true)
    expect(qualifiesAsPrivatbostadsforetag(0.95)).toBe(true)
    expect(qualifiesAsPrivatbostadsforetag(0.5999)).toBe(false)
    expect(qualifiesAsPrivatbostadsforetag(0)).toBe(false)
    expect(qualifiesAsPrivatbostadsforetag(null)).toBe(false)
    expect(qualifiesAsPrivatbostadsforetag(undefined)).toBe(false)
    expect(qualifiesAsPrivatbostadsforetag(Number.NaN)).toBe(false)
  })

  it('reads the stored decision as a fact and reports an unassessed year as unknown', () => {
    expect(isPrivatbostadsforetag(null)).toBeNull()
    expect(isPrivatbostadsforetag({ privatbostadsforetag: true })).toBe(true)
    expect(isPrivatbostadsforetag({ privatbostadsforetag: false })).toBe(false)
  })
})

describe('tax profile and property facts persistence', () => {
  it('upserts one profile per company and year with the board decision and share', async () => {
    enqueue({
      data: {
        id: 'p1',
        company_id: 'company-1',
        fiscal_year: 2026,
        privatbostadsforetag: true,
        qualified_share: '0.8200',
        assessed_on: '2026-03-01',
        notes: null,
      },
    })
    const row = await upsertTaxProfile(client, 'company-1', 'user-1', {
      fiscal_year: 2026,
      privatbostadsforetag: true,
      qualified_share: 0.82,
      assessed_on: '2026-03-01',
    })
    expect(row.fiscal_year).toBe(2026)
    expect(supabase.from).toHaveBeenCalledWith('brf_tax_profiles')
  })

  it('returns null for a year without an assessment', async () => {
    enqueue({ data: null })
    await expect(getTaxProfile(client, 'company-1', 2025)).resolves.toBeNull()
  })

  it('stores optional facts as null instead of dropping them', async () => {
    enqueue({ data: { id: 'f1', company_id: 'company-1', kvm_bostadsratt: '2500.00', taxeringsvarde: null } })
    const row = await upsertPropertyFacts(client, 'company-1', 'user-1', { kvm_bostadsratt: 2500 })
    expect(row.id).toBe('f1')
    expect(supabase.from).toHaveBeenCalledWith('brf_property_facts')
  })
})
