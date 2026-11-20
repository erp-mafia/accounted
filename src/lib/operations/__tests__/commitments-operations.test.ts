/**
 * The commitments operations (./commitments.ts): each one hands its input to
 * the service without the id the path or the tool carries, writes stage
 * under their own pending type with a title the approver reads, and the
 * tools are discoverable only while BOLAGET_COMPANY_IDS names a company.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const services = vi.hoisted(() => ({
  agreements: { listAgreements: vi.fn(), listObligations: vi.fn(), createAgreement: vi.fn(), updateAgreement: vi.fn(), endAgreement: vi.fn() },
  securities: { listSecurities: vi.fn(), createSecurity: vi.fn(), updateSecurity: vi.fn() },
  groupLinks: { listGroupLinks: vi.fn(), createGroupLink: vi.fn(), updateGroupLink: vi.fn() },
}))
vi.mock('@/lib/commitments/agreements', () => services.agreements)
vi.mock('@/lib/commitments/securities', () => services.securities)
vi.mock('@/lib/commitments/group-links', () => services.groupLinks)

import {
  COMMITMENTS_OPERATIONS,
  agreementsCreate,
  agreementsEnd,
  groupLinksUpdate,
  securitiesList,
  securitiesUpdate,
} from '../commitments'
import type { OperationContext } from '../types'

const ctx = { supabase: {}, companyId: 'company-1', userId: 'user-1', log: {} } as unknown as OperationContext
const ID = '11111111-1111-4111-8111-111111111111'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('commitments operations', () => {
  it('pass the input on without the id the path carries', async () => {
    services.securities.updateSecurity.mockResolvedValue({ ok: true, data: {} })
    await securitiesUpdate.run(ctx, securitiesUpdate.input.parse({ security_id: ID, valid_to: '2026-06-30' }), { dryRun: true })
    expect(services.securities.updateSecurity).toHaveBeenCalledWith(ctx, ID, { valid_to: '2026-06-30' }, { dryRun: true })

    services.groupLinks.updateGroupLink.mockResolvedValue({ ok: true, data: {} })
    await groupLinksUpdate.run(ctx, groupLinksUpdate.input.parse({ group_link_id: ID, ownership_percent: 60 }), { dryRun: false })
    expect(services.groupLinks.updateGroupLink).toHaveBeenCalledWith(ctx, ID, { ownership_percent: 60 }, { dryRun: false })

    services.agreements.endAgreement.mockResolvedValue({ ok: true, data: {} })
    await agreementsEnd.run(ctx, agreementsEnd.input.parse({ agreement_id: ID }), { dryRun: false })
    expect(services.agreements.endAgreement).toHaveBeenCalledWith(ctx, ID, {}, { dryRun: false })
  })

  it('read the balance date of the note texts from the input', async () => {
    services.securities.listSecurities.mockResolvedValue({ ok: true, data: {} })
    await securitiesList.run(ctx, securitiesList.input.parse({ balance_date: '2026-12-31' }), { dryRun: false })
    expect(services.securities.listSecurities).toHaveBeenCalledWith(ctx, { balance_date: '2026-12-31' })
  })

  it('stage every write under its own pending type with a Swedish title', () => {
    const writes = COMMITMENTS_OPERATIONS.filter((op) => op.kind === 'write')
    expect(writes.map((op) => op.mcp?.stage?.pendingType)).toEqual([
      'create_agreement',
      'update_agreement',
      'end_agreement',
      'create_security',
      'update_security',
      'create_group_link',
      'update_group_link',
    ])
    expect(agreementsCreate.mcp?.stage?.title({ title: 'Hyresavtal kontor' })).toBe('Registrera avtal: Hyresavtal kontor')
    expect(securitiesUpdate.mcp?.stage?.title({ description: 'Borgen' })).toBe('Ändra säkerhet: Borgen')
  })

  it('refuse a personnummer-shaped or unknown field in the strict inputs', () => {
    expect(agreementsCreate.input.safeParse({ kind: 'rental', title: 'X', personal_number: '19121212-1212' }).success).toBe(false)
  })

  it('are discoverable only while the rollout names a company', async () => {
    vi.stubEnv('BOLAGET_COMPANY_IDS', '')
    const off = await import('../registry')
    expect(off.OPERATIONS.some((op) => op.id === 'agreements.create')).toBe(false)
    expect(off.ALL_OPERATIONS.some((op) => op.id === 'agreements.create')).toBe(true)
    vi.resetModules()
    vi.stubEnv('BOLAGET_COMPANY_IDS', 'company-1')
    const on = await import('../registry')
    expect(on.OPERATIONS.some((op) => op.id === 'agreements.create')).toBe(true)
    // The registry pulls in every operation module twice: a cold import is slow.
  }, 120_000)
})
