'use client'

import {
  ArrowUpTrayIcon,
  ArrowsRightLeftIcon,
  AtSymbolIcon,
  BuildingLibraryIcon,
  BuildingOfficeIcon,
  ChatBubbleOvalLeftIcon,
  CodeBracketSquareIcon,
  EnvelopeIcon,
  GlobeAltIcon,
  InboxArrowDownIcon,
  LinkIcon,
  SparklesIcon,
  TableCellsIcon,
  WalletIcon,
  type Icon as AppIcon,
} from '@/components/icons'
import { useTranslations } from 'next-intl'
import { BrandMark, GlyphMark } from '@/components/parties/BrandMark'
import type { IntakeSourceId } from '@/lib/intake/sources'
import { MAILBOX_ORDER, type MailboxDoor } from '@/lib/inkorg/mailboxes'
import type { VendorKey } from '@/lib/vendor-marks'

/** A connected mailbox's provider (channel_context.mail_provider), when the items say. */
export type MailProvider = 'gmail' | 'microsoft' | null

/** One quiet glyph per door, for the places that stay text-only. */
const DOOR_ICON: Record<IntakeSourceId, AppIcon> = {
  intake_email: AtSymbolIcon,
  mailbox: EnvelopeIcon,
  whatsapp: ChatBubbleOvalLeftIcon,
  upload: ArrowUpTrayIcon,
  peppol: CodeBracketSquareIcon,
  partner_api: LinkIcon,
  mcp: SparklesIcon,
  migration: ArrowsRightLeftIcon,
  system: BuildingOfficeIcon,
  bank_feed: BuildingLibraryIcon,
  bank_file: TableCellsIcon,
  sie: TableCellsIcon,
  billo: InboxArrowDownIcon,
  kivra: InboxArrowDownIcon,
  paypal: WalletIcon,
  portal: GlobeAltIcon,
}

export function DoorIcon({ door, className }: { door: IntakeSourceId; className?: string }) {
  const Icon = DOOR_ICON[door]
  return <Icon aria-hidden="true" className={className ?? 'h-[15px] w-[15px] shrink-0 text-muted-foreground'} />
}

/**
 * The doors that are a vendor wear its mark: a connected mailbox is Gmail
 * (the one Lägg till brevlåda connects), and WhatsApp, Peppol, Kivra, Billo
 * and PayPal wear theirs. Every other door is the app's own and wears its
 * glyph on the quiet chip (the intake address a letter, an upload an arrow).
 */
const DOOR_VENDOR: Partial<Record<IntakeSourceId, VendorKey>> = {
  mailbox: 'gmail',
  whatsapp: 'whatsapp',
  peppol: 'peppol',
  kivra: 'kivra',
  billo: 'billo',
  paypal: 'paypal',
}

/**
 * The doors whose vendor Simple Icons has no mark for wear the vendor's own
 * app icon, taken once from its own site (kivra.se, billo.life, 2026-10-20)
 * and shipped in public/logos like the other partner logos. The monogram
 * stays the fallback if the file fails to load.
 */
const DOOR_ICON_URL: Partial<Record<IntakeSourceId, string>> = {
  kivra: '/logos/kivra.png',
  billo: '/logos/billo.png',
}

const DOOR_GLYPH: Partial<Record<IntakeSourceId, AppIcon>> = {
  intake_email: EnvelopeIcon,
}

export function DoorMark({
  door,
  size = 22,
  className,
  mailProvider = null,
}: {
  door: IntakeSourceId
  size?: 22 | 28 | 40
  className?: string
  /** A connected mailbox is Gmail unless its items say Microsoft. */
  mailProvider?: MailProvider
}) {
  const vendor = door === 'mailbox' && mailProvider === 'microsoft' ? 'microsoft' : DOOR_VENDOR[door]
  if (vendor) {
    return <BrandMark name={door} vendor={vendor} variant="mark" size={size} className={className} logoUrl={DOOR_ICON_URL[door] ?? null} />
  }
  const Icon = DOOR_GLYPH[door] ?? DOOR_ICON[door]
  const glyph = Math.round(size * 0.5)
  return (
    <GlyphMark size={size} className={className}>
      <Icon aria-hidden="true" style={{ width: glyph, height: glyph }} strokeWidth={1.25} />
    </GlyphMark>
  )
}

/**
 * A door's name where room is short (the rail, a row's meta line): the name
 * Lägg till brevlåda gives it ("Inkorgsadress", "Peppol", "Gmail"), else
 * the door's own name. A Microsoft mailbox keeps the general name.
 */
export function useDoorName(mailProvider: MailProvider = null): (door: IntakeSourceId) => string {
  const t = useTranslations('inkorg')
  const tDoor = useTranslations('intake_sources')
  return (door) => {
    if (door === 'mailbox' && mailProvider === 'microsoft') return tDoor(door)
    return (MAILBOX_ORDER as readonly string[]).includes(door) ? t(`mailbox_${door as MailboxDoor}_name`) : tDoor(door)
  }
}
