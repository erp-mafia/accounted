import { describe, it, expect } from 'vitest'
import {
  autoCorrectionDescription,
  correctionDescriptionForSubmit,
} from '@/components/bookkeeping/correction-entry-description'

const ORIGINAL = 'Lån från närstående personer, långfristig del'

describe('autoCorrectionDescription', () => {
  it('matches the server-side fallback format', () => {
    expect(autoCorrectionDescription(ORIGINAL)).toBe(`Rättelse: ${ORIGINAL}`)
  })
})

describe('correctionDescriptionForSubmit', () => {
  it('sends nothing when the field still equals the auto prefill', () => {
    expect(correctionDescriptionForSubmit(`Rättelse: ${ORIGINAL}`, ORIGINAL)).toBeUndefined()
  })

  it('sends nothing when the prefill only gained surrounding whitespace', () => {
    expect(correctionDescriptionForSubmit(`  Rättelse: ${ORIGINAL} `, ORIGINAL)).toBeUndefined()
  })

  it('sends nothing when the field was cleared (server fallback applies)', () => {
    expect(correctionDescriptionForSubmit('', ORIGINAL)).toBeUndefined()
    expect(correctionDescriptionForSubmit('   ', ORIGINAL)).toBeUndefined()
  })

  it('sends a user-edited description (the reported bug: relabel after account change)', () => {
    expect(
      correctionDescriptionForSubmit('Rättelse: Skulder till närstående personer, kortfristig del', ORIGINAL),
    ).toBe('Rättelse: Skulder till närstående personer, kortfristig del')
  })

  it('trims a user-edited description before sending', () => {
    expect(correctionDescriptionForSubmit('  Omföring till rätt konto  ', ORIGINAL)).toBe(
      'Omföring till rätt konto',
    )
  })
})
