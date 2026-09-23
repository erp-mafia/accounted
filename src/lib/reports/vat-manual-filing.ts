import { VAT_RUTA_LABELS, type VatDeclarationRutor } from '@/types'

export interface ManualFilingRow {
  /** Two-digit ruta number, e.g. '05', '10', '49'. */
  ruta: string
  label: string
  /**
   * Amount in whole kronor (hela kronor), as filed. For ruta 49 (the net) this
   * is the absolute value; the direction is carried by the label.
   */
  amount: number
  /** True only for the ruta 49 net row (Moms att betala / återfå). */
  isNet?: boolean
}

// The output-VAT rutor that sum into ruta 49 per the SKV 4700 formula
// (swedish-vat reference, Section G): (10+11+12+30+31+32+60+61+62) - 48 = 49.
const OUTPUT_VAT_RUTOR: (keyof VatDeclarationRutor)[] = [
  'ruta10', 'ruta11', 'ruta12',
  'ruta30', 'ruta31', 'ruta32',
  'ruta60', 'ruta61', 'ruta62',
]

/**
 * The rutor exactly as they are filed at Skatteverket: every ruta truncated to
 * a whole krona (öretal faller bort per SFL 22 kap 1 §: dropped, not rounded to
 * nearest) and the ruta 49 net recomputed from those truncated output/input
 * rutor rather than from the pre-computed öre value, so the arithmetic ties out
 * exactly to what is filed. This is NOT bookkeeping math (nothing here is
 * posted), so the öre-precision money rule (Math.round(x*100)/100) does not
 * apply; it mirrors the SRU income-tax path, which drops öre under the same
 * statute.
 *
 * This is the single source of truth for the whole-krona amounts shared by the
 * manual-filing PDF (buildManualFilingRows) and the eSKD XML file
 * (lib/reports/vat-eskd-file.ts), so the two can never disagree.
 */
export function buildFiledAmounts(rutor: VatDeclarationRutor): {
  /** Every ruta truncated to whole kronor. ruta49 carries its sign (negative = återfå). */
  amounts: Record<keyof VatDeclarationRutor, number>
  /** The recomputed ruta 49 net, signed: positive = att betala, negative = att återfå. */
  net: number
} {
  // Truncate toward zero: öretal faller bort (SFL 22 kap 1 §), never round up.
  const kr = (key: keyof VatDeclarationRutor): number => Math.trunc(rutor[key] ?? 0)

  const outputVat = OUTPUT_VAT_RUTOR.reduce((sum, key) => sum + kr(key), 0)
  const net = outputVat - kr('ruta48')

  const amounts = {} as Record<keyof VatDeclarationRutor, number>
  for (const key of Object.keys(VAT_RUTA_LABELS) as (keyof VatDeclarationRutor)[]) {
    amounts[key] = kr(key)
  }
  // ruta49 is the recomputed net, not the source öre value.
  amounts.ruta49 = net

  return { amounts, net }
}

/**
 * Builds the momsdeklaration rows for manual filing at skatteverket.se, in
 * hela kronor.
 *
 * Skatteverket files whole kronor with no öre, so each ruta is truncated to a
 * whole krona (öretal faller bort per SFL 22 kap 1 §: the öre are dropped, not
 * rounded to nearest) and ruta 49 (the net) is recomputed from the truncated
 * output/input rutor, not from the pre-computed öre value, so the document's
 * arithmetic ties out exactly to what the user types into the form. This
 * whole-krona truncation is intentional and specific to the filing document; it
 * is NOT bookkeeping math (nothing here is posted), so the usual öre-precision
 * money rule (Math.round(x*100)/100) does not apply. It also matches the SRU
 * income-tax filing path, which drops öre under the same statute.
 *
 * Only populated rutor are included, plus ruta 48 and the ruta 49 net (always),
 * so a manual filer sees every box that needs a value and nothing that doesn't.
 * Ruta 49 is always rendered last, mirroring its position on the SKV 4700 form.
 *
 * Swedish-only by design: these are Skatteverket form labels (VAT_RUTA_LABELS),
 * which stay Swedish in both locales.
 */
export function buildManualFilingRows(rutor: VatDeclarationRutor): ManualFilingRow[] {
  const { amounts, net } = buildFiledAmounts(rutor)

  // Every ruta except 49, in ascending form order; 49 is appended last below.
  const keys = (Object.keys(VAT_RUTA_LABELS) as (keyof VatDeclarationRutor)[])
    .filter((key) => key !== 'ruta49')
    .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))

  const rows: ManualFilingRow[] = []
  for (const key of keys) {
    const amount = amounts[key]
    // Always surface ruta 48 (deductible input VAT); otherwise only populated
    // rutor so the reference stays short.
    if (key !== 'ruta48' && amount === 0) continue
    rows.push({ ruta: key.slice(4), label: VAT_RUTA_LABELS[key], amount })
  }

  rows.push({
    ruta: '49',
    label: net >= 0 ? 'Moms att betala' : 'Moms att återfå',
    amount: Math.abs(net),
    isNet: true,
  })

  return rows
}
