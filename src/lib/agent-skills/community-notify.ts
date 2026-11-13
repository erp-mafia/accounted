import type { SupabaseClient } from '@supabase/supabase-js'
import { getBranding } from '@/lib/branding/service'
import { getEmailService } from '@/lib/email/service'
import {
  publishedEmailHtml, publishedEmailSubject, publishedEmailText,
  reviewRequestEmailHtml, reviewRequestEmailSubject, reviewRequestEmailText,
  type CommunityEmailKind,
} from '@/lib/email/community-templates'
import { createLogger } from '@/lib/logger'
import { communityPageUrl } from './community-repo'
import { communityReviewerIds } from './reviewers'

type Fetch = typeof fetch
const log = createLogger('community.notify')

/** How long the check that a published page answers on accounted.se may take; a timeout fails that row only. */
const PAGE_CHECK_TIMEOUT_MS = 10_000

export interface PublishedNotifyResult {
  notified: string[]
  /** Published, but the page on accounted.se is not up yet: asked again next hour. */
  waiting: string[]
  failed: string[]
}

interface PublishedRow { id: string; name: string | null; author_handle: string | null; created_by: string; published_atom_id: string | null }

async function userEmail(service: SupabaseClient, userId: string): Promise<string | null> {
  const { data } = await service.auth.admin.getUserById(userId)
  return data?.user?.email ?? null
}

/**
 * "Din instruktion är publicerad. Vill du dela den?", once per publication,
 * and only when its page answers on accounted.se: the website refreshes its
 * approved list hourly, so an email sent at approval would link to a page
 * that is not there yet. The row is claimed before sending (at most one
 * email, whichever run gets there first) and released when the send fails
 * or throws, so the next run tries again: a claim left standing after a
 * throw meant the author was never told. Runs after the hourly community
 * sync; the page check gives up after PAGE_CHECK_TIMEOUT_MS.
 */
export async function notifyPublishedAuthors(service: SupabaseClient, fetchImpl: Fetch = fetch): Promise<PublishedNotifyResult> {
  const result: PublishedNotifyResult = { notified: [], waiting: [], failed: [] }
  const email = await getEmailService()
  if (!email.isConfigured()) return result
  const { data, error } = await service.from('company_skills')
    .select('id, name, author_handle, created_by, published_atom_id')
    .eq('share_status', 'published').is('published_notified_at', null).not('published_atom_id', 'is', null)
  if (error) throw new Error(`Failed to read published items: ${error.message}`)

  for (const row of (data ?? []) as PublishedRow[]) {
    const slug = row.published_atom_id!.replace(/^community\//, '')
    const pageUrl = communityPageUrl(slug)
    let claimedByThisRun = false
    const release = () => service.from('company_skills').update({ published_notified_at: null }).eq('id', row.id).eq('share_status', 'published')
    try {
      const page = await fetchImpl(pageUrl, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(PAGE_CHECK_TIMEOUT_MS) })
      if (!page.ok) { result.waiting.push(row.id); continue }
      const { data: claimed, error: claimError } = await service.from('company_skills')
        .update({ published_notified_at: new Date().toISOString() })
        .eq('id', row.id).eq('share_status', 'published').is('published_notified_at', null).select('id')
      if (claimError) throw new Error(claimError.message)
      if ((claimed ?? []).length === 0) continue
      claimedByThisRun = true
      const to = await userEmail(service, row.created_by)
      // No address to write to: the claim stands, there is nobody to retry for.
      if (!to) continue
      const mail = { title: row.name ?? slug, handle: row.author_handle ?? '', pageUrl }
      const sent = await email.sendEmail({
        to, subject: publishedEmailSubject(mail), html: publishedEmailHtml(mail), text: publishedEmailText(mail), replyTo: getBranding().supportEmail,
      })
      if (sent.success) { result.notified.push(row.id); continue }
      await release()
      result.failed.push(row.id)
    } catch (err) {
      log.warn('Publish notification failed', { submission: row.id, error: err instanceof Error ? err.message : String(err) })
      result.failed.push(row.id)
      if (claimedByThisRun) {
        const { error: releaseError } = await release()
        // Not released: nothing will ever mail this author, so a person must.
        if (releaseError) log.error('Publish notification claim not released; the author is never told', { submission: row.id, error: releaseError.message })
      }
    }
  }
  return result
}

/**
 * Tells Accounted's reviewers that an item was shared and waits for them.
 * Best effort: a failure is logged, never shown to the author, whose share
 * is already saved and listed on the review page.
 */
export async function notifyReviewersOfSubmission(
  service: SupabaseClient,
  submission: { title: string; handle: string; kind: CommunityEmailKind },
  reviewUrl: string,
): Promise<void> {
  try {
    const email = await getEmailService()
    const ids = communityReviewerIds()
    if (!email.isConfigured() || ids.length === 0) return
    const to = (await Promise.all(ids.map((id) => userEmail(service, id)))).filter((address): address is string => !!address)
    if (to.length === 0) return
    const mail = { ...submission, reviewUrl }
    const sent = await email.sendEmail({ to, subject: reviewRequestEmailSubject(mail), html: reviewRequestEmailHtml(mail), text: reviewRequestEmailText(mail) })
    if (!sent.success) log.warn('Review request email failed', { error: sent.error })
  } catch (err) {
    log.warn('Review request email failed', { error: err instanceof Error ? err.message : String(err) })
  }
}
