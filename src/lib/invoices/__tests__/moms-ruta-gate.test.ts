import { describe, expect, it } from 'vitest'
import { hasRequiredMomsRuta } from '../moms-ruta-gate'

describe('hasRequiredMomsRuta', () => {
  it('accepts any invoice that carries a ruta', () => {
    expect(hasRequiredMomsRuta({ vat_registered: true }, { moms_ruta: '05', vat_treatment: 'standard_25' })).toBe(true)
    expect(hasRequiredMomsRuta({ vat_registered: false }, { moms_ruta: '05', vat_treatment: 'exempt' })).toBe(true)
  })

  it('accepts a null ruta only for an exempt invoice from a non-VAT-registered seller', () => {
    expect(hasRequiredMomsRuta({ vat_registered: false }, { moms_ruta: null, vat_treatment: 'exempt' })).toBe(true)
  })

  it('rejects a null ruta from a VAT-registered seller, whatever the treatment', () => {
    expect(hasRequiredMomsRuta({ vat_registered: true }, { moms_ruta: null, vat_treatment: 'exempt' })).toBe(false)
    expect(hasRequiredMomsRuta({ vat_registered: true }, { moms_ruta: null, vat_treatment: 'standard_25' })).toBe(false)
  })

  it('rejects a null ruta on a non-exempt invoice from a non-VAT-registered seller', () => {
    expect(hasRequiredMomsRuta({ vat_registered: false }, { moms_ruta: null, vat_treatment: 'standard_25' })).toBe(false)
    expect(hasRequiredMomsRuta({ vat_registered: false }, { moms_ruta: null, vat_treatment: 'reverse_charge' })).toBe(false)
  })

  it('treats an unknown registration status as registered', () => {
    const unknown = {} as { vat_registered: boolean }
    expect(hasRequiredMomsRuta(unknown, { moms_ruta: null, vat_treatment: 'exempt' })).toBe(false)
  })
})
