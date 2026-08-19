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
 */
export default function RattelseExplainer({ children, className }: RattelseExplainerProps) {
  return (
    <HelpPopover className={className}>
      <p>
        En bokförd verifikation kan inte ändras direkt. Varje rättelse loggas
        med vem och när, och det ursprungliga innehållet förblir synligt i
        verifikatets rättelsehistorik, enligt bokföringslagen.
      </p>
      <div className="mt-2 space-y-2">{children}</div>
    </HelpPopover>
  )
}
