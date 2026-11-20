/**
 * The deadlines a capital event raises, as rows in `deadlines` keyed by
 * source_key (the pattern of lib/arkiv/agreements/store.ts): one row per
 * key, inserted once, its date kept in step while nobody has completed or
 * dismissed it, and completed when the event is done.
 *
 *   bolaget:ku31:<year>                  KU31 by 31 January (SFL 24:1), only
 *                                        when the company has not turned on
 *                                        the kontrolluppgifter deadline the
 *                                        generator already raises
 *                                        (lib/tax/deadline-config.ts), so
 *                                        the two never duplicate.
 *   bolaget:capital:<id>:registration    nyemission 6 months (ABL 13:27),
 *                                        fondemission genast (12:10),
 *                                        minskning 4 months (20:19).
 *   bolaget:capital:<id>:notice          minskning: notice by post to the
 *                                        holders whose shares go (20:18).
 *   bolaget:dividend:<id>:registration   dividend decided at an extra
 *                                        stämma, filed genast (18:10).
 *
 * A reminder is a help, never the record: a failed write is logged and the
 * capital event stands.
 */
import { createServiceClient } from '@/lib/supabase/server'
import { todayIsoStockholm } from '@/lib/dates/iso'
import type { OperationContext } from '@/lib/operations/types'
import { writeSystemDeadline, type SystemDeadlineDraft, type SystemDeadlineRow } from '../system-deadlines'

export type CapitalDeadlineDraft = SystemDeadlineDraft

export async function upsertCapitalDeadline(ctx: OperationContext, draft: CapitalDeadlineDraft): Promise<void> {
  try {
    const service = createServiceClient()
    const { data, error } = await service
      .from('deadlines')
      .select('id, due_date, title, is_completed, dismissed_at, status')
      .eq('company_id', ctx.companyId)
      .eq('source_key', draft.sourceKey)
      .maybeSingle()
    if (error) throw new Error(error.message)
    await writeSystemDeadline(service, ctx.companyId, draft, data as SystemDeadlineRow | null, todayIsoStockholm(), new Date().toISOString())
  } catch (error) {
    ctx.log.warn('[bolaget] capital deadline write failed', {
      companyId: ctx.companyId,
      sourceKey: draft.sourceKey,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Complete the open deadlines under a key prefix (the event they reminded of is done). */
export async function completeCapitalDeadlines(ctx: OperationContext, sourceKeyPrefix: string): Promise<void> {
  try {
    const { error } = await createServiceClient()
      .from('deadlines')
      .update({ is_completed: true, completed_at: new Date().toISOString(), status: 'confirmed', status_changed_at: new Date().toISOString() })
      .eq('company_id', ctx.companyId)
      .like('source_key', `${sourceKeyPrefix}%`)
      .eq('is_completed', false)
    if (error) throw new Error(error.message)
  } catch (error) {
    ctx.log.warn('[bolaget] capital deadline completion failed', {
      companyId: ctx.companyId,
      sourceKeyPrefix,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export function ku31DeadlineKey(year: number): string {
  return `bolaget:ku31:${year}`
}

/**
 * The KU31 reminder for an inkomstår in which a dividend is paid: 31
 * January the year after (SFL 24:1). Left to the existing kontrolluppgifter
 * deadline when the company has turned it on.
 */
export async function syncKu31Deadline(ctx: OperationContext, year: number): Promise<void> {
  const { data } = await ctx.supabase
    .from('company_settings')
    .select('kontrolluppgifter_enabled')
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if ((data as { kontrolluppgifter_enabled: boolean | null } | null)?.kontrolluppgifter_enabled) return
  await upsertCapitalDeadline(ctx, {
    sourceKey: ku31DeadlineKey(year),
    title: `Kontrolluppgift KU31 (utdelning) för inkomstår ${year}`,
    dueOn: `${year + 1}-01-31`,
    priority: 'important',
    notes:
      `Utdelning har betalats ut under ${year}. Kontrolluppgift KU31 för varje fysisk person och dödsbo som fått utdelning ` +
      `ska lämnas till Skatteverket senast den 31 januari ${year + 1} (24 kap. 1 § skatteförfarandelagen). ` +
      'Filen skapas under Bolaget, Kapital och utdelning, och lämnas i Skatteverkets e-tjänst Lämna kontrolluppgifter.',
  })
}
