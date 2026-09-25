import type { SupabaseClient } from '@supabase/supabase-js'
import type { CommunityKind } from './community'
import { communitySlug, githubNewFileUrl, privacyFindings, publicBody, toCommunitySkillMd, type PrivacyFinding } from './community-repo'

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
