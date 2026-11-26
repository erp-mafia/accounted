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
 * are part of the inbox itself. When Kivra says the company already has a
 * mailbox there, Kivra is listed directly after the intake address. Billo and Kivra without credentials stay
 * listed as coming soon, the way every deployment showed them before they
 * were built.
 */
export function mailboxEntries(
  available: MailboxAvailability,
  kivraCompanyMailbox: 'has' | 'none' | 'unknown' | null = null,
): MailboxEntry[] {
  const order =
    kivraCompanyMailbox === 'has'
      ? [MAILBOX_ORDER[0]!, 'kivra' as const, ...MAILBOX_ORDER.slice(1).filter((door) => door !== 'kivra')]
      : MAILBOX_ORDER
  return order.filter((door) => {
    if (door === 'whatsapp') return available.whatsapp
    if (door === 'mailbox') return available.mail
    return true
  }).map((door) => {
    const carried = door === 'kivra' ? available.kivra : door === 'billo' ? available.billo : true
    return { door, comingSoon: !INTAKE_SOURCES[door].live || !carried }
  })
}

/**
 * Whether Billo is left out of a list that offers Kivra and Billo as the
 * company's one digital mailbox (the onboarding's receipts step): a company
 * that already has its mailbox at Kivra, or has connected Kivra, is not also
 * offered Billo. A Billo that is already connected stays listed. While the
 * answer is on its way Billo waits, so it never shows and then goes; a failed
 * read lists both, each with its own line.
 */
export function billoLeftOutForKivra(input: {
  read: 'loading' | 'ready' | 'failed'
  kivraCompanyMailbox: 'has' | 'none' | 'unknown' | null
  kivraConnected: boolean
  billoConnected: boolean
}): boolean {
  if (input.read === 'loading') return true
  if (input.read === 'failed' || input.billoConnected) return false
  return input.kivraCompanyMailbox === 'has' || input.kivraConnected
}
