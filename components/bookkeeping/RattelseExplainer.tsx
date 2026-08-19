'use client'

import { HelpPopover } from '@/components/ui/help-popover'

interface RattelseExplainerProps {
  /** Per-dialog specifics, rendered after the shared framing paragraph. */
  children: React.ReactNode
  className?: string
}

/**
 * Shared "?" help for the rättelse family of dialogs (CorrectionEntryDialog,
 * StrikeLinesDialog, RecordateEntryDialog, CorrectMetadataDialog): one place
 * for the "a posted verifikat cannot be edited directly" framing, so the four
 * dialogs stop maintaining near-duplicate inline paragraphs. Rendered next to
 * the DialogTitle per UI-migration convention 7 (help lives behind a "?",
 * not in the dialog flow: see MatchVoucherDialog). Stays Swedish
 * (verifikat surface, .claude/rules/i18n.md).
 *
 * Only the universally true framing lives here. The audit-trail sentence is
 * mechanism-specific (BFL 5 kap 5 §: two distinct correction tracks) and must
 * come from each dialog's children: the inline strike-and-replace dialogs
 * (StrikeLinesDialog, CorrectMetadataDialog) write the who/when
 * rättelsehistorik log, while the storno dialogs (CorrectionEntryDialog,
 * RecordateEntryDialog) never touch that log: their trail is the storno chain
 * of linked verifikat. Claiming the rättelsehistorik here would be false for
 * the storno paths.
 */
export default function RattelseExplainer({ children, className }: RattelseExplainerProps) {
  return (
    <HelpPopover className={className}>
      <p>
        En bokförd verifikation kan inte ändras direkt: enligt bokföringslagen
        måste varje rättelse vara spårbar i efterhand.
      </p>
      <div className="mt-2 space-y-2">{children}</div>
    </HelpPopover>
  )
}
