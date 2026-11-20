'use client'

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { CheckIcon, DocumentMagnifyingGlassIcon, PaperClipIcon } from '@/components/icons'
import { InboxArrivalProvenance } from '@/components/extensions/general/InboxArrivalProvenance'
import { PurchaseCategoryChip } from '@/components/inbox/PurchaseCategoryChip'
import BookingWhy from '@/components/bookkeeping/BookingWhy'
import { BrandMark, GlyphMark } from '@/components/parties/BrandMark'
import { Button } from '@/components/ui/button'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { Skeleton } from '@/components/ui/skeleton'
import type { InboxPurchaseCategory } from '@/lib/categories/inbox-purchase-category'
import type { PurchaseCategoryAlternative } from '@/lib/categories/propose-purchase-category'
import type { DocumentReading } from '@/lib/documents/reading/types'
import type { BankMatch } from '@/lib/documents/inbox-bank-match'
import { inboxKindLabelKey, isOwnIssuedInvoice } from '@/lib/documents/inbox-kind'
import { formatAccountWithName } from '@/lib/bookkeeping/client-account-names'
import { shortDate, shortDateTime } from '@/lib/inkorg/dates'
import { bookedOnAccount, focusDecision, type DecisionQuestion, type InkorgStartable } from '@/lib/inkorg/decision'
import { doorOf, itemHeadline, mailSenderOf, type InkorgItem } from '@/lib/inkorg/items'
import { formatCurrency, formatRowAmount } from '@/lib/utils'
import { useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import type { SellerRegion } from '@/lib/vat/seller-country'
import { FocusDecision, type DecisionDone, type SuggestedBooking } from './FocusDecision'
import { useBookingPlan, type OneClickBooking } from './use-booking-plan'
import { FocusDocumentFields } from './FocusDocumentFields'
import { FocusDocumentPreview, useDocumentMeta } from './FocusDocumentPreview'
import { Fold } from './motion'
import { useDoorName } from './door-icon'

const ITEM_URL = (id: string) => `/api/extensions/ext/invoice-inbox/items/${id}`

/** The questions a first decision asks: what one click can answer, so its plan is read for them. */
const FIRST_DECISION: ReadonlySet<DecisionQuestion> = new Set(['already_paid', 'invoice_paid', 'who_paid', 'book_purchase'])

const SELLER_REGIONS: readonly SellerRegion[] = ['se', 'eu', 'non_eu']

interface ItemDetail {
  purchase_category?: InboxPurchaseCategory | null
  /** What else the evidence points to, offered in the category dialog. */
  purchase_category_alternatives?: PurchaseCategoryAlternative[]
  reading?: DocumentReading
  /** The bank row the Inkorg found when the document arrived (match on arrival), or null. */
  bank_match?: BankMatch | null
  /** The supplier card the reading matched, whose accounts the document's are checked against. */
  matched_supplier_id?: string | null
}

type DetailState = { key: string; detail: ItemDetail | null; readingFailed: boolean }

/**
 * The item's detail read: the one reading (?include=reading) and what it
 * bought. When the reading cannot be assembled the route answers 500 for the
 * whole read, so the plain read follows and only the field list says it
 * failed.
 */
function useItemDetail(itemId: string, revision: number): { detail: ItemDetail | null; loading: boolean; readingFailed: boolean } {
  const key = `${itemId}:${revision}`
  const [answer, setAnswer] = useState<DetailState | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const read = async (url: string) => {
        const res = await fetch(url)
        if (!res.ok) throw new Error(String(res.status))
        return ((await res.json()) as { data?: ItemDetail }).data ?? null
      }
      try {
        const detail = await read(`${ITEM_URL(itemId)}?include=reading`)
        if (!cancelled) setAnswer({ key, detail, readingFailed: !detail?.reading })
      } catch {
        try {
          const detail = await read(ITEM_URL(itemId))
          if (!cancelled) setAnswer({ key, detail, readingFailed: true })
        } catch {
          if (!cancelled) setAnswer({ key, detail: null, readingFailed: true })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [itemId, key])

  const current = answer?.key === key ? answer : null
  return { detail: current?.detail ?? null, loading: current === null, readingFailed: current?.readingFailed ?? false }
}

/** The proposal for a matched purchase, read only while the item asks to book one. */
function useSuggestion(itemId: string, transactionId: string | null, wanted: boolean): SuggestedBooking | null {
  const key = wanted && transactionId ? `${itemId}:${transactionId}` : null
  const [answer, setAnswer] = useState<{ key: string; data: SuggestedBooking | null } | null>(null)

  useEffect(() => {
    if (!key) return
    const controller = new AbortController()
    fetch(`${ITEM_URL(itemId)}/suggest-booking`, { method: 'POST', signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const json = (await res.json()) as { data?: SuggestedBooking }
        setAnswer({ key, data: json.data ?? null })
      })
      .catch(() => {
        // No proposal is not the user's doing: the editor opens empty instead.
        if (!controller.signal.aborted) setAnswer({ key, data: null })
      })
    return () => controller.abort()
  }, [itemId, key])

  return key && answer?.key === key ? answer.data : null
}

export interface FinePrintOpen {
  booking: boolean
  fields: boolean
}

/**
 * One item in focus, laid out like a desk: the document as a sheet of paper
 * on the left (with "Öppna i full storlek" and "Visa originalet" under it),
 * on the right who sent it, the one question with its evidence, where it
 * will be booked, the answers, and the fine print folded away. On a phone
 * the question comes first and the document under it.
 */
export function FocusStage({
  item,
  companion = null,
  revision,
  finishing,
  finePrint,
  onFinePrint,
  onBankMatch,
  onDone,
  startable,
  ownerAccount = null,
  onBack,
  onBook,
  openEditor = null,
  canWrite = true,
}: {
  item: InkorgItem
  /** The receipt the invoice came with as one purchase (its pairing): shown as its second document. */
  companion?: InkorgItem | null
  /** Bumped after every action, so the detail is read again. */
  revision: number
  /** The item just finished: "Klart" sits over it while it leaves. */
  finishing: boolean
  finePrint: FinePrintOpen
  /** Takes an update, so two folds toggled in one moment both count. */
  onFinePrint: Dispatch<SetStateAction<FinePrintOpen>>
  /** What the detail read says about the bank row it looks paid by (null: none), for the list to say too. */
  onBankMatch?: (itemId: string, match: BankMatch | null) => void
  onDone: DecisionDone
  /** What the company can start (its switched-on packages); every package on when absent. */
  startable?: InkorgStartable
  /** The account a cost paid with the owner's own money is booked against (enskild firma: 2018). */
  ownerAccount?: string | null
  /** Back to the list, the item untouched: an answer that writes nothing. */
  onBack?: () => void
  /** One click: the page holds the booking a moment (Ångra), then sends it. */
  onBook?: (booking: OneClickBooking) => void
  /** Bumped when a one-click booking came back refused for its date: the editor opens, prefilled. */
  openEditor?: number | null
  /** False for a read-only member: every answer and edit is locked. */
  canWrite?: boolean
}) {
  const t = useTranslations('inkorg')
  const tWork = useTranslations('inbox_workspace')
  const doorName = useDoorName(item.channel_context?.mail_provider ?? null)
  const locale = useLocale()
  const [docGeneration, setDocGeneration] = useState(0)
  // The sheet shows the invoice; with a receipt beside it, the person can turn to the receipt.
  const [receiptShownFor, setReceiptShownFor] = useState<string | null>(null)
  const receiptDocumentId = companion?.document_id ?? null
  const showingReceipt = receiptShownFor === item.id && !!receiptDocumentId
  const { meta: invoiceMeta, state: invoiceDocState } = useDocumentMeta(item.document_id, docGeneration)
  const { meta: receiptMeta, state: receiptDocState } = useDocumentMeta(showingReceipt ? receiptDocumentId : null, docGeneration)
  const meta = showingReceipt ? receiptMeta : invoiceMeta
  const docState = showingReceipt ? receiptDocState : invoiceDocState
  const { detail, loading: detailLoading, readingFailed } = useItemDetail(item.id, revision)
  // A document nobody read gets "Läs igen" only where the server would read it (retry-extraction needs ai).
  const canRead = useCapability(CAPABILITY.ai)
  // Until the detail lands, the match the list read carried: the question does not change under the person.
  const decision = focusDecision(item, { bankMatch: detail ? (detail.bank_match ?? null) : (item.bank_match ?? null), startable, companion, canRead })
  const suggestion = useSuggestion(item.id, item.matched_transaction_id, decision.question === 'book_purchase')
  // What one click books, read after the detail (whose read checks the bank first), and again for each answer.
  const [answers, setAnswers] = useState<{ itemId: string; category: number; seller: SellerRegion | null }>({ itemId: item.id, category: 0, seller: null })
  const answered = answers.itemId === item.id ? answers : { itemId: item.id, category: 0, seller: null }
  const bookingPlan = useBookingPlan(
    item.id,
    !detailLoading && FIRST_DECISION.has(decision.question),
    `${item.id}:${revision}:${answered.category}:${detail?.bank_match?.transaction_id ?? ''}`,
    answered.seller ? { seller_country: answered.seller } : {},
  )
  const plan = bookingPlan?.plan ?? null
  const headline = itemHeadline(item)
  const account = plan?.costAccount ?? bookedOnAccount(suggestion?.lines)

  // The list says "Ser redan betald ut" for what the detail read found.
  const bankMatch = detailLoading ? undefined : (detail?.bank_match ?? null)
  useEffect(() => {
    if (bankMatch !== undefined) onBankMatch?.(item.id, bankMatch)
  }, [item.id, bankMatch, onBankMatch])

  // The verifikat that says why: the item's own, or the one that books its matched
  // transaction (also when this underlag has not reached it yet, which is why it is here).
  const whyEntryId = item.created_journal_entry_id ?? item.matched_transaction_journal_entry_id ?? item.document_journal_entry_id ?? null
  // Each part stays whole when the line wraps: a date never breaks inside.
  const kindLabelKey = inboxKindLabelKey(headline.kind, item.extracted_data)
  // The mail's sender sits beside the door it came through. An address can outgrow a narrow column, so it alone may break inside.
  const mailSender = mailSenderOf(item)
  const metaFacts: { text: string | null; sender?: boolean }[] = [
    { text: kindLabelKey ? tWork(kindLabelKey) : null },
    { text: doorName(doorOf(item)) },
    { text: mailSender ? t('meta_from', { sender: mailSender }) : null, sender: true },
    { text: shortDateTime(item.created_at, locale) },
  ]
  const metaParts = metaFacts.filter((part): part is { text: string; sender?: boolean } => Boolean(part.text))

  // The company's own invoice bought nothing: no category is asked for.
  const category =
    item.extracted_data && !isOwnIssuedInvoice(item.extracted_data) && detail?.purchase_category !== undefined ? (
      <PurchaseCategoryChip
        itemId={item.id}
        value={detail.purchase_category}
        alternatives={detail.purchase_category_alternatives}
        locked={!!item.created_supplier_invoice_id || !canWrite}
        // "Varje gång" needs a matched supplier card; the headline is its name as read.
        supplierName={detail.matched_supplier_id && item.extracted_data.supplier?.name?.trim() ? headline.name : null}
        label={account ? null : undefined}
        // One click waits for what was bought: the chip asks for it.
        prompt={plan?.ask === 'category'}
        onChange={() => setAnswers({ ...answered, category: answered.category + 1 })}
      />
    ) : null

  // Where it will be booked, on the page rather than in the fold: the account when a
  // proposal names one, and what it bought, with Ändra.
  const bookingLine = detailLoading ? (
    <Skeleton className="h-5 w-56 rounded-sm" />
  ) : plan?.ask === 'seller_country' ? (
    // Nothing on the document says where the seller is: one row of chips, in place of the category's.
    <div role="group" aria-label={t('seller_country_question')} className="flex flex-wrap items-center gap-2 text-[13px]">
      <span className="text-muted-foreground">{t('seller_country_question')}</span>
      {SELLER_REGIONS.map((region) => (
        <Button key={region} type="button" variant="outline" onClick={() => setAnswers({ ...answered, seller: region })}>
          {t(`seller_country_${region}`)}
        </Button>
      ))}
    </div>
  ) : account || category ? (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
      {account && (
        <>
          <span className="text-muted-foreground">{t('booked_on')}</span>
          <span className="font-medium tabular-nums">{formatAccountWithName(account)}</span>
        </>
      )}
      {category}
    </div>
  ) : null

  return (
    <div className="relative">
      {/* The sheet takes its width from its height (A4), so the document fills it; the answers take the rest. */}
      <div className="flex flex-col gap-8 lg:grid lg:grid-cols-[auto_minmax(0,1fr)] lg:items-start lg:gap-10">
        <div className="order-2 space-y-3 lg:order-1">
          <FocusDocumentPreview
            meta={meta}
            state={docState}
            onRetry={() => setDocGeneration((g) => g + 1)}
            className="aspect-[210/297] lg:h-[calc(100vh-12rem)] lg:w-auto lg:max-w-[40rem]"
            paper
          />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            {meta && (
              <a href={meta.url} target="_blank" rel="noopener noreferrer" className={QUIET_LINK_CLASS}>
                {t('open_full_size')}
              </a>
            )}
            {receiptDocumentId && (
              <button type="button" onClick={() => setReceiptShownFor(showingReceipt ? null : item.id)} className={QUIET_LINK_CLASS}>
                {showingReceipt ? t('companion_show_invoice') : t('companion_show')}
              </button>
            )}
            <InboxArrivalProvenance documentId={item.document_id} mailProvider={item.channel_context?.mail_provider ?? null} variant="original_link" />
          </div>
        </div>

        <div className="@container order-1 min-w-0 space-y-6 lg:order-2 lg:max-w-[36rem]">
          <header className="flex items-start gap-3 border-b-hairline pb-6">
            {headline.name ? (
              <BrandMark name={headline.name} variant="mark" size={40} logoUrl={item.logo_url} />
            ) : (
              <GlyphMark size={40}>
                <DocumentMagnifyingGlassIcon aria-hidden="true" className="h-5 w-5 text-muted-foreground" />
              </GlyphMark>
            )}
            <div className="min-w-0 flex-1">
              {/* Sized by the column, not the window: the large step only where the name and the amount fit side by side. */}
              <h2 data-ph-mask="" className="text-2xl leading-8 tracking-[-0.02em] [overflow-wrap:anywhere] @lg:text-3xl @lg:leading-9">
                {headline.name ?? t('row_unknown')}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {metaParts.map((part, i) => (
                  <span
                    key={i}
                    data-ph-mask={part.sender ? '' : undefined}
                    className={part.sender ? '[overflow-wrap:anywhere]' : 'whitespace-nowrap'}
                  >
                    {i > 0 && ' · '}
                    {part.text}
                  </span>
                ))}
              </p>
              {/* A narrow column puts the amount under the name instead of squeezing the name beside it. */}
              {headline.amount != null && (
                <p data-ph-mask="" className="mt-2 font-display text-2xl leading-8 tracking-[-0.02em] tabular-nums @lg:hidden">
                  {formatCurrency(headline.amount, headline.currency)}
                </p>
              )}
            </div>
            {headline.amount != null && (
              <p data-ph-mask="" className="hidden shrink-0 pt-1 font-display text-3xl leading-9 tracking-[-0.02em] tabular-nums @lg:block">
                {formatCurrency(headline.amount, headline.currency)}
              </p>
            )}
          </header>

          {/* What the sender wrote with the document (a partner's delivery note), read before deciding. */}
          <InboxArrivalProvenance documentId={item.document_id} variant="note" />

          {companion && (
            <CompanionReceipt
              receipt={companion}
              showing={showingReceipt}
              onToggle={receiptDocumentId ? () => setReceiptShownFor(showingReceipt ? null : item.id) : undefined}
            />
          )}

          <FocusDecision
            item={item}
            decision={decision}
            suggestion={suggestion}
            documentMeta={invoiceMeta}
            bookingLine={bookingLine}
            onDone={onDone}
            ownerAccount={ownerAccount}
            matchedSupplierId={detail?.matched_supplier_id ?? null}
            onBack={onBack}
            bookingPlan={bookingPlan}
            answers={answered.seller ? { seller_country: answered.seller } : {}}
            onBook={onBook}
            canWrite={canWrite}
            openEditor={openEditor}
          />

          <div className="border-t-hairline">
            <Fold
              className="border-b-hairline"
              label={t('fine_booking')}
              open={finePrint.booking}
              onToggle={(booking) => onFinePrint((current) => ({ ...current, booking }))}
            >
              <div className="space-y-3 pb-4">
                {plan && plan.lines.length > 0 ? (
                  <ProposalLines lines={plan.lines} />
                ) : (
                  suggestion && suggestion.lines.length > 0 && <ProposalLines lines={suggestion.lines} />
                )}
                {whyEntryId && <BookingWhy journalEntryId={whyEntryId} variant="inline" />}
                {/* Where it came from, read off its arrivals; the rail's own chrome is flattened here. */}
                <div className="[&>div]:border-b-0 [&>div]:px-0 [&>div]:py-0">
                  <InboxArrivalProvenance
                    documentId={item.document_id}
                    mailProvider={item.channel_context?.mail_provider ?? null}
                    withNote={false}
                    formatDate={(iso) => shortDate(iso, locale)}
                    fallback={
                      item.email_from || item.email_subject ? (
                        <p data-ph-mask="" className="text-xs text-muted-foreground">
                          {[item.email_from, item.email_subject].filter(Boolean).join(' · ')}
                        </p>
                      ) : null
                    }
                  />
                </div>
              </div>
            </Fold>
            <Fold
              className="border-b-hairline"
              label={t('fine_fields')}
              open={finePrint.fields}
              onToggle={(fields) => onFinePrint((current) => ({ ...current, fields }))}
            >
              <div className="pb-4">
                <FocusDocumentFields
                  itemId={item.id}
                  reading={detail?.reading ?? null}
                  loading={detailLoading}
                  failed={!detailLoading && readingFailed}
                  locked={!!item.created_supplier_invoice_id || !canWrite}
                  onChanged={() => void onDone({ leaves: false })}
                />
              </div>
            </Fold>
          </div>
        </div>
      </div>

      {finishing && (
        <div className="absolute inset-0 flex items-start justify-center bg-background/70 pt-12 animate-fade-in" aria-live="polite">
          <span className="flex items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-[13px] font-medium">
            <CheckIcon aria-hidden="true" className="h-4 w-4" />
            {t('done')}
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * The receipt that came with the invoice as one purchase, as one hairline
 * row: what it is, how it says it was paid, and a way to turn the sheet to
 * it. Its own row in the list is hidden; it is booked with the invoice.
 */
function CompanionReceipt({ receipt, showing, onToggle }: { receipt: InkorgItem; showing: boolean; onToggle?: () => void }) {
  const t = useTranslations('inkorg')
  const payment = receipt.extracted_data?.payment
  const paid = payment?.method
    ? payment.method === 'card' && payment.cardLast4
      ? t(receipt.payment_card_known === true ? 'ev_paid_card_last4' : 'ev_paid_card_last4_unknown', { last4: payment.cardLast4 })
      : t(`ev_paid_${payment.method}`)
    : null
  return (
    <div role="group" aria-label={t('companion_label')} className="flex items-center gap-3 rounded-lg px-4 py-3 text-[13px] bg-control shadow-raised">
      <PaperClipIcon aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block">{t('companion_title')}</span>
        {paid && (
          <span data-ph-mask="" className="block text-xs text-muted-foreground">
            {paid}
          </span>
        )}
      </span>
      {onToggle && (
        <button type="button" onClick={onToggle} className={`${QUIET_LINK_CLASS} shrink-0 text-xs`}>
          {showing ? t('companion_show_invoice') : t('companion_show')}
        </button>
      )}
    </div>
  )
}

/** The proposed kontering, read-only: what one click books, or what "Granska och bokför" opens with. */
function ProposalLines({ lines }: { lines: ReadonlyArray<Pick<SuggestedBooking['lines'][number], 'account_number' | 'description' | 'debit_amount' | 'credit_amount'>> }) {
  const t = useTranslations('inkorg')
  return (
    <table className="w-full border-collapse text-xs">
      <caption className="pb-1 text-left text-xs text-muted-foreground">{t('proposal_caption')}</caption>
      <tbody>
        {lines.map((line, i) => (
          <tr key={`${line.account_number}-${i}`} className="border-b-hairline last:border-0">
            <td className="w-12 py-1 pr-2 tabular-nums text-muted-foreground">{line.account_number}</td>
            <td data-ph-mask="" className="max-w-0 truncate py-1 pr-2">
              {line.description}
            </td>
            {/* Journal lines are in SEK whatever the document's currency. */}
            <td data-ph-mask="" className="w-24 py-1 text-right tabular-nums">
              {line.debit_amount ? formatRowAmount(line.debit_amount, 'SEK') : ''}
            </td>
            <td data-ph-mask="" className="w-24 py-1 pl-2 text-right tabular-nums text-muted-foreground">
              {line.credit_amount ? formatRowAmount(line.credit_amount, 'SEK') : ''}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
