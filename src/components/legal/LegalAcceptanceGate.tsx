import { isSelfHosted } from '@/lib/env/public-flags'
import { ACCOUNT_DELETION_PATH } from '@/lib/company/no-company-routes'
import { currentAcceptanceVersions, type AcceptanceState } from '@/lib/legal/acceptance'
import { LegalAcceptanceDialog } from './LegalAcceptanceDialog'

/**
 * Where the prompt never renders, so it locks nobody in: the archive export
 * (taking the books out is always possible, BFL and the Data Act alike) and
 * deleting the account (leaving needs no agreement).
 */
const UNGATED_PATH_PREFIXES = ['/import', ACCOUNT_DELETION_PATH]

/**
 * No acceptance prompt in front of the app. The
 * dialog, the accept route and the records stay so it can come back; while
 * this is false nothing is shown, and /dpa must not claim acceptances are
 * recorded (pinned in app/(public)/privacy/__tests__).
 */
const PROMPT_ENABLED = false

/**
 * Puts the acceptance prompt in front of a signed-in person who has not
 * accepted every document at its current version (lib/legal/documents.ts):
 * a new signup by any route (password, BankID, OAuth, invite) and everyone
 * after a version bump. Rendered by the dashboard and onboarding layouts with
 * the state they read once per request (readAcceptanceState).
 *
 * Off on a self-host: the documents are Arcim Technology AB's, for the
 * hosted service; an operator runs their own. Sandbox and anonymous demo
 * sessions accept nothing either.
 */
export function LegalAcceptanceGate({
  state,
  pathname,
  company,
  role,
  isSandbox = false,
  isAnonymous = false,
}: {
  state: AcceptanceState
  pathname: string
  company: { id: string; name: string } | null
  role: string | null
  isSandbox?: boolean
  isAnonymous?: boolean
}) {
  if (!PROMPT_ENABLED || isSelfHosted() || isSandbox || isAnonymous) return null
  if (state.pending.length === 0) return null
  if (UNGATED_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return null
  return (
    <LegalAcceptanceDialog
      documents={currentAcceptanceVersions()}
      initialAnalytics={state.analyticsConsent}
      company={company}
      canDecideForCompany={role === 'owner' || role === 'admin'}
    />
  )
}
