/**
 * vatFilingVerdict: the "Kontroll av underlaget" gate on the server, the
 * verdict every path that sends a momsdeklaration to Skatteverket refuses on.
 * It must be the gate the web UI computes (VatDeclarationView: the shared
 * checks over the declaration, folded through withRcBasisGapFindings with the
 * per-verifikat scan, then isFilingBlocked), so the browser and the server
 * cannot disagree on whether a declaration may be sent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFindRcBasisGaps = vi.fn()
vi.mock('@/lib/reports/rc-basis-gaps', () => ({
  findRcBasisGaps: (...a: unknown[]) => mockFindRcBasisGaps(...a),
}))

import { vatFilingVerdict } from '../vat-close-check'
import { rcInputTotalsFromDeclaration } from '../vat-declaration'
import { runVatDeclarationChecks } from '../vat-declaration-checks'
import { isFilingBlocked, withRcBasisGapFindings } from '../vat-filing-gate'
import type { VatDeclaration, VatDeclarationRutor } from '@/types'

const ZERO_RUTOR: VatDeclarationRutor = {
  ruta05: 0, ruta06: 0, ruta07: 0, ruta08: 0,
  ruta10: 0, ruta11: 0, ruta12: 0,
  ruta20: 0, ruta21: 0, ruta22: 0, ruta23: 0, ruta24: 0,
  ruta30: 0, ruta31: 0, ruta32: 0,
  ruta35: 0, ruta36: 0, ruta37: 0, ruta38: 0,
  ruta39: 0, ruta40: 0, ruta41: 0, ruta42: 0,
  ruta48: 0, ruta49: 0,
  ruta50: 0, ruta60: 0, ruta61: 0, ruta62: 0,
}

function declaration(rutor: Partial<VatDeclarationRutor>, extra: Partial<VatDeclaration> = {}): VatDeclaration {
  return {
    period: { type: 'quarterly', year: 2026, period: 2, start: '2026-04-01', end: '2026-06-30' },
    rutor: { ...ZERO_RUTOR, ...rutor },
    rcInputAccountTotals: { '2645': { debit: 0, credit: 0 }, '2647': { debit: 0, credit: 0 } },
    rcBasisByRate: { r25: 0, r12: 0, r6: 0 },
    revenueAccountsWithoutRuta: [],
    invoiceCount: 0,
    transactionCount: 0,
    breakdown: {} as VatDeclaration['breakdown'],
    ...extra,
  }
}

// Fiktiv moms 25 % on 2614 (ruta 30) and its deduction on 2645, but no
// basbelopp in rutor 20-24: the FK004 shape Skatteverket rejects.
const FK004 = declaration(
  { ruta30: 250, ruta48: 250, ruta49: 0 },
  { rcInputAccountTotals: { '2645': { debit: 250, credit: 0 }, '2647': { debit: 0, credit: 0 } } },
)

const COMPLETE = declaration(
  { ruta05: 1000, ruta10: 250, ruta21: 1000, ruta30: 250, ruta48: 250, ruta49: 250 },
  {
    rcInputAccountTotals: { '2645': { debit: 250, credit: 0 }, '2647': { debit: 0, credit: 0 } },
    rcBasisByRate: { r25: 1000, r12: 0, r6: 0 },
  },
)

beforeEach(() => {
  vi.clearAllMocks()
  mockFindRcBasisGaps.mockResolvedValue([])
})

describe('vatFilingVerdict', () => {
  it('blocks a declaration with fiktiv moms and no basbelopp (FK004)', async () => {
    const verdict = await vatFilingVerdict({} as never, 'company-1', FK004)

    expect(verdict.blocked).toBe(true)
    expect(verdict.checks).toContainEqual(expect.objectContaining({ code: 'RC_BASIS_MISSING', status: 'ERROR' }))
  })

  it('lets a complete declaration through', async () => {
    const verdict = await vatFilingVerdict({} as never, 'company-1', COMPLETE)

    expect(verdict).toEqual({ checks: [], blocked: false, gaps: [] })
  })

  it('hands back the scanned gaps for review fingerprints, and null when the scan failed', async () => {
    const gaps = [{ entryId: 'je-1', rcOutputAccount: '2614', rcOutputAmount: 25, missingBasisAmount: 100 }]
    mockFindRcBasisGaps.mockResolvedValueOnce(gaps)
    expect((await vatFilingVerdict({} as never, 'company-1', COMPLETE)).gaps).toEqual(gaps)
    mockFindRcBasisGaps.mockRejectedValueOnce(new Error('db down'))
    expect((await vatFilingVerdict({} as never, 'company-1', COMPLETE)).gaps).toBeNull()
  })

  it('blocks on per-verifikat gaps when the period identity is also broken', async () => {
    mockFindRcBasisGaps.mockResolvedValueOnce([{ journal_entry_id: 'je-1' }, { journal_entry_id: 'je-2' }])
    const verdict = await vatFilingVerdict({} as never, 'company-1', FK004)

    expect(verdict.blocked).toBe(true)
  })

  it('turns a failed per-verifikat scan into a WARNING, not a pass and not a block', async () => {
    mockFindRcBasisGaps.mockRejectedValueOnce(new Error('db down'))
    const verdict = await vatFilingVerdict({} as never, 'company-1', COMPLETE)

    expect(verdict.blocked).toBe(false)
    expect(verdict.checks).toEqual([expect.objectContaining({ status: 'WARNING' })])
  })

  it('scans the period the declaration covers, the räkenskapsår included', async () => {
    await vatFilingVerdict({} as never, 'company-1', COMPLETE, { fiscalPeriodId: 'fp-1' })

    expect(mockFindRcBasisGaps).toHaveBeenCalledWith({}, 'company-1', 'quarterly', 2026, 2, { fiscalPeriodId: 'fp-1' })
  })

  it('is the verdict the web UI computes over the same declaration', async () => {
    for (const [decl, gaps] of [[FK004, 0], [COMPLETE, 0], [COMPLETE, 3], [FK004, 2]] as const) {
      mockFindRcBasisGaps.mockResolvedValueOnce(Array.from({ length: gaps }, (_, i) => ({ journal_entry_id: `je-${i}` })))
      const verdict = await vatFilingVerdict({} as never, 'company-1', decl)
      // VatDeclarationView.tsx, verbatim composition.
      const uiChecks = withRcBasisGapFindings(
        runVatDeclarationChecks(decl.rutor, rcInputTotalsFromDeclaration(decl), {
          revenueAccountsWithoutRuta: decl.revenueAccountsWithoutRuta,
        }),
        { status: 'scanned', gapCount: gaps },
        decl.rcBasisByRate ? { rutor: decl.rutor, rcBasisByRate: decl.rcBasisByRate } : undefined,
      )
      expect(verdict.checks).toEqual(uiChecks)
      expect(verdict.blocked).toBe(isFilingBlocked(uiChecks))
    }
  })
})
