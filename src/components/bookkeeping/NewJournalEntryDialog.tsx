'use client'

import { useId, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { EyeIcon, EyeSlashIcon, LinkIcon, Square2StackIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  holdEscapeWhileUnsaved,
} from '@/components/ui/dialog'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Skeleton } from '@/components/ui/skeleton'
import JournalEntryForm, { type FormLine } from '@/components/bookkeeping/JournalEntryForm'
import DocumentViewerPane from '@/components/bookkeeping/DocumentViewerPane'
import type { UploadedFile } from '@/components/bookkeeping/DocumentUploadZone'
import { shownUnderlag, underlagPaneOpen, viewableUnderlag } from '@/components/bookkeeping/underlag-pane'
import { useMediaQuery } from '@/lib/hooks/use-media-query'
import { cn } from '@/lib/utils'

/** Where the underlag fits beside the form (Tailwind's xl, 80rem): the
 *  konteringsrader keep about 700px of their own from here up. */
const SIDE_BY_SIDE_QUERY = '(min-width: 80rem)'

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
 *
 * Once a file attached in the form has uploaded, the dialog shows it beside
 * the konteringsrader (crm#1954), so the figures are read off the underlag
 * while they are typed: side by side on a wide screen, above the form behind
 * "Visa underlag" on a narrow one. The form keeps the files; the dialog only
 * hears about them (onUploadedFilesChange).
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
  const [hasUnsavedInput, setHasUnsavedInput] = useState(false)
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([])
  // The switcher's pick, and the show/hide control's choice (null until used).
  const [pickedUnderlagId, setPickedUnderlagId] = useState<string | null>(null)
  const [paneChoice, setPaneChoice] = useState<boolean | null>(null)
  const sideBySide = useMediaQuery(SIDE_BY_SIDE_QUERY)
  const paneId = useId()
  const underlag = useMemo(() => viewableUnderlag(uploadedFiles), [uploadedFiles])
  const shown = shownUnderlag(underlag, pickedUnderlagId)
  const paneOpen = underlagPaneOpen({ hasUnderlag: shown != null, wide: sideBySide, choice: paneChoice })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="document"
 // Wide: the konteringsrader table (konto, radtext, debet, kredit,
 // saldo) is the point of this dialog, and at 3xl the amount columns
 // were squeezed against the account search. Capped at 6xl so it stays
 // a dialog on an ultrawide screen. With the underlag beside the rows it
 // widens to hold both, up to the window minus a docked agent sheet
 // (--agent-sheet-w, 0px when none), so the form's right edge never
 // ends up under the sheet.
 className={cn(
   'lg:max-w-6xl',
   paneOpen && 'xl:max-w-[min(1760px,calc(100vw-var(--agent-sheet-w,0px)-4rem))]',
 )}
 // Escape closes an untouched dialog, like every other overlay, but a
 // half-typed verifikat must survive a stray Escape (easy to hit across
 // multiple windows/screens, or when you only meant to dismiss a
 // combobox dropdown): then closing is explicit, the header X. See
 // holdEscapeWhileUnsaved. A backdrop click never closes it. This also
 // stops nested popovers (AccountCombobox, date pickers) and the form's
 // own confirm dialogs from collapsing the parent when they portal
 // outside it.
 onEscapeKeyDown={(e) => holdEscapeWhileUnsaved(e, hasUnsavedInput)}
 onPointerDownOutside={(e) => e.preventDefault()}
 onInteractOutside={(e) => e.preventDefault()}
>
        <DialogHeader className={cn(shown && 'flex-row items-center justify-between gap-3')}>
          <DialogTitle>{t('new_entry_dialog_title')}</DialogTitle>
          {shown && (
            // Beside the title, clear of the corner X; -my-1 keeps the
            // header at the title's height so nothing below it moves.
            <Button
              variant="ghost"
              className="-my-1 shrink-0"
              aria-expanded={paneOpen}
              aria-controls={paneId}
              onClick={() => setPaneChoice(!paneOpen)}
            >
              {paneOpen ? (
                <EyeSlashIcon className="h-4 w-4" aria-hidden="true" />
              ) : (
                <EyeIcon className="h-4 w-4" aria-hidden="true" />
              )}
              {paneOpen ? t('underlag_pane_hide') : t('underlag_pane_show')}
            </Button>
          )}
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-3 py-4" aria-busy="true" aria-label={t('loading_source_voucher')}>
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-2/3" />
          </div>
        ) : (
          // One tree whether or not the underlag shows, so opening the pane
          // never remounts the form (and loses what was typed). Without it
          // both wrappers are display: contents and the banners and the form
          // sit in the dialog's own grid exactly as before.
          <div
            className={
              paneOpen
                ? 'grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]'
                : 'contents'
            }
          >
            {paneOpen && shown && (
              // Sticky on a wide screen while the form scrolls, with a fixed
              // height; above the form on a narrow one.
              <div
                id={paneId}
                className="flex min-w-0 flex-col gap-3 xl:sticky xl:top-0 xl:h-[min(72vh,calc(100dvh-15rem))] xl:self-start"
              >
                {underlag.length > 1 && (
                  <SegmentedControl
                    aria-label={t('underlag_pane_switch')}
                    value={shown.id}
                    onChange={setPickedUnderlagId}
                    options={underlag.map((u) => ({
                      value: u.id,
                      label: (
                        <span className="max-w-36 truncate" title={u.fileName} data-ph-mask="">
                          {u.fileName}
                        </span>
                      ),
                    }))}
                    className="max-w-full self-start overflow-x-auto"
                  />
                )}
                {/* The one object in the dialog: the raised surface. */}
                <DocumentViewerPane
                  documentId={shown.id}
                  mime={shown.mime}
                  fileName={shown.fileName}
                  className="h-[45vh] rounded-lg bg-control shadow-raised xl:h-auto xl:min-h-0 xl:flex-1"
                />
              </div>
            )}
            <div className={paneOpen ? 'min-w-0 space-y-5' : 'contents'}>
              {copyPrefill && (
                <div className="flex items-start gap-3 rounded-lg p-3 text-sm bg-control shadow-raised">
                  <Square2StackIcon className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
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
                <div className="flex items-start gap-3 rounded-lg p-3 text-sm bg-control shadow-raised">
                  <LinkIcon className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
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
                onHasContentChange={setHasUnsavedInput}
                onUploadedFilesChange={setUploadedFiles}
              />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
