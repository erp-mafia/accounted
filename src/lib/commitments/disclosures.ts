import type { SupabaseClient } from '@supabase/supabase-js'
import { commitmentsEnabledFor } from '@/lib/env/commitments-switch'
import { createLogger } from '@/lib/logger'
import { loadGroupLinkRows } from './group-links'
import { registerNoteTexts, type RegisterNoteTexts } from './note-text'
import { loadSecurityRows } from './securities'

/**
 * What the registers say in the årsredovisning on a balance date: the
 * ställda säkerheter and eventualförpliktelser note texts and the parent of
 * the koncernförhållanden note. Null for a company outside the Bolaget
 * rollout, when nothing is registered, or when the registers cannot be read
 * (a table not yet migrated): the årsredovisning then reads the narrative
 * alone, as before.
 */
export async function loadRegisterNoteTexts(
  supabase: SupabaseClient,
  companyId: string,
  balanceDate: string,
): Promise<RegisterNoteTexts | null> {
  if (!commitmentsEnabledFor(companyId)) return null
  try {
    const [securities, groupLinks] = await Promise.all([
      loadSecurityRows({ supabase, companyId }),
      loadGroupLinkRows({ supabase, companyId }),
    ])
    const texts = registerNoteTexts(
      securities.map((s) => ({ ...s, amount: Number(s.amount) })),
      groupLinks,
      balanceDate,
    )
    if (!texts.securities_pledged && !texts.contingent_liabilities && !texts.parent_company) return null
    return texts
  } catch (err) {
    // The årsredovisning must still build from the narrative alone (a table
    // not yet migrated, a read that failed): logged, never thrown.
    createLogger('commitments.disclosures').warn('register note texts not read', {
      company: companyId,
      reason: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
