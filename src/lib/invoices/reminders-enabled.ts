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
 * sent a final notice with fee and interest as a first reminder), and must
 * skip invoices the collections provider pursues (lib/collections/reminder-guard.ts).
 *
 * Kept dependency-free on purpose: it is imported from both server code and
 * client components (the settings form).
 */
export const REMINDERS_SENDING_ENABLED = false as boolean

/**
 * Whether automatic reminders actually go out for a company: the product-wide
 * switch above AND the company's own "Skicka automatiska påminnelser" toggle.
 *
 * A missing company value counts as on, mirroring the setting's default (the
 * old sender skipped only on `=== false`).
 *
 * Every surface that tells a user "reminders are sent after N days" must read
 * this, never the company setting alone: that setting defaults to on, so read
 * by itself it promises a schedule nothing runs (crm#95). The
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
  return sendingEnabled && companySetting !== false
}
