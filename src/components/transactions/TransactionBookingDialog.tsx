'use client'

import { useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogVeil, holdEscapeWhileUnsaved, useDashShellInert, useEditedSinceOpen } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { DestructiveConfirmDialog } from '@/components/ui/destructive-confirm-dialog'
import { Button } from '@/components/ui/button'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { InboxIcon } from '@/components/icons'
import JournalEntryForm from '@/components/bookkeeping/JournalEntryForm'
import DocumentViewerPane from '@/components/bookkeeping/DocumentViewerPane'
import DocumentUploadZone from '@/components/bookkeeping/DocumentUploadZone'
import InboxDocumentPicker from '@/components/bookkeeping/InboxDocumentPicker'
import type { FormLine } from '@/components/bookkeeping/JournalEntryForm'
import { useHeldUnderlag } from './use-held-underlag'
import { bankRowInitialLines } from './bank-row-lines'
import UnderlagFileRow from './UnderlagFileRow'
import { resolveSekAmount, buildCurrencyMetadata } from '@/lib/bookkeeping/currency-utils'
import { applyTemplate } from '@/lib/bookkeeping/template-library'
import { bankSideOf, templateBankLeg } from '@/lib/bookkeeping/bank-leg'
import { proposalLinesToFormLines } from '@/lib/bookkeeping/proposal-lines'
import type { ProposalLine } from '@/lib/bookkeeping/proposal-lines'
import type { BookingTemplateLibrary } from '@/types'
import type { TransactionWithInvoice } from './transaction-types'
import { resolveAccount } from '@/lib/cash-accounts/resolve-account'
import { useCashAccounts } from '@/lib/reference-data/hooks'

interface TransactionBookingDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  transaction: TransactionWithInvoice | null
  onBooked: (
    transactionId: string,
    journalEntryId: string,
    attachedDocumentId?: string | null,
    /** True when the transaction was LINKED to an existing voucher via the
     *  duplicate guard's match action: no new verifikat was created. */
    matched?: boolean,
  ) => void
  preselectedTemplate?: BookingTemplateLibrary | null
  /**
   * "Andra rader" hand-off from a proposal view (QuickReviewDialog): the
   * COMPUTED lines the user was shown, prefilled for per-line editing. Takes
   * precedence over preselectedTemplate. The settlement leg's account is
   * swapped for the transaction's resolved cash account, same as the
   * library-template path.
   */
  proposalLines?: ProposalLine[] | null
  /** Radtext for the business lines of a proposal handed over from the review. */
  proposalLineDescription?: string | null
  /** Account number (string, e.g. '5460') to prefill on the counter line:
   *  set when the user picked an account from the template picker's "Konton"
   *  search results. Ignored when a preselectedTemplate is present. */
  preselectedAccount?: string | null
  /** The row's own underlag was pinned here, or taken off (null): the page keeps its rows in step. */
  onUnderlagChange?: (transactionId: string, documentId: string | null) => void
}

function buildInitialLinesFromTemplate(
  transaction: TransactionWithInvoice,
  template: BookingTemplateLibrary,
  bankAccount: string = '1930',
): FormLine[] {
  const sekAmount = Math.round(Math.abs(resolveSekAmount(
    transaction.amount,
    transaction.amount_sek,
    transaction.currency,
    transaction.exchange_rate
  )) * 100) / 100
  const lines = applyTemplate(template.lines, sekAmount)

  const isForeign = !!transaction.currency && transaction.currency !== 'SEK'
  const currencyMeta = isForeign
    ? buildCurrencyMetadata(
        transaction.currency,
        Math.abs(transaction.amount),
        transaction.exchange_rate
      )
    : {}

  // The mall books the accounts it was saved with; only its bank line moves
  // to the bank this transaction came from (templateBankLeg). The FX
  // metadata goes on that line.
  const bankLeg = templateBankLeg(template.lines, bankSideOf(transaction.amount), bankAccount)
  return lines.map((line, i) => {
    if (i !== bankLeg?.index) return line
    return {
      ...line,
      ...(isForeign ? currencyMeta : {}),
      ...(bankLeg.moves ? { account_number: bankAccount } : {}),
    }
  })
}

export default function TransactionBookingDialog({
  open,
  onOpenChange,
  transaction,
  onBooked,
  preselectedTemplate,
  proposalLines,
  proposalLineDescription,
  preselectedAccount,
  onUnderlagChange,
}: TransactionBookingDialogProps) {
  const t = useTranslations('tx_booking_dialog')
  const tUnderlag = useTranslations('tx_booking_underlag')
  const tDetach = useTranslations('tx_detach')
  const { toast } = useToast()
  // The whole dialog takes a dropped file, not only the dashed box.
  const dropSurfaceRef = useRef<HTMLDivElement>(null)
  const [inboxPickerOpen, setInboxPickerOpen] = useState(false)
  // The transaction's own underlag and everything attached here, as on the
  // booking screen (one hook for both): the first document attached here is
  // pinned to the row at once, so closing the dialog keeps it (crm#1101).
  const attachments = useHeldUnderlag({
    transactionId: transaction?.id ?? null,
    rowDocumentId: transaction?.document_id ?? null,
    open,
    onChange: onUnderlagChange,
  })
  const { underlag, held, claimUpload, letGo } = attachments
  const uploadedFiles = attachments.attached.files
  const pickedInboxDocs = attachments.attached.inboxDocs
  // Settlement account for the bank line: resolved from the session-cached
  // cash accounts (seeded by the dashboard layout), so the form below mounts
  // on the first paint instead of after a /api/cash-accounts round trip on
  // every open. null only while the list is genuinely still loading.
  const { cashAccounts, isLoading: cashAccountsLoading } = useCashAccounts()
  const { bankAccount, bankAccountName } = useMemo(() => {
    if (!transaction || cashAccountsLoading) {
      return { bankAccount: null as string | null, bankAccountName: null as string | null }
    }
    const { account } = resolveAccount(
      cashAccounts,
      transaction.cash_account_id ?? null,
      transaction.currency ?? 'SEK',
    )
    // Use the matched account's own name instead of a generic label.
    const matched =
      cashAccounts.find((a) => a.id === transaction.cash_account_id) ??
      cashAccounts.find((a) => a.ledger_account === account)
    return { bankAccount: account, bankAccountName: matched?.name ?? null }
  }, [transaction, cashAccounts, cashAccountsLoading])

  // Non-modal dialog (see below): page modality is restored by hand so the
  // agent sheet stays live. See useDashShellInert in components/ui/dialog.tsx.
  useDashShellInert(open)
  // The form opens filled with the bank row's lines, so "has content" is
  // always true: Escape follows "changed since open" instead.
  const { edited, editProps } = useEditedSinceOpen()

  if (!transaction) return null

  const isIncome = transaction.amount > 0

  const handleBooked = async (transactionId: string, journalEntryId: string, matched = false) => {
    // Everything attached here goes onto the verifikat: the new one, or the
    // existing one the duplicate guard's match linked the row to. The
    // document pinned to the row is among it although the booking and the
    // match anchor the row's pin themselves: linking it again changes
    // nothing, and reports an anchor that failed. Inbox documents picked via
    // InboxDocumentPicker carry their inbox_item_id, which stamps the inbox
    // item as consumed so it drops out of the active inbox (see
    // app/api/documents/[id]/link/route.ts); transaction_id pins the first of
    // them to a row without underlag so the list shows the indicator. A pin
    // or a take-off still on its way lands first, and a document the person
    // removed here is left out.
    const { failed, firstLinkedId, ownUnderlag } = await attachments.link(journalEntryId, transactionId)
    if (failed.length > 0) {
      toast({
        title: t('doc_link_failed_title'),
        description: t('doc_link_failed_description', { count: failed.length }),
        variant: 'destructive',
      })
    }

    // The server pins only when the tx has no document_id yet (first linked
    // doc wins): mirror that here so the optimistic state never claims a
    // pin the server refused to swap. An inkorg match is not a pin.
    const pinnedDocId = ownUnderlag && underlag.source !== 'matched' ? null : firstLinkedId
    if (pinnedDocId) {
      // Same event AgentChat dispatches after uploads: flips the inbox card's
      // paperclip optimistically without a refetch.
      window.dispatchEvent(
        new CustomEvent('Accounted:transaction-document-linked', {
          detail: { transaction_id: transactionId, document_id: pinnedDocId },
        }),
      )
    }

    attachments.clear()
    onBooked(transactionId, journalEntryId, pinnedDocId, matched)
  }

  // The receipt to show beside the form: the row's own underlag (from before
  // this dialog, or the first document attached in it), else the first one
  // held here, as soon as it is available (shownUnderlag).
  const { documentId: viewerDocId, mime: viewerMime, fileName: viewerName } = attachments.shown
  // The row's underlag from before this dialog is in neither list: it gets a
  // row (and an x) of its own.
  const ownFromBefore = attachments.ownFromBefore

  // Every change from the upload zones goes through the hook: the x on a
  // finished upload lets it go, every other change lands on the latest list.
  const handleFilesChange = attachments.onFilesChange

  // The underlag the row had before this dialog is confirmed off, as the
  // row's own "Ta bort underlag" is: it may be a match someone else made.
  const detachEarlierUnderlag = () =>
    attachments.detachEarlier({
      description: transaction.description,
      amount: formatCurrency(transaction.amount, transaction.currency),
    })

  // Secondary intake path beside the upload zone: underlag already in the
  // inkorg, picked instead of uploaded again.
  const pickFromInbox = (
    <Button variant="ghost" className="-ml-2.5 self-start" onClick={() => setInboxPickerOpen(true)}>
      <InboxIcon className="h-4 w-4" />
      {t('doc_pick_inbox')}
    </Button>
  )

  // The header's context line (Stil v3): the row, its date and its amount.
  const contextLine = [
    transaction.description,
    formatDate(transaction.date),
    `${isIncome ? '+' : ''}${formatCurrency(transaction.amount, transaction.currency)}`,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <Dialog open={open} onOpenChange={(o) => {
      if (!o) {
        attachments.clear()
        setInboxPickerOpen(false)
      }
      onOpenChange(o)
    }} modal={false}>
      <DialogVeil />
      <DialogContent
        ref={dropSurfaceRef}
        // A drop anywhere on the dialog is the upload zone's (dropSurfaceRef);
        // once a document is shown instead, the two preventDefaults keep a
        // stray drop from navigating the tab to the file.
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => e.preventDefault()}
        // Stil v3 widths: wide (720px) holds the kontering lines on their
        // own; with a document to read beside them the dialog takes the
        // document size, since a page and a four-column line editor do not
        // fit 720px. The primitive centres every size in the space left of a
        // docked agent sheet, but its document width does not subtract the
        // sheet: capped here so the form's right edge, and the Granska
        // button, never end up unreachable under the sheet (z-60 over z-50).
        // --agent-sheet-w is docked-only, so with the sheet closed this is
        // the primitive's own width.
        size={viewerDocId ? 'document' : 'wide'}
        className={cn(viewerDocId && 'sm:max-w-[min(1120px,calc(100vw-var(--agent-sheet-w,0px)-4rem))]')}
        // Non-modal so the agent sheet (fixed z-[60], portaled outside this
        // dialog) stays interactive beside a booking in progress; a click in
        // its text field must not count as outside-dismissal. Same convention
        // as NewInvoiceDialog (which pairs non-modality with the inert effect
        // above). Escape closes the dialog while nothing has changed since it
        // opened; a half-booked transaction, or underlag held here that only
        // the booking links, survives a stray Escape: then closing is
        // explicit, the header X. A backdrop click never closes it.
        onEscapeKeyDown={(e) =>
          holdEscapeWhileUnsaved(e, edited() || held.files.length > 0 || held.inboxDocs.length > 0)
        }
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          {/* The row's own text and amount: user data in session replays. */}
          <DialogDescription data-ph-mask="">{contextLine}</DialogDescription>
        </DialogHeader>

        <div
          className={
            viewerDocId
              ? 'grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]'
              : 'flex flex-col gap-5'
          }
        >
          {/* The underlag: a section above the form while there is none (the
              upload zone and the inkorg pick, the whole dialog takes a drop),
              and once a document exists its own column beside the form: the
              viewer takes a fixed height and the column stays sticky on
              desktop while the form scrolls, stacked above the form on
              smaller screens. Same underlag as the Bokför review: the first
              document attached is the row's own at once (closing keeps it),
              every one has its x, more can be added. */}
          <div
            className={
              viewerDocId
                ? 'flex flex-col gap-3 lg:sticky lg:top-0 lg:h-[min(72vh,calc(100dvh-15rem))] lg:self-start'
                : 'flex flex-col gap-2'
            }
          >
            {viewerDocId ? (
              // The one object in the dialog: the raised surface.
              <DocumentViewerPane
                documentId={viewerDocId}
                mime={viewerMime}
                fileName={viewerName}
                className="h-[45vh] rounded-lg bg-control shadow-raised lg:h-auto lg:min-h-0 lg:flex-1"
              />
            ) : (
              <>
                <h3 className="text-[12px] font-medium leading-4 text-muted-foreground">{t('doc_label')}</h3>
                <DocumentUploadZone
                  files={uploadedFiles}
                  onFilesChange={handleFilesChange}
                  onUploaded={claimUpload}
                  compact
                  dropSurfaceRef={dropSurfaceRef}
                />
              </>
            )}

            {viewerDocId ? (
              <div className="flex shrink-0 flex-col gap-2">
                {ownFromBefore && (
                  <UnderlagFileRow
                    name={underlag.fileName ?? tUnderlag('file_fallback')}
                    removeLabel={tDetach('menu_item')}
                    disabled={underlag.busy}
                    onRemove={() => void detachEarlierUnderlag()}
                  />
                )}
                <DocumentUploadZone
                  files={uploadedFiles}
                  onFilesChange={handleFilesChange}
                  onUploaded={claimUpload}
                  compact
                  dropSurfaceRef={dropSurfaceRef}
                />
                {pickedInboxDocs.map((doc) => (
                  <UnderlagFileRow
                    key={doc.document_id}
                    name={doc.supplier_name ?? doc.file_name}
                    removeLabel={t('doc_picked_remove')}
                    onRemove={() => void letGo(doc.document_id)}
                  />
                ))}
                {pickFromInbox}
              </div>
            ) : (
              pickFromInbox
            )}
          </div>

          {/* Booking form: its kontering lines and its own Granska step,
              which states the outcome before anything is booked. */}
          <div className="space-y-4" {...editProps}>
            {bankAccount !== null && (
              <JournalEntryForm
                key={`${transaction.id}-${proposalLines && proposalLines.length > 0 ? 'proposal' : preselectedTemplate?.id ?? 'default'}-${preselectedAccount ?? 'none'}-${bankAccount}`}
                embedded
                initialLines={
                  proposalLines && proposalLines.length > 0
                    ? proposalLinesToFormLines(proposalLines, {
                        settlementAccount: bankAccount,
                        currency: transaction.currency,
                        foreignAmount: Math.abs(transaction.amount),
                        exchangeRate: transaction.exchange_rate,
                        businessLineDescription: proposalLineDescription ?? undefined,
                      })
                    : preselectedTemplate
                      ? buildInitialLinesFromTemplate(transaction, preselectedTemplate, bankAccount)
                      : bankRowInitialLines(transaction, bankAccountName ?? t('bank_line_description'), bankAccount, preselectedAccount)
                }
                initialDate={transaction.date}
                initialDescription={transaction.description}
                submitUrl={`/api/transactions/${transaction.id}/book`}
                sourceType="bank_transaction"
                sourceId={transaction.id}
                // Series picker seeded from the bank account's own series
                // (Inställningar → Bokföring → Verifikationsserie per bankkonto).
                seriesPicker
                cashAccountId={transaction.cash_account_id ?? null}
                onEntryCreated={(entryId) => handleBooked(transaction.id, entryId)}
                duplicateMatchTransaction={{
                  id: transaction.id,
                  cash_account_id: transaction.cash_account_id ?? null,
                  currency: transaction.currency ?? 'SEK',
                }}
                // Duplicate guard match: the bank line was linked to an existing
                // voucher (no new entry). Reuse the booked flow so attached
                // documents land on that verifikat and the row leaves the list.
                onDuplicateMatched={(journalEntryId) => handleBooked(transaction.id, journalEntryId, true)}
              />
            )}
          </div>
        </div>

        {/* A pick becomes the row's underlag when it has none (the attach
            route marks the inbox item matched, and the booking consumes it);
            either way handleBooked links it to the verifikat. */}
        <InboxDocumentPicker
          open={inboxPickerOpen}
          onClose={() => setInboxPickerOpen(false)}
          onSelect={attachments.pickInboxDoc}
        />
        <DestructiveConfirmDialog {...underlag.confirmProps} />
      </DialogContent>
    </Dialog>
  )
}
