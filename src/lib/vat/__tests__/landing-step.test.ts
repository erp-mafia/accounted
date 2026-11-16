import { describe, expect, it } from 'vitest'
import type { VatDeclarationRutor } from '@/types'
import { isNilVatDeclaration, vatLandingStep } from '../landing-step'

const rutor = (over: Partial<VatDeclarationRutor> = {}): VatDeclarationRutor =>
  ({ ruta05: 0, ruta10: 0, ruta48: 0, ruta49: 0, ...over }) as VatDeclarationRutor

describe('vatLandingStep: which step the moms page opens on', () => {
  it('opens on Granska when the period has amounts and no check blocks', () => {
    expect(vatLandingStep({ checksBlocked: false, rutor: rutor({ ruta05: 1000, ruta10: 250, ruta49: 250 }) })).toBe(2)
  })

  it('opens on Kontrollera when a check blocks filing', () => {
    expect(vatLandingStep({ checksBlocked: true, rutor: rutor({ ruta05: 1000, ruta10: 250, ruta49: 250 }) })).toBe(1)
  })

  it('opens on Kontrollera when no ruta has an amount', () => {
    expect(vatLandingStep({ checksBlocked: false, rutor: rutor() })).toBe(1)
  })

  it('a period whose in and out cancel to 0 kr in ruta 49 still has amounts to review', () => {
    const cancelling = rutor({ ruta05: 1000, ruta10: 250, ruta48: 250, ruta49: 0 })
    expect(isNilVatDeclaration(cancelling)).toBe(false)
    expect(vatLandingStep({ checksBlocked: false, rutor: cancelling })).toBe(2)
  })

  it('a negative amount (moms att återfå) is an amount', () => {
    expect(isNilVatDeclaration(rutor({ ruta48: 100, ruta49: -100 }))).toBe(false)
  })
})
