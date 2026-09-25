import type { SupabaseClient } from '@supabase/supabase-js'
import { COMMUNITY_DIR, COMMUNITY_REPO, communityRepoUrl, parseCommunitySkillMd, type ParsedCommunitySkill } from './community-repo'

/**
 * Publishing: what is merged into community/ in erp-mafia/accounted-skills
 * becomes a tier 'community' atom in every company's catalogue, and what is
 * removed there is switched off here. A merge is Accounted's review, so the
 * repository is the only way in. Runs hourly (api/community/sync/cron) with a
 * service-role client; public repository, so no token is needed (GITHUB_TOKEN
 * is used when set, for a higher rate limit).
 */

type Fetch = typeof fetch

export interface CommunitySyncResult {
  published: string[]
  updated: string[]
  deactivated: string[]
  /** Submissions from Accounted that are now published. */
  linked: string[]
  /** Folders that could not be read, with why: they are skipped, not half-published. */
  skipped: Array<{ slug: string; error: string }>
}

interface AtomRow { id: string; body: string | null; version: number; is_active: boolean; title: string; description: string; trigger_signals: Record<string, unknown> | null; reviewed_at: string | null }

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN?.trim()
  return { Accept: 'application/vnd.github+json', 'User-Agent': 'accounted-community-sync', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
}

/** The folders under community/ on main. */
async function listFolders(fetchImpl: Fetch): Promise<string[]> {
  const response = await fetchImpl(`https://api.github.com/repos/${COMMUNITY_REPO}/contents/${COMMUNITY_DIR}?ref=main`, { headers: githubHeaders(), cache: 'no-store' })
  if (response.status === 404) return []
  if (!response.ok) throw new Error(`GitHub listing failed: ${response.status}`)
  const entries = await response.json() as Array<{ type: string; name: string }>
  return entries.filter((e) => e.type === 'dir').map((e) => e.name).sort()
}

async function readSkill(fetchImpl: Fetch, slug: string): Promise<string | null> {
  const response = await fetchImpl(`https://raw.githubusercontent.com/${COMMUNITY_REPO}/main/${COMMUNITY_DIR}/${slug}/SKILL.md`, { headers: { 'User-Agent': 'accounted-community-sync' }, cache: 'no-store' })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`GitHub read failed for ${slug}: ${response.status}`)
  return response.text()
}

function signals(item: ParsedCommunitySkill): Record<string, unknown> {
  return { kind: item.kind, author: item.author, industries: item.industries, source: communityRepoUrl(item.slug) }
}

export async function syncCommunityFromRepo(supabase: SupabaseClient, fetchImpl: Fetch = fetch): Promise<CommunitySyncResult> {
  const result: CommunitySyncResult = { published: [], updated: [], deactivated: [], linked: [], skipped: [] }
  const folders = await listFolders(fetchImpl)

  const items: ParsedCommunitySkill[] = []
  for (const slug of folders) {
    const text = await readSkill(fetchImpl, slug)
    if (text === null) { result.skipped.push({ slug, error: 'no SKILL.md' }); continue }
    const parsed = parseCommunitySkillMd(slug, text)
    if ('error' in parsed) { result.skipped.push({ slug, error: parsed.error }); continue }
    items.push(parsed)
  }

  const { data: existingRows, error: readError } = await supabase.from('agent_atom_registry')
    .select('id, body, version, is_active, title, description, trigger_signals, reviewed_at').eq('tier', 'community').is('parent_atom_id', null)
  if (readError) throw new Error(`Failed to read community atoms: ${readError.message}`)
  const existing = new Map(((existingRows ?? []) as AtomRow[]).map((row) => [row.id, row]))
  const now = new Date().toISOString()

  for (const item of items) {
    const id = `community/${item.slug}`
    const before = existing.get(id)
    const unchanged = before?.is_active && before.body === item.body && before.title === item.title && before.description === item.description
      && JSON.stringify(before.trigger_signals ?? {}) === JSON.stringify(signals(item))
    if (!unchanged) {
      const { error } = await supabase.from('agent_atom_registry').upsert({
        id, tier: 'community', title: item.title, description: item.description, body: item.body,
        body_path: `${COMMUNITY_REPO}/${COMMUNITY_DIR}/${item.slug}/SKILL.md`, trigger_signals: signals(item),
        estimated_tokens: Math.ceil(item.body.length / 4), sni_prefixes: [], parent_atom_id: null, schema_version: 1,
        version: before ? before.version + (before.body === item.body ? 0 : 1) : 1,
        is_active: true, mcp_exposed: true,
        // Merged means reviewed; the first publication dates it, later edits keep it.
        reviewed_at: before?.reviewed_at ?? now,
        updated_at: now,
      }, { onConflict: 'id' })
      if (error) throw new Error(`Failed to publish ${id}: ${error.message}`)
      ;(before ? result.updated : result.published).push(id)
    }
    if (item.submissionId) {
      const { data: linked, error } = await supabase.from('company_skills')
        .update({ share_status: 'published', published_atom_id: id, reviewed_at: now, review_url: communityRepoUrl(item.slug) })
        .eq('id', item.submissionId).eq('share_status', 'submitted').select('id')
      if (error) throw new Error(`Failed to mark submission ${item.submissionId} published: ${error.message}`)
      if ((linked ?? []).length > 0) result.linked.push(item.submissionId)
    }
  }

  // Removed from the repository: off here too. The row stays for the votes and history.
  // A folder that failed to read keeps what was published before: a broken edit is not an unpublish.
  const live = new Set([...items.map((i) => `community/${i.slug}`), ...result.skipped.map((s) => `community/${s.slug}`)])
  const gone = [...existing.values()].filter((row) => row.is_active && !live.has(row.id)).map((row) => row.id)
  if (gone.length > 0) {
    const { error } = await supabase.from('agent_atom_registry').update({ is_active: false, mcp_exposed: false, updated_at: now }).in('id', gone)
    if (error) throw new Error(`Failed to switch off removed items: ${error.message}`)
    result.deactivated.push(...gone)
  }
  return result
}
