/**
 * "Lägg till brevlåda": every door a document can come in through that a
 * company connects itself, in the order the dialog lists them. A door that
 * is not built yet is listed as coming soon and cannot be opened; whether a
 * door is built is INTAKE_SOURCES' `live`, the one place that says so.
 * Billo and Kivra are built, but a deployment carries them only with
 * Accounted's partner credentials: without them they stay coming soon.
 *
 * Pure: the dialog reads the doors' states over HTTP and renders the rows.
 */
import { INTAKE_SOURCES, type IntakeSourceId } from '@/lib/intake/sources'

/** The doors the dialog offers. Upload, MCP and the API are ways in, not mailboxes to connect. */
export type MailboxDoor = Extract<IntakeSourceId, 'intake_email' | 'whatsapp' | 'peppol' | 'mailbox' | 'billo' | 'kivra'>

export const MAILBOX_ORDER: readonly MailboxDoor[] = ['intake_email', 'whatsapp', 'peppol', 'mailbox', 'billo', 'kivra']

export interface MailboxEntry {
  door: MailboxDoor
  /** Not built, or not carried by this deployment: shown as coming soon, not clickable. */
  comingSoon: boolean
}

export interface MailboxAvailability {
  /** The WhatsApp intake is built into this deployment (extension whatsapp-inbox). */
  whatsapp: boolean
  /** The Gmail connection is built into this deployment (extension mail). */
  mail: boolean
  /** This deployment can receive from Kivra (Accounted's Kivra credentials are configured). */
  kivra: boolean
  /** This deployment can receive from Billo (Accounted's Billo credentials are configured). */
  billo: boolean
}

/**
 * The rows of the dialog. A built door this deployment does not carry is
 * left out rather than shown as a dead end; the intake address and Peppol
 * are part of the inbox itself. Billo and Kivra without credentials stay
 * listed as coming soon, the way every deployment showed them before they
 * were built.
 */
export function mailboxEntries(available: MailboxAvailability): MailboxEntry[] {
  return MAILBOX_ORDER.filter((door) => {
    if (door === 'whatsapp') return available.whatsapp
    if (door === 'mailbox') return available.mail
    return true
  }).map((door) => {
    const carried = door === 'kivra' ? available.kivra : door === 'billo' ? available.billo : true
    return { door, comingSoon: !INTAKE_SOURCES[door].live || !carried }
  })
}
