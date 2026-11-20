import type { ReminderResponseType } from '@/types'

/** What a customer may answer to a reminder, and how long their note may be. Client-safe. */
export const REMINDER_ANSWER_ACTIONS = ['marked_paid', 'disputed'] as const satisfies readonly ReminderResponseType[]

/** Matches the invoice_reminders_response_note_length CHECK (migration 20261027120000). */
export const REMINDER_ANSWER_NOTE_MAX = 1000
