import { getPostHogServer } from '@/lib/analytics/posthog-server'

/**
 * Arkiv phase 9: the handful of product events the next re-plan is measured
 * on. Page views told us where people are; these tell us what they do with
 * the archive. Never throws, never blocks: without a PostHog token it is a
 * no-op, and a capture failure is swallowed.
 */
export type ArkivEvent = 'arkiv_document_landed' | 'arkiv_question_answered' | 'arkiv_document_asked' | 'arkiv_missing_resolved' | 'arkiv_searched'

export function captureArkivEvent(event: ArkivEvent, input: { companyId: string; userId?: string | null } & Record<string, unknown>): void {
  try {
    const posthog = getPostHogServer()
    if (!posthog) return
    const { companyId, userId, ...properties } = input
    posthog.capture({
      // A person when one acted, else the company itself: an agent or a cron has no person.
      distinctId: userId || `company:${companyId}`,
      event,
      properties: { ...properties, company_id: companyId },
      groups: { company: companyId },
    })
  } catch {
    // Analytics never gets to break the pipeline.
  }
}
