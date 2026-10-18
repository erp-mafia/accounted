/**
 * "Lägg till brevlåda": every door a document can come in through that a
 * company connects itself, in the order the dialog lists them. A door that
 * is named but not built yet (Billo, Kivra) is listed as coming soon and
 * cannot be opened; whether a door is built is INTAKE_SOURCES' `live`, the
 * one place that says so.
 *
 * Pure: the dialog reads the doors' states over HTTP and renders the rows.
 */
import { INTAKE_SOURCES, type IntakeSourceId } from '@/lib/intake/sources'

/** The doors the dialog offers. Upload, MCP and the API are ways in, not mailboxes to connect. */
export type MailboxDoor = Extract<IntakeSourceId, 'intake_email' | 'whatsapp' | 'peppol' | 'mailbox' | 'billo' | 'kivra'>

export const MAILBOX_ORDER: readonly MailboxDoor[] = ['intake_email', 'whatsapp', 'peppol', 'mailbox', 'billo', 'kivra']

export interface MailboxEntry {
  door: MailboxDoor
  /** Not built yet: shown as coming soon, not clickable. */
  comingSoon: boolean
}

export interface MailboxAvailability {
  /** The WhatsApp intake is built into this deployment (extension whatsapp-inbox). */
  whatsapp: boolean
  /** The Gmail connection is built into this deployment (extension mail). */
  mail: boolean
}

/**
 * The rows of the dialog. A built door this deployment does not carry is
 * left out rather than shown as a dead end; the intake address and Peppol
 * are part of the inbox itself.
 */
export function mailboxEntries(available: MailboxAvailability): MailboxEntry[] {
  return MAILBOX_ORDER.filter((door) => {
    if (door === 'whatsapp') return available.whatsapp
    if (door === 'mailbox') return available.mail
    return true
  }).map((door) => ({ door, comingSoon: !INTAKE_SOURCES[door].live }))
}
