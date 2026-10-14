'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAccounts, useCompanySettings } from '@/lib/reference-data/hooks'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { activateBasAccounts, pickNeedsActivation } from '@/lib/bookkeeping/bas-catalog-client'
import { useBasCatalog } from '@/lib/hooks/use-bas-catalog'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogVeil, useDashShellInert } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { DestructiveConfirmDialog } from '@/components/ui/destructive-confirm-dialog'
import { ToastAction } from '@/components/ui/toast'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { AttnLine } from '@/components/ui/attn-line'
import { needsUnderlagPrompt, templateVatMismatch, vatDisagrees, vatTreatmentAfterAccountChange } from '@/lib/transactions/underlag-read'
import { linkDocuments, formatFailedDocumentNames } from '@/lib/documents/link-documents'
import { ArrowUpRight, ArrowDownRight, Check, Paperclip, ChevronDown, ChevronUp, Inbox } from 'lucide-react'
import { resolveTemplateAccountsForEntity } from '@/lib/bookkeeping/proposal-lines'
import type { ProposalLine } from '@/lib/bookkeeping/proposal-lines'
import { accountProposal, businessAccount, carriedCategory, categorizeBodyFor, templateBehind, withAccount, type BookingProposal } from '@/lib/bookkeeping/proposal'
import { useProposalPreview } from '@/lib/hooks/use-proposal-preview'
import { useProposalWhy } from './proposal-why'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import JournalEntryPreview from './JournalEntryPreview'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import LineDimensionFields from '@/components/dimensions/LineDimensionFields'
import DocumentUploadZone from '@/components/bookkeeping/DocumentUploadZone'
import DocumentViewerPane from '@/components/bookkeeping/DocumentViewerPane'
import InboxDocumentPicker from '@/components/bookkeeping/InboxDocumentPicker'
import type { UploadedFile } from '@/components/bookkeeping/DocumentUploadZone'
import type { UploadedFilesUpdate } from '@/components/bookkeeping/upload-list'
import type { AvailableInboxDoc } from '@/components/bookkeeping/InboxDocumentPicker'
import { carriedDocumentIds, heldUnderlag, removedUpload, underlagLinkTargets, underlagToCarry, uploadInFlight, type ReviewUnderlag } from './review-underlag'
import { useTransactionUnderlag } from './use-transaction-underlag'
import UnderlagFileRow from './UnderlagFileRow'
import VatTreatmentSelect from './VatTreatmentSelect'
import AiCategorizeProposal, { AiStatusLine, pickFromRead, proposalMetaFromRead, type AiProposalMeta, type AssistantPick } from './AiCategorizeProposal'
import { readIsFresh, type AssistantRead } from '@/lib/agent/categorize/read-shape'
import { isPersonChoice, type ReviewChoice } from '@/lib/transactions/review-choice'
import { getAccountName } from '@/lib/bookkeeping/client-account-names'
import { useDocumentExtraction } from '@/lib/hooks/use-document-extraction'
import { VAT_TREATMENT_OPTIONS } from './transaction-types'
import type { TransactionWithInvoice } from './transaction-types'
import type { VatTreatment, EntityType } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

interface QuickReviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  transaction: TransactionWithInvoice | null
  /** What will be booked and why: the one object every source produces (lib/bookkeeping/proposal.ts). */
  proposal: BookingProposal
  /** The person chose this from the picker: the header says Din kontering. */
  picked?: boolean
  entityType?: EntityType
  /** Book the proposal as shown. Resolves to the verifikat id, or null when the server refused. */
  onConfirm: (
    id: string,
    proposal: BookingProposal,
    extras: { dimensions?: Record<string, string>; vatAmount?: number },
  ) => Promise<string | null>
  /**
   * "Byt": the review closes for the template picker. It hands over the
   * underlag attached here (review-underlag.ts underlagToCarry), which the
   * review the picker opens gets back as carriedUnderlag.
   */
  onChangeTemplate?: (underlag: ReviewUnderlag | null) => void
  /** Underlag attached in the review that "Byt" closed: this one opens with it attached. */
  carriedUnderlag?: ReviewUnderlag | null
  /** The assistant's stored read of this row, when one exists: the line opens with it instead of fetching. */
  assistantRead?: AssistantRead | null
  /**
   * "Andra rader": hand the COMPUTED proposal lines (exactly what the
   * verifikation preview shows) to the parent, which routes them into
   * TransactionBookingDialog as an editable prefill. The transaction passed
   * back is the dialog's ENRICHED row (with any in-dialog SEK conversion
   * backfill): the parent must hand that one to the booking dialog so the
   * settlement leg's FX metadata carries the same rate the amounts used.
   */
  onEditLines?: (lines: ProposalLine[], transaction: TransactionWithInvoice) => void
  /** The row's own underlag was pinned here, or taken off (null): the page keeps its rows in step. */
  onUnderlagChange?: (transactionId: string, documentId: string | null) => void
  /**
   * What the review holds, on open and after every change: its booking, the
   * document the row pins and the account it will activate at booking. The
   * page keeps a booking the person set (lib/transactions/review-choice.ts)
   * for the row and the next open.
   */
  onProposalChange?: (transactionId: string, held: ReviewChoice) => void
  /**
   * The account the person picked from the catalogue in the review this one
   * continues, which that review was going to activate at booking: this one
   * still does. Read when the review opens.
   */
  activateOnBooking?: string | null
}

export default function QuickReviewDialog({
  open,
  onOpenChange,
  transaction,
  proposal: initialProposal,
  picked = false,
  entityType,
  onConfirm,
  onChangeTemplate,
  carriedUnderlag = null,
  assistantRead = null,
  onEditLines,
  onUnderlagChange,
  onProposalChange,
  activateOnBooking = null,
}: QuickReviewDialogProps) {
  const t = useTranslations('tx_quick_review')
  const tCat = useTranslations('tx_categories')
  const tJournal = useTranslations('journal_form')
  const tUnderlag = useTranslations('tx_booking_underlag')
  const tDetach = useTranslations('tx_detach')
  const whyFor = useProposalWhy()
  const { toast } = useToast()
  const router = useRouter()
  // The one thing this dialog edits. An account or VAT the person changes
  // turns it into an account booking; everything below (header, preview,
  // confirm) reads this and nothing else.
  const [proposal, setProposal] = useState<BookingProposal>(initialProposal)
  // What the review showed before the person took the assistant's pick: the
  // change line names it and Ångra restores it. Null until a pick is taken.
  const [previous, setPrevious] = useState<BookingProposal | null>(null)
  const catalogTemplate = templateBehind(proposal)
  const accountOverride = proposal.booking.kind === 'account' ? proposal.booking.account : ''
  const vatTreatment: VatTreatment | 'none' = proposal.booking.kind === 'account' ? proposal.booking.vat_treatment : 'none'
  // Session-cached (lib/reference-data): the kontoväljare is populated on
  // the first open of every row instead of after a request per open.
  const { accounts } = useAccounts()
  // The standard accounts the company has not added, and those it
  // deactivated, listed in the kontoväljare as activated at booking, where
  // it used to say it found nothing (crm#1101). JournalEntryForm lists the
  // same; handleConfirm activates the one the person picks here, and no
  // other (pickedToActivate below).
  const { catalog: basCatalog, chart: wholeChart } = useBasCatalog({ includeDeactivated: true })
  const { settings: companySettings } = useCompanySettings()
  // The AI proposal shown this session, kept so we can log a calibration sample
  // (proposed vs actually booked) once the user confirms.
  const [aiProposal, setAiProposal] = useState<AiProposalMeta | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Seeded with what "Byt" carried from the review it closed: a template
  // switch keeps the underlag attached (PostHog PH 118).
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>(() => carriedUnderlag?.files ?? [])
  // Underlag already sitting in the inkorg, picked instead of re-uploaded.
  // The journal entry does not exist yet at pick time: the first document
  // attached here is pinned to the row at once (useTransactionUnderlag), and
  // every pick is linked (with its inbox_item_id, which consumes the inbox
  // item) once the booking returns a verifikat, the same select-mode
  // contract TransactionBookingDialog uses.
  const [pickedInboxDocs, setPickedInboxDocs] = useState<AvailableInboxDoc[]>(() => carriedUnderlag?.inboxDocs ?? [])
  // Carried documents are not read again (see carriedDocumentIds).
  const [carriedDocIds] = useState(() => carriedDocumentIds(carriedUnderlag))
  const [inboxPickerOpen, setInboxPickerOpen] = useState(false)
  const [showUploadZone, setShowUploadZone] = useState(false)
  const [showVatDropdown, setShowVatDropdown] = useState(false)
  // Mirror of `transaction` so we can patch in a freshly-fetched SEK conversion
  // before the user confirms: the verifikation must always be in SEK and the
  // engine reads these fields straight off the transaction row.
  const [enrichedTx, setEnrichedTx] = useState<TransactionWithInvoice | null>(transaction)
  const [rateLoading, setRateLoading] = useState(false)
  const [rateError, setRateError] = useState<string | null>(null)
  // Dimension tagging (kostnadsställe/projekt): the picker renders only when
  // company_settings.dimensions_enabled, same gate as BulkBookDialog. Seeded
  // from the counterparty template's learned bag so the user sees what the
  // booking will carry and can change it.
  const dimensionsEnabled = companySettings?.dimensions_enabled === true
  const [dims, setDims] = useState<Record<string, string>>(
    () => ({ ...(initialProposal.default_dimensions ?? {}) }),
  )
  // The dimension fields stay folded until one is set or asked for: two
  // empty pickers on every review was weight without a decision.
  const [dimsOpen, setDimsOpen] = useState(false)
  const showDims = dimsOpen || Object.keys(dims).length > 0

  // The transaction's own underlag, from either door (pinned to the row, or
  // matched in the inbox): its moms is offered over the rate. The first
  // document attached here becomes it at once, so closing keeps it
  // (crm#1101); the hook is shared with TransactionBookingDialog.
  const underlagState = useTransactionUnderlag({
    transactionId: transaction?.id ?? null,
    rowDocumentId: transaction?.document_id ?? null,
    open,
    onChange: onUnderlagChange,
  })
  const underlag = underlagState.read
  const documentId = underlagState.documentId
  // The underlag the row had when the review opened is shown beside it. One
  // attached here stays in the list where it was dropped instead of
  // reshaping the dialog under the person's hand; it is beside the review
  // from the next open on.
  const viewerDocId = documentId && documentId !== underlagState.attachedHere ? documentId : null
  // What only this review holds beyond the row's own underlag: what "Byt"
  // carries to the next review (the row keeps its own).
  const held = heldUnderlag({ files: uploadedFiles, inboxDocs: pickedInboxDocs }, documentId)
  const [useDocVat, setUseDocVat] = useState(true)
  // Underlag attached in this dialog (an upload, or a pick from the inkorg).
  // The assistant's stored read never saw it: once its extraction lands, the
  // row is read again with it (a bank row with an insurance invoice attached
  // kept proposing internet). Latest upload first: that is the one the
  // person just dropped.
  const inDialogDocId = viewerDocId
    ? null
    : ([...uploadedFiles].reverse().find((f) => f.status === 'uploaded' && f.id)?.id ??
        pickedInboxDocs[0]?.document_id ??
        null)
  const inDialogExtraction = useDocumentExtraction(inDialogDocId)
  const readDocId = inDialogExtraction.status === 'succeeded' ? inDialogDocId : null
  // What the underlag says, whichever door it came through: the row's own
  // (pinned, or matched in the inbox), or the one attached here once it has
  // been read. Its moms is offered over the proposal's rate below and is
  // what an account change books; a document dropped in here used to be
  // read for the assistant only, never for the moms (PostHog PH 118).
  const docFacts = underlag?.facts ?? inDialogExtraction.facts
  const [docReading, setDocReading] = useState(false)
  // The assistant's read with the document attached here, once its pick was
  // taken into the review. It is not stored (the effect below), so the
  // review keeps it: when the person then sets another account, the
  // assistant's line names this read as the alternative, not the stored one
  // from before the document.
  const [docRead, setDocRead] = useState<AssistantRead | null>(null)
  // The whole dialog takes a dropped file, not only the dashed box: the box
  // is folded away until asked for, so the first drag also unfolds it.
  const dropSurfaceRef = useRef<HTMLDivElement>(null)
  // A finished upload is offered to the row as its underlag; it stays in the
  // list either way (only held here when the row already has one).
  const { claim: claimUnderlag, withdraw: withdrawUnderlag, settled: underlagSettled } = underlagState
  const claimUpload = useCallback((file: UploadedFile) => {
    if (file.id) void claimUnderlag(file.id, file.fileName)
  }, [claimUnderlag])

  // An account the person sets: the proposal becomes an account booking on
  // it, with the moms vatTreatmentAfterAccountChange decides (none on a
  // class-2 account, the underlag's rate over a carried-over default). The
  // rate counts when the document is in the row's currency, the condition
  // its moms amount is offered under below.
  const amountForLegs = transaction?.amount ?? 0
  const underlagVatRate =
    docFacts && (docFacts.currency ?? transaction?.currency) === transaction?.currency ? docFacts.vat_rate : null
  const vatRegistered = companySettings?.vat_registered
  // The account the person picked here from the catalogue that the active
  // chart lacks, listed "Aktiveras vid bokföring": the one account
  // handleConfirm activates before booking. An account a proposal brought
  // (the assistant's pick, the one the review opened with) is never
  // activated here: one the company deactivated is refused by the
  // categorize route, whose toast offers "Aktivera och bokför".
  // A review reopened on the booking the person set starts with the pick
  // they made then (activateOnBooking).
  const [pickedToActivate, setPickedToActivate] = useState<string | null>(activateOnBooking)
  const handleAccountChange = useCallback((account: string) => {
    if (!account) return
    setPickedToActivate(pickNeedsActivation(account, accounts, basCatalog) ? account : null)
    // The booking is the person's from here on (withAccount), named by the
    // account they picked: the company's own name for it, else the catalogue's.
    const label =
      accounts.find((a) => a.account_number === account)?.account_name ??
      basCatalog.find((a) => a.account_number === account)?.account_name ??
      getAccountName(account)
    setProposal((p) => {
      const current = p.booking.kind === 'account' ? p.booking.vat_treatment : (p.vat_treatment ?? 'exempt')
      const vat = vatTreatmentAfterAccountChange({
        account,
        current,
        underlagRate: underlagVatRate,
        chosenByHand: !useDocVat,
        vatRegistered,
      })
      return withAccount(p, account, vat, amountForLegs, label)
    })
  }, [accounts, basCatalog, amountForLegs, underlagVatRate, useDocVat, vatRegistered])
  // The assistant's pick, taken into this review: the proposal becomes the
  // account it named with its VAT. A pick that pre-filled on its own leaves
  // nothing to undo; one the person clicked, or one read off a document
  // they just attached, keeps the previous proposal so it can be undone.
  const takeAssistantPick = useCallback((pick: AssistantPick, opts: { auto: boolean; fromDocument?: boolean }) => {
    setProposal((p) => {
      if (!opts.auto) setPrevious(p)
      return accountProposal({
        id: `assistant:${transaction?.id ?? ''}`,
        source: 'assistant',
        account: pick.account,
        label: pick.label,
        // A candidate pick names no category and takes the one the review
        // held, unless that one books no moms (carriedCategory).
        category:
          pick.category ??
          (p.booking.kind === 'counterparty'
            ? (amountForLegs < 0 ? 'expense_other' : 'income_other')
            : carriedCategory(p.booking.category, pick.account, amountForLegs)),
        vat_treatment: pick.account.startsWith('2') || pick.vat === 'none' ? 'exempt' : pick.vat,
        reverse_charge_kind: pick.reverseChargeKind,
        amount: amountForLegs,
        has_underlag: opts.fromDocument || !!transaction?.document_id,
      })
    })
  }, [amountForLegs, transaction?.id, transaction?.document_id])

  // Read the row again with the underlag attached in this dialog, once its
  // extraction has landed. The pick replaces the proposal (undo stays
  // offered) and reports itself for the calibration sample; the read is not
  // stored, only the document's pin on the row is. A document "Byt" carried
  // over is not read again: the template the person picked after attaching
  // it stands.
  useEffect(() => {
    if (!open || !readDocId || !transaction?.id || carriedDocIds.has(readDocId)) return
    let alive = true
    setDocReading(true)
    ;(async () => {
      try {
        const res = await fetch('/api/agent/categorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transaction_id: transaction.id, document_id: readDocId }),
        })
        if (!alive) return
        const body = res.ok ? ((await res.json()) as { data?: AssistantRead }) : null
        if (!alive) return
        const read = body?.data
        const pick = read ? pickFromRead(read) : null
        // A low guess off the document is no better than the row's: the
        // proposal already shown stands.
        if (read && pick && read.confidence >= 0.5) {
          // Kept in the same update that takes the pick: the assistant's
          // line is off while the review is its pick, so the read it opens
          // with never changes under it.
          setDocRead(read)
          setAiProposal(proposalMetaFromRead(read, pick))
          takeAssistantPick(pick, { auto: false, fromDocument: true })
        }
      } catch {
        // The document is attached either way; only the re-read was lost.
      } finally {
        if (alive) setDocReading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [open, readDocId, transaction?.id, takeAssistantPick, carriedDocIds])
  // The person's own VAT choice. It also settles the underlag question: a
  // rate picked by hand is what gets booked, and the moms line below offers
  // the document's figure as the way back. Without this the document's moms
  // silently won and changing the rate appeared to do nothing.
  const setVatTreatment = useCallback((v: VatTreatment | 'none') => {
    setUseDocVat(false)
    setProposal((p) => withAccount(p, p.booking.kind === 'account' ? p.booking.account : businessAccount(p), v === 'none' ? 'exempt' : v, amountForLegs))
  }, [amountForLegs])

  // The page is told what this review holds whenever that changes, so a
  // booking the person set is still there after the review closes (PostHog
  // 170). It goes with the row's own pin as the review knows it, the key the
  // assistant's stored read is fresh by (one attached here counts, an inkorg
  // match does not move it), and with the account picked for activation.
  const reviewedId = transaction?.id ?? null
  const rowUnderlagKey = underlagState.source === 'pinned' ? documentId : null
  useEffect(() => {
    if (reviewedId) onProposalChange?.(reviewedId, { proposal, underlag_key: rowUnderlagKey, activate: pickedToActivate })
  }, [reviewedId, proposal, rowUnderlagKey, pickedToActivate, onProposalChange])

  // Reset local mirror whenever the underlying transaction changes (the parent
  // reuses the dialog instance across rows).
  useEffect(() => {
    setEnrichedTx(transaction)
    setRateError(null)
    setDims({ ...(initialProposal.default_dimensions ?? {}) })
    // A document picked for the previous row must never follow the dialog to
    // the next one: it would attach that underlag to the wrong verifikat.
    // What "Byt" carried over is this row's own and stays.
    setPickedInboxDocs(carriedUnderlag?.inboxDocs ?? [])
    setUseDocVat(true)
    // Re-seeding on the proposal alone would clobber in-flight edits; the
    // bag only changes together with the transaction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transaction])

  // Backfill the SEK conversion on demand. resolveSekAmount silently falls
  // back to the raw foreign amount when amount_sek/exchange_rate are null,
  // which means the user would see misleading "kr" values in the verifikation
  // and the engine would post the wrong number to the books.
  useEffect(() => {
    if (!open || !transaction) return
    const needsRate =
      !!transaction.currency &&
      transaction.currency !== 'SEK' &&
      (transaction.amount_sek == null || transaction.exchange_rate == null)
    if (!needsRate) return

    let cancelled = false
    setRateLoading(true)
    setRateError(null)
    ;(async () => {
      try {
        const res = await fetch(`/api/transactions/${transaction.id}/refresh-exchange-rate`, {
          method: 'POST',
        })
        const json = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setRateError(getUserErrorMessage(json?.error) || t('exchange_rate_fetch_failed'))
          return
        }
        if (json?.data) {
          setEnrichedTx({ ...json.data, ...{
            potential_invoice: transaction.potential_invoice,
            potential_supplier_invoice: transaction.potential_supplier_invoice,
            potential_rot_rut_payout: transaction.potential_rot_rut_payout,
          } })
        }
      } catch {
        if (!cancelled) setRateError(t('exchange_rate_fetch_failed'))
      } finally {
        if (!cancelled) setRateLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [open, transaction, t])

  // ── The lines the proposal books ─────────────────────────────────────
  // Built on the server by the code the booking posts with (POST
  // /api/bookkeeping/proposal-preview), from the body handleConfirm sends:
  // the preview shows, and "Ändra rader" hands over, the verifikat the
  // booking makes. The server reads the row itself, so its SEK backfill
  // above asks again.
  const previewTx = enrichedTx ?? transaction
  const previewVersion = previewTx ? `${previewTx.amount_sek}:${previewTx.exchange_rate}` : ''
  const basePreview = useProposalPreview(
    open && previewTx ? { transaction_id: previewTx.id, booking: categorizeBodyFor(proposal) } : null,
    { refreshKey: previewVersion },
  )

  // The document's moms against the proposal's. The VAT leg of the lines the
  // preview shows (ingående 264x on a purchase, utgående 261x-263x on a sale)
  // is SEK; the document's figure is in the row's currency, so the proposal
  // is scaled back by the gross's own ratio before they are compared. Only a
  // rate-based treatment has a line to replace, and a counterparty pattern
  // carries its own lines, which the override does not touch.
  const previewSekAmount = previewTx
    ? resolveSekAmount(previewTx.amount, previewTx.amount_sek, previewTx.currency, previewTx.exchange_rate)
    : 0
  const previewSekMissing =
    !!previewTx?.currency && previewTx.currency !== 'SEK' && (previewTx.amount_sek == null || previewTx.exchange_rate == null)
  const currentTreatment = proposal.booking.kind === 'account' ? proposal.booking.vat_treatment : (catalogTemplate?.vat_treatment ?? proposal.vat_treatment ?? null)
  const rateBased = currentTreatment === 'standard_25' || currentTreatment === 'reduced_12' || currentTreatment === 'reduced_6'
  const proposedVatSek = basePreview.lines
    .filter((l) =>
      (previewTx?.amount ?? 0) < 0
        ? l.side === 'debet' && l.account.startsWith('264') && l.account !== '2645'
        : l.side === 'kredit' && /^26[123]/.test(l.account),
    )
    .reduce((sum, l) => sum + l.amount, 0)
  const docVat = docFacts?.vat_amount ?? null
  const docVatUsable =
    !!previewTx &&
    docVat != null &&
    docVat > 0 &&
    rateBased &&
    !accountOverride.startsWith('2') &&
    proposal.booking.kind !== 'counterparty' &&
    proposedVatSek > 0 &&
    !previewSekMissing &&
    (docFacts?.currency ?? previewTx.currency) === previewTx.currency
  const proposedVatInTxCurrency =
    previewTx && previewSekAmount && Math.abs(previewSekAmount) > 0
      ? proposedVatSek * (Math.abs(previewTx.amount) / Math.abs(previewSekAmount))
      : proposedVatSek
  const docVatDiffers = docVatUsable && vatDisagrees(docVat, proposedVatInTxCurrency)
  const bookDocVat = docVatUsable && docVatDiffers && useDocVat && docVat != null
  // Booking the document's moms is its own preview, the body with vat_amount
  // exactly as handleConfirm sends it.
  const docVatPreview = useProposalPreview(
    bookDocVat && previewTx ? { transaction_id: previewTx.id, booking: categorizeBodyFor(proposal, { vatAmount: docVat }) } : null,
    { refreshKey: previewVersion },
  )
  const preview = bookDocVat ? docVatPreview : basePreview
  // The lines the previous proposal did not have are marked in the preview,
  // so the change the assistant's pick made is seen, not inferred.
  const previousPreview = useProposalPreview(
    open && previewTx && previous ? { transaction_id: previewTx.id, booking: categorizeBodyFor(previous) } : null,
    { refreshKey: previewVersion },
  )

  // Non-modal dialog (see the Dialog below): hand-restore page modality so
  // the agent sheet stays live. See useDashShellInert in ui/dialog.tsx.
  useDashShellInert(open)

  if (!transaction) return null

  const tx = enrichedTx ?? transaction
  const isIncome = tx.amount > 0
  // Keyed off the template ID, not off the presence of a line pattern: a
  // *learned* counterparty (one business line, no pattern) is still booked
  // server-side from counterparty_template_id, so its accounts and VAT come
  // from the stored template. Deciding this from counterparties that happen
  // to have a multi-line pattern made single-line ones fall through to the
  // category branch, which previewed the wrong accounts and offered an
  // account/VAT editor whose values the categorize route discards.
  const isCounterpartyTemplate = proposal.booking.kind === 'counterparty'
  const hasCounterpartyPattern = isCounterpartyTemplate && !!(proposal.line_pattern && proposal.line_pattern.length > 0)
  const isTemplateBooking = proposal.booking.kind !== 'account'
  // The template's rules as one line under the why, not three boxes: the
  // special rule, the deductibility note when it adds something, and the
  // reverse-charge requirement.
  const ruleLine = [
    catalogTemplate?.special_rules_sv,
    catalogTemplate?.deductibility_note_sv && !(catalogTemplate.special_rules_sv ?? '').includes(catalogTemplate.deductibility_note_sv)
      ? catalogTemplate.deductibility_note_sv
      : null,
    catalogTemplate?.requires_vat_registration_data ? t('reverse_charge_warning') : null,
  ]
    .filter((x): x is string => !!x)
    .join(' · ')
  const isLiabilityAccount = accountOverride.startsWith('2')
  // For non-SEK transactions, the verifikation and the headline must show
  // the SEK-converted total: the mall/category booking always posts in SEK.
  const sekAmount = resolveSekAmount(
    tx.amount,
    tx.amount_sek,
    tx.currency,
    tx.exchange_rate
  )
  // The row's underlag when it is beside the review, and what was attached
  // here (the first of it pinned to the row, the rest held).
  const attachedCount =
    (viewerDocId ? 1 : 0) + uploadedFiles.filter((f) => f.status === 'uploaded').length + pickedInboxDocs.length
  const isForeign = !!(tx.currency && tx.currency !== 'SEK')
  const sekConversionMissing = isForeign && (tx.amount_sek == null || tx.exchange_rate == null)

  // Dimensions carried by the counterparty template's line pattern (dimensions
  // PR7). Business lines may each carry a {sie_dim_no: code} bag: merge them
  // into one compact display label ("KS01 · P001", dim-number order). This is
  // display-only: booking applies the pattern's bags server-side.
  const patternDims: Record<string, string> = {}
  for (const line of proposal.line_pattern ?? []) {
    if (line.dimensions) Object.assign(patternDims, line.dimensions)
  }
  const patternDimsLabel = Object.entries(patternDims)
    .filter(([, code]) => code)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, code]) => code)
    .join(' · ')

  // The account this review books to, for the assistant's agree check: a
  // static template's AB account when the company is one.
  const entityAccounts = resolveTemplateAccountsForEntity(catalogTemplate ?? {}, entityType)
  const currentAccount = catalogTemplate
    ? businessAccount({ debit_account: entityAccounts.debitAccount ?? catalogTemplate.debit_account, credit_account: entityAccounts.creditAccount ?? catalogTemplate.credit_account })
    : businessAccount(proposal)

  // A template whose rate is not the one the underlag states (a massage
  // invoice at 25 % through Friskvård's 6 %, PostHog PH 118): said beside the
  // moms, never acted on. The person keeps the template, books the
  // underlag's moms below, or picks another one.
  const vatRateMismatch = templateVatMismatch({ template: catalogTemplate, underlagRate: underlagVatRate, vatRegistered })
  // A purchase worth asking about and nothing to show for it: the review
  // says so and the button says what booking now means.
  const bookingWithoutUnderlag = !documentId && attachedCount === 0 && !!underlag && needsUnderlagPrompt(sekAmount)

  // What "Ändra rader" hands over: the lines the preview shows, never ones
  // still on their way for a changed proposal.
  const proposalLines = onEditLines && !preview.loading ? preview.lines : []
  const changedAccounts =
    previous && !previousPreview.loading && previousPreview.lines.length > 0
      ? (() => {
          const before = new Set(previousPreview.lines.map((l) => l.account))
          return preview.lines.map((l) => l.account).filter((a) => !before.has(a))
        })()
      : []

  function handleEditLines() {
    if (!onEditLines || proposalLines.length === 0) return
    onEditLines(proposalLines, tx)
  }

  async function handleConfirm() {
    if (!transaction) return

    setIsProcessing(true)
    setError(null)
    try {
      // A pin or a take-off still on its way lands first (Bokför waits for
      // them; this covers the same tick): the categorize route anchors the
      // row's pin as it reads it when the booking starts.
      await underlagSettled()

      // The account the person picked here from the BAS catalogue is
      // activated first, as the kontoväljare said it would be: added when
      // the chart lacks it, reactivated when the company deactivated it,
      // since the categorize route books an account override only when the
      // chart has it active. Only that pick: an inactive account the
      // assistant or the opening proposal brought, and a number outside the
      // catalogue, meet the route's refusal and its "Aktivera och bokför",
      // as does a failed activation.
      if (proposal.booking.kind === 'account' && proposal.booking.account === pickedToActivate && wholeChart) {
        const activated = await activateBasAccounts([proposal.booking.account], wholeChart)
        if (activated.length > 0) void invalidateReferenceData('ref:accounts')
      }

      // Cleared combobox values leave empty strings behind; strip them so an
      // untouched picker sends no bag at all (learned template bags then apply
      // server-side unchanged).
      const cleanedDims = Object.fromEntries(
        Object.entries(dims).filter(([, code]) => code && code.trim().length > 0),
      )
      const journalEntryId = await onConfirm(transaction.id, proposal, {
        dimensions: Object.keys(cleanedDims).length > 0 ? cleanedDims : undefined,
        vatAmount: bookDocVat ? docVat : undefined,
      })

      // Calibration telemetry: what the model proposed vs what was actually
      // booked. Best-effort and fire-and-forget — never blocks the booking.
      if (journalEntryId && aiProposal) {
        void fetch('/api/agent/categorize/outcome', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            confidence: aiProposal.confidence,
            agreement: aiProposal.agreement,
            model_confidence: aiProposal.modelConfidence,
            source: aiProposal.source,
            proposed_account: aiProposal.account,
            booked_account: businessAccount(proposal),
          }),
        }).catch(() => {})
      }

      // Attach the underlag attached here to the verifikat the booking just
      // created, the document pinned to the row included: the categorize
      // route anchors that one too, and linking it again changes nothing but
      // reports an anchor that failed. BFL 5 kap 7 § requires the
      // verifikation to reference its underlag and BFL 7 kap requires that
      // underlag to be archived with it; the verifikat is already committed
      // here, so a failed link can only be reported, not undone. The
      // parent's "Bokförd" toast must not be the last word when a receipt
      // never made it onto the books. A pick's inboxItemId stamps the inbox
      // item as consumed so it drops out of "Underlag att hantera": see
      // app/api/documents/[id]/link/route.ts. A document the person removed
      // here never goes onto the verifikat.
      const targets = underlagLinkTargets({ files: uploadedFiles, inboxDocs: pickedInboxDocs }, transaction.id).filter(
        (target) => !underlagState.isLetGo(target.documentId),
      )
      if (journalEntryId && targets.length > 0) {
        const { failed } = await linkDocuments(targets, journalEntryId)
        if (failed.length > 0) {
          toast({
            title: t('doc_link_failed_booked_title'),
            description: t('doc_link_failed_booked_description', {
              count: failed.length,
              files: formatFailedDocumentNames(failed),
            }),
            variant: 'destructive',
            action: (
              <ToastAction
                altText={t('doc_link_open_entry')}
                onClick={() => router.push(`/bookkeeping/${journalEntryId}`)}
              >
                {t('doc_link_open_entry')}
              </ToastAction>
            ),
          })
          // By this point the parent has already closed the dialog (onConfirm
          // resolved before linkDocuments did), so this component's file state
          // is invisible either way: the toast above, with its open-entry
          // action, is the user's actual pointer to the underlag that did not
          // attach. The early return just skips the redundant cleanup below.
          //
          // Picks are still dropped: the dialog instance is reused across rows,
          // and a pick that DID link is already consumed, so carrying it into
          // the next transaction would re-link a spent document. Nothing is lost
          // by clearing, unlike uploadedFiles: an underlag that failed to link
          // was never stamped, so it is still sitting in the inkorg to re-pick.
          setPickedInboxDocs([])
          return
        }
      }

      setUploadedFiles([])
      setPickedInboxDocs([])
      setShowUploadZone(false)
    } catch {
      setError(t('generic_error'))
    } finally {
      // Always reset isProcessing: without this, an onConfirm that resolves
      // with null (e.g. server returned a structured 4xx error like
      // ACCOUNTS_NOT_IN_CHART) leaves the dialog frozen because the
      // <Dialog onOpenChange> below disables backdrop/ESC while processing.
      setIsProcessing(false)
    }
  }

  // The x on a document attached here lets it go: off the row when the row
  // holds it or a pin for it is on its way (the file stays in the archive),
  // then out of the lists. Listed until the row has let it go: a refused
  // take-off keeps it, as does attaching it again meanwhile.
  async function letGo(docId: string) {
    if (!(await withdrawUnderlag(docId))) return
    setUploadedFiles((prev) => prev.filter((f) => f.id !== docId))
    setPickedInboxDocs((prev) => prev.filter((d) => d.document_id !== docId))
  }

  // Every change from the upload zone is an update of the list as it is
  // when it lands, so an upload finishing after another drop or a removal
  // keeps both. The x on a finished upload is the one change the dialog
  // takes over: the document goes through letGo above.
  function handleFilesChange(update: UploadedFilesUpdate) {
    const removed = removedUpload(uploadedFiles, update(uploadedFiles))
    if (removed?.id) {
      void letGo(removed.id)
      return
    }
    setUploadedFiles(update)
  }

  // The underlag the row had before this review is confirmed off, as the
  // row's own "Ta bort underlag" is: it may be a match someone else made.
  async function detachEarlierUnderlag() {
    const released = await underlagState.detachEarlier({
      description: tx.description,
      amount: formatCurrency(tx.amount, tx.currency),
    })
    if (!released) return
    setUploadedFiles((prev) => prev.filter((f) => f.id !== released))
    setPickedInboxDocs((prev) => prev.filter((d) => d.document_id !== released))
  }

  return (
    // Non-modal so the agent sheet and its trigger stay usable during review
    // (useDashShellInert above hand-restores page modality). Existing
    // dismissal semantics kept: Esc/veil-click close unless processing, and
    // assistant clicks never dismiss (data-agent-ui counts as inside).
    <Dialog modal={false} open={open} onOpenChange={isProcessing ? undefined : (o) => {
      if (!o) {
        setUploadedFiles([])
        setPickedInboxDocs([])
        setShowUploadZone(false)
      }
      onOpenChange(o)
    }}>
      <DialogVeil />
      {/* Both variants cap at the space left of a docked agent sheet so the
          right edge never lands unreachable under it (sheet is z-60).
          --agent-sheet-w is docked-only: sheet closed = the old widths.
          Header, body and footer, as in ConfirmationDialog: only the body
          scrolls, so Stäng and Bokför stay in view however far the body grows
          (an upload, the assistant reading it, the dimension fields), on a
          phone as on a desktop. The dialog used to scroll as a whole and an
          attached file pushed the buttons out of sight (crm#1101). */}
      <DialogContent
        ref={dropSurfaceRef}
        className={cn(
          'flex max-h-[95dvh] flex-col gap-0 overflow-hidden p-0 sm:max-h-[90dvh]',
          viewerDocId
            ? 'max-w-[min(72rem,calc(100vw-var(--agent-sheet-w,0px)))]'
            : 'max-w-[min(28rem,calc(100vw-var(--agent-sheet-w,0px)))] sm:max-w-[min(32rem,calc(100vw-var(--agent-sheet-w,0px)))]',
        )}
        // A file dragged anywhere over the dialog unfolds the upload zone,
        // which then owns the drop (DocumentUploadZone dropSurfaceRef). The
        // two preventDefaults keep a drop that lands before the zone has
        // mounted from navigating the tab to the file.
        onDragEnter={(e) => {
          if (!showUploadZone && e.dataTransfer.types.includes('Files')) setShowUploadZone(true)
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => e.preventDefault()}
      >
        <DialogHeader className="shrink-0 px-4 pb-3 pt-4 sm:px-6 sm:pb-4 sm:pt-6">
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription className="sr-only">
            {isTemplateBooking ? t('description_template') : t('description_default')}
          </DialogDescription>
        </DialogHeader>

        <div className="scrollbar-visible min-h-0 flex-1 overflow-y-auto px-4 pb-4 sm:px-6">
        {/* When the row came with its underlag, show it side-by-side (receipt
            left, review right). Without one the review column uses
            display:contents so the body collapses to the single column. */}
        <div className={viewerDocId ? 'grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,520px)]' : 'flex flex-col gap-4'}>
          {viewerDocId && (
            // The column's height leaves room for the header and the pinned
            // footer (the body scrolls between them), so the file row at its
            // foot is in view on a short laptop screen too.
            <div className="flex h-[45vh] flex-col gap-2 lg:sticky lg:top-0 lg:h-[min(72vh,calc(90dvh-9rem))] lg:self-start">
              <DocumentViewerPane documentId={viewerDocId} className="min-h-0 flex-1" />
              {/* Its x takes it off the row once confirmed; the file stays in
                  the archive. */}
              <div className="shrink-0">
                <UnderlagFileRow
                  name={underlagState.fileName ?? tUnderlag('file_fallback')}
                  removeLabel={tDetach('menu_item')}
                  disabled={isProcessing || underlagState.busy}
                  onRemove={() => void detachEarlierUnderlag()}
                />
              </div>
            </div>
          )}
          <div className={viewerDocId ? 'flex min-w-0 flex-col gap-4' : 'contents'}>

        {bookingWithoutUnderlag && (
          <AttnLine action={{ label: t('underlag_fetch'), onClick: () => setShowUploadZone(true) }}>
            {t('underlag_missing_title', { amount: formatCurrency(Math.abs(tx.amount), tx.currency) })} {t('underlag_missing_body')}
          </AttnLine>
        )}

        {/* Transaction summary */}
        <div className="flex items-center gap-3 rounded-lg border p-3">
          <div
            className={`h-9 w-9 rounded-full flex items-center justify-center flex-shrink-0 ${isIncome ? 'text-success' : 'text-destructive'}`}
          >
            {isIncome ? (
              <ArrowUpRight className="h-4 w-4" />
            ) : (
              <ArrowDownRight className="h-4 w-4" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm break-all">{tx.description}</p>
            <p className="text-xs text-muted-foreground">{formatDate(tx.date)}</p>
          </div>
          <div className="text-right flex-shrink-0">
            {isForeign ? (
              <>
                <p className={`font-medium text-sm tabular-nums ${isIncome ? 'text-success' : ''}`}>
                  {isIncome ? '+' : ''}
                  {formatCurrency(tx.amount, tx.currency)}
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {rateLoading || sekConversionMissing
                    ? t('amount_loading')
                    : t('amount_approx', { sign: isIncome ? '+' : '', sek: formatCurrency(sekAmount, 'SEK') })}
                </p>
              </>
            ) : (
              <p className={`font-medium text-sm tabular-nums ${isIncome ? 'text-success' : ''}`}>
                {isIncome ? '+' : ''}
                {formatCurrency(sekAmount, 'SEK')}
              </p>
            )}
          </div>
        </div>

        {isForeign && tx.exchange_rate != null && tx.exchange_rate_date && !sekConversionMissing && (
          <p className="text-xs text-muted-foreground -mt-1">
            {t('rate_footnote', {
              rate: formatCurrency(tx.exchange_rate, 'SEK'),
              currency: tx.currency,
              date: formatDate(tx.exchange_rate_date),
            })}
          </p>
        )}

        {rateError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/[0.05] px-3 py-2">
            <p className="text-xs text-destructive leading-snug">{rateError}</p>
          </div>
        )}

        {/* One header says what will be booked and why: the pick, the source
            of the recommendation, and beneath it the assistant's verdict on
            it. The verifikat block further down is the proof. */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {picked || proposal.source === 'manual' ? t('rec_kicker_manual') : t('rec_kicker')}
            </span>
            {onChangeTemplate && !hasCounterpartyPattern && (
              // The switch closes this review for the picker: the underlag
              // held here goes along to the review the pick opens (the row's
              // own is on the row), and an upload or a pin still on its way
              // is waited for, not dropped.
              <button
                type="button"
                className={cn(QUIET_LINK_CLASS, 'text-[12.5px] disabled:pointer-events-none disabled:opacity-50')}
                disabled={uploadInFlight(uploadedFiles) || underlagState.busy}
                onClick={() => onChangeTemplate(underlagToCarry(held))}
              >
                {t('rec_change')}
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-medium text-foreground">{proposal.name_sv}</span>
            {patternDimsLabel && (
              <Badge data-ph-mask="" variant="secondary" className="font-mono tabular-nums">
                {patternDimsLabel}
              </Badge>
            )}
          </div>
          <p className="text-[12.5px] text-muted-foreground">{whyFor(proposal)}</p>
          {ruleLine && <p className="text-[12.5px] leading-snug text-muted-foreground">{ruleLine}</p>}
          {/* The assistant's read, unless this review already is its pick. */}
          {previous && (
            <p className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-foreground">
              <span>{t('changed_from', { label: `${previous.name_sv} ${businessAccount(previous)}` })}</span>
              <button
                type="button"
                className={cn(QUIET_LINK_CLASS, 'text-[12.5px]')}
                onClick={() => {
                  setProposal(previous)
                  setPrevious(null)
                }}
              >
                {t('changed_undo')}
              </button>
            </p>
          )}
          {/* The row is being read again with the underlag just attached:
              said here, above the verdict line, since that line is gone once
              this review already is the assistant's pick. */}
          {(docReading || (!!inDialogDocId && inDialogExtraction.status === 'running')) && (
            <AiStatusLine text={t('ai_reading')} />
          )}
          {tx.id && proposal.source !== 'assistant' && (
            <AiCategorizeProposal
              key={tx.id}
              transactionId={tx.id}
              open={open}
              hasUnderlag={!!documentId}
              initial={docRead ?? (assistantRead && readIsFresh(assistantRead, tx) ? assistantRead : null)}
              currentAccount={currentAccount}
              // The pick fills an account booking nobody chose. One the
              // person set or picked stands, and so does the proposal they
              // went back to after the document's read was taken once: the
              // line offers the pick instead of taking it over theirs.
              autoApply={!isTemplateBooking && !isPersonChoice(proposal) && !docRead}
              onProposal={setAiProposal}
              onTake={takeAssistantPick}
            />
          )}
        </div>

        {/* Journal entry preview: hidden until we have a SEK conversion;
            otherwise we'd render a verifikation in the wrong currency. */}
        {!sekConversionMissing && !rateLoading && (
          <div>
            <JournalEntryPreview lines={preview.lines} loading={preview.loading} error={preview.error} changedAccounts={changedAccounts} />
            {/* "Andra rader": send the computed lines into the manual booking
                dialog for per-line editing. Offered on every proposal surface
                (AI suggestion, static template, counterparty pattern). */}
            {onEditLines && proposalLines.length > 0 && (
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  className="text-xs text-primary hover:underline disabled:pointer-events-none disabled:opacity-50"
                  disabled={isProcessing}
                  onClick={handleEditLines}
                >
                  {t('edit_lines')}
                </button>
              </div>
            )}
          </div>
        )}

        {vatRateMismatch && (
          <AttnLine>
            {t('vat_template_rate_differs', { doc: vatRateMismatch.underlag, template: vatRateMismatch.template })}
          </AttnLine>
        )}

        {/* Moms per the underlag: stated whenever the document has one, with
            the choice to book it when it differs from the proposal's rate. */}
        {/* The underlag's moms, only when it disagrees with the rate: when
            they agree the verifikat above already shows the figure, and
            saying it twice reads as two different facts. */}
        {docVatDiffers && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted-foreground">
            <span>
              {useDocVat
                ? t('vat_doc_wins', { amount: formatCurrency(docVat, tx.currency) })
                : t('vat_rate_wins', { amount: formatCurrency(proposedVatInTxCurrency, tx.currency) })}
            </span>
            <button
              type="button"
              className={cn(QUIET_LINK_CLASS, 'text-[12.5px]')}
              disabled={isProcessing}
              onClick={() => setUseDocVat((v) => !v)}
            >
              {useDocVat
                ? t('vat_use_proposal', { amount: formatCurrency(proposedVatInTxCurrency, tx.currency) })
                : t('vat_use_doc_amount', { amount: formatCurrency(docVat, tx.currency) })}
            </button>
          </p>
        )}

        {/* Account & VAT: hidden for template bookings (accounts defined by the template) */}
        {!isTemplateBooking && (
          <>
            <div>
              <label className="text-sm font-medium text-muted-foreground">{t('label_account')}</label>
              <div className="mt-1">
                <AccountCombobox
                  value={accountOverride}
                  accounts={accounts}
                  catalog={basCatalog}
                  notActivatedLabel={tJournal('account_not_activated')}
                  onChange={handleAccountChange}
                />
              </div>
            </div>

            <div>
              <label className="text-sm font-medium text-muted-foreground">{t('label_vat_treatment')}</label>
              <div className="mt-1">
                {isLiabilityAccount ? (
                  <p className="text-sm text-muted-foreground">
                    {t('no_vat_liability_account')}
                  </p>
                ) : showVatDropdown ? (
                  <VatTreatmentSelect
                    value={vatTreatment}
                    onValueChange={setVatTreatment}
                  />
                ) : (
                  <p className="text-sm">
                    {(() => {
                      const opt = VAT_TREATMENT_OPTIONS.find(o => o.value === vatTreatment)
                      return opt ? tCat(opt.labelKey) : t('no_vat_default')
                    })()}
                    {' '}
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline"
                      onClick={() => setShowVatDropdown(true)}
                    >
                      {t('change')}
                    </button>
                  </p>
                )}
              </div>
            </div>
          </>
        )}

        {/* Dimension tags (kostnadsställe/projekt): rendered for category,
            library-template and legacy counterparty bookings. Multi-line
            counterparty patterns are excluded: their per-line bags are
            authoritative server-side and an edit here would be ignored. */}
        {dimensionsEnabled && !hasCounterpartyPattern && !showDims && (
          <div className="flex justify-end">
            <button type="button" className={cn(QUIET_LINK_CLASS, 'text-xs')} onClick={() => setDimsOpen(true)} disabled={isProcessing}>
              {t('label_dimensions')}
            </button>
          </div>
        )}
        {dimensionsEnabled && !hasCounterpartyPattern && showDims && (
          <div>
            <label className="text-sm font-medium text-muted-foreground">{t('label_dimensions')}</label>
            <div className="mt-1">
              <LineDimensionFields
                dimensions={dims}
                onChange={(sieDimNo, code) => {
                  setDims((prev) => {
                    const next = { ...prev }
                    if (code) next[sieDimNo] = code
                    else delete next[sieDimNo]
                    return next
                  })
                }}
                inputClassName="h-8"
              />
            </div>
          </div>
        )}

        {/* The underlag: what was attached here (the first of it is the row's
            own the moment it lands, so closing keeps it) and the way to add
            more. The row's underlag from before this review is beside it,
            with its own x. Locked while the booking runs: handleConfirm
            links what was attached when it started. */}
        <div className="rounded-lg border">
          <button
            type="button"
            onClick={() => setShowUploadZone(!showUploadZone)}
            className="flex items-center justify-between w-full px-3 py-2.5 text-sm hover:bg-secondary/60 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Paperclip className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">{t('doc_label')}</span>
              {attachedCount > 0 && (
                <span className="text-xs text-muted-foreground">
                  {t('doc_attached_count', { count: attachedCount })}
                </span>
              )}
            </div>
            {showUploadZone ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
          {showUploadZone && (
            <div className="px-3 pb-3 space-y-2">
              <DocumentUploadZone
                files={uploadedFiles}
                onFilesChange={handleFilesChange}
                onUploaded={claimUpload}
                compact
                disabled={isProcessing}
                dropSurfaceRef={dropSurfaceRef}
              />
              {pickedInboxDocs.map((doc) => (
                <UnderlagFileRow
                  key={doc.document_id}
                  name={doc.supplier_name ?? doc.file_name}
                  removeLabel={t('doc_picked_remove')}
                  disabled={isProcessing}
                  onRemove={() => void letGo(doc.document_id)}
                />
              ))}
              {/* Locked while the booking is in flight: handleConfirm captured
                  pickedInboxDocs when it started, so anything picked now would
                  never be linked and would then be cleared on completion,
                  vanishing from the list with no error to explain it.
                  Styled as the dropzone's footer (same treatment as
                  TransactionBookingDialog) so upload and inbox-pick read as
                  one underlag surface. */}
              <button
                type="button"
                disabled={isProcessing}
                onClick={() => setInboxPickerOpen(true)}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-muted-foreground/25 px-3 py-2 text-[13px] text-muted-foreground transition-colors duration-150 hover:border-primary/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                <Inbox className="h-4 w-4" />
                <span>{t('doc_pick_existing_inline')}</span>
              </button>
            </div>
          )}
        </div>
          </div>
        </div>
        </div>

        {/* Actions, outside the scrolling body. "Stäng", not "Avbryt": an
            underlag dropped in here is archived the moment it lands and the
            first one stays on the row, so closing undoes nothing; the button
            only closes the review (PostHog PH 118). */}
        <div className="shrink-0 space-y-3 border-t px-4 py-3 sm:px-6 sm:py-4">
          {error && (
            <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
              {error}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isProcessing}
            >
              {t('close')}
            </Button>
            {/* Waits, like "Byt", for an upload or a pin still on its way:
                one landing during the booking would reach the row after the
                categorize route read it, and miss the verifikat. */}
            <Button
              onClick={handleConfirm}
              disabled={
                isProcessing ||
                (!isTemplateBooking && !accountOverride) ||
                rateLoading ||
                sekConversionMissing ||
                uploadInFlight(uploadedFiles) ||
                underlagState.busy
              }
            >
              <Check className="mr-2 h-4 w-4" />
              {isProcessing ? t('booking') : rateLoading ? t('fetching_rate') : bookingWithoutUnderlag ? t('book_without_underlag') : t('book')}
            </Button>
          </DialogFooter>
        </div>

        {/* Select mode: the verifikat does not exist yet. The pick becomes
            the row's underlag when it has none (the attach route marks the
            inbox item matched, and the booking consumes it); either way
            handleConfirm links it once the booking returns its id. */}
        <InboxDocumentPicker
          open={inboxPickerOpen}
          onClose={() => setInboxPickerOpen(false)}
          onSelect={(doc) => {
            if (pickedInboxDocs.some((d) => d.document_id === doc.document_id)) return
            setPickedInboxDocs((prev) =>
              prev.some((d) => d.document_id === doc.document_id) ? prev : [...prev, doc],
            )
            void claimUnderlag(doc.document_id, doc.supplier_name ?? doc.file_name)
          }}
        />
        {/* Inside the content: a click or focus in the confirm counts as
            inside this non-modal review, so it never dismisses it. */}
        <DestructiveConfirmDialog {...underlagState.confirmProps} />
      </DialogContent>
    </Dialog>
  )
}
