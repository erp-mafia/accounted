/**
 * The company's model for internally generated intangible assets under K3
 * (BFNAR 2012:1 punkt 18.7): the kostnadsföringsmodell ('expense') or the
 * aktiveringsmodell ('capitalise'), applied consistently to every such
 * asset. Stored on companies.development_expenditure_model; the K3
 * accounting policies note reads it (K3 plan phase 1 seam).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { getActor } from '@/lib/bookkeeping/actor-context'
import { listFiscalYearFrameworks } from '@/lib/company/accounting-framework'

export const DEVELOPMENT_MODELS = ['expense', 'capitalise'] as const
export type DevelopmentModel = (typeof DEVELOPMENT_MODELS)[number]

export const DevelopmentModelSchema = z.object({
  development_expenditure_model: z.enum(DEVELOPMENT_MODELS),
})

/** Why the model cannot be set: not a K3 company, or own development is on the books. */
export class DevelopmentModelRefusedError extends Error {
  readonly code = 'DEVELOPMENT_MODEL_REFUSED'
  constructor(readonly reason: 'not_k3' | 'capitalised_assets') {
    super(
      reason === 'not_k3'
        ? 'Modellen för internt upparbetade immateriella tillgångar väljs bara enligt K3 (punkt 18.7); enligt K2 kostnadsförs eget utvecklingsarbete alltid.'
        : 'Aktiverat eget utvecklingsarbete finns i anläggningsregistret. Ett byte till kostnadsföringsmodellen är ett byte av redovisningsprincip (K3 kap. 10) och görs inte här.',
    )
    this.name = 'DevelopmentModelRefusedError'
  }
}

/**
 * The model, and whether the company reports under K3 for it: the model is
 * a policy for the K3 years, so K3 when an open year (not closed, not
 * locked) is reported under K3, an elected next year included; with no
 * fiscal year yet, the company setting. Not companies.accounting_framework
 * alone: that is the latest year's. set_development_expenditure_model judges
 * the same way.
 */
export async function getDevelopmentModel(
  supabase: SupabaseClient,
  companyId: string,
): Promise<{ model: DevelopmentModel | null; framework: 'k2' | 'k3' }> {
  const [{ data, error }, years] = await Promise.all([
    supabase
      .from('companies')
      .select('accounting_framework, development_expenditure_model')
      .eq('id', companyId)
      .maybeSingle(),
    listFiscalYearFrameworks(supabase, companyId),
  ])
  if (error) throw new Error(`Kunde inte läsa redovisningsprinciperna: ${error.message}`)
  const row = data as { accounting_framework?: string | null; development_expenditure_model?: string | null } | null
  const model = row?.development_expenditure_model
  const k3 = years.length === 0
    ? row?.accounting_framework === 'k3'
    : years.some((year) => !year.is_closed && !year.locked_at && year.framework === 'k3')
  return {
    model: model === 'expense' || model === 'capitalise' ? model : null,
    framework: k3 ? 'k3' : 'k2',
  }
}

/**
 * Set the model. K3 companies only; a switch to the kostnadsföringsmodell is
 * refused while capitalised own development is on the register, since that
 * is a change of accounting policy with restated comparatives (K3 kap. 10),
 * not a setting.
 *
 * Written by set_development_expenditure_model, whose trigger records who
 * changed the model from what to what in audit_log (behandlingshistorik,
 * BFL 5 kap. 11 §, BFNAR 2013:2 punkt 9.16). userId names the person for a
 * service-role door (API key, MCP), where the database sees no signed-in
 * user; the surrounding actor scope names the credential.
 */
export async function setDevelopmentModel(
  supabase: SupabaseClient,
  companyId: string,
  model: DevelopmentModel,
  /** dryRun: the same checks, nothing written. */
  options: { dryRun?: boolean; userId?: string } = {},
): Promise<DevelopmentModel> {
  const current = await getDevelopmentModel(supabase, companyId)
  if (current.framework !== 'k3') throw new DevelopmentModelRefusedError('not_k3')
  if (model === 'expense' && current.model === 'capitalise') {
    const { data, error } = await supabase
      .from('assets')
      .select('id')
      .eq('company_id', companyId)
      .is('disposed_at', null)
      .eq('own_development', true)
      .limit(1)
    if (error) throw new Error(`Kunde inte läsa anläggningsregistret: ${error.message}`)
    if ((data ?? []).length > 0) {
      throw new DevelopmentModelRefusedError('capitalised_assets')
    }
  }
  if (options.dryRun) return model
  if (current.model === model) return model
  const actor = getActor()
  const { error } = await supabase.rpc('set_development_expenditure_model', {
    p_company_id: companyId,
    p_model: model,
    p_user_id: options.userId ?? null,
    p_actor_type: actor?.type ?? null,
    p_actor_label: actor?.label ?? null,
  })
  if (error) {
    if (error.message === 'DEVELOPMENT_MODEL_REFUSED') throw new DevelopmentModelRefusedError('not_k3')
    throw new Error(`Kunde inte spara redovisningsprincipen: ${error.message}`)
  }
  return model
}
