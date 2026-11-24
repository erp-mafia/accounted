'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { useViewerLock } from '@/components/ui/viewer-lock'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { DestructiveConfirmDialog } from '@/components/ui/destructive-confirm-dialog'
import useSWR from 'swr'
import { BuildingLibraryIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, InboxIcon, LightBulbIcon } from '@/components/icons'
import JournalEntryForm from '@/components/bookkeeping/JournalEntryForm'
import DocumentViewerPane from '@/components/bookkeeping/DocumentViewerPane'
import DocumentUploadZone from '@/components/bookkeeping/DocumentUploadZone'
import type { UploadedFile } from '@/components/bookkeeping/DocumentUploadZone'
import InboxDocumentPicker, { type AvailableInboxDoc } from '@/components/bookkeeping/InboxDocumentPicker'
import { useHeldUnderlag } from '@/components/transactions/use-held-underlag'
import { bankRowInitialLines } from '@/components/transactions/bank-row-lines'
import { HeldUnderlagRows } from '@/components/transactions/HeldUnderlagRows'
import { resolveAccount } from '@/lib/cash-accounts/resolve-account'
import { useCashAccounts } from '@/lib/reference-data/hooks'
import { formatCurrency, formatDate } from '@/lib/utils'
import { BOOKING_SCREEN_PATH, bookingScreenHref, bookingScreenOrigin } from '@/lib/bookkeeping/booking-screen'
import { bookingWalk, toBookAmountLabel, toBookFilterOfBack, toBookScreenSubject, type ToBookRow } from '@/lib/bookkeeping/to-book'
import { focusKeyAction, focusPosition, neighbour } from '@/lib/inkorg/focus'
import { isEditableTarget, isOverlayBlocking } from '@/lib/hooks/detail-pager-guards'
import { categorizeBodyFor, type BookingProposal } from '@/lib/bookkeeping/proposal'
import { rowProposal, type SuggestedTemplate } from '@/lib/transactions/category-suggestions'
import { fetchProposalPreview } from '@/lib/hooks/use-proposal-preview'
import { proposalLinesToFormLines, type ProposalLine } from '@/lib/bookkeeping/proposal-lines'
import { takePickedProposal } from '@/lib/bookkeeping/booking-screen-pick'
import { suggestionToFill } from '@/lib/transactions/booking-screen-fill'
import { useProposalWhy } from '@/components/transactions/proposal-why'
import { useToBookRows } from './use-to-book-rows'
import { useClaimNavRow } from '@/components/dashboard/nav-row-claim'
import type { Transaction } from '@/types'

// The row may already have its verifikat (imported bookkeeping, a salary
// run): the matcher Bankrader uses, loaded when it is opened.
const MatchVoucherDialog = dynamic(() =>
  import('@/components/transactions/MatchVoucherDialog').then((module) => module.MatchVoucherDialog),
)

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
  /** The inbox document found for the bank row (Kvitto hittat), held as its underlag until Bokför. */
  found: AvailableInboxDoc | null
  /** The found document was asked for but could not be read: the screen says so. */
  foundFailed?: boolean
  /** A proposal the person picked beside the row waits (booking-screen-pick.ts): the screen opens with it used. */
  picked?: boolean
  /** The page to return to (the list with its filters), checked by safeReturnPath. */
  back: string | null
}

export function BookingScreen({ transaction, account, found, foundFailed = false, picked = false, back }: BookingScreenProps) {
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
    '/': t('back_home'),
  }[origin]

  const amountLabel = transaction
    ? `${transaction.amount > 0 ? '+' : ''}${formatCurrency(transaction.amount, transaction.currency)}`
    : null

  // Opened from Att bokföra: the screen steps through the list's bank rows
  // (J, K, Esc) until the person types, and Bokför opens the next one.
  const [touched, setTouched] = useState(false)
  const walk = useBookingWalk(transaction && !transaction.journal_entry_id && canWrite ? transaction.id : null, back, backHref)
  const walking = walk.position !== null
  useEffect(() => {
    if (!walking || touched) return
    const onKey = (e: KeyboardEvent) => {
      const action = focusKeyAction({
        key: e.key,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        targetIsEditable: isEditableTarget(e.target),
        overlayOpen: isOverlayBlocking(document),
      })
      const target = action === 'next' ? walk.nextHref : action === 'previous' ? walk.previousHref : action === 'back' ? backHref : null
      if (!target) return
      e.preventDefault()
      router.push(target)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [walking, touched, walk.nextHref, walk.previousHref, backHref, router])

  return (
    // A keystroke in the form is work the keys must not throw away.
    <div className="space-y-6" onInputCapture={() => setTouched(true)}>
      <PageHeader
        title={t('title')}
        parent={{ label: backLabel, href: backHref }}
        action={
          walk.position ? (
            <div className="flex items-center gap-2">
              {!touched && <span className="hidden text-xs text-muted-foreground lg:inline">{t('walk_keys_hint')}</span>}
              <Button
                variant="outline"
                size="icon-toolbar"
                aria-label={t('walk_previous')}
                disabled={!walk.previousHref}
                onClick={() => walk.previousHref && router.push(walk.previousHref)}
              >
                <ChevronLeftIcon className="h-4 w-4" />
              </Button>
              <span className="whitespace-nowrap text-sm tabular-nums text-strong">
                {t('walk_position', { index: walk.position.index, total: walk.position.total })}
              </span>
              <Button
                variant="outline"
                size="icon-toolbar"
                aria-label={t('walk_next')}
                disabled={!walk.nextHref}
                onClick={() => walk.nextHref && router.push(walk.nextHref)}
              >
                <ChevronRightIcon className="h-4 w-4" />
              </Button>
            </div>
          ) : undefined
        }
        // The bank row is named once: in the Betalning strip while it is
        // being booked, here when the page shows it booked or read-only.
        meta={
          transaction && (transaction.journal_entry_id || !canWrite) ? (
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
          found={found}
          foundFailed={foundFailed}
          picked={picked}
          amountLabel={amountLabel ?? ''}
          nextUp={walk.afterRow}
          onTouched={() => setTouched(true)}
          onDone={walk.afterBooked}
        />
      ) : (
        <VoucherBooking onDone={() => router.push(backHref)} />
      )}
    </div>
  )
}

/**
 * Where the screen is in Att bokföra's list, when it was opened from there
 * (the return address names the list and its filter): the position, the rows
 * before and after it, and where Bokför leads (the next row, else the one
 * before, else back to the list). The rows are the list's own read, shared
 * through its cache. Opened from anywhere else, there is nothing to step to.
 */
function useBookingWalk(transactionId: string | null, back: string | null, backHref: string) {
  const router = useRouter()
  const filter = toBookFilterOfBack(back)
  const { rows, refreshBankRows } = useToBookRows({ enabled: filter !== null && transactionId !== null, cachedOnly: true })
  const walk = useMemo(() => (filter ? bookingWalk(rows, filter) : []), [rows, filter])
  const position = focusPosition(walk, transactionId)
  const previousId = position && transactionId ? neighbour(walk, transactionId, -1) : null
  const nextId = position && transactionId ? neighbour(walk, transactionId, 1) : null
  const afterId = nextId ?? previousId
  // A row opens as the list opens it: with the receipt found for it.
  const hrefOf = (id: string | null) => {
    if (!id) return null
    const row = rows.find((r) => r.transactionId === id)
    return bookingScreenHref(row ? toBookScreenSubject(row) : { kind: 'transaction', transactionId: id, account: null }, back)
  }
  return {
    position,
    previousHref: hrefOf(previousId),
    nextHref: hrefOf(nextId),
    afterRow: afterId ? (rows.find((r) => r.transactionId === afterId) ?? null) : null,
    afterBooked: () => {
      // The booked row leaves the list: read it again, and go on meanwhile.
      if (position) void refreshBankRows()
      router.push(hrefOf(afterId) ?? backHref)
    },
  }
}

/**
 * The suggestion Bankrader shows for the row (POST
 * /api/transactions/suggest-categories, picked by rowProposal), or null.
 */
function useRowProposal(transactionId: string, enabled: boolean): BookingProposal | null {
  const { data } = useSWR(enabled ? ['booking-screen:proposal', transactionId] : null, async () => {
    const res = await fetch('/api/transactions/suggest-categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction_ids: [transactionId] }),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { template_suggestions?: Record<string, SuggestedTemplate[]> }
    return rowProposal(json.template_suggestions?.[transactionId]) ?? null
  })
  return data ?? null
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
  found,
  foundFailed,
  picked,
  amountLabel,
  nextUp,
  onTouched,
  onDone,
}: {
  transaction: Transaction
  account: string | null
  found: AvailableInboxDoc | null
  foundFailed: boolean
  picked: boolean
  amountLabel: string
  /** The row Bokför opens next, named under the form. */
  nextUp: ToBookRow | null
  /** The person changed the kontering: the screen's keys stop browsing. */
  onTouched: () => void
  onDone: () => void
}) {
  const t = useTranslations('booking_screen')
  const { toast } = useToast()
  const dropSurfaceRef = useRef<HTMLDivElement>(null)
  const [inboxPickerOpen, setInboxPickerOpen] = useState(false)
  const [matchOpen, setMatchOpen] = useState(false)

  // The row's own underlag and everything attached here, through the same
  // hook as the booking dialog: the first document attached is pinned to the
  // row at once, so leaving the page keeps it. The receipt found for the row
  // starts attached but only held: opening or stepping past the row writes
  // nothing, and Bokför links it to the verifikat, which takes it out of the
  // inbox.
  const attachments = useHeldUnderlag({
    transactionId: transaction.id,
    rowDocumentId: transaction.document_id ?? null,
    open: true,
    found,
  })
  const foundHeld = found !== null && attachments.attached.inboxDocs.some((d) => d.inbox_item_id === found.inbox_item_id)
  const { underlag, claimUpload } = attachments
  const uploadedFiles = attachments.attached.files
  const viewer = attachments.shown

  const { cashAccounts, isLoading: cashAccountsLoading } = useCashAccounts()
  const { bankAccount, bankAccountName } = useMemo(() => {
    if (cashAccountsLoading) return { bankAccount: null as string | null, bankAccountName: null as string | null }
    const { account: ledger } = resolveAccount(cashAccounts, transaction.cash_account_id ?? null, transaction.currency ?? 'SEK')
    const matched =
      cashAccounts.find((a) => a.id === transaction.cash_account_id) ?? cashAccounts.find((a) => a.ledger_account === ledger)
    return { bankAccount: ledger, bankAccountName: matched?.name ?? null }
  }, [transaction, cashAccounts, cashAccountsLoading])

  // The row's suggestion, the one Bankrader shows, when the person has not
  // picked an account already. It fills the grid with the lines the
  // suggestion books (POST /api/bookkeeping/proposal-preview, as Bankrader's
  // review does): by itself when the screen opens (suggestionToFill), or on
  // Använd when it was not filled. The person still checks it and books.
  const proposal = useRowProposal(transaction.id, account === null)
  const whyFor = useProposalWhy()
  const [used, setUsed] = useState<{ proposal: BookingProposal; lines: ProposalLine[]; filled: boolean } | null>(null)
  const [applying, setApplying] = useState(false)
  const [filling, setFilling] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  // The person has begun on the kontering (any press, key or focus in it):
  // a suggestion is no longer filled in over it.
  const personStarted = useRef(false)
  const markStarted = () => {
    personStarted.current = true
  }
  const fillTried = useRef(false)
  const applyProposal = async (chosen: BookingProposal, filled = false) => {
    if (!filled) {
      markStarted()
      onTouched()
    }
    const setBusy = filled ? setFilling : setApplying
    setBusy(true)
    setApplyError(null)
    try {
      const lines = await fetchProposalPreview({ transaction_id: transaction.id, booking: categorizeBodyFor(chosen) })
      // Begun while the lines were read: what the person did stays.
      if (filled && personStarted.current) return
      if (lines.length > 0) setUsed({ proposal: chosen, lines, filled })
      else if (!filled) setApplyError(t('offer_failed'))
    } catch {
      // A fill nobody asked for fails quietly: the suggestion stays offered.
      if (!filled) setApplyError(t('offer_failed'))
    } finally {
      setBusy(false)
    }
  }
  const applySuggestion = () => (proposal ? applyProposal(proposal) : undefined)

  // A template or counterpart picked beside the row in Bankrader: used at
  // once, as a pick in the quick review was. Taken once, so a reload or the
  // next row opens with the screen's own suggestion.
  // The form waits for it: booking before its lines land would skip the pick.
  const pickTaken = useRef(false)
  const [pickPending, setPickPending] = useState(picked)
  useEffect(() => {
    if (!picked || pickTaken.current) return
    pickTaken.current = true
    const chosen = takePickedProposal(transaction.id)
    if (!chosen) {
      setPickPending(false)
      return
    }
    void applyProposal(chosen).finally(() => setPickPending(false))
    // Once, on opening: the pick is the row's when the screen opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The row's own suggestion, filled in once when it arrives, into the
  // kontering as it opened. After the pick above, which runs first.
  useEffect(() => {
    const chosen = suggestionToFill({
      suggestion: proposal,
      personStarted: personStarted.current,
      filledOrTried: fillTried.current || used !== null || applying || filling || pickPending,
    })
    if (!chosen) return
    fillTried.current = true
    void applyProposal(chosen, true)
    // Run when the suggestion arrives or a pick settles; the refs and
    // suggestionToFill keep it to once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal, pickPending])

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

  // The inbox is another way in beside "Ladda upp", on the zone's own line.
  const pickFromInbox = (
    <Button variant="ghost" onClick={() => setInboxPickerOpen(true)}>
      <InboxIcon className="h-4 w-4" />
      {t('doc_pick_inbox')}
    </Button>
  )
  // No document yet: the underlag is one line over the kontering, which then
  // takes the width; a document, once there, shows beside it.
  const shownDocumentId = viewer.documentId
  const hasDocument = shownDocumentId != null

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
        {/* A row whose verifikat already exists is matched to it, not booked again. */}
        <p className="text-xs text-muted-foreground">
          {t('match_existing_lead')}{' '}
          <button type="button" className={QUIET_LINK_CLASS} onClick={() => setMatchOpen(true)}>
            {t('match_existing_action')}
          </button>
        </p>
      </section>
      {matchOpen && (
        <MatchVoucherDialog
          open
          onOpenChange={(open) => {
            if (!open) setMatchOpen(false)
          }}
          transaction={transaction}
          onLinked={(_transactionId, journalEntryId) => {
            setMatchOpen(false)
            void handleBooked(journalEntryId)
          }}
        />
      )}

      {!hasDocument && (
        <section aria-labelledby="booking-screen-underlag-line" className="space-y-2">
          <SectionLabel id="booking-screen-underlag-line">{t('underlag_label')}</SectionLabel>
          <DocumentUploadZone
            files={uploadedFiles}
            onFilesChange={attachments.onFilesChange}
            onUploaded={claimUpload}
            compact
            dropSurfaceRef={dropSurfaceRef}
            actions={pickFromInbox}
          />
          {foundFailed && <p className="text-sm text-foreground/80">{t('underlag_found_failed')}</p>}
        </section>
      )}

      <BookingColumns
        dropSurfaceRef={dropSurfaceRef}
        split={hasDocument}
        underlag={
          hasDocument ? (
            <>
              {foundHeld && <p className="text-xs text-muted-foreground">{t('underlag_found_held')}</p>}
              <DocumentViewerPane
                documentId={shownDocumentId}
                mime={viewer.mime}
                fileName={viewer.fileName}
                className="h-[60vh] rounded-lg bg-control shadow-raised lg:h-auto lg:min-h-0 lg:flex-1"
              />
              <HeldUnderlagRows
                attachments={attachments}
                onDetachEarlier={() => void detachEarlierUnderlag()}
                dropSurfaceRef={dropSurfaceRef}
                actions={pickFromInbox}
              />
            </>
          ) : null
        }
        kontering={
          bankAccount !== null ? (
            // A press, key or focus here is the person's: a suggestion still
            // on its way is not filled in over it.
            <div className="space-y-3" onPointerDownCapture={markStarted} onKeyDownCapture={markStarted} onFocusCapture={markStarted}>
              {used ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <CheckIcon className="h-4 w-4 text-success" aria-hidden="true" />
                  <span className="text-foreground/80">{t('offer_used', { name: used.proposal.name_sv })}</span>
                  {/* Filled without a press: the why the offer showed stays beside it. */}
                  {used.filled && <span className="text-xs text-muted-foreground">{whyFor(used.proposal)}</span>}
                  <Button variant="ghost" onClick={() => setUsed(null)}>
                    {t('offer_undo')}
                  </Button>
                </div>
              ) : filling ? (
                <p className="text-sm text-muted-foreground">{t('offer_applying')}</p>
              ) : proposal ? (
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-control px-3 py-2 text-sm shadow-raised">
                    <LightBulbIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="flex min-w-0 flex-col">
                      <span className="text-strong">{t('offer_label', { name: proposal.name_sv })}</span>
                      <span className="text-xs text-muted-foreground">{whyFor(proposal)}</span>
                    </span>
                    <Button variant="outline" className="ml-auto" loading={applying} onClick={() => void applySuggestion()}>
                      {t('offer_use')}
                    </Button>
                  </div>
                  {applyError && <p className="text-xs text-destructive">{applyError}</p>}
                </div>
              ) : applying ? (
                <p className="text-sm text-muted-foreground">{t('offer_applying')}</p>
              ) : applyError ? (
                <p className="text-xs text-destructive">{applyError}</p>
              ) : null}
              {!pickPending && (
                <JournalEntryForm
                  key={`${transaction.id}-${bankAccount}-${account ?? 'none'}-${used ? used.proposal.template_id : 'own'}`}
                  embedded
                  onPage
                  initialLines={
                    used
                      ? proposalLinesToFormLines(used.lines, {
                          settlementAccount: bankAccount,
                          currency: transaction.currency,
                          foreignAmount: Math.abs(transaction.amount),
                          exchangeRate: transaction.exchange_rate,
                          lineDescription: used.proposal.name_sv,
                          settlementLineDescription: bankAccountName ?? t('bank_line_description'),
                        })
                      : bankRowInitialLines(transaction, bankAccountName ?? t('bank_line_description'), bankAccount, account)
                  }
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
              )}
              {nextUp && (
                <p className="text-xs text-muted-foreground" data-ph-mask="">
                  {t('walk_next_up', {
                    name: nextUp.name,
                    date: nextUp.date ? formatDate(nextUp.date) : '',
                    amount: toBookAmountLabel(nextUp),
                  })}
                </p>
              )}
            </div>
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
            onPage
            onEntryCreated={() => onDone()}
            onUploadedFilesChange={setUploadedFiles}
            uploadDropSurfaceRef={dropSurfaceRef}
          />
        }
      />
    </>
  )
}
