import { describe, expect, it } from 'vitest'
import { fallbackAtomSelection } from '../fallback'
import type { ComposerInputs } from '../inputs'

const ATOMS = [
  'horizontal/swedish-vat',
  'horizontal/swedish-invoice-compliance',
  'horizontal/swedish-year-end-closing',
  'horizontal/swedish-accounting-compliance',
  'horizontal/swedish-sie-import-export',
  'horizontal/swedish-asset-accounting',
  'horizontal/swedish-financial-reporting',
  'horizontal/swedish-sru-filing',
  'horizontal/swedish-tax-planning',
  'horizontal/swedish-payroll',
  'modifier/single-shareholder-ab-fmb',
  'modifier/enskild-firma',
]

function inputs(entityType: string): ComposerInputs {
  return {
    companyId: 'company-1',
    companyName: 'Test',
    entityType,
    ticSnapshot: null,
    ticFetchedAt: null,
    companySettings: null,
    activeEmployees: null,
    sieSummary: null,
    bankingSummary: null,
    atomIndex: ATOMS.map((id) => ({ id, tier: id.split('/')[0], sni_prefixes: [] })) as ComposerInputs['atomIndex'],
    userIsConfirmedDirector: false,
  }
}

describe('fallbackAtomSelection: legal form', () => {
  it('gives an ekonomisk förening the INK2 reporting atoms without the aktiebolag ownership modifier', () => {
    const selection = fallbackAtomSelection(inputs('ekonomisk_forening'))
    expect(selection.horizontal_atoms).toEqual(
      expect.arrayContaining([
        'horizontal/swedish-financial-reporting',
        'horizontal/swedish-sru-filing',
        'horizontal/swedish-tax-planning',
      ]),
    )
    expect(selection.modifier_atoms).not.toContain('modifier/single-shareholder-ab-fmb')
    expect(selection.modifier_atoms).not.toContain('modifier/enskild-firma')
  })

  it('keeps the INK2 atoms away from an enskild firma and an ideell förening', () => {
    for (const form of ['enskild_firma', 'ideell_forening']) {
      const selection = fallbackAtomSelection(inputs(form))
      expect(selection.horizontal_atoms, form).not.toContain('horizontal/swedish-sru-filing')
    }
  })
})
