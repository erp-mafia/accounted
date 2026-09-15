import { roundOre } from '@/lib/money'

/**
 * Kommunal fastighetsavgift and statlig fastighetsskatt for a
 * bostadsrättsförening (flerbostadshus / hyreshus).
 *
 * - Bostadsdelen: kommunal fastighetsavgift (lag 2007:1398), per
 *   bostadslägenhet with a cap ("takbelopp") indexed each year, but never
 *   more than 0,3 % of the taxeringsvärde of bostadsbyggnaden and tomtmarken
 *   (3 § 3 st.). Skatteverket ("Fastighetsavgift och fastighetsskatt",
 *   inkomstår 2026): 1 784 kr, 2025: 1 724 kr, 2024: 1 630 kr per
 *   bostadslägenhet.
 * - Lokaldelen: statlig fastighetsskatt (lag 1984:1052) 1,0 % of the
 *   taxeringsvärde of lokaler in hyreshus (3 § 1 st. d).
 * - Nybyggda bostäder (lag 2007:1398 6 §): a byggnad with värdeår 2012 or
 *   later pays no fastighetsavgift for the 15 years after the värdeår;
 *   värdeår 2011 or earlier gets five years without avgift and five years
 *   with half (SKV 378 "Nybyggda hus", SKV 296).
 * - The fee is assessed per calendar year on the owner at the start of the
 *   year (lag 2007:1398 2 §) and is never prorated for a brutet or shortened
 *   räkenskapsår (SKV 378, "Brutet räkenskapsår"). The underlag is
 *   pre-filled on INK2 page 1 (1.9 hyreshus bostäder hel/halv avgift, 1.11
 *   hyreshus lokaler); for a privatbostadsföretag the cost belongs to the
 *   property block and is not deductible (IL 39 kap. 25 §), for an oäkta
 *   förening it is an ordinary deductible cost.
 *
 * The calculator is pure: the caller passes the facts, the function returns
 * the computation with the caps it applied and the statute for each step.
 * Amounts in whole kronor as on the form.
 */

/** Takbelopp per bostadslägenhet in flerbostadshus by income year (Skatteverket). */
export const FASTIGHETSAVGIFT_CAP_PER_LAGENHET: Readonly<Record<number, number>> = {
  2024: 1_630,
  2025: 1_724,
  2026: 1_784,
}

/** 0,3 % of the taxeringsvärde of the bostadsdel (lag 2007:1398 3 § 3 st.). */
export const FASTIGHETSAVGIFT_PERCENT_CAP = 0.003
/** 1,0 % of the taxeringsvärde of lokaler in hyreshus (lag 1984:1052 3 §). */
export const FASTIGHETSSKATT_LOKALER_RATE = 0.01
/** Värdeår from which the 15-year full exemption applies (lag 2007:1398 6 §, 2013 change). */
export const NYBYGGNAD_FULL_EXEMPTION_FROM_VARDEAR = 2012

export const FASTIGHETSAVGIFT_BOOKING_TEMPLATE_ID = 'brf_fastighetsavgift'

export interface FastighetsavgiftInput {
  /** Calendar year the fee is charged for. */
  incomeYear: number
  antalBostadslagenheter: number | null
  /** Taxeringsvärde of bostadsbyggnad and tomtmark, whole kronor. */
  taxeringsvardeBostader: number | null
  /** Taxeringsvärde of lokaler, whole kronor. */
  taxeringsvardeLokaler: number | null
  /** Värdeår of the building; null when unknown (no nybyggnad reduction applied). */
  vardear: number | null
}

export type NybyggnadReduction = 'none' | 'full' | 'half'

export interface FastighetsavgiftComputation {
  incomeYear: number
  bostader: {
    antalLagenheter: number | null
    capPerLagenhet: number | null
    /** antal × takbelopp */
    capTotal: number | null
    /** 0,3 % × taxeringsvärde bostäder */
    percentCap: number | null
    /** The lower of the two caps before any nybyggnad reduction. */
    beforeReduction: number | null
    reduction: NybyggnadReduction
    /** Amount payable, whole kronor; null when an input is missing. */
    amount: number | null
    /** INK2 1.9 "Hyreshus, bostäder": which box the underlag belongs in. */
    ink2Field: '1.9 hel avgift' | '1.9 halv avgift' | '1.9 (befriad)' | null
  }
  lokaler: {
    taxeringsvarde: number | null
    rate: number
    amount: number | null
    ink2Field: '1.11'
  }
  /** Sum of the two; null when either side is unknown. */
  total: number | null
  bookingTemplateId: typeof FASTIGHETSAVGIFT_BOOKING_TEMPLATE_ID
  statuteBasis: string[]
  warnings: string[]
}

function capForYear(incomeYear: number): number | null {
  return FASTIGHETSAVGIFT_CAP_PER_LAGENHET[incomeYear] ?? null
}

/**
 * Nybyggnad reduction for the income year (lag 2007:1398 6 §): years are
 * counted from the year after the värdeår.
 */
export function nybyggnadReduction(incomeYear: number, vardear: number | null): NybyggnadReduction {
  if (vardear === null || !Number.isInteger(vardear)) return 'none'
  const yearsSince = incomeYear - vardear
  if (yearsSince < 1) return 'none'
  if (vardear >= NYBYGGNAD_FULL_EXEMPTION_FROM_VARDEAR) {
    return yearsSince <= 15 ? 'full' : 'none'
  }
  if (yearsSince <= 5) return 'full'
  if (yearsSince <= 10) return 'half'
  return 'none'
}

export function computeFastighetsavgift(input: FastighetsavgiftInput): FastighetsavgiftComputation {
  const warnings: string[] = []
  const statuteBasis = [
    'Lag (2007:1398) om kommunal fastighetsavgift 3 §: avgift per bostadslägenhet i hyreshus, dock högst 0,3 % av taxeringsvärdet för bostadsdelen.',
    'Lag (1984:1052) om statlig fastighetsskatt 3 §: 1,0 % av taxeringsvärdet för lokaler i hyreshus.',
    'Lag (2007:1398) 2 §: avgiften tas ut per kalenderår av den som äger fastigheten vid årets ingång; ingen jämkning för brutet eller förkortat räkenskapsår.',
  ]

  const capPerLagenhet = capForYear(input.incomeYear)
  if (capPerLagenhet === null) {
    warnings.push(
      `Takbeloppet per bostadslägenhet för inkomståret ${input.incomeYear} finns inte i tabellen (kända år: ${Object.keys(FASTIGHETSAVGIFT_CAP_PER_LAGENHET).join(', ')}). Kontrollera beloppet hos Skatteverket.`,
    )
  }

  const antal = input.antalBostadslagenheter
  const tvBostader = input.taxeringsvardeBostader
  if (antal === null) warnings.push('Antal bostadslägenheter saknas i fastighetsuppgifterna.')
  if (tvBostader === null) warnings.push('Taxeringsvärde för bostadsdelen saknas i fastighetsuppgifterna.')

  const capTotal = antal !== null && capPerLagenhet !== null ? antal * capPerLagenhet : null
  const percentCap = tvBostader !== null ? Math.floor(tvBostader * FASTIGHETSAVGIFT_PERCENT_CAP) : null
  const beforeReduction =
    capTotal !== null && percentCap !== null ? Math.min(capTotal, percentCap) : null

  const reduction = nybyggnadReduction(input.incomeYear, input.vardear)
  if (input.vardear === null) {
    warnings.push(
      'Värdeår saknas: ingen nedsättning för nybyggnad har beräknats (lag 2007:1398 6 §). Ange värdeåret om byggnaden är nyare än 15 år.',
    )
  } else if (reduction !== 'none') {
    statuteBasis.push(
      'Lag (2007:1398) 6 §: nybyggda bostäder med värdeår 2012 eller senare är befriade från avgift i 15 år; värdeår 2011 eller tidigare ger fem avgiftsfria år och därefter halv avgift i fem år.',
    )
  }

  const bostaderAmount =
    beforeReduction === null
      ? null
      : reduction === 'full'
        ? 0
        : reduction === 'half'
          ? Math.floor(beforeReduction / 2)
          : beforeReduction

  const ink2Field: FastighetsavgiftComputation['bostader']['ink2Field'] =
    beforeReduction === null
      ? null
      : reduction === 'full'
        ? '1.9 (befriad)'
        : reduction === 'half'
          ? '1.9 halv avgift'
          : '1.9 hel avgift'

  const tvLokaler = input.taxeringsvardeLokaler
  const lokalerAmount = tvLokaler !== null ? Math.floor(tvLokaler * FASTIGHETSSKATT_LOKALER_RATE) : null
  if (tvLokaler === null) {
    warnings.push(
      'Taxeringsvärde för lokaler saknas: ange 0 om fastigheten saknar lokaler, annars beräknas ingen fastighetsskatt.',
    )
  }

  const total =
    bostaderAmount !== null && lokalerAmount !== null ? roundOre(bostaderAmount + lokalerAmount) : null

  return {
    incomeYear: input.incomeYear,
    bostader: {
      antalLagenheter: antal,
      capPerLagenhet,
      capTotal,
      percentCap,
      beforeReduction,
      reduction,
      amount: bostaderAmount,
      ink2Field,
    },
    lokaler: {
      taxeringsvarde: tvLokaler,
      rate: FASTIGHETSSKATT_LOKALER_RATE,
      amount: lokalerAmount,
      ink2Field: '1.11',
    },
    total,
    bookingTemplateId: FASTIGHETSAVGIFT_BOOKING_TEMPLATE_ID,
    statuteBasis,
    warnings,
  }
}
