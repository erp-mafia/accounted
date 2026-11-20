import type { SupabaseClient } from '@supabase/supabase-js'

export interface PayrollConfig {
  configYear: number
  avgifterTotal: number
  avgifterAlderspension: number
  avgifterSjukforsakring: number
  avgifterForaldraforsakring: number
  avgifterEfterlevandepension: number
  avgifterArbetsmarknad: number
  avgifterArbetsskada: number
  avgifterAllmanLoneavgift: number
  avgifterReduced65plus: number
  avgifterYouthRate: number | null
  avgifterYouthSalaryCap: number | null
  avgifterVaxaStodRate: number | null
  avgifterVaxaStodCap: number | null
  avgifterMinimumAnnual: number
  egenavgifterTotal: number
  slpRate: number
  prisbasbelopp: number
  inkomstbasbelopp: number
  maxPgi: number
  sgiCeiling: number
  statligSkattBrytpunkt: number
  traktamenteHeldag: number
  traktamenteHalvdag: number
  traktamenteNatt: number
  milersattningEgenBil: number
  milersattningFormansbilFossil: number
  milersattningFormansbilEl: number
  kostformanHeldag: number
  kostformanLunch: number
  kostformanFrukost: number
  friskvardCap: number
  bilformanSlr: number
  sjuklonRate: number
  karensavdragFactor: number
  maxKarensavdragPerYear: number
  reducedAvgiftAge: number
}

/**
 * The year's statutory payroll figures (arbetsgivaravgifter, prisbasbelopp,
 * traktamente, bilförmån's statslåneränta, ...) are not in
 * salary_payroll_config. Each year's row ships as a migration once the
 * figures are officially set, so this means the year has not been added yet:
 * nothing the caller can fix, and nothing to retry. Carries a registered code
 * so every door reports it by name instead of "Något gick fel".
 */
export class PayrollConfigMissingError extends Error {
  readonly code = 'SALARY_PAYROLL_CONFIG_MISSING'

  constructor(readonly year: number) {
    super(`Payroll rates for ${year} are not loaded yet; payroll, trips and allowances dated ${year} cannot be calculated until they are.`)
    this.name = 'PayrollConfigMissingError'
  }
}

/**
 * Load payroll configuration for a given year. Throws PayrollConfigMissingError
 * when the year has no row, and the database error itself when the read fails,
 * so a connection problem is never reported as missing rates.
 */
export async function loadPayrollConfig(
  supabase: SupabaseClient,
  year: number
): Promise<PayrollConfig> {
  const { data, error } = await supabase
    .from('salary_payroll_config')
    .select('*')
    .eq('config_year', year)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new PayrollConfigMissingError(year)

  return {
    configYear: data.config_year,
    avgifterTotal: data.avgifter_total,
    avgifterAlderspension: data.avgifter_alderspension,
    avgifterSjukforsakring: data.avgifter_sjukforsakring,
    avgifterForaldraforsakring: data.avgifter_foraldraforsakring,
    avgifterEfterlevandepension: data.avgifter_efterlevandepension,
    avgifterArbetsmarknad: data.avgifter_arbetsmarknad,
    avgifterArbetsskada: data.avgifter_arbetsskada,
    avgifterAllmanLoneavgift: data.avgifter_allman_loneavgift,
    avgifterReduced65plus: data.avgifter_reduced_65plus,
    avgifterYouthRate: data.avgifter_youth_rate,
    avgifterYouthSalaryCap: data.avgifter_youth_salary_cap,
    avgifterVaxaStodRate: data.avgifter_vaxa_stod_rate,
    avgifterVaxaStodCap: data.avgifter_vaxa_stod_cap,
    avgifterMinimumAnnual: data.avgifter_minimum_annual,
    egenavgifterTotal: data.egenavgifter_total,
    slpRate: data.slp_rate,
    prisbasbelopp: data.prisbasbelopp,
    inkomstbasbelopp: data.inkomstbasbelopp,
    maxPgi: data.max_pgi,
    sgiCeiling: data.sgi_ceiling,
    statligSkattBrytpunkt: data.statlig_skatt_brytpunkt,
    traktamenteHeldag: data.traktamente_heldag,
    traktamenteHalvdag: data.traktamente_halvdag,
    traktamenteNatt: data.traktamente_natt,
    milersattningEgenBil: data.milersattning_egen_bil,
    milersattningFormansbilFossil: data.milersattning_formansbil_fossil,
    milersattningFormansbilEl: data.milersattning_formansbil_el,
    kostformanHeldag: data.kostforman_heldag,
    kostformanLunch: data.kostforman_lunch,
    kostformanFrukost: data.kostforman_frukost,
    friskvardCap: data.friskvard_cap,
    bilformanSlr: data.bilforman_slr,
    sjuklonRate: data.sjuklon_rate,
    karensavdragFactor: data.karensavdrag_factor,
    maxKarensavdragPerYear: data.max_karensavdrag_per_year,
    reducedAvgiftAge: data.reduced_avgift_age,
  }
}

/**
 * Serialize payroll config for snapshot storage in salary_runs.calculation_params.
 */
export function serializePayrollConfig(config: PayrollConfig): Record<string, unknown> {
  return { ...config }
}
