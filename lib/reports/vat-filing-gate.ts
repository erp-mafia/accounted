import type {
  VatDeclarationCheck,
  VatCheckAccountTotals,
} from './vat-declaration-checks'
import { roundOre } from '@/lib/money'
import type { VatDeclarationRutor } from '@/types'

/**
 * The filing gate for the momsdeklaration: ONE derived value that the
 * "Kontroll av underlaget" banner, the stegen counters and the "Skicka till
 * Skatteverket" button all read.
 *
 * Why this exists: `runVatDeclarationChecks` compares PERIOD TOTALS with a
 * tolerance, while `/api/reports/vat-declaration/rc-basis-gaps` scans PER
 * VERIFIKAT with no tolerance. The two disagree by design:
 *
 * - the RC tolerance scales with period size (0.5% of the implied basis), so
 *   a handful of vouchers can each miss their basbelopp while the period
 *   shortfall still lands inside it. At a 400 000 kr basis that hides up to
 *   2 000 kr of missing underlag.
 * - a partly finished korrigering clears the aggregate long before the last
 *   broken voucher is fixed (the worklist itself documents this).
 *
 * Before this helper the banner and the send gate read the aggregate only, so
 * the UI could render "Inga fel hittades i underlaget för perioden" directly
 * above a worklist of the very verifikationer that make the declaration
 * wrong, with Skicka enabled.
 *
 * The per-voucher scan is authoritative here WHEN the aggregate identity is
 * also broken: every gap it returns is a verifikat with fiktiv moms on
 * 2614/2624/2634 and no matching basbelopp on 44xx/45xx in that same
 * verifikat. Vid omvänd skattskyldighet ska köparen redovisa BÅDE
 * beskattningsunderlaget (ruta 20-24) och den fiktiva momsen (ruta 30-32);
 * tyst kvittning är inte tillåten, och Skatteverkets gateway avvisar den
 * obalansen med felkod FK004. So when the period totals are ALSO short, the
 * scan blocks filing exactly like the aggregate ERROR it stands in for.
 *
 * When the period's basis/moms identity holds PER MOMSSATS (see
 * rcBasisPerRateConsistent), the same gaps downgrade to a WARNING: a
 * moms-only rattelseverifikat legitimately carries fiktiv moms whose
 * basbelopp lives in another verifikat, and with the per-rate identity intact
 * the flagged vouchers cannot be under-reporting either the basis boxes or
 * the moms boxes. Blocking on them was an unfixable dead end: the correction
 * voucher that repairs the period joins the blocklist it was meant to clear
 * (see rcBasisGapAdvisoryFinding for the full argument).
 *
 * The evidence is deliberately PER RATE and taken from the 44xx/45xx account
 * totals, not from the rutor: rutor 20-24 are partitioned by purchase type
 * (EU goods / EU services / non-EU / domestic RC), not by rate, so a
 * cross-rate sum over them certifies nothing about rutor 30-32. A /skeptic
 * pass refuted the first cross-rate version of this predicate with a
 * wrong-rate fiktiv moms voucher (12% moms "covered" by a 25% basis, 7 800 kr
 * under-declared) and with a net-negative rate box that made the summed
 * comparison vacuous. Both are impossible per rate: the basis accounts are
 * rate-specific (4515 vs 4516 vs 4517, and so on), so each ruta 30/31/32 is
 * checked against exactly the basis booked at its own sats, two-sided, with
 * öre epsilon only. A shortfall the aggregate 0.5% tolerance absorbs still
 * blocks here, which is the exact hole this module was built to close.
 *
 * Blocking, not advisory, is safe here because the block is not a dead end:
 * the one-click Korrigera worklist sits on the same page directly under the
 * finding, and the manual filing route (eSKD-XML and PDF in
 * VatManualFilingCard) is deliberately left ungated, so a user who disagrees
 * with the finding can still file. Only the direct SKV submission is gated.
 *
 * This module owns only the gate. The 0.5% tolerance itself belongs to
 * vat-declaration-checks.ts and is deliberately untouched here.
 */

/**
 * What the per-verifikat scan currently knows.
 *
 * `pending` and `unavailable` are kept apart on purpose: neither is "inga
 * brister", but only a settled failure is worth telling the user about. An
 * in-flight scan says nothing; a failed one must not be allowed to pass as an
 * all-clear.
 */
export type RcBasisGapScan =
  | { status: 'pending' }
  | { status: 'unavailable' }
  | { status: 'scanned'; gapCount: number }

/**
 * The reverse-charge basis accounts grouped by momssats. One column per rate
 * across the five purchase-type families (EU goods, EU services, non-EU
 * services, domestic goods RC, domestic services RC). This is the single
 * source for the per-rate downgrade evidence, and rc-basis-gaps.ts derives
 * its flat account set from it, so the scan and the evidence can never
 * disagree about which accounts carry RC basis.
 */
export const RC_BASIS_ACCOUNTS_BY_RATE = {
  r25: ['4515', '4535', '4531', '4415', '4425'],
  r12: ['4516', '4536', '4532', '4416', '4426'],
  r6: ['4517', '4537', '4533', '4417', '4427'],
} as const

/** Net debit balance of the RC basis accounts, one figure per momssats. */
export interface RcBasisTotalsByRate {
  r25: number
  r12: number
  r6: number
}

/**
 * Project the per-rate RC basis balances out of a per-account totals map
 * (the `VatAccountTotals.totals` shape `fetchVatAccountTotals()` returns).
 * Debit minus credit, like every basis box: a credit-heavy rate (a period
 * dominated by credit notes) legitimately comes out negative.
 */
export function rcBasisTotalsByRate(
  totals: VatCheckAccountTotals,
  dynamic?: { explicitAccounts: Set<string>; rcBasisRateByAccount: Map<string, number> },
): RcBasisTotalsByRate {
  const sumGroup = (accounts: readonly string[]): number => {
    let sum = 0
    for (const account of accounts) {
      if (dynamic?.explicitAccounts.has(account)) continue
      const t = totals.get(account)
      if (t) sum += t.debit - t.credit
    }
    return Math.round(sum * 100) / 100
  }
  const result = {
    r25: sumGroup(RC_BASIS_ACCOUNTS_BY_RATE.r25),
    r12: sumGroup(RC_BASIS_ACCOUNTS_BY_RATE.r12),
    r6: sumGroup(RC_BASIS_ACCOUNTS_BY_RATE.r6),
  }
  for (const [account, rate] of dynamic?.rcBasisRateByAccount ?? []) {
    const total = totals.get(account)
    if (!total) continue
    const key = rate === 0.25 ? 'r25' : rate === 0.12 ? 'r12' : 'r6'
    result[key] = roundOre(result[key] + total.debit - total.credit)
  }
  return result
}

/**
 * Everything the downgrade decision needs. Both halves come from the same
 * declaration calculation, so they describe the same ledger state: `rutor`
 * carries the moms boxes 30-32, `rcBasisByRate` the per-sats basis balances
 * the rutor cannot express. Callers that cannot supply this (an older wire
 * payload, a totals-less context) simply omit it and keep the blocking
 * behavior.
 */
export interface RcGapDowngradeEvidence {
  rutor: VatDeclarationRutor
  rcBasisByRate: RcBasisTotalsByRate
}

/**
 * The WARNING-tier variant of the per-voucher gap finding, used when the
 * period's per-rate basis/moms identity holds (see rcBasisPerRateConsistent).
 *
 * Why it exists: the per-voucher scan assumes every posted verifikat with
 * fiktiv moms (2614/2624/2634 credit) carries its own basbelopp. A legitimate
 * moms-only rattelseverifikat breaks that assumption by construction: its
 * basbelopp already lives in another verifikat (often a reversed one the scan
 * never sees), and there is provably NO arrangement of vouchers that satisfies
 * both the per-voucher scan and the aggregate basis/moms identity once, say, a
 * refund's basis reduction sits in reversed history. Blocking on that made the
 * red state unfixable: every correction the user (or support) booked joined
 * the blocklist it was meant to clear. (First hit in production 2026-08:
 * a 323 kr refund correction chain left a company permanently blocked.)
 *
 * So when the basis booked at each momssats matches the fiktiv moms declared
 * at that sats, the per-voucher list stays visible as a worklist (same
 * RC_BASIS_MISSING code) but stops gating "Skicka": at that point the flagged
 * vouchers are corrections whose basis is elsewhere in the period at the same
 * sats, and the declaration is not under-reporting. With any per-rate
 * mismatch the ERROR tier still applies.
 */
export function rcBasisGapAdvisoryFinding(gapCount: number): VatDeclarationCheck {
  const subject = gapCount === 1 ? '1 verifikation' : `${gapCount} verifikationer`
  return {
    code: 'RC_BASIS_MISSING',
    status: 'WARNING',
    message:
      `${subject} i perioden har fiktiv moms (2614/2624/2634) utan eget basbelopp ` +
      'på 44xx/45xx. Periodens underlag stämmer dock per momssats: basbeloppen ' +
      'på 44xx/45xx motsvarar den fiktiva momsen i ruta 30-32, så detta är ' +
      'normalt rättelseverifikat vars basbelopp redan finns i ett annat ' +
      'verifikat. Kontrollera listan nedan; är raderna rättelser behöver du ' +
      'inte göra något och kan lämna in som vanligt.',
    rutor: ['ruta20', 'ruta21', 'ruta22', 'ruta23', 'ruta24', 'ruta30', 'ruta31', 'ruta32'],
  }
}

/**
 * The synthetic finding that makes per-voucher gaps visible to the gate.
 *
 * It reuses the `RC_BASIS_MISSING` code on purpose: it is the same defect the
 * aggregate check describes, only detected per verifikat, and the worklist in
 * VatChecksCard keys its own visibility off that code.
 */
export function rcBasisGapFinding(gapCount: number): VatDeclarationCheck {
  const subject = gapCount === 1 ? '1 verifikation' : `${gapCount} verifikationer`
  const remedy =
    gapCount === 1
      ? 'Korrigera verifikationen i listan nedan innan du lämnar in.'
      : 'Korrigera verifikationerna i listan nedan innan du lämnar in.'
  return {
    code: 'RC_BASIS_MISSING',
    status: 'ERROR',
    message:
      `${subject} i perioden har fiktiv moms (2614/2624/2634) utan basbelopp ` +
      'på 44xx/45xx, så ruta 20-24 är för låga. Vid omvänd skattskyldighet ska ' +
      'både beskattningsunderlaget (ruta 20-24) och den fiktiva momsen ' +
      `(ruta 30-32) redovisas; Skatteverket avvisar annars med felkod FK004. ${remedy}`,
    rutor: ['ruta20', 'ruta21', 'ruta22', 'ruta23', 'ruta24', 'ruta30', 'ruta31', 'ruta32'],
  }
}

/**
 * Shown when the per-verifikat scan could not run. A WARNING, not an ERROR: a
 * network hiccup must not lock a user out of a statutory filing deadline, and
 * there is nothing for them to correct. But it must exist, because an empty
 * check list renders as "Inga fel hittades i underlaget för perioden", and
 * that is a claim we have not earned when the scan never answered.
 */
export function rcBasisScanUnavailableFinding(): VatDeclarationCheck {
  return {
    code: 'RC_BASIS_MISSING',
    status: 'WARNING',
    message:
      'Kontrollen av enskilda verifikationer kunde inte köras, så vi vet inte ' +
      'om någon verifikation har fiktiv moms (2614/2624/2634) utan basbelopp ' +
      'på 44xx/45xx. Ladda om sidan för att försöka igen. Om listan nedan ' +
      'innehåller verifikationer ska de korrigeras innan du lämnar in.',
    rutor: ['ruta20', 'ruta21', 'ruta22', 'ruta23', 'ruta24', 'ruta30', 'ruta31', 'ruta32'],
  }
}

/**
 * Fold the per-verifikat scan into the check list the UI renders and gates on.
 * Everything downstream (banner, stegen counters, Skicka) reads the returned
 * array, so there is one list and no second opinion.
 */
export function withRcBasisGapFindings(
  checks: VatDeclarationCheck[],
  scan: RcBasisGapScan,
  evidence?: RcGapDowngradeEvidence,
): VatDeclarationCheck[] {
  // The aggregate check already says this, and already blocks; don't say it
  // twice, and don't stack a "could not check" note on top of a live finding.
  if (checks.some((c) => c.code === 'RC_BASIS_MISSING')) return checks
  if (scan.status === 'pending') return checks
  if (scan.status === 'unavailable') return [...checks, rcBasisScanUnavailableFinding()]
  if (scan.gapCount <= 0) return checks
  // Tier the finding by the per-rate identity (see rcBasisPerRateConsistent).
  // RC_OUTPUT_MISSING in the list refuses the downgrade outright: that ERROR
  // asserts the period totals are broken, and an advisory beside it claiming
  // they hold would contradict it in the same card. Mathematically the
  // per-rate identity nearly excludes it anyway (three rates at öre epsilon
  // leave at most 1.5 kr of surplus, inside the aggregate tolerance), so this
  // guard is belt and braces, not a second predicate. Callers that cannot
  // supply evidence keep the blocking behavior unchanged.
  const aggregateSurplusError = checks.some((c) => c.code === 'RC_OUTPUT_MISSING')
  return [
    ...checks,
    evidence && !aggregateSurplusError && rcBasisPerRateConsistent(evidence)
      ? rcBasisGapAdvisoryFinding(scan.gapCount)
      : rcBasisGapFinding(scan.gapCount),
  ]
}

/**
 * True when, FOR EACH momssats separately, the RC basis booked at that rate
 * matches the fiktiv moms declared at that rate (basbelopp = moms / sats),
 * two-sided within an öre epsilon, and no moms box is negative.
 *
 * Under this condition a per-voucher basis gap cannot mean the declaration is
 * under-reporting: the gap voucher's missing in-voucher basis provably exists
 * elsewhere in the period AT THE SAME SATS, so both the basis boxes and the
 * moms boxes are exactly what the ledger supports. Two-sided on purpose: a
 * surplus at one rate is not allowed to vouch for a shortfall at another, and
 * a surplus at the SAME rate means fiktiv moms is missing for some voucher
 * (the RC_OUTPUT_MISSING defect), which a downgrade must not paper over.
 *
 * The negative-box guard closes the vacuity hole: a net-negative rate
 * (credit notes exceeding purchases) made the refuted summed comparison
 * trivially true while rutor 20-24 could be arbitrarily wrong. Any negative
 * moms box refuses the downgrade outright, even a per-rate-consistent one:
 * SKV rejects negative rutor anyway, so such a period needs human attention
 * regardless, and failing toward the blocking ERROR is the safe direction.
 */
function rcBasisPerRateConsistent(evidence: RcGapDowngradeEvidence): boolean {
  const { rutor, rcBasisByRate } = evidence
  const eps = 0.5
  const pairs: Array<[number, number, number]> = [
    [rcBasisByRate.r25, rutor.ruta30, 0.25],
    [rcBasisByRate.r12, rutor.ruta31, 0.12],
    [rcBasisByRate.r6, rutor.ruta32, 0.06],
  ]
  for (const [basis, moms, rate] of pairs) {
    // The evidence can arrive as unvalidated JSON (the web view reads it off
    // the declaration response). A missing or non-numeric field would make
    // every comparison below false-and-passing (NaN compares false to
    // everything), silently relaxing a statutory filing gate. Non-finite
    // input therefore refuses the downgrade outright: this predicate must
    // only ever fail toward the blocking ERROR.
    if (!Number.isFinite(basis) || !Number.isFinite(moms)) return false
    if (moms < -eps) return false
    if (Math.abs(basis - moms / rate) > eps) return false
  }
  return true
}

/**
 * The single send gate. Everything that claims "all clear" or enables filing
 * must read this over the SAME array, or the two will drift apart again.
 */
export function isFilingBlocked(checks: VatDeclarationCheck[]): boolean {
  return checks.some((c) => c.status === 'ERROR')
}
