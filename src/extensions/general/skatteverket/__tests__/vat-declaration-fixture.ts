/**
 * VatDeclaration fixtures for the filing-path tests. Every path that sends a
 * declaration to Skatteverket runs vatFilingVerdict over the declaration
 * buildMomsuppgift returns, so a buildMomsuppgift double has to carry one.
 */
import type { VatDeclaration, VatDeclarationRutor } from '@/types'

const ZERO_RUTOR = Object.fromEntries(
  ['05', '06', '07', '08', '10', '11', '12', '20', '21', '22', '23', '24', '30', '31', '32',
    '35', '36', '37', '38', '39', '40', '41', '42', '48', '49', '50', '60', '61', '62']
    .map((n) => [`ruta${n}`, 0]),
) as unknown as VatDeclarationRutor

export function vatDeclarationFixture(
  rutor: Partial<VatDeclarationRutor>,
  options: { rc2645?: number; period?: VatDeclaration['period'] } = {},
): VatDeclaration {
  return {
    period: options.period ?? { type: 'monthly', year: 2026, period: 6, start: '2026-06-01', end: '2026-06-30' },
    rutor: { ...ZERO_RUTOR, ...rutor },
    rcInputAccountTotals: { '2645': { debit: options.rc2645 ?? 0, credit: 0 }, '2647': { debit: 0, credit: 0 } },
    rcBasisByRate: { r25: 0, r12: 0, r6: 0 },
    revenueAccountsWithoutRuta: [],
    invoiceCount: 0,
    transactionCount: 0,
    breakdown: {} as VatDeclaration['breakdown'],
  }
}

/** A domestic 25 % sale: complete, nothing for the completeness gate to find. */
export const COMPLETE_VAT_DECLARATION = vatDeclarationFixture({ ruta05: 600, ruta10: 150, ruta49: 150 })

/** Fiktiv moms on 2614 (ruta 30) with no basbelopp in rutor 20-24: FK004, blocked. */
export const INCOMPLETE_VAT_DECLARATION = vatDeclarationFixture({ ruta30: 250, ruta48: 250, ruta49: 0 }, { rc2645: 250 })
