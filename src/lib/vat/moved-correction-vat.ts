/**
 * The VAT advice for a rättelse whose storno moved out of a locked period.
 *
 * A verifikat whose own date is in a locked or closed year, or on or before
 * the company lock date, is corrected with a storno and a corrected
 * verifikat dated in the first open period (lib/core/bookkeeping/
 * storno-target.ts). In the books the VAT difference then lands in the
 * momsperiod of the correction's date, but the error belongs to the
 * original's period: moms reported in another period than the one it belongs
 * to is a period error with skattetillägg (SFL 49 kap. 13 §), and a voluntary
 * correction of the declaration (egen rättelse) is what keeps it away (SFL 49
 * kap. 10 §). So when the pair changes a VAT account (26xx), the person and
 * the agent are told which momsperiod the error belongs to, whether that
 * declaration is on record as filed, and that a filed one is corrected
 * instead.
 *
 * Advice, never a refusal: it rides the confirm-before-posting guard in the
 * app (code VAT_OF_MOVED_CORRECTION) and the staging preview and answer in
 * MCP and v1.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { VoucherWarning } from '@/lib/bookkeeping/voucher-plausibility'
import { roundOre } from '@/lib/money'
import { assertStornoTarget, type StornoTarget } from '@/lib/core/bookkeeping/storno-target'
import { isMomsAccount } from '@/lib/reports/vat-declaration'
import { previewVoucherVatDeclaration, type VoucherImpactLine } from './voucher-vat-impact'

/**
 * What the pair does to each VAT account (26xx): the corrected lines in, the
 * original's out, net debit minus credit, only the accounts that move. Pure.
 */
export function vatAccountChange(
  originalLines: readonly VoucherImpactLine[],
  correctedLines: readonly VoucherImpactLine[],
): Record<string, number> {
  const net = new Map<string, number>()
  const add = (lines: readonly VoucherImpactLine[], sign: 1 | -1) => {
    for (const line of lines) {
      if (!isMomsAccount(line.account_number)) continue
      const amount = roundOre(Number(line.debit_amount || 0) - Number(line.credit_amount || 0))
      net.set(line.account_number, roundOre((net.get(line.account_number) ?? 0) + sign * amount))
    }
  }
  add(correctedLines, 1)
  add(originalLines, -1)
  const moved: Record<string, number> = {}
  for (const [account, amount] of net) if (amount !== 0) moved[account] = amount
  return moved
}

/**
 * The warning, or null when the pair moves no VAT account or the company
 * files no momsdeklaration. Never throws: an unread VAT period is named by the
 * original's date instead.
 */
export async function movedCorrectionVatWarning(
  supabase: SupabaseClient,
  companyId: string,
  input: {
    originalDate: string
    correctionDate: string
    originalLines: readonly VoucherImpactLine[]
    correctedLines: readonly VoucherImpactLine[]
  },
): Promise<VoucherWarning | null> {
  const change = vatAccountChange(input.originalLines, input.correctedLines)
  if (Object.keys(change).length === 0) return null

  // The original's momsperiod and whether it is on record as filed: the
  // same read the staged voucher preview shows.
  const impact = await previewVoucherVatDeclaration(supabase, companyId, {
    entryDate: input.originalDate,
    lines: input.originalLines,
    isOpeningBalance: false,
  })
  if (impact.status === 'not_vat_registered') return null
  const period = impact.status === 'ok' ? impact.vat_period : null
  const labelSv = period?.label ?? `momsperioden för ${input.originalDate}`
  const labelEn = period?.label ?? `the VAT period of ${input.originalDate}`
  const filedOn = period?.filed_on ?? null

  const landsSv =
    `Rättelsen ändrar momsen. Den bokförs ${input.correctionDate}, så i bokföringen hamnar skillnaden i den ` +
    `momsperioden, men felet hör till ${labelSv}.`
  const landsEn =
    `The correction changes VAT. It is posted on ${input.correctionDate}, so in the books the difference lands in ` +
    `that VAT period, but the error belongs to ${labelEn}.`
  return {
    code: 'VAT_OF_MOVED_CORRECTION',
    message_sv: filedOn
      ? `${landsSv} Deklarationen för ${labelSv} är redan inlämnad (${filedOn}): rätta den i stället, med en egen ` +
        'rättelse hos Skatteverket, och deklarera inte skillnaden igen i den senare perioden. Moms i fel period ' +
        'ger skattetillägg (SFL 49 kap. 13 §).'
      : `${landsSv} Den perioden är inte deklarerad här: ta med skillnaden i deklarationen för ${labelSv} och inte ` +
        'i den senare perioden. Moms i fel period ger skattetillägg (SFL 49 kap. 13 §).',
    message_en: filedOn
      ? `${landsEn} The return for ${labelEn} is already filed (${filedOn}): correct that return instead, with a ` +
        'voluntary correction to Skatteverket, and do not declare the difference again in the later period. VAT ' +
        'in the wrong period carries a tax surcharge (SFL 49 kap. 13 §).'
      : `${landsEn} That period is not on record as filed: include the difference in the return for ${labelEn}, ` +
        'not in the later period. VAT in the wrong period carries a tax surcharge (SFL 49 kap. 13 §).',
    details: {
      original_entry_date: input.originalDate,
      correction_date: input.correctionDate,
      original_vat_period: period?.label ?? null,
      original_vat_period_filed_on: filedOn,
      vat_account_change: change,
    },
  }
}

interface CorrectedOriginal {
  id: string
  fiscal_period_id: string
  entry_date: string
  source_type?: string | null
  lines?: ReadonlyArray<{ account_number: string; debit_amount: number | string; credit_amount: number | string }> | null
}

/**
 * Where a person's rättelse lands (assertStornoTarget with
 * inFirstOpenPeriodWhenLocked, the check correctEntry runs at commit), and,
 * when the storno moved out of a locked period, the VAT advice for it. One
 * read for every door that previews or confirms a rättelse: the app's
 * confirm-before-posting guard, the v1 dry run and answer, the MCP staging
 * preview. Throws assertStornoTarget's refusals.
 */
export async function correctionLanding(
  supabase: SupabaseClient,
  companyId: string,
  original: CorrectedOriginal,
  correctedLines: readonly VoucherImpactLine[],
  correctionDate?: string,
): Promise<{ target: StornoTarget; vatWarning: VoucherWarning | null }> {
  const target = await assertStornoTarget(supabase, companyId, original, undefined, {
    inFirstOpenPeriodWhenLocked: true,
  })
  if (!target.moved) return { target, vatWarning: null }
  const vatWarning = await movedCorrectionVatWarning(supabase, companyId, {
    originalDate: original.entry_date,
    correctionDate: correctionDate || target.date,
    originalLines: (original.lines ?? []).map((l) => ({
      account_number: l.account_number,
      debit_amount: Number(l.debit_amount) || 0,
      credit_amount: Number(l.credit_amount) || 0,
    })),
    correctedLines,
  })
  return { target, vatWarning }
}
