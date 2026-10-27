import { flagEnabled } from '@/lib/env/public-flags'

/**
 * Master switch for automatic invoice reminder sending.
 *
 * Sending was gated off in May 2026 (PR #583), and the dormant sender, its
 * cron route and its email templates were removed on 2026-10-12 (Plan 2
 * step 18): reminders belong to the collections integration now
 * (lib/collections). The schedule settings (send_invoice_reminders,
 * reminder_days_level_1/2/3) stay stored, and Försäljning → Utskick reads
 * this constant to hide the schedule while automatic sending is off.
 *
 * Turning reminders back on is a founder product decision and means building
 * a sender again, not flipping this flag. Whatever sender comes next must be
 * idempotent per (invoice, reminder level), must decide how to treat the
 * backlog of long-overdue and imported invoices (the old sender would have
 * sent a final notice with fee and interest as a first reminder), must
 * skip invoices the collections provider pursues (lib/collections/reminder-guard.ts),
 * and must start switched off for every company. The toggle is opt-in since
 * migration 20261025084600, and customers were told that reminders come back
 * off until they turn them on themselves. The rebuild spec is GitLab
 * accounted#104: remind only invoices issued from Accounted, pass the
 * collections bank check (lib/collections/bank-check.ts) before every
 * reminder, approval per batch by default with automatic sending opt-in.
 * The new sender's engine is lib/reminders (policy, facts, channel, and
 * dispatch.ts, the one send path), with the daily batch, the turn-on flow
 * and automatic sending built (phases 1 to 4).
 *
 * Switched on by NEXT_PUBLIC_REMINDERS_SENDING_ENABLED=true, a founder's
 * decision: set it in the deployment's environment and redeploy (it is read
 * at build time, as client components import it). Unset, everything stays
 * dark: no batch is gathered, nothing sends, and no turn-on offer shows.
 * Each company still turns reminders on itself, and its batches wait for
 * approval.
 *
 * Self-hosted Docker images carry no sentinel for it yet, so there it stays
 * off.
 *
 * Kept free of server dependencies on purpose: it is imported from both
 * server code and client components (the settings form).
 */
export const REMINDERS_SENDING_ENABLED: boolean = flagEnabled(process.env.NEXT_PUBLIC_REMINDERS_SENDING_ENABLED)

/**
 * Whether automatic reminders actually go out for a company: the product-wide
 * switch above AND the company's own "Skicka automatiska påminnelser" toggle.
 *
 * Only an explicit true turns a company on: a missing value counts as off,
 * mirroring the opt-in default (migration 20261025084600).
 *
 * Every surface that tells a user "reminders are sent after N days" must read
 * this, never the company setting alone: the setting can be on while nothing
 * sends, so read by itself it promises a schedule nothing runs (crm#95). The
 * settings page keeps reading REMINDERS_SENDING_ENABLED directly because
 * whether the schedule shows at all is about the product-wide state, whatever
 * the toggle says.
 *
 * `sendingEnabled` is a parameter only so tests can pin the truth table for
 * both switch states; callers never pass it.
 */
export function remindersActiveFor(
  companySetting: boolean | null | undefined,
  sendingEnabled: boolean = REMINDERS_SENDING_ENABLED,
): boolean {
  return sendingEnabled && companySetting === true
}
