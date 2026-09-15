import { describe, expect, it } from 'vitest'
import {
  buildRemapProposals,
  EntityTypeMigrationError,
  reclassificationLines,
  validateRemapPlan,
  type EntityTypePreview,
} from '../entity-type-migration'

function preview(overrides: Partial<EntityTypePreview> = {}): EntityTypePreview {
  return {
    ok: true,
    current_entity_type: 'aktiebolag',
    target_entity_type: 'ekonomisk_forening',
    same_form: false,
    empty_books_path_available: false,
    caller_role: 'owner',
    blockers: { journal_entries: 12, invoices: 0, supplier_invoices: 0, custom_accounts: 0, configured_account_references: 0 },
    decision_accounts: [
      { account: '2081', balance: 25_000 },
      { account: '2087', balance: 5_000 },
      { account: '2091', balance: 10_000 },
      { account: '2893', balance: -3_200.5 },
      { account: '2099', balance: 0 },
    ],
    ...overrides,
  }
}

describe('buildRemapProposals', () => {
  it('proposes the design mappings for aktiebolag → ekonomisk förening, every one skipped by default', () => {
    const proposals = buildRemapProposals(preview())
    expect(proposals.map((p) => p.account_from)).toEqual(['2081', '2087', '2091', '2893'])
    expect(proposals.every((p) => p.decision === 'skipped')).toBe(true)
    const byAccount = Object.fromEntries(proposals.map((p) => [p.account_from, p]))
    expect(byAccount['2081']).toMatchObject({ account_to: '2083', plausibility: 'plausible', amount: 25_000 })
    expect(byAccount['2087']).toMatchObject({ account_to: null, plausibility: 'keep' })
    expect(byAccount['2091']).toMatchObject({ account_to: null, plausibility: 'keep' })
    expect(byAccount['2893']).toMatchObject({ account_to: '2890', plausibility: 'review', amount: -3_200.5 })
  })

  it('drops zero balances and falls back to review for accounts without a rule', () => {
    const proposals = buildRemapProposals(
      preview({ decision_accounts: [{ account: '2099', balance: 0 }, { account: '2013', balance: 400 }] }),
    )
    expect(proposals).toHaveLength(1)
    expect(proposals[0]).toMatchObject({ account_from: '2013', account_to: null, plausibility: 'review' })
  })

  it('maps the ideell förening result chain to 2091/2099', () => {
    const proposals = buildRemapProposals(
      preview({
        current_entity_type: 'ideell_forening',
        decision_accounts: [
          { account: '2068', balance: 1_000 },
          { account: '2069', balance: 500 },
          { account: '2890', balance: 200 },
        ],
      }),
    )
    const byAccount = Object.fromEntries(proposals.map((p) => [p.account_from, p]))
    expect(byAccount['2068']).toMatchObject({ account_to: '2091', plausibility: 'plausible' })
    expect(byAccount['2069']).toMatchObject({ account_to: '2099', plausibility: 'plausible' })
    expect(byAccount['2890']).toMatchObject({ account_to: null, plausibility: 'keep' })
  })
})

describe('validateRemapPlan', () => {
  it('refuses when a nonzero decision account has no decision', () => {
    expect(() =>
      validateRemapPlan(preview(), [
        { account_from: '2081', account_to: '2083', amount: 25_000, decision: 'confirmed' },
      ]),
    ).toThrowError(EntityTypeMigrationError)
    try {
      validateRemapPlan(preview(), [{ account_from: '2081', account_to: '2083', amount: 25_000, decision: 'confirmed' }])
    } catch (err) {
      expect((err as EntityTypeMigrationError).code).toBe('ENTITY_TYPE_MIGRATION_UNDECIDED_ACCOUNT')
      expect((err as EntityTypeMigrationError).details).toEqual({ accounts: ['2087', '2091', '2893'] })
    }
  })

  it('refuses an entry outside the snapshot and a confirmed remap without a target', () => {
    const full = [
      { account_from: '2081', account_to: '2083', amount: 25_000, decision: 'confirmed' as const },
      { account_from: '2087', account_to: null, amount: 5_000, decision: 'skipped' as const },
      { account_from: '2091', account_to: null, amount: 10_000, decision: 'skipped' as const },
      { account_from: '2893', account_to: null, amount: -3_200.5, decision: 'skipped' as const },
    ]
    expect(() =>
      validateRemapPlan(preview(), [...full, { account_from: '1930', account_to: '1940', amount: 1, decision: 'confirmed' }]),
    ).toThrowError(/INVALID_PLAN/)
    expect(() =>
      validateRemapPlan(preview(), [{ ...full[0], account_to: null }, ...full.slice(1)]),
    ).toThrowError(/INVALID_PLAN/)
    expect(() =>
      validateRemapPlan(preview(), [{ ...full[0], account_to: '2081' }, ...full.slice(1)]),
    ).toThrowError(/INVALID_PLAN/)
  })

  it('returns the confirmed remaps with the snapshot balances, ignoring the caller amount', () => {
    const remaps = validateRemapPlan(preview(), [
      { account_from: '2081', account_to: '2083', amount: 1, decision: 'confirmed' },
      { account_from: '2087', account_to: null, amount: 5_000, decision: 'skipped' },
      { account_from: '2091', account_to: null, amount: 10_000, decision: 'skipped' },
      { account_from: '2893', account_to: '2890', amount: -3_200.5, decision: 'confirmed' },
    ])
    expect(remaps).toEqual([
      { account_from: '2081', account_to: '2083', balance: 25_000 },
      { account_from: '2893', account_to: '2890', balance: -3_200.5 },
    ])
  })
})

describe('reclassificationLines', () => {
  it('moves a credit balance by debiting the old account and a debit balance the other way', () => {
    const lines = reclassificationLines([
      { account_from: '2081', account_to: '2083', balance: 25_000 },
      { account_from: '2893', account_to: '2890', balance: -3_200.5 },
      { account_from: '2087', account_to: '2083', balance: 0 },
    ])
    expect(lines).toEqual([
      expect.objectContaining({ account_number: '2081', debit_amount: 25_000, credit_amount: 0 }),
      expect.objectContaining({ account_number: '2083', debit_amount: 0, credit_amount: 25_000 }),
      expect.objectContaining({ account_number: '2890', debit_amount: 3_200.5, credit_amount: 0 }),
      expect.objectContaining({ account_number: '2893', debit_amount: 0, credit_amount: 3_200.5 }),
    ])
    const debit = lines.reduce((sum, l) => sum + l.debit_amount, 0)
    const credit = lines.reduce((sum, l) => sum + l.credit_amount, 0)
    expect(debit).toBe(credit)
  })
})
