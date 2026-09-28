import type { SupabaseClient } from '@supabase/supabase-js'
import type { EntityType, VatPeriodType } from '@/types'
import { calculateVatDeclaration } from '@/lib/reports/vat-declaration'
import { buildFiledAmounts } from '@/lib/reports/vat-manual-filing'
import { getVatDeadlineForPeriod } from '@/lib/tax/deadline-config'
import { adjustDeadlineToNextBankingDay } from '@/lib/tax/swedish-holidays'
import { formatDateISO } from '@/lib/calendar/utils'
import { roundOre } from '@/lib/money'

export interface CombinedTaxPaymentSettings {
  moms_period: VatPeriodType | null
  fiscal_year_start_month: number | null
  vat_has_eu_trade: boolean | null
  vat_filing_method: 'electronic' | 'paper' | null
  vat_taxable_base_over_40m: boolean | null
  vat_registered: boolean | null
}

export interface VatPaymentSource {
  periodType: VatPeriodType
  year: number
  period: number
  fiscalPeriodId?: string
}

export interface CombinedTaxPayment {
  paymentDate: string
  agi: { id: string; period: string; tax: number; avgifter: number; amount: number } | null
  vat: { periodType: VatPeriodType; year: number; period: number; amount: number } | null
  totalAmount: number
}

export function agiTaxPaymentDate(
  periodYear: number,
  periodMonth: number,
  settings: Pick<CombinedTaxPaymentSettings, 'vat_registered' | 'vat_taxable_base_over_40m'>,
): string {
  const deadlineMonth = periodMonth === 12 ? 1 : periodMonth + 1
  const deadlineYear = periodMonth === 12 ? periodYear + 1 : periodYear
  const large = settings.vat_registered === true && settings.vat_taxable_base_over_40m === true
  const day = deadlineMonth === 1 || (!large && deadlineMonth === 8) ? 17 : 12
  return formatDateISO(
    adjustDeadlineToNextBankingDay(new Date(deadlineYear, deadlineMonth - 1, day)),
  )
}

export function vatTaxPaymentDate(
  source: Omit<VatPaymentSource, 'fiscalPeriodId'>,
  entityType: EntityType,
  settings: CombinedTaxPaymentSettings,
): string | null {
  const deadline = getVatDeadlineForPeriod(source.periodType, source.year, source.period, {
    entity_type: entityType,
    fiscal_year_start_month: settings.fiscal_year_start_month,
    vat_has_eu_trade: settings.vat_has_eu_trade === true,
    vat_filing_method: settings.vat_filing_method,
    vat_taxable_base_over_40m: settings.vat_taxable_base_over_40m === true,
  })
  return deadline
    ? formatDateISO(adjustDeadlineToNextBankingDay(new Date(deadline.year, deadline.month, deadline.day)))
    : null
}

export async function resolveCombinedTaxPayment(
  supabase: SupabaseClient,
  companyId: string,
  entityType: EntityType,
  settings: CombinedTaxPaymentSettings,
  paymentDate: string,
  vatSource?: VatPaymentSource,
): Promise<CombinedTaxPayment> {
  const due = new Date(`${paymentDate}T12:00:00Z`)
  const candidate = new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth() - 1, 1))
  const agiYear = candidate.getUTCFullYear()
  const agiMonth = candidate.getUTCMonth() + 1
  let agi: CombinedTaxPayment['agi'] = null

  if (agiTaxPaymentDate(agiYear, agiMonth, settings) === paymentDate) {
    const { data } = await supabase
      .from('agi_declarations')
      .select('id, total_tax, total_avgifter, tax_paid_at')
      .eq('company_id', companyId)
      .eq('period_year', agiYear)
      .eq('period_month', agiMonth)
      .maybeSingle()
    if (data && !data.tax_paid_at) {
      const tax = Number(data.total_tax) || 0
      const avgifter = Number(data.total_avgifter) || 0
      const amount = Number.isInteger(tax) && Number.isInteger(avgifter)
        ? tax + avgifter
        : roundOre(tax + avgifter)
      if (amount > 0) {
        agi = {
          id: data.id,
          period: `${agiYear}-${String(agiMonth).padStart(2, '0')}`,
          tax,
          avgifter,
          amount,
        }
      }
    }
  }

  const source = vatSource ?? await findVatSourceForPaymentDate(
    supabase,
    companyId,
    entityType,
    settings,
    paymentDate,
  )
  let vat: CombinedTaxPayment['vat'] = null
  if (source && vatTaxPaymentDate(source, entityType, settings) === paymentDate) {
    const declaration = await calculateVatDeclaration(
      supabase,
      companyId,
      source.periodType,
      source.year,
      source.period,
      { fiscalPeriodId: source.fiscalPeriodId },
    )
    const amount = buildFiledAmounts(declaration.rutor).net
    if (amount > 0) {
      vat = { periodType: source.periodType, year: source.year, period: source.period, amount }
    }
  }

  return {
    paymentDate,
    agi,
    vat,
    totalAmount: roundOre((agi?.amount ?? 0) + (vat?.amount ?? 0)),
  }
}

async function findVatSourceForPaymentDate(
  supabase: SupabaseClient,
  companyId: string,
  entityType: EntityType,
  settings: CombinedTaxPaymentSettings,
  paymentDate: string,
): Promise<VatPaymentSource | undefined> {
  const periodType = settings.moms_period
  if (!periodType || settings.vat_registered !== true) return undefined
  const dueYear = Number(paymentDate.slice(0, 4))
  const max = periodType === 'monthly' ? 12 : periodType === 'quarterly' ? 4 : 1
  for (const year of [dueYear - 1, dueYear]) {
    for (let period = 1; period <= max; period++) {
      const source = { periodType, year, period }
      if (vatTaxPaymentDate(source, entityType, settings) !== paymentDate) continue
      if (periodType !== 'yearly') return source

      const startMonth = settings.fiscal_year_start_month ?? 1
      const endMonth = startMonth === 1 ? 12 : startMonth - 1
      const month = String(endMonth).padStart(2, '0')
      const { data } = await supabase
        .from('fiscal_periods')
        .select('id')
        .eq('company_id', companyId)
        .gte('period_end', `${year}-${month}-01`)
        .lte('period_end', `${year}-${month}-31`)
        .maybeSingle()
      if (data?.id) return { ...source, fiscalPeriodId: data.id }
    }
  }
  return undefined
}
