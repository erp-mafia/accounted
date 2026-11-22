'use client'

import { useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { useViewerLock } from '@/components/ui/viewer-lock'
import { DestructiveConfirmDialog } from '@/components/ui/destructive-confirm-dialog'
import { BuildingLibraryIcon, InboxIcon } from '@/components/icons'
import JournalEntryForm from '@/components/bookkeeping/JournalEntryForm'
import DocumentViewerPane from '@/components/bookkeeping/DocumentViewerPane'
import DocumentUploadZone from '@/components/bookkeeping/DocumentUploadZone'
import type { UploadedFile } from '@/components/bookkeeping/DocumentUploadZone'
import InboxDocumentPicker from '@/components/bookkeeping/InboxDocumentPicker'
import { useHeldUnderlag } from '@/components/transactions/use-held-underlag'
import { bankRowInitialLines } from '@/components/transactions/bank-row-lines'
import UnderlagFileRow from '@/components/transactions/UnderlagFileRow'
import { resolveAccount } from '@/lib/cash-accounts/resolve-account'
import { useCashAccounts } from '@/lib/reference-data/hooks'
import { formatCurrency, formatDate } from '@/lib/utils'
import { BOOKING_SCREEN_PATH, bookingScreenOrigin } from '@/lib/bookkeeping/booking-screen'
import { useClaimNavRow } from '@/components/dashboard/nav-row-claim'
import type { Transaction } from '@/types'

/**
 * The booking screen (/bokfor): one full page for booking, in the order the
 * person reads it. The betalning on top (the bank row, or the line saying
 * there is none), the underlag on the left and the kontering on the right,
 * with the form's own review step stating the verifikat before anything
 * posts.
 *
 * It books through the same doors as the dialogs it stands in for: a bank
 * row through POST /api/transactions/[id]/book with the row's underlag held
 * and linked as TransactionBookingDialog does (useTransactionUnderlag,
 * underlagLinkTargets), and a verifikat without a bank row through the
 * form's default door with the form's own upload zone, as
 * NewJournalEntryDialog does.
 */
export interface BookingScreenProps {
  /** The bank row to book; null for a new verifikation with no bank row. */
  transaction: Transaction | null
  /** A counter account the person already picked before opening the screen. */
  account: string | null
  /** The page to return to (the list with its filters), checked by safeReturnPath. */
  back: string | null
}

export function BookingScreen({ transaction, account, back }: BookingScreenProps) {
  const t = useTranslations('booking_screen')
  const router = useRouter()
  const { canWrite, lockedTitle } = useViewerLock()

  // The way back is named after the page the screen was opened from, and
  // that page's menu row stays lit: from Att bokföra the person is still in
  // Att göra, not moved to Bokföring.
  const origin = bookingScreenOrigin(back, transaction !== null)
  useClaimNavRow(BOOKING_SCREEN_PATH, origin)
  const backHref = back ?? origin
  const backLabel = {
    '/att-bokfora': t('back_to_book'),
    '/transactions': t('back_transactions'),
    '/bookkeeping': t('back_vouchers'),
  }[origin]

  const amountLabel = transaction
    ? `${transaction.amount > 0 ? '+' : ''}${formatCurrency(transaction.amount, transaction.currency)}`
    : null

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        parent={{ label: backLabel, href: backHref }}
        meta={
          transaction ? (
            <span data-ph-mask="">
              {[transaction.description, formatDate(transaction.date), amountLabel].filter(Boolean).join(' · ')}
            </span>
          ) : undefined
        }
      />

      {transaction?.journal_entry_id ? (
        <p className="text-sm">
          {t('already_booked')}{' '}
          <Link href={`/bookkeeping/${transaction.journal_entry_id}`} className="font-medium text-strong underline decoration-foreground/25 underline-offset-[3px] hover:decoration-foreground/60">
            {t('open_voucher')}
          </Link>
        </p>
      ) : !canWrite ? (
        <p className="text-sm text-muted-foreground">{lockedTitle}</p>
      ) : transaction ? (
        <TransactionBooking
          transaction={transaction}
          account={account}
          amountLabel={amountLabel ?? ''}
          onDone={() => router.push(backHref)}
        />
      ) : (
        <VoucherBooking onDone={() => router.push(backHref)} />
      )}
    </div>
  )
}

/** The section label used on the screen: 12px/500 in the muted ink. */
function SectionLabel({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="text-xs font-medium text-muted-foreground">
      {children}
    </h2>
  )
}

/** The two-column body: the underlag on the left, sticky on a wide screen while the kontering scrolls. */
function BookingColumns({
  underlag,
  kontering,
  dropSurfaceRef,
  split = true,
}: {
  underlag: React.ReactNode
  kontering: React.ReactNode
  dropSurfaceRef?: React.RefObject<HTMLDivElement | null>
  /**
   * The underlag column beside the kontering. Off, the kontering takes the
   * width (a new verifikation before a file is added). The kontering keeps
   * its place in the tree either way, so splitting never remounts the form
   * and loses what was typed.
   */
  split?: boolean
}) {
  const t = useTranslations('booking_screen')
  return (
    <div
      ref={dropSurfaceRef}
      className={split ? 'grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]' : 'grid grid-cols-1 gap-8'}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => e.preventDefault()}
    >
      {split ? (
        <section
          aria-labelledby="booking-screen-underlag"
          className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-16 lg:h-[calc(100dvh-11rem)] lg:self-start"
        >
          <SectionLabel id="booking-screen-underlag">{t('underlag_label')}</SectionLabel>
          {underlag}
        </section>
      ) : null}
      <section aria-labelledby="booking-screen-kontering" className="min-w-0 space-y-3">
        <SectionLabel id="booking-screen-kontering">{t('kontering_label')}</SectionLabel>
        {kontering}
      </section>
    </div>
  )
}

function TransactionBooking({
  transaction,
  account,
  amountLabel,
  onDone,
}: {
  transaction: Transaction
  account: string | null
  amountLabel: string
  onDone: () => void
}) {
  const t = useTranslations('booking_screen')
  const tUnderlag = useTranslations('tx_booking_underlag')
  const tDetach = useTranslations('tx_detach')
  const { toast } = useToast()
  const dropSurfaceRef = useRef<HTMLDivElement>(null)
  const [inboxPickerOpen, setInboxPickerOpen] = useState(false)

  // The row's own underlag and everything attached here, through the same
  // hook as the booking dialog: the first document attached is pinned to the
  // row at once, so leaving the page keeps it.
  const attachments = useHeldUnderlag({
    transactionId: transaction.id,
    rowDocumentId: transaction.document_id ?? null,
    open: true,
  })
  const { underlag, claimUpload, letGo } = attachments
  const uploadedFiles = attachments.attached.files
  const pickedInboxDocs = attachments.attached.inboxDocs
  const viewer = attachments.shown

  const { cashAccounts, isLoading: cashAccountsLoading } = useCashAccounts()
  const { bankAccount, bankAccountName } = useMemo(() => {
    if (cashAccountsLoading) return { bankAccount: null as string | null, bankAccountName: null as string | null }
    const { account: ledger } = resolveAccount(cashAccounts, transaction.cash_account_id ?? null, transaction.currency ?? 'SEK')
    const matched =
      cashAccounts.find((a) => a.id === transaction.cash_account_id) ?? cashAccounts.find((a) => a.ledger_account === ledger)
    return { bankAccount: ledger, bankAccountName: matched?.name ?? null }
  }, [transaction, cashAccounts, cashAccountsLoading])

  const detachEarlierUnderlag = () =>
    attachments.detachEarlier({
      description: transaction.description,
      amount: formatCurrency(transaction.amount, transaction.currency),
    })

  // Everything attached here goes onto the verifikat (the new one, or the
  // existing one the duplicate guard matched the row to), as in the dialog.
  const handleBooked = async (journalEntryId: string) => {
    const { failed } = await attachments.link(journalEntryId, transaction.id)
    if (failed.length > 0) {
      toast({
        title: t('doc_link_failed_title'),
        description: t('doc_link_failed_description', { count: failed.length }),
        variant: 'destructive',
      })
    }
    onDone()
  }

  const pickFromInbox = (
    <Button variant="ghost" className="-ml-2.5 self-start" onClick={() => setInboxPickerOpen(true)}>
      <InboxIcon className="h-4 w-4" />
      {t('doc_pick_inbox')}
    </Button>
  )

  return (
    <>
      <section aria-labelledby="booking-screen-betalning" className="space-y-2">
        <SectionLabel id="booking-screen-betalning">{t('payment_label')}</SectionLabel>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-control px-3 py-2 text-sm shadow-raised">
          <BuildingLibraryIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="font-medium text-strong">{bankAccountName ?? bankAccount ?? t('bank_line_description')}</span>
          <span className="date-figures text-muted-foreground">{formatDate(transaction.date)}</span>
          <span className="min-w-0 truncate text-muted-foreground" data-ph-mask="">
            {transaction.description}
          </span>
          <span className="ml-auto tabular-nums text-strong" data-ph-mask="">
            {amountLabel}
          </span>
        </div>
      </section>

      <BookingColumns
        dropSurfaceRef={dropSurfaceRef}
        underlag={
          <>
            {viewer.documentId ? (
              <DocumentViewerPane
                documentId={viewer.documentId}
                mime={viewer.mime}
                fileName={viewer.fileName}
                className="h-[60vh] rounded-lg bg-control shadow-raised lg:h-auto lg:min-h-0 lg:flex-1"
              />
            ) : (
              <DocumentUploadZone
                files={uploadedFiles}
                onFilesChange={attachments.onFilesChange}
                onUploaded={claimUpload}
                dropSurfaceRef={dropSurfaceRef}
              />
            )}
            {/* Once a document shows, one compact zone for more (the only
                zone then, so a drop is handled once), the rows that can
                be taken off, and the inbox pick. */}
            {viewer.documentId ? (
              <div className="flex shrink-0 flex-col gap-2">
                {attachments.ownFromBefore && (
                  <UnderlagFileRow
                    name={underlag.fileName ?? tUnderlag('file_fallback')}
                    removeLabel={tDetach('menu_item')}
                    disabled={underlag.busy}
                    onRemove={() => void detachEarlierUnderlag()}
                  />
                )}
                <DocumentUploadZone
                  files={uploadedFiles}
                  onFilesChange={attachments.onFilesChange}
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
              </div>
            ) : null}
            {pickFromInbox}
          </>
        }
        kontering={
          bankAccount !== null ? (
            <JournalEntryForm
              key={`${transaction.id}-${bankAccount}-${account ?? 'none'}`}
              embedded
              initialLines={bankRowInitialLines(transaction, bankAccountName ?? t('bank_line_description'), bankAccount, account)}
              initialDate={transaction.date}
              initialDescription={transaction.description}
              submitUrl={`/api/transactions/${transaction.id}/book`}
              sourceType="bank_transaction"
              sourceId={transaction.id}
              seriesPicker
              cashAccountId={transaction.cash_account_id ?? null}
              onEntryCreated={(entryId) => void handleBooked(entryId)}
              duplicateMatchTransaction={{
                id: transaction.id,
                cash_account_id: transaction.cash_account_id ?? null,
                currency: transaction.currency ?? 'SEK',
              }}
              onDuplicateMatched={(journalEntryId) => void handleBooked(journalEntryId)}
            />
          ) : null
        }
      />

      <InboxDocumentPicker
        open={inboxPickerOpen}
        onClose={() => setInboxPickerOpen(false)}
        onSelect={attachments.pickInboxDoc}
      />
      <DestructiveConfirmDialog {...underlag.confirmProps} />
    </>
  )
}

function VoucherBooking({ onDone }: { onDone: () => void }) {
  const t = useTranslations('booking_screen')
  // The form keeps its own upload zone and links the files after posting
  // (as in NewJournalEntryDialog); the screen shows the first one beside it
  // and lets a file dropped anywhere on it reach that zone.
  const dropSurfaceRef = useRef<HTMLDivElement>(null)
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([])
  const shown = uploadedFiles.find((f) => f.status === 'uploaded' && f.id)

  return (
    <>
      <section aria-labelledby="booking-screen-betalning" className="space-y-2">
        <SectionLabel id="booking-screen-betalning">{t('payment_label')}</SectionLabel>
        <p className="text-sm text-muted-foreground">{t('payment_none')}</p>
      </section>

      <BookingColumns
        dropSurfaceRef={dropSurfaceRef}
        split={!!shown?.id}
        underlag={
          shown?.id ? (
            <DocumentViewerPane
              documentId={shown.id}
              mime={shown.file.type || null}
              fileName={shown.fileName}
              className="h-[60vh] rounded-lg bg-control shadow-raised lg:h-auto lg:min-h-0 lg:flex-1"
            />
          ) : null
        }
        kontering={
          <JournalEntryForm
            bare
            onEntryCreated={() => onDone()}
            onUploadedFilesChange={setUploadedFiles}
            uploadDropSurfaceRef={dropSurfaceRef}
          />
        }
      />
    </>
  )
}
