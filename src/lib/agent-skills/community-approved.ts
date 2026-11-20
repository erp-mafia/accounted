import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { communityBodySha } from './community-approval'

/**
 * What accounted.se may show of the community: the items every company's AI
 * gets (tier 'community', active and exposed), each with the fingerprint of
 * the exact text an Accounted reviewer approved. The website lists a folder of
 * erp-mafia/accounted-skills only when its SKILL.md hashes to that fingerprint,
 * so a merge nobody approved, or an edit made on GitHub after the approval, is
 * never shown as "Granskad av Accounted". Slugs and hashes of files that are
 * already public: nothing here needs a login.
 */
export interface ApprovedCommunityItem {
  slug: string
  /** SHA-256 of the trimmed SKILL.md text (communityBodySha). */
  sha: string
}

interface ExposedRow { id: string; body: string | null; trigger_signals: Record<string, unknown> | null }

export async function loadApprovedCommunityItems(service: SupabaseClient): Promise<ApprovedCommunityItem[]> {
  const rows = await fetchAllRows<ExposedRow>(({ from, to }) => service.from('agent_atom_registry')
    .select('id, body, trigger_signals')
    .eq('tier', 'community').eq('is_active', true).eq('mcp_exposed', true).is('parent_atom_id', null)
    .order('id').range(from, to))
  return rows.flatMap((row) => {
    if (!row.body) return []
    const sha = communityBodySha(row.body)
    // Exposed means approved, and the approval pins one text (community-sync.ts). A row
    // whose stored text is not the approved one is left out rather than vouched for.
    if (row.trigger_signals?.approved_sha !== sha) return []
    return [{ slug: row.id.replace(/^community\//, ''), sha }]
  })
}
