/**
 * The Hem gate: what the dashboard root ("Att göra", route "/") does with a
 * resolved company before it renders.
 *
 * `onboarding_complete` is a recorded fact about the company's settings row:
 * the answers onboarding collects exist. It is written once, by company
 * creation (lib/company/create-company.ts), and inherited by a migration-reset
 * replacement, whose settings row is a copy of the source's
 * (20260920190800). It is never derived from how much bookkeeping a company
 * holds: a company that is lawfully emptied (migration reset, SIE import
 * undo, fiscal-year reset) is still an onboarded company.
 *
 * That matters because 'onboarding' is a one-way door. /onboarding is the
 * create-a-NEW-company journey; no flow completes onboarding for a company
 * that already exists. Any writer that leaves an existing company at
 * onboarding_complete = false therefore locks its members out of Hem and
 * steers them into creating a duplicate of the same legal entity. Every
 * other nav entry keeps working (the dashboard layout renders regardless),
 * which is why the symptom reads as "Att göra sends me to onboarding".
 *
 * Pure so the decision is testable: the page passes what it already read.
 */
export type HemGateDecision = 'render' | 'onboarding' | 'byra'

export function decideHemGate(input: {
  /** company_settings.onboarding_complete; a missing row reads as not onboarded. */
  onboardingComplete: boolean | null | undefined
  /** The user explicitly picked this company this session (COMPANY_PICKED_COOKIE). */
  companyPicked: boolean
  /** Member (any role) of at least one byrå team. */
  isByraMember: boolean
}): HemGateDecision {
  if (input.onboardingComplete) return 'render'
  // A byrå member who did NOT explicitly pick this company goes to the
  // cockpit instead. The auto-resolved company can be onboarding-incomplete
  // through no action of theirs, and the first-run journey is a dead end for
  // role 'member': WL-15 refuses client creation and the shell has no nav.
  if (!input.companyPicked && input.isByraMember) return 'byra'
  return 'onboarding'
}
