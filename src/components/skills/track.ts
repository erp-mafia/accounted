'use client'

import posthog from 'posthog-js'
import { isAnalyticsEnabled } from '@/lib/analytics/enabled'

/**
 * The Instruktioner funnel, the clicks the launch is judged on: someone
 * connects an AI, starts or creates something, adds an AI-made draft, or
 * turns a flow into a routine. The server already logs when an agent loads
 * the flow (event_log mcp.skill_loaded), so a start click without a load
 * means the chat was opened and abandoned. No names or texts in properties:
 * ids, kinds and clients only. Never throws.
 */
export type InstructionsEvent =
  | 'instructions_connect_clicked'
  | 'instructions_start_clicked'
  | 'instructions_create_clicked'
  | 'instructions_draft_added'
  | 'instructions_routine_opened'

export function trackInstructions(event: InstructionsEvent, properties: Record<string, string | number | boolean | null>): void {
  if (!isAnalyticsEnabled()) return
  try {
    posthog.capture(event, properties)
  } catch {
    // Telemetry must never affect the page.
  }
}
