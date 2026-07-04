'use client'

import { useTranslations } from 'next-intl'
import { Copy, Loader2, MessageCircle } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import JournalEntryForm, { type FormLine } from '@/components/bookkeeping/JournalEntryForm'
import { useAgentSheet } from '@/components/agent/AgentSheetProvider'

export interface CopyPrefill {
  sourceId: string
  sourceVoucherLabel: string
  lines: FormLine[]
  description: string
  notes: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fired after a verifikat is created/saved as draft. */
  onCreated: () => void
  /** When set, the form is pre-filled from a copied verifikat. */
  copyPrefill?: CopyPrefill | null
  /** True while the copy source is being fetched. */
  isLoading?: boolean
}

/**
 * "Ny verifikat" as a modal: the dialog you type a manual voucher into,
 * instead of an inline tab. Wraps the standalone JournalEntryForm; the form's
 * own review/confirm dialogs stack on top of this one.
 */
export default function NewJournalEntryDialog({
  open,
  onOpenChange,
  onCreated,
  copyPrefill,
  isLoading,
}: Props) {
  const t = useTranslations('bookkeeping')
  const { openAgentSheet, identity } = useAgentSheet()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-3xl max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto"
        // A half-typed verifikat must survive an accidental backdrop click or a
        // stray Escape (easy to hit across multiple windows/screens, or when you
        // only meant to dismiss a combobox dropdown). Closing is explicit: the
        // header X. This also stops nested popovers (AccountCombobox, date
        // pickers) and the form's own confirm dialogs from collapsing the parent
        // when they portal outside it.
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t('new_entry_dialog_title')}</DialogTitle>
        </DialogHeader>

        {identity.isVerified && !copyPrefill && (
          // Hand off to the assistant: it reads the underlag (the figures the
          // user often can't see), suggests accounts, and stages a balanced
          // verifikat to approve: no copy-paste. Close the modal first so its
          // focus trap doesn't fight the (non-modal) agent sheet.
          <button
            type="button"
            onClick={() => {
              onOpenChange(false)
              openAgentSheet({ intentId: 'verifikation.draft', contextRef: 'verifikation:new' })
            }}
            className="inline-flex w-fit items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <MessageCircle className="h-3.5 w-3.5" />
            {t('ask_assistant_handoff')}
          </button>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">{t('loading_source_voucher')}</span>
          </div>
        ) : (
          <>
            {copyPrefill && (
              <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm">
                <Copy className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                <div className="flex-1">
                  <p className="font-medium">
                    {t('copy_banner_title', {
                      label: copyPrefill.sourceVoucherLabel || t('copy_banner_unknown_label'),
                    })}
                  </p>
                  <p className="text-muted-foreground mt-0.5">{t('copy_banner_body')}</p>
                </div>
              </div>
            )}
            <JournalEntryForm
              key={copyPrefill?.sourceId ?? 'fresh'}
              bare
              onCreated={onCreated}
              initialLines={copyPrefill?.lines}
              initialDescription={copyPrefill?.description}
              initialNotes={copyPrefill?.notes}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
