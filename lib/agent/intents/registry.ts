import type { AgentIntent } from './types'
import { generalHelp } from './general-help'
import { transactionCategorization } from './transaction-categorization'
import { inboxBulkBook } from './inbox-bulk-book'
import { invoiceDraft } from './invoice-draft'
import { supplierInvoiceReview } from './supplier-invoice-review'
import { vatReview } from './vat-review'
import { bokslutStep } from './bokslut-step'
import { verifikationDraft } from './verifikation-draft'
import { kpiExplain } from './kpi-explain'
import { settingsHelp } from './settings-help'
import { onboardingEmpty } from './onboarding-empty'
import { onboardingIntake } from './onboarding-intake'

// Static intent table. Adding a new intent: write a file under
// lib/agent/intents/<id>.ts that calls defineAgentIntent({...}), import it
// here, append it to INTENTS, and it's reachable from /api/agent/invoke.
// Plan refs: §8 (intent system).
//
// Using a static table (not a registry singleton) on purpose: intents are
// pure code, not data. Their lifetime matches the deployment.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const INTENTS: AgentIntent<any, any>[] = [
  generalHelp,
  transactionCategorization,
  inboxBulkBook,
  invoiceDraft,
  supplierInvoiceReview,
  vatReview,
  bokslutStep,
  verifikationDraft,
  kpiExplain,
  settingsHelp,
  onboardingEmpty,
  onboardingIntake,
]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getIntent(id: string): AgentIntent<any, any> | undefined {
  return INTENTS.find((i) => i.id === id)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function listIntents(): AgentIntent<any, any>[] {
  return INTENTS
}
