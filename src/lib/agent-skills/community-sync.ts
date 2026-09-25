import type { SupabaseClient } from '@supabase/supabase-js'
import { COMMUNITY_DIR, COMMUNITY_REPO, communityRepoUrl, parseCommunitySkillMd, type ParsedCommunitySkill } from './community-repo'
import { communityBodySha } from './community-approval'

/**
 * Publishing: what is merged into community/ in erp-mafia/accounted-skills
 * becomes a tier 'community' atom, and what is removed there is switched off
 * here. The repository is public and a push to main is not a review, so an
 * atom is exposed to AIs only when an Accounted reviewer approved that exact
 * text: the submission's approved_body_sha (set when the reviewer opened it
 * as a pull request) or the atom's own approved_sha (set by "Godkänn och
 * publicera" in the review list). A new or changed text without one waits,
 * unexposed, in the review list. Runs hourly (api/community/sync/cron) with a
 * service-role client; no token needed (GITHUB_TOKEN is used when set).
 */

type Fetch = typeof fetch

export interface CommunitySyncResult {
  published: string[]
  updated: string[]
  deactivated: string[]
  /** Submissions from Accounted that are now published. */
  linked: string[]
  /** Merged texts no reviewer approved yet: stored, not exposed, listed for review. */
  pending: string[]
  /** Folders that could not be read, with why: they are skipped, not half-published. */
  skipped: Array<{ slug: string; error: string }>
}

interface AtomRow { id: string; body: string | null; version: number; is_active: boolean; mcp_exposed: boolean; title: string; description: string; trigger_signals: Record<string, unknown> | null; reviewed_at: string | null }

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

function signals(item: ParsedCommunitySkill, approvedSha: string | null): Record<string, unknown> {
  return { kind: item.kind, author: item.author, industries: item.industries, source: communityRepoUrl(item.slug), submission: item.submissionId, approved_sha: approvedSha }
}

export async function syncCommunityFromRepo(supabase: SupabaseClient, fetchImpl: Fetch = fetch): Promise<CommunitySyncResult> {
  const result: CommunitySyncResult = { published: [], updated: [], deactivated: [], linked: [], pending: [], skipped: [] }
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
    .select('id, body, version, is_active, mcp_exposed, title, description, trigger_signals, reviewed_at').eq('tier', 'community').is('parent_atom_id', null)
  if (readError) throw new Error(`Failed to read community atoms: ${readError.message}`)
  const existing = new Map(((existingRows ?? []) as AtomRow[]).map((row) => [row.id, row]))
  const now = new Date().toISOString()

  // What the reviewer approved when opening each submission as a pull request.
  const submissionIds = items.map((i) => i.submissionId).filter((id): id is string => !!id)
  const approvedBySubmission = new Map<string, string>()
  if (submissionIds.length > 0) {
    const { data: rows, error } = await supabase.from('company_skills').select('id, approved_body_sha').in('id', submissionIds)
    if (error) throw new Error(`Failed to read approvals: ${error.message}`)
    for (const row of (rows ?? []) as Array<{ id: string; approved_body_sha: string | null }>) {
      if (row.approved_body_sha) approvedBySubmission.set(row.id, row.approved_body_sha)
    }
  }

  for (const item of items) {
    const id = `community/${item.slug}`
    const before = existing.get(id)
    const sha = communityBodySha(item.body)
    const previouslyApproved = typeof before?.trigger_signals?.approved_sha === 'string' ? before.trigger_signals.approved_sha : null
    const approved = previouslyApproved === sha || (item.submissionId !== null && approvedBySubmission.get(item.submissionId) === sha)
    const approvedSha = approved ? sha : previouslyApproved
    const unchanged = before?.is_active && before.mcp_exposed === approved && before.body === item.body && before.title === item.title && before.description === item.description
      && JSON.stringify(before.trigger_signals ?? {}) === JSON.stringify(signals(item, approvedSha))
    if (!approved) result.pending.push(id)
    if (!unchanged) {
      const { error } = await supabase.from('agent_atom_registry').upsert({
        id, tier: 'community', title: item.title, description: item.description, body: item.body,
        body_path: `${COMMUNITY_REPO}/${COMMUNITY_DIR}/${item.slug}/SKILL.md`, trigger_signals: signals(item, approvedSha),
        estimated_tokens: Math.ceil(item.body.length / 4), sni_prefixes: [], parent_atom_id: null, schema_version: 1,
        version: before ? before.version + (before.body === item.body ? 0 : 1) : 1,
        // Stored either way, exposed to AIs only once approved.
        is_active: true, mcp_exposed: approved,
        reviewed_at: approved ? before?.reviewed_at ?? now : before?.reviewed_at ?? null,
        updated_at: now,
      }, { onConflict: 'id' })
      if (error) throw new Error(`Failed to publish ${id}: ${error.message}`)
      if (approved) (before ? result.updated : result.published).push(id)
    }
    if (approved && item.submissionId) {
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
