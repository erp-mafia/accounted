import { describe, it, expect } from 'vitest'
import { splitCreateAccountPrefill } from '../create-account-prefill'

describe('splitCreateAccountPrefill', () => {
  it('routes a full account number to the number field', () => {
    // The support case: 8022 is a retired BAS account, so the picker finds
    // nothing and the user reaches for "Skapa konto" with the number typed.
    expect(splitCreateAccountPrefill('8022')).toEqual({ initialAccountNumber: '8022' })
  })

  it('routes a partial account number to the number field', () => {
    expect(splitCreateAccountPrefill('80')).toEqual({ initialAccountNumber: '80' })
  })

  it('routes a name fragment to the name field', () => {
    expect(splitCreateAccountPrefill('andelar i dotterföretag')).toEqual({
      initialAccountName: 'andelar i dotterföretag',
    })
  })

  it('treats a number longer than four digits as a name, not a number', () => {
    // The dialog would silently truncate it to four digits; keeping it in the
    // name field makes the mistake visible instead.
    expect(splitCreateAccountPrefill('80221')).toEqual({ initialAccountName: '80221' })
  })

  it('treats a mixed string as a name', () => {
    expect(splitCreateAccountPrefill('8022 dotter')).toEqual({ initialAccountName: '8022 dotter' })
  })

  it('trims surrounding whitespace before deciding', () => {
    expect(splitCreateAccountPrefill('  8022  ')).toEqual({ initialAccountNumber: '8022' })
  })

  it('returns neither prefill for an empty or blank string', () => {
    // Spreading {} leaves both props undefined, so the dialog opens blank
    // rather than with an empty-string name.
    expect(splitCreateAccountPrefill('')).toEqual({})
    expect(splitCreateAccountPrefill('   ')).toEqual({})
  })
})
