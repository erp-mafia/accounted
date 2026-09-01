import type { InitialSetupPath, MomsPeriod } from '@/types'

/**
 * What the Skatteverket checklist step should say about VAT deadlines.
 *
 * - 'date': the company's next momsdeklaration due date is known; show it.
 * - 'missing_period': the company is VAT-registered but moms_period is unset,
 *   which makes the deadline engine silently generate ZERO VAT deadlines
 *   (lib/tax/deadline-config.ts conditions all require a concrete period).
 *   An empty deadlines query in that state means misconfiguration, not
 *   "no VAT duty", so the UI must prompt for the period instead of showing
 *   nothing.
 * - null: not VAT-registered (no line), or VAT-registered with a period set
 *   but no upcoming row surfaced (transient or horizon gap; say nothing
 *   rather than guessing).
 */
export type VatDeadlineLine =
  | { kind: 'date'; dueDate: string }
  | { kind: 'missing_period' }
  | null

export function vatDeadlineLine(input: {
  vatRegistered: boolean | null | undefined
  momsPeriod: MomsPeriod | null | undefined
  nextVatDueDate: string | null | undefined
}): VatDeadlineLine {
  if (!input.vatRegistered) return null
  if (!input.momsPeriod) return { kind: 'missing_period' }
  if (!input.nextVatDueDate) return null
  return { kind: 'date', dueDate: input.nextVatDueDate }
}

/**
 * Display ordinals for the setup checklist steps. Books and bank are always
 * present; Skatteverket and the receipts/inbox step render only when their
 * extensions are enabled; the assistant step is always last. `count` drives
 * the "{count} steg så är bokföringen igång" title.
 */
export function checklistNumbers(gates: { hasSkatteverket: boolean; hasInbox: boolean }): {
  count: number
  skv: number
  receipts: number
  assistant: number
} {
  const skv = 3
  const receipts = 3 + (gates.hasSkatteverket ? 1 : 0)
  const assistant = receipts + (gates.hasInbox ? 1 : 0)
  return { count: assistant, skv, receipts, assistant }
}

/**
 * Body of the PATCH that retires the checklist once every step is done.
 * The route refuses `completed: true` without a path ("Välj först hur du
 * vill komma igång"). `path` is null when the journey's books question was
 * skipped and the books then arrived through /import or MCP; in that state
 * step 1 can only be done via an import, so `migration` is the truthful path
 * to record. Without it that cohort looped on a 400 (PR #2147 skeptic).
 */
export function completionPatchBody(
  path: InitialSetupPath | null,
): { completed: true; path?: InitialSetupPath } {
  return path ? { completed: true } : { completed: true, path: 'migration' }
}

/**
 * Done-state for the "Anslut till Claude" step. The only thing that means
 * "connected" is a live API key minted by the MCP OAuth token route: it
 * exists exactly when a client (claude.ai, Claude Desktop, Claude Code)
 * completed the first-call sign-in. `oauthKeyCount` is the head count of
 * that user's unrevoked rows named by OAUTH_MCP_KEY_NAME (lib/auth/api-keys).
 * Before issue #2133 the step ticked on the in-app AI-profile flag, which
 * has nothing to do with Claude; the step could show done for a user who
 * never connected and stay open for one who had.
 */
export function claudeStepDone(input: { oauthKeyCount: number | null | undefined }): boolean {
  return (input.oauthKeyCount ?? 0) > 0
}

/**
 * The claude.ai Add-custom-connector deep link the checklist's Claude step
 * opens. Same shape as the Settings → API & MCP button: `tool_namespace` is
 * load-bearing (without it the server hands out legacy `gnubok_` tool
 * names), `client` is a telemetry-only distribution marker, and the origin
 * comes from the page so self-hosted and white-label domains link to
 * themselves. The link only prefills the dialog; the user reviews there.
 */
export function claudeConnectorLink(input: { origin: string; appName: string }): string {
  const serverUrl = `${input.origin}/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted&client=claude-connector`
  return (
    'https://claude.ai/customize/connectors?modal=add-custom-connector' +
    `&connectorName=${encodeURIComponent(input.appName)}` +
    `&connectorUrl=${encodeURIComponent(serverUrl)}`
  )
}
