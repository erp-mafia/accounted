import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { filesIncomeReturn, resolveCompanyEntityType } from '@/lib/company/entity-type'
import {
  computeEfDeclarationPreview,
  EfDeclarationNotApplicableError,
  type EfDeclarationPreviewInput,
} from './ef-declaration-preview'

/**
 * What an enskild firma's owner enters for the NE-bilaga's sida 2, kept per
 * räkenskapsår in ne_declaration_inputs: the year-end preview's input
 * (EfDeclarationPreviewInput) without the legal-form hint. Every figure is
 * optional: an empty one means not entered, which the preview reports.
 */
export const NeDeclarationInputsSchema = z
  .object({
    category: z.enum(['full', 'pensioner', 'passive']).optional(),
    kapitalunderlag: z.number().finite().optional(),
    sparatFordelningsbelopp: z.number().finite().nonnegative().optional(),
    expansionsfondKapitalunderlag: z.number().finite().optional(),
    priorYearSchablonavdrag: z.number().finite().nonnegative().optional(),
    priorYearActualCharged: z.number().finite().nonnegative().optional(),
    pfondDesiredAmount: z.number().finite().nonnegative().optional(),
    pfondExistingFonder: z
      .array(
        z
          .object({
            cohort_year: z.number().int().min(2000).max(2100),
            balance: z.number().finite().positive(),
          })
          .strict(),
      )
      .max(10, 'Högst 10 periodiseringsfonder')
      .refine(
        (fonder) => new Set(fonder.map((fond) => fond.cohort_year)).size === fonder.length,
        'Ett år kan bara ha en periodiseringsfond',
      )
      .optional(),
    expansionsfondExistingBalance: z.number().finite().nonnegative().optional(),
    expansionsfondDesiredChange: z.number().finite().optional(),
  })
  .strict()

export type NeDeclarationInputs = z.infer<typeof NeDeclarationInputsSchema>

export interface LoadedNeDeclarationInputs {
  inputs: NeDeclarationInputs
  /**
   * 'saved': this year's own row. 'carried': nothing saved yet, so the
   * figures last year's declaration hands on (R40 from last year's R43, the
   * funds that stay, the expansionsfond, the sparat fördelningsbelopp) are
   * proposed. 'none': neither.
   */
  source: 'saved' | 'carried' | 'none'
  /** The räkenskapsår the carried figures come from. */
  carriedFrom?: { fiscalPeriodId: string; name: string }
}

async function assertFilesNe(supabase: SupabaseClient, companyId: string): Promise<void> {
  const form = await resolveCompanyEntityType(supabase, companyId)
  if (filesIncomeReturn(form) !== 'NE') throw new EfDeclarationNotApplicableError(form)
}

async function savedInputs(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<NeDeclarationInputs | null> {
  const { data, error } = await supabase
    .from('ne_declaration_inputs')
    .select('inputs')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load NE-bilaga inputs: ${error.message}`)
  if (!data) return null
  // A stored value that no longer fits the schema is treated as not entered
  // rather than trusted: the owner sees empty fields and enters them again.
  const parsed = NeDeclarationInputsSchema.safeParse((data as { inputs: unknown }).inputs)
  return parsed.success ? parsed.data : {}
}

/**
 * The figures last year's NE-bilaga hands on to this year's, computed from
 * last year's saved inputs by the same preview the year-end step shows:
 *
 *   - R40 (last year's schablonavdrag) is last year's R43;
 *   - the periodiseringsfonder that stay are last year's funds not återförda
 *     (status optional) plus last year's avsättning (R34) as that year's fund;
 *   - the expansionsfond is last year's balance plus R36 less R37;
 *   - the sparat fördelningsbelopp is last year's Övriga uppgifter 8011;
 *   - the egenavgift category stays.
 *
 * R41 (egenavgifter charged on the slutskattebesked) and both kapitalunderlag
 * are this year's own figures and are never carried.
 */
export function carriedInputs(
  previous: NeDeclarationInputs,
  preview: Awaited<ReturnType<typeof computeEfDeclarationPreview>>,
  previousClosingYear: number,
): NeDeclarationInputs {
  const staying = preview.pfondFonder
    .filter((fond) => fond.status === 'optional')
    .map((fond) => ({ cohort_year: fond.cohort_year, balance: fond.balance }))
  if (preview.rutor.R34 > 0 && !staying.some((fond) => fond.cohort_year === previousClosingYear)) {
    staying.push({ cohort_year: previousClosingYear, balance: preview.rutor.R34 })
  }
  const expansionsfond = (previous.expansionsfondExistingBalance ?? 0) + preview.rutor.R36 - preview.rutor.R37
  const sparat = preview.ovrigaUppgifter.find((row) => row.faltkod === '8011')?.amount ?? 0
  return {
    ...(previous.category ? { category: previous.category } : {}),
    ...(preview.rutor.R43 > 0 ? { priorYearSchablonavdrag: preview.rutor.R43 } : {}),
    ...(staying.length > 0 ? { pfondExistingFonder: staying.slice(0, 10) } : {}),
    ...(expansionsfond > 0 ? { expansionsfondExistingBalance: expansionsfond } : {}),
    ...(sparat > 0 ? { sparatFordelningsbelopp: sparat } : {}),
  }
}

/** This year's saved inputs, or what last year's saved inputs hand on, or none. */
export async function loadNeDeclarationInputs(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<LoadedNeDeclarationInputs> {
  await assertFilesNe(supabase, companyId)
  const saved = await savedInputs(supabase, companyId, fiscalPeriodId)
  if (saved) return { inputs: saved, source: 'saved' }

  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('period_start')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()
  if (periodError || !period) throw new Error('Fiscal period not found')

  const { data: previous, error: previousError } = await supabase
    .from('fiscal_periods')
    .select('id, name, period_end')
    .eq('company_id', companyId)
    .lt('period_end', (period as { period_start: string }).period_start)
    .order('period_end', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (previousError) throw new Error(`Failed to load the previous fiscal year: ${previousError.message}`)
  if (!previous) return { inputs: {}, source: 'none' }

  const prior = previous as { id: string; name: string; period_end: string }
  const previousInputs = await savedInputs(supabase, companyId, prior.id)
  if (!previousInputs) return { inputs: {}, source: 'none' }

  const preview = await computeEfDeclarationPreview(supabase, companyId, prior.id, {
    ...(previousInputs as EfDeclarationPreviewInput),
    entityType: 'enskild_firma',
  })
  return {
    inputs: carriedInputs(previousInputs, preview, Number(prior.period_end.slice(0, 4))),
    source: 'carried',
    carriedFrom: { fiscalPeriodId: prior.id, name: prior.name },
  }
}

/** Replace the räkenskapsår's inputs, in the caller's name. */
export async function saveNeDeclarationInputs(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  userId: string,
  inputs: NeDeclarationInputs,
): Promise<LoadedNeDeclarationInputs> {
  await assertFilesNe(supabase, companyId)
  const { data, error } = await supabase
    .from('ne_declaration_inputs')
    .upsert(
      { company_id: companyId, fiscal_period_id: fiscalPeriodId, inputs, updated_by: userId },
      { onConflict: 'company_id,fiscal_period_id' },
    )
    .select('inputs')
    .single()
  if (error) throw error
  return { inputs: (data as { inputs: NeDeclarationInputs }).inputs, source: 'saved' }
}
