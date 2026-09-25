import type { SupabaseClient } from '@supabase/supabase-js'
import type { CommunityKind } from './community'
import { communityRepoUrl, communitySlug, githubNewFileUrl, privacyFindings, publicBody, toCommunitySkillMd, type PrivacyFinding } from './community-repo'
import { communityBodySha } from './community-approval'

/**
 * Accounted's review of shared own items, before anything is public: the
 * reviewer reads the exact SKILL.md that would be published, with a privacy
 * screen, and either opens it as a pull request in erp-mafia/accounted-skills
 * (as themselves, from GitHub's editor) or sends it back with a reason. A
 * merge publishes it (community-sync.ts). Service-role reads: submissions
 * belong to every company, so the caller must have checked the reviewer.
 */
export interface ReviewSubmission {
  id: string
  title: string
  description: string
  kind: CommunityKind
  author: string
  submitted_at: string | null
  slug: string
  skill_md: string
  /** GitHub's editor with the file filled in; null when too long for a URL (copy it instead). */
  github_url: string | null
  privacy: PrivacyFinding[]
}

interface SubmittedRow {
  id: string
  name: string | null
  description: string | null
  body: string | null
  kind: CommunityKind | null
  author_handle: string | null
  share_confirmed_at: string | null
}

export async function loadSubmissionsForReview(service: SupabaseClient): Promise<ReviewSubmission[]> {
  const [{ data, error }, { data: atoms, error: atomsError }] = await Promise.all([
    service.from('company_skills')
      .select('id, name, description, body, kind, author_handle, share_confirmed_at')
      .eq('share_status', 'submitted').order('share_confirmed_at', { ascending: true }),
    service.from('agent_atom_registry').select('id').eq('tier', 'community'),
  ])
  if (error) throw new Error(`Failed to read submissions: ${error.message}`)
  if (atomsError) throw new Error(`Failed to read published items: ${atomsError.message}`)
  // A folder name nobody has: published items and the other submissions in this list.
  const taken = new Set((atoms ?? []).map((a) => (a as { id: string }).id.replace(/^community\//, '')))
  return ((data ?? []) as SubmittedRow[]).filter((row) => row.name && row.body).map((row) => {
    const base = communitySlug(row.name!)
    let slug = base
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`
    taken.add(slug)
    const skillMd = toCommunitySkillMd({
      slug, title: row.name!, description: row.description ?? row.name!, kind: row.kind ?? 'workflow',
      author: row.author_handle ?? 'anonym', body: row.body!, submissionId: row.id,
    })
    return {
      id: row.id,
      title: row.name!,
      description: row.description ?? '',
      kind: row.kind ?? 'workflow',
      author: row.author_handle ?? '',
      submitted_at: row.share_confirmed_at,
      slug,
      skill_md: skillMd,
      github_url: githubNewFileUrl(slug, skillMd),
      // Screen what will be public, plus the name and description.
      privacy: privacyFindings(`${row.name}\n${row.description ?? ''}\n${publicBody(row.body!)}`),
    }
  })
}

/** Sends a submission back to its author: private again, with the reason shown to them. */
export async function sendBackSubmission(service: SupabaseClient, id: string, reason: string): Promise<boolean> {
  const { data, error } = await service.from('company_skills')
    .update({ share_status: 'private', review_note: reason })
    .eq('id', id).eq('share_status', 'submitted').select('id')
  if (error) throw new Error(`Failed to send back ${id}: ${error.message}`)
  return (data ?? []).length > 0
}

/**
 * Records the reviewer's approval of a submission's exact SKILL.md, when they
 * open it as a pull request. The hash is computed here from the file the
 * server builds, never taken from the browser. False when it is not waiting.
 */
export async function approveSubmission(service: SupabaseClient, id: string): Promise<boolean> {
  const submission = (await loadSubmissionsForReview(service)).find((s) => s.id === id)
  if (!submission) return false
  const { data, error } = await service.from('company_skills')
    .update({ approved_body_sha: communityBodySha(submission.skill_md) })
    .eq('id', id).eq('share_status', 'submitted').select('id')
  if (error) throw new Error(`Failed to approve ${id}: ${error.message}`)
  return (data ?? []).length > 0
}

/** A merged text no reviewer has approved: an edit made on GitHub, or a contribution straight from GitHub. */
export interface PendingItem {
  slug: string
  title: string
  description: string
  kind: CommunityKind
  author: string
  body: string
  /** The fingerprint the reviewer approves: the page sends it back, so a text that changed since cannot be approved blind. */
  sha: string
  source: string
  privacy: PrivacyFinding[]
}

export async function loadPendingItems(service: SupabaseClient): Promise<PendingItem[]> {
  const { data, error } = await service.from('agent_atom_registry')
    .select('id, title, description, body, trigger_signals')
    .eq('tier', 'community').eq('is_active', true).eq('mcp_exposed', false).is('parent_atom_id', null).order('id')
  if (error) throw new Error(`Failed to read pending items: ${error.message}`)
  return ((data ?? []) as Array<{ id: string; title: string; description: string; body: string | null; trigger_signals: Record<string, unknown> | null }>)
    .filter((row) => row.body)
    .map((row) => {
      const slug = row.id.replace(/^community\//, '')
      const signals = row.trigger_signals ?? {}
      return {
        slug,
        title: row.title,
        description: row.description,
        kind: (signals.kind as CommunityKind) ?? 'workflow',
        author: typeof signals.author === 'string' ? signals.author : '',
        body: row.body!,
        sha: communityBodySha(row.body!),
        source: communityRepoUrl(slug),
        privacy: privacyFindings(row.body!),
      }
    })
}

/**
 * "Godkänn och publicera": exposes a merged text to every company's AI, if
 * it is still the text the reviewer read (same fingerprint). Marks the
 * submission it came from published. False when it changed or is not pending.
 */
export async function approvePendingItem(service: SupabaseClient, slug: string, sha: string): Promise<boolean> {
  const id = `community/${slug}`
  const { data: row, error } = await service.from('agent_atom_registry')
    .select('id, body, trigger_signals').eq('id', id).eq('tier', 'community').eq('is_active', true).eq('mcp_exposed', false).maybeSingle()
  if (error) throw new Error(`Failed to read ${id}: ${error.message}`)
  const atom = row as { id: string; body: string | null; trigger_signals: Record<string, unknown> | null } | null
  if (!atom?.body || communityBodySha(atom.body) !== sha) return false
  const now = new Date().toISOString()
  // Compare-and-set on the body: a sync that stored a newer text since the read must not be exposed by this approval.
  const { data: exposed, error: updateError } = await service.from('agent_atom_registry')
    .update({ mcp_exposed: true, reviewed_at: now, updated_at: now, trigger_signals: { ...(atom.trigger_signals ?? {}), approved_sha: sha } })
    .eq('id', id).eq('body', atom.body).eq('mcp_exposed', false).select('id')
  if (updateError) throw new Error(`Failed to publish ${id}: ${updateError.message}`)
  if ((exposed ?? []).length === 0) return false
  const submission = atom.trigger_signals?.submission
  if (typeof submission === 'string') {
    const { error: linkError } = await service.from('company_skills')
      .update({ share_status: 'published', published_atom_id: id, reviewed_at: now, review_url: communityRepoUrl(slug) })
      .eq('id', submission).eq('share_status', 'submitted')
    if (linkError) throw new Error(`Failed to mark submission ${submission} published: ${linkError.message}`)
  }
  return true
}
