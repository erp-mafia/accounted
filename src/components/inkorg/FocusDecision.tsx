'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AttnLine } from '@/components/ui/attn-line'
import { ToastAction } from '@/components/ui/toast'
import { useToast } from '@/components/ui/use-toast'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import NewSupplierInvoiceDialog from '@/components/supplier-invoices/NewSupplierInvoiceDialog'
import TransactionMatchPicker from '@/components/inbox/TransactionMatchPicker'
import RegisterExpenseDialog, { type ExpensePayer } from '@/components/extensions/general/RegisterExpenseDialog'
import EditKonteringDialog from '@/components/extensions/general/EditKonteringDialog'
import BookDirectlyDialog from '@/components/extensions/general/BookDirectlyDialog'
import { InboxCreditNotePanel } from '@/components/extensions/general/InboxCreditNotePanel'
import { BrandMark } from '@/components/parties/BrandMark'
import { getResponseErrorMessage } from '@/lib/errors/get-error-message'
import { notifySessionExpired } from '@/lib/auth/session-timeout-shared'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { useCompanySettings } from '@/lib/reference-data/hooks'
import { cn, formatCurrency } from '@/lib/utils'
import { shortDate } from '@/lib/inkorg/dates'
import type { DecisionAction, DecisionEvidence, FocusDecision as Decision } from '@/lib/inkorg/decision'
import { itemHeadline, type InkorgItem } from '@/lib/inkorg/items'
import { ownerPaidLines, templateCostAccount, type CounterpartyTemplateMatch } from '@/lib/inkorg/owner-paid'
import type { PackageId } from '@/lib/modules/packages'
import type { InvoiceExtractionResult } from '@/types'
import type { DocumentMeta } from './FocusDocumentPreview'
import type { PayInBankTarget } from './PayInBankDialog'
import { PayFromDocumentDialog } from './PayFromDocumentDialog'

const ITEM_URL = (id: string) => `/api/extensions/ext/invoice-inbox/items/${id}`

/** Where a package is switched on: Inställningar, Anpassa, opened at the package the answer needs. */
const ANPASSA_PACKAGE: Record<'turn_on_supplier_invoices' | 'turn_on_expenses', PackageId> = {
  turn_on_supplier_invoices: 'supplier-invoices-and-payments',
  turn_on_expenses: 'expenses',
}

/** What POST /items/:id/suggest-booking answers, as far as the focus view reads it. */
export interface SuggestedBooking {
  source: string
  lines: { account_number: string; debit_amount: number; credit_amount: number; description: string; dimensions?: Record<string, string> }[]
  fallback_lines?: { account_number: string; debit_amount: number; credit_amount: number; description: string }[]
  entry_date?: string
  transaction?: { amount_sek: number; date: string } | null
}

/**
 * An action finished. `leaves`: the item is done here and leaves the queue
 * (the next opens by itself). `payInBank`: the invoice was registered to be
 * paid in the bank; the page shows what to type there, over the next item.
 * `dropped`: it left as not an underlag, nothing booked (a receipt that came
 * with it has no booking to follow).
 */
export type DecisionDone = (outcome: { leaves: boolean; payInBank?: PayInBankTarget; dropped?: boolean }) => Promise<void>

/**
 * The cost account the company booked this supplier on before (its
 * counterparty template), read while "Privat, med mina egna pengar" is on
 * offer, so the verifikat opens with it. Best effort: no answer leaves the
 * cost line for the person to pick.
 */
function useSupplierCostAccount(supplierName: string | null, wanted: boolean): string | null {
  const key = wanted && supplierName ? supplierName : null
  const [answer, setAnswer] = useState<{ key: string; account: string | null } | null>(null)

  useEffect(() => {
    if (!key) return
    const controller = new AbortController()
    fetch(`/api/settings/counterparty-templates?counterparty=${encodeURIComponent(key)}`, { signal: controller.signal })
      .then(async (res) => {
        const match = res.ok ? ((await res.json()) as { data?: CounterpartyTemplateMatch | null }).data : null
        setAnswer({ key, account: templateCostAccount(match) })
      })
      .catch(() => {
        if (!controller.signal.aborted) setAnswer({ key, account: null })
      })
    return () => controller.abort()
  }, [key])

  return key && answer?.key === key ? answer.account : null
}

/**
 * The one question, its evidence and at most three answers, each on the
 * action the Underlag workspace already runs: the same dialogs and the same
 * endpoints. The first two answers sit side by side; the third is a quiet
 * text button under them. Ångra follows a match and its release, the two an
 * endpoint truly undoes; everything that posts confirms in its own dialog
 * first, and dropping an item confirms because nothing can bring it back.
 *
 * The answers that follow the company's switched-off packages: paying from
 * the document and waiting for the payment write nothing and go back to the
 * list; the owner's own money books through book-direct (a receipts door,
 * never gated) with the payment on the owner's account; switching a package
 * on is a link to Anpassa, with one line saying why it is needed.
 */
export function FocusDecision({
  item,
  decision,
  suggestion,
  documentMeta,
  bookingLine,
  onDone,
  ownerAccount = null,
  matchedSupplierId = null,
  onBack,
}: {
  item: InkorgItem
  decision: Decision
  suggestion: SuggestedBooking | null
  documentMeta: DocumentMeta | null
  /** "Bokförs på ...": where it will be booked, between the evidence and the answers. */
  bookingLine?: ReactNode
  onDone: DecisionDone
  /** The account a cost paid with the owner's own money is booked against (enskild firma: 2018). */
  ownerAccount?: string | null
  /** The supplier card the reading matched, for the pay-from-document panel's payee check. */
  matchedSupplierId?: string | null
  /** Back to the list with the item untouched. */
  onBack?: () => void
}) {
  const t = useTranslations('inkorg')
  const tWork = useTranslations('inbox_workspace')
  const { toast } = useToast()
  const locale = useLocale()
  const router = useRouter()
  const paidLooking = decision.question === 'already_paid'
  const { dialogProps, confirm } = useDestructiveConfirm()
  // invoice: register it; settle: register it and settle it against the bank row; pay: register it to pay in the bank;
  // pay_doc: pay from the document, nothing registered; owner: book it as paid with the owner's own money.
  const [open, setOpen] = useState<null | 'invoice' | 'settle' | 'pay' | 'pay_doc' | 'match' | 'book' | 'owner' | 'editor'>(null)
  const { settings: companySettings } = useCompanySettings()
  const ownerCostAccount = useSupplierCostAccount(
    item.extracted_data?.supplier?.name?.trim() || null,
    !!ownerAccount && decision.actions.includes('owner_paid'),
  )
  const [expensePayer, setExpensePayer] = useState<ExpensePayer | null>(null)
  const [busy, setBusy] = useState<DecisionAction | null>(null)
  const data = item.extracted_data

  async function failed(title: string, res: Response) {
    notifySessionExpired(res)
    toast({ title, description: await getResponseErrorMessage(res, undefined, locale === 'en' ? 'en' : 'sv'), variant: 'destructive' })
  }

  async function post(url: string, body?: unknown): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
  }

  /** Ångra for a match: release it again. */
  function offerUndoMatch(title: string) {
    toast({
      title,
      action: (
        <ToastAction
          altText={t('undo')}
          onClick={async () => {
            const res = await post(`${ITEM_URL(item.id)}/unmatch-transaction`)
            if (!res.ok) return failed(t('undo_failed'), res)
            toast({ title: t('undone') })
            await onDone({ leaves: false })
          }}
        >
          {t('undo')}
        </ToastAction>
      ),
    })
  }

  /** Ser redan betald ut: link it to the bank row found on arrival, as the picker would. */
  async function acceptBankMatch() {
    if (decision.evidence?.kind !== 'bank_match') return
    const transactionId = decision.evidence.transactionId
    setBusy('accept_bank_match')
    try {
      const res = await post(`${ITEM_URL(item.id)}/match-transaction`, { transaction_id: transactionId })
      if (!res.ok) return failed(t('bank_match_failed'), res)
      await onDone({ leaves: false })
      offerUndoMatch(t('matched'))
    } finally {
      setBusy(null)
    }
  }

  async function unmatch() {
    const previous = item.matched_transaction_id
    setBusy('unmatch')
    try {
      const res = await post(`${ITEM_URL(item.id)}/unmatch-transaction`)
      if (!res.ok) return failed(t('unmatch_failed'), res)
      await onDone({ leaves: false })
      if (!previous) return
      // Ångra makes the same match again: match-transaction restores what unmatch released.
      toast({
        title: t('unmatched'),
        action: (
          <ToastAction
            altText={t('undo')}
            onClick={async () => {
              const again = await post(`${ITEM_URL(item.id)}/match-transaction`, { transaction_id: previous })
              if (!again.ok) return failed(t('undo_failed'), again)
              toast({ title: t('undone') })
              await onDone({ leaves: false })
            }}
          >
            {t('undo')}
          </ToastAction>
        ),
      })
    } finally {
      setBusy(null)
    }
  }

  async function retryReading() {
    const hasFields = !!(data?.supplier?.name || data?.totals?.total != null)
    const run = async () => {
      setBusy('retry_reading')
      try {
        const res = await post(`${ITEM_URL(item.id)}/retry-extraction`)
        if (!res.ok) return failed(t('retry_failed'), res)
        await onDone({ leaves: false })
      } finally {
        setBusy(null)
      }
    }
    // A new reading replaces the fields, corrections included: ask first when there is anything to lose.
    if (!hasFields) return run()
    await confirm(
      { title: t('retry_confirm_title'), description: tWork('retry_overwrite_confirm'), confirmLabel: t('action_retry_reading'), variant: 'warning' },
      run,
    )
  }

  /** Nothing is written: the item stays, and the bank check offers its row once the payment arrives. */
  function leaveUntilPaid() {
    setOpen(null)
    toast({ title: t('offered_when_paid') })
    onBack?.()
  }

  async function dropItem() {
    await confirm(
      { title: t('drop_confirm_title'), description: t('drop_confirm_body'), confirmLabel: t('drop_confirm_label'), variant: 'destructive' },
      async () => {
        const res = await fetch(ITEM_URL(item.id), { method: 'DELETE' })
        if (!res.ok) {
          await failed(t('drop_failed'), res)
          throw new Error('drop failed')
        }
        await onDone({ leaves: true, dropped: true })
      },
    )
  }

  // The first answer is the primary pill, the second the secondary one beside it, the third a quiet text button.
  const variantAt = (index: number) => (index === 0 ? 'default' : index === 1 ? 'secondary' : 'ghost')
  // Two pills side by side from a tablet up, the quiet third under them; on a phone all
  // three full width, the third centred like the others rather than alone at the edge.
  const width = 'w-full sm:w-auto'

  function renderAction(action: DecisionAction, index: number) {
    const variant = variantAt(index)
    switch (action) {
      case 'register_invoice':
        return (
          <Button key={action} variant={variant} className={width} onClick={() => setOpen('invoice')}>
            {paidLooking
              ? t('action_not_paid')
              : decision.question === 'invoice_paid'
                ? t('action_register_unpaid')
                : t('action_register_invoice')}
          </Button>
        )
      case 'register_and_settle':
        return (
          <Button key={action} variant={variant} className={width} onClick={() => setOpen('settle')}>
            {t('action_register_and_settle')}
          </Button>
        )
      case 'pay_in_bank':
        return (
          <Button key={action} variant={variant} className={width} onClick={() => setOpen('pay')}>
            {t('action_pay_in_bank')}
          </Button>
        )
      case 'accept_bank_match':
        return (
          <Button key={action} variant={variant} className={width} disabled={busy !== null} loading={busy === 'accept_bank_match'} onClick={() => void acceptBankMatch()}>
            {t('action_accept_bank_match')}
          </Button>
        )
      case 'match_purchase':
        return (
          <Button key={action} variant={variant} className={width} onClick={() => setOpen('match')}>
            {paidLooking
              ? t('action_pick_other_row')
              : decision.question === 'invoice_paid'
                ? t('action_match_paid')
                : t('action_match_company')}
          </Button>
        )
      case 'expense':
        return (
          <DropdownMenu key={action}>
            <DropdownMenuTrigger asChild>
              <Button variant={variant} className={width}>
                {t('action_expense')}
                <ChevronDown aria-hidden="true" className="ml-1 h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => setExpensePayer('owner')}>{tWork('payer_owner')}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setExpensePayer('employee')}>{tWork('payer_employee')}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )
      case 'book':
        return (
          <Button key={action} variant={variant} className={width} onClick={() => setOpen('book')}>
            {suggestion?.lines.length ? tWork('review_and_book') : tWork('book_manually')}
          </Button>
        )
      case 'unmatch':
        return (
          <Button key={action} variant={variant} className={width} onClick={() => void unmatch()} loading={busy === 'unmatch'}>
            {t('action_unmatch')}
          </Button>
        )
      case 'not_underlag':
        return (
          <Button key={action} variant={variant} className={width} onClick={() => void dropItem()}>
            {t('action_not_underlag')}
          </Button>
        )
      case 'retry_reading':
        return (
          <Button key={action} variant={variant} className={width} onClick={() => void retryReading()} loading={busy === 'retry_reading'}>
            {t('action_retry_reading')}
          </Button>
        )
      case 'open_entry':
        return item.created_journal_entry_id ? (
          <Button key={action} asChild variant={variant} className={width}>
            <Link href={`/bookkeeping/${item.created_journal_entry_id}`}>{t('action_open_entry')}</Link>
          </Button>
        ) : null
      case 'open_matched_entry':
        return item.matched_transaction_journal_entry_id ? (
          <Button key={action} asChild variant={variant} className={width}>
            <Link href={`/bookkeeping/${item.matched_transaction_journal_entry_id}`}>{t('action_open_entry')}</Link>
          </Button>
        ) : null
      case 'open_supplier_invoice':
        return item.created_supplier_invoice_id ? (
          <Button key={action} asChild variant={variant} className={width}>
            <Link href={`/supplier-invoices/${item.created_supplier_invoice_id}`}>{t('action_open_supplier_invoice')}</Link>
          </Button>
        ) : null
      case 'pay_in_bank_unregistered':
        return (
          <Button key={action} variant={variant} className={width} onClick={() => setOpen('pay_doc')}>
            {t('action_pay_in_bank')}
          </Button>
        )
      case 'wait_for_payment':
        return (
          <Button key={action} variant={variant} className={width} onClick={leaveUntilPaid}>
            {t('action_wait_for_payment')}
          </Button>
        )
      case 'owner_paid':
        return (
          // Without the owner's account (never for an enskild firma) the verifikat editor stands in.
          <Button key={action} variant={variant} className={width} onClick={() => setOpen(ownerAccount ? 'owner' : 'editor')}>
            {t('action_owner_paid')}
          </Button>
        )
      case 'turn_on_supplier_invoices':
      case 'turn_on_expenses':
        return (
          <Button key={action} asChild variant={variant} className={width}>
            <Link href={`/settings/anpassa?package=${ANPASSA_PACKAGE[action]}`}>{t(`action_${action}`)}</Link>
          </Button>
        )
      case 'credit':
        // The credit note's own panel: which invoice it credits, and Kreditera.
        return null
    }
  }

  const buttons = decision.actions.filter((a) => a !== 'credit')
  const settleWith =
    decision.evidence?.kind === 'bank_match'
      ? {
          transactionId: decision.evidence.transactionId,
          date: decision.evidence.date,
          amount: decision.evidence.amount,
          currency: decision.evidence.currency,
          counterparty: decision.evidence.counterparty,
        }
      : null

  const evidence = decision.evidence
  const question =
    evidence?.kind === 'bank_match' ? t('q_already_paid_on', { date: shortDate(evidence.date, locale) }) : t(`q_${decision.question}`)
  const rendered = buttons.map(renderAction).filter(Boolean)

  return (
    <section aria-labelledby={`q-${item.id}`} className="space-y-6">
      <div className="space-y-3">
        <h3 id={`q-${item.id}`} className="font-display text-2xl leading-8 tracking-[-0.02em]">
          {question}
        </h3>
        {evidence?.kind === 'bank_match' ? (
          <BankMatchEvidence evidence={evidence} item={item} />
        ) : (
          <Evidence evidence={evidence} suggestion={suggestion} />
        )}
      </div>

      {bookingLine}

      {decision.actions.includes('credit') && (
        <InboxCreditNotePanel
          itemId={item.id}
          extracted={(data ?? null) as Record<string, unknown> | null}
          onCredited={() => onDone({ leaves: true })}
          onFieldsUpdated={() => void onDone({ leaves: false })}
        />
      )}

      {rendered.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">{rendered.slice(0, 2)}</div>
          {rendered.length > 2 && <div className="flex">{rendered.slice(2)}</div>}
          {/* Why a package has to be switched on first: one plain line. */}
          {decision.actions.includes('turn_on_supplier_invoices') && (
            <p className="text-[12.5px] text-muted-foreground">{t('why_supplier_invoices')}</p>
          )}
          {decision.actions.includes('turn_on_expenses') && <p className="text-[12.5px] text-muted-foreground">{t('why_expenses')}</p>}
        </div>
      )}

      {(decision.editorEscape || decision.quietActions.length > 0) && (
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {decision.editorEscape && (
            <button type="button" onClick={() => setOpen('editor')} className={cn(QUIET_LINK_CLASS, 'text-[12.5px]')}>
              {tWork('payer_open_editor')}
            </button>
          )}
          {decision.quietActions.includes('not_underlag') && (
            <button type="button" onClick={() => void dropItem()} className={cn(QUIET_LINK_CLASS, 'text-[12.5px]')}>
              {t('action_not_underlag')}
            </button>
          )}
        </div>
      )}

      <NewSupplierInvoiceDialog
        open={open === 'invoice' || open === 'settle' || open === 'pay'}
        onOpenChange={(next) => {
          if (!next) setOpen(null)
        }}
        inboxItemId={item.id}
        // Settled on registration against the bank row it looks paid by (POST /api/inkorg/items/:id/register-and-settle).
        settleWith={open === 'settle' ? settleWith : null}
        onCreated={async (invoiceId) => {
          const mode = open
          setOpen(null)
          await onDone(mode === 'pay' ? { leaves: true, payInBank: { inboxItemId: item.id, supplierInvoiceId: invoiceId ?? null } } : { leaves: true })
        }}
      />
      <TransactionMatchPicker
        open={open === 'match'}
        onClose={() => setOpen(null)}
        inboxItemId={item.id}
        extractedData={data as InvoiceExtractionResult | null}
        onMatched={async () => {
          setOpen(null)
          await onDone({ leaves: false })
          offerUndoMatch(t('matched'))
        }}
      />
      {expensePayer && (
        <RegisterExpenseDialog
          open
          onOpenChange={(next) => {
            if (!next) setExpensePayer(null)
          }}
          item={item}
          payer={expensePayer}
          onSuccess={async () => {
            setExpensePayer(null)
            await onDone({ leaves: true })
            // The Utlägg menu row shows once a claim exists; the layout computes it.
            router.refresh()
          }}
        />
      )}
      {decision.actions.includes('book') && (
        <EditKonteringDialog
          open={open === 'book'}
          onOpenChange={(next) => setOpen(next ? 'book' : null)}
          itemId={item.id}
          documentId={item.document_id}
          documentMime={documentMeta?.mime ?? null}
          documentUrl={null}
          fileName={null}
          transactionId={item.matched_transaction_id}
          // The bank's date is the business event for a matched purchase; then the document's own date.
          entryDate={suggestion?.entry_date ?? data?.invoice?.invoiceDate ?? todayIsoStockholm()}
          description={data?.supplier?.name ?? item.email_subject ?? t('document_label')}
          lines={suggestion?.lines.length ? suggestion.lines : (suggestion?.fallback_lines ?? [])}
          matchedTransaction={suggestion?.transaction ?? null}
          onBooked={() => {
            setOpen(null)
            void onDone({ leaves: true })
          }}
        />
      )}
      {decision.actions.includes('owner_paid') && ownerAccount && (
        <EditKonteringDialog
          open={open === 'owner'}
          onOpenChange={(next) => setOpen(next ? 'owner' : null)}
          itemId={item.id}
          documentId={item.document_id}
          documentMime={documentMeta?.mime ?? null}
          documentUrl={null}
          fileName={null}
          // Never touched the company account: no bank row, and the payment side is the owner's.
          transactionId={null}
          entryDate={data?.invoice?.invoiceDate ?? todayIsoStockholm()}
          description={data?.supplier?.name ?? item.email_subject ?? t('document_label')}
          lines={ownerPaidLines(data ?? null, ownerAccount, companySettings?.vat_registered, ownerCostAccount)}
          onBooked={() => {
            setOpen(null)
            void onDone({ leaves: true })
          }}
        />
      )}
      {decision.actions.includes('pay_in_bank_unregistered') && (
        <PayFromDocumentDialog
          open={open === 'pay_doc'}
          reading={data ?? null}
          matchedSupplierId={matchedSupplierId}
          onClose={() => setOpen(null)}
          onDone={leaveUntilPaid}
        />
      )}
      {decision.editorEscape && (
        <BookDirectlyDialog
          open={open === 'editor'}
          onOpenChange={(next) => setOpen(next ? 'editor' : null)}
          item={item}
          docUrl={documentMeta?.url ?? null}
          docMime={documentMeta?.mime ?? null}
          onSuccess={async () => {
            setOpen(null)
            await onDone({ leaves: true })
          }}
        />
      )}
      <DestructiveConfirmDialog {...dialogProps} />
    </section>
  )
}

function Evidence({ evidence, suggestion }: { evidence: DecisionEvidence | null; suggestion: SuggestedBooking | null }) {
  const t = useTranslations('inkorg')
  const tWork = useTranslations('inbox_workspace')
  const locale = useLocale()
  if (!evidence) return null

  const line = (() => {
    switch (evidence.kind) {
      case 'due':
        return t('ev_due', { date: shortDate(evidence.date, locale) })
      case 'issued':
        return t('ev_issued', { date: shortDate(evidence.date, locale) })
      case 'paid_with':
        return evidence.method === 'card' && evidence.cardLast4
          ? t('ev_paid_card_last4', { last4: evidence.cardLast4 })
          : t(`ev_paid_${evidence.method}`)
      case 'amount':
        return evidence.date
          ? t('ev_amount_on', { amount: formatCurrency(evidence.amount, evidence.currency), date: shortDate(evidence.date, locale) })
          : formatCurrency(evidence.amount, evidence.currency)
      case 'linked_purchase':
        return suggestion?.transaction
          ? t('ev_linked_on', {
              date: shortDate(suggestion.transaction.date, locale),
              amount: formatCurrency(Math.abs(suggestion.transaction.amount_sek), 'SEK'),
            })
          : t('ev_linked')
      case 'underlag_status':
      case 'bank_match':
        return null
      case 'credit_note':
        return t('ev_credit_note')
      case 'reading':
        return t('ev_reading')
      case 'unreadable':
        return t('ev_unreadable')
      case 'booked':
        return t('ev_booked')
    }
  })()

  if (evidence.kind === 'underlag_status') {
    return <AttnLine>{tWork(`underlag_${evidence.status}`)}</AttnLine>
  }
  return (
    <p data-ph-mask="" className="text-[13px] text-muted-foreground">
      {line}
    </p>
  )
}

/**
 * The bank row it looks paid by, as a card: the payee's mark, the day, the
 * bank's own text in a monospace face and the amount as the bank has it;
 * under it, in plain words, why they belong together, and how sure that is.
 */
function BankMatchEvidence({ evidence, item }: { evidence: Extract<DecisionEvidence, { kind: 'bank_match' }>; item: InkorgItem }) {
  const t = useTranslations('inkorg')
  const locale = useLocale()
  const bankText = evidence.counterparty ?? t('ev_bank_match_unknown')
  const supplier = itemHeadline(item).name
  const doc = itemHeadline(item).kind === 'receipt' ? 'receipt' : 'invoice'
  return (
    <div className="space-y-3">
      <div
        role="group"
        aria-label={t('bank_row_label')}
        className="flex items-center gap-3 rounded-lg border border-border px-4 py-3 text-[13px]"
      >
        <BrandMark name={evidence.counterparty ?? supplier ?? '?'} variant="mark" size={22} logoUrl={item.logo_url} />
        <span className="shrink-0 tabular-nums">{shortDate(evidence.date, locale)}</span>
        <span data-ph-mask="" className="min-w-0 flex-1 truncate font-mono text-[12.5px] uppercase tracking-[0.02em]">
          {bankText}
        </span>
        <span data-ph-mask="" className="shrink-0 tabular-nums">
          {formatCurrency(evidence.amount, evidence.currency)}
        </span>
      </div>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
        <span>{t(`reason_${evidence.basis}`, { doc })}</span>
        <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[11px] leading-none tracking-[0.02em] text-foreground">
          {t(`level_${evidence.level}`)}
        </span>
      </p>
    </div>
  )
}
