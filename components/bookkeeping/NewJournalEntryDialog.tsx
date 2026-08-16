'use client'

import { useTranslations } from 'next-intl'
import { Copy, Link2, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import JournalEntryForm, { type FormLine } from '@/components/bookkeeping/JournalEntryForm'

export interface CopyPrefill {
  sourceId: string
  sourceVoucherLabel: string
  lines: FormLine[]
  description: string
  notes: string
}

/** Prefill for the skattekonto "Skapa verifikat manuellt" deep link. */
export interface SkvLinkPrefill {
  transactionId: string
  /** Row summary for the banner: date, text and amount, built by the caller. */
  bannerLabel: string
  lines: FormLine[]
  description: string
  date: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fired after a verifikat is created/saved as draft. */
  onCreated: () => void
  /** Fired with the created entry's id (both posted and draft saves). */
  onEntryCreated?: (entryId: string) => void
  /** When set, the form is pre-filled from a copied verifikat. */
  copyPrefill?: CopyPrefill | null
  /** When set, the form is pre-filled from a skattekonto row and the caller
   *  links the created entry back to it. copyPrefill wins if both are set. */
  skvPrefill?: SkvLinkPrefill | null
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
  onEntryCreated,
  copyPrefill,
  skvPrefill,
  isLoading,
}: Props) {
  const t = useTranslations('bookkeeping')
  const activeSkvPrefill = copyPrefill ? null : (skvPrefill ?? null)

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
            {activeSkvPrefill && (
              <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm">
                <Link2 className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                <div className="flex-1">
                  <p className="font-medium">
                    {t('skv_link_banner_title', { label: activeSkvPrefill.bannerLabel })}
                  </p>
                  <p className="text-muted-foreground mt-0.5">{t('skv_link_banner_body')}</p>
                </div>
              </div>
            )}
            <JournalEntryForm
              key={copyPrefill?.sourceId ?? activeSkvPrefill?.transactionId ?? 'fresh'}
              bare
              onCreated={onCreated}
              onEntryCreated={onEntryCreated}
              initialLines={copyPrefill?.lines ?? activeSkvPrefill?.lines}
              initialDate={activeSkvPrefill?.date}
              initialDescription={copyPrefill?.description ?? activeSkvPrefill?.description}
              initialNotes={copyPrefill?.notes}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
