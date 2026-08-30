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
 * that automatic sending is currently disabled. Re-enabling sending later is
 * a product decision executed by flipping this single flag; the notice
 * disappears and the cron starts processing in the same change.
 *
 * Kept dependency-free on purpose: it is imported from both server code
 * (the cron route) and client components (the settings form).
 */
export const REMINDERS_SENDING_ENABLED = false as boolean
