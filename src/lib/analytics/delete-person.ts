import { createLogger } from '@/lib/logger'
import { isAnalyticsEnabled } from './enabled'

const log = createLogger('analytics.delete-person')

/** PostHog's app host (the REST API), not the ingestion host: EU cloud unless set. */
const DEFAULT_APP_HOST = 'https://eu.posthog.com'
const TIMEOUT_MS = 5_000

export type DeletePersonOutcome = 'deleted' | 'skipped' | 'failed'

/**
 * Erase a deleted account's person at PostHog: the person, their events and
 * their session recordings (persons/bulk_delete with delete_events and
 * delete_recordings). PostHog queues the deletion and finishes it
 * asynchronously.
 *
 * Needs a personal API key with person:write (POSTHOG_PERSONAL_API_KEY) and
 * the project id (POSTHOG_PROJECT_ID); POSTHOG_APP_HOST overrides the EU
 * default. Without them it logs a warning and answers 'skipped'. It never
 * throws: account deletion must not depend on a third party answering.
 *
 * The distinct id is the user id, the one AnalyticsIdentify identifies with.
 */
export async function deletePostHogPerson(
  distinctId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeletePersonOutcome> {
  if (!isAnalyticsEnabled()) return 'skipped'
  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY
  const projectId = process.env.POSTHOG_PROJECT_ID
  if (!apiKey || !projectId) {
    log.warn('PostHog person not deleted: POSTHOG_PERSONAL_API_KEY or POSTHOG_PROJECT_ID is unset', { distinctId })
    return 'skipped'
  }
  const host = (process.env.POSTHOG_APP_HOST || DEFAULT_APP_HOST).replace(/\/+$/, '')
  try {
    const res = await fetchImpl(`${host}/api/projects/${encodeURIComponent(projectId)}/persons/bulk_delete/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ distinct_ids: [distinctId], delete_events: true, delete_recordings: true }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      log.error('PostHog person deletion refused', { distinctId, status: res.status })
      return 'failed'
    }
    return 'deleted'
  } catch (err) {
    log.error('PostHog person deletion failed', { distinctId, err })
    return 'failed'
  }
}
