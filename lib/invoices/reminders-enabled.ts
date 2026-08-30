/**
 * Master switch for automatic invoice reminder sending.
 *
 * Sending was deliberately gated off in May 2026 (PR #583): the reminder
 * cron route answers 503 and no reminder emails go out, while the schedule
 * settings (send_invoice_reminders, reminder_days_level_1/2/3) remain
 * editable and are honored per company once sending is on.
 *
 * Both sides of that gate read this one constant: the cron route uses it as
 * its 503 gate, and the invoice settings form uses it to disclose to users
 * that automatic sending is currently disabled. Flipping it opens the route
 * and removes the notice in the same change.
 *
 * Re-enabling sending is a founder product decision and takes MORE than
 * this flip. The checklist (verified against the repo 2026-08-30):
 *
 * 1. Flip this flag to true.
 * 2. Hosted: the route has had no vercel.json cron entry since PR #559,
 *    and scripts/__tests__/generate-crontabs.test.ts pins it in
 *    INTENTIONALLY_UNSCHEDULED (the ratchet fails if it is scheduled).
 *    Add the cron entry back and drop the pin together. Self-hosted
 *    crontabs built from docs/SELF-HOSTING.md may already hit the route,
 *    so those installs resume on the flag flip alone.
 * 3. Before any flip, make the reminder run idempotent: invoice_reminders
 *    has no unique (invoice_id, reminder_level) constraint and
 *    processOverdueReminders books the reminder fee entry BEFORE inserting
 *    the invoice_reminders row, so a run dying mid-batch double-books the
 *    fee (Dr 1510 / Cr 3990) on the next run. Also decide how to handle
 *    the backlog: determineReminderLevel sends the highest eligible level
 *    first, so long-overdue customers would get a final notice with fee
 *    and interest as their first-ever reminder.
 *
 * Kept dependency-free on purpose: it is imported from both server code
 * (the cron route) and client components (the settings form).
 */
export const REMINDERS_SENDING_ENABLED = false as boolean
