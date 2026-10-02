'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { FileText } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useToast } from '@/components/ui/use-toast'
import { Badge } from '@/components/ui/badge'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useCompany, useCapability } from '@/contexts/CompanyContext'
import { useAccounts, useCompanySettings } from '@/lib/reference-data/hooks'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { AutoGrowTextarea } from '@/components/invoices/AutoGrowTextarea'
import { InvoiceEditorShell, type EditorPane } from './InvoiceEditorShell'
import { InvoiceEditorShellSkeleton } from './InvoiceEditorShellSkeleton'
import { EditorTopBar, type TopBarMenuEntry } from './EditorTopBar'
import { EditorPreviewPane } from './EditorPreviewPane'
import { EditorEmailPreview, type EmailTextOverride } from './EditorEmailPreview'
import { EditorStatusLine } from './EditorStatusLine'
import { EditorSection } from './EditorSection'
import { SendConfirmDialog, type ConfirmVoucher } from './SendConfirmDialog'
import { useInvoicePdfPreview } from './use-editor-previews'
import {
  resolveChannelOptions,
  resolveEffectiveChannel,
  type ChannelContext,
  type EditorChannel,
  type EmailBlockReason,
} from '@/lib/invoices/editor/channel'
import { resolveSendLabel } from '@/lib/invoices/editor/primary-action'
import { resolveEditorStatusLine } from '@/lib/invoices/editor/status-line'
import { proposeCreditNoteSendLines } from '@/lib/invoices/editor/voucher-preview'
import { persistAndSend } from '@/lib/invoices/editor/send-sequence'
import { creditNoteNumber, creditNoteOriginalReference } from '@/lib/invoices/build-credit-note'
import { creditNoteNeedsJournalEntry } from '@/lib/bookkeeping/booking-mode'
import { isEntityType } from '@/lib/company/entity-type'
import { EMAIL_PATTERN, parseInvoiceRecipientText } from '@/lib/invoices/email-recipients'
import { hasLineDiscount } from '@/lib/invoices/line-amounts'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import type { Invoice, InvoiceItem } from '@/types'
import type { InvoiceWithRelations } from '@/components/invoices/types'

// Why email is not possible, as keys of the invoice_editor_shell namespace.
const EMAIL_BLOCK_KEYS: Record<EmailBlockReason, string> = {
  not_emailable: 'email_block_not_emailable',
  sandbox: 'email_block_sandbox',
  no_email_plan: 'email_block_no_email_plan',
  no_customer_email: 'email_block_no_customer_email',
}

type CreditIntent = { kind: 'send'; channel: EditorChannel } | { kind: 'create' }

const NOTE_INPUT_CLASS =
  'w-full rounded-lg border border-input bg-card px-4 py-2 text-[13px] transition-colors duration-150 placeholder:text-muted-foreground/60 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/20'

/**
 * /invoices/[id]/credit: the kreditfaktura of an issued invoice in the
 * editor's two-pane shell. The rows are the original's, negated and read
 * only (a full credit, as POST /api/invoices creates it); the reason prints
 * as the note; the live preview is the credit note itself. The top bar sends
 * it (or marks it sent) through the same small confirm as the editor, which
 * states the reversal it books, then lands on the credit note.
 */
export function CreditNoteEditor({ invoiceId }: { invoiceId: string }) {
  const router = useRouter()
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const { company, role, isSandbox } = useCompany()
  const canEmail = useCapability(CAPABILITY.email_send)
  const { settings: companySettings } = useCompanySettings()
  const { accounts } = useAccounts()
  const locale = useLocale() as ErrorLocale
  const t = useTranslations('invoice_credit')
  const tShell = useTranslations('invoice_editor_shell')
  const tSend = useTranslations('invoice_send_dialog')
  const supabase = useMemo(() => createClient(), [])
  const isCompanyAdmin = role === 'owner' || role === 'admin'

  const [invoice, setInvoice] = useState<InvoiceWithRelations | null>(null)
  const [reason, setReason] = useState('')
  const [channelChoice, setChannelChoice] = useState<EditorChannel | null>(null)
  const [emailOverride, setEmailOverride] = useState<EmailTextOverride | null>(null)
  const [extraCcText, setExtraCcText] = useState('')
  const [pane, setPane] = useState<EditorPane>('form')
  const [confirmIntent, setConfirmIntent] = useState<CreditIntent | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const { data, error } = await supabase
        .from('invoices')
        .select(`
          *,
          customer:customers(*),
          items:invoice_items(*)
        `)
        .eq('id', invoiceId)
        .single()
      if (cancelled) return

      if (error || !data) {
        toast({ title: t('load_failed_title'), description: t('load_failed_description'), variant: 'destructive' })
        router.push('/invoices')
        return
      }
      // Only an issued invoice has a number a credit note can refer to (ML
      // 17 kap 22-23 §§); a partly paid one is refused by the create route.
      if (!['sent', 'paid', 'overdue'].includes(data.status)) {
        toast({ title: t('cannot_credit_title'), description: t('cannot_credit_description'), variant: 'destructive' })
        router.push(`/invoices/${invoiceId}`)
        return
      }
      if (data.items) data.items.sort((a: InvoiceItem, b: InvoiceItem) => a.sort_order - b.sort_order)
      setInvoice(data as InvoiceWithRelations)
      setReason(t('reason_default', { number: creditNoteOriginalReference(data) ?? '' }))
    }
    void load()
    return () => {
      cancelled = true
    }
    // supabase is memoised; t and toast are stable for the page's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceId])

  const originalNumber = invoice ? creditNoteOriginalReference(invoice) : null
  const creditNumber = originalNumber ? creditNoteNumber(originalNumber) : null
  const customer = invoice?.customer ?? null
  const currency = invoice?.currency ?? 'SEK'

  // The live previews: the credit note POST /api/invoices would create, with
  // this reason as its note.
  const previewBody = invoice ? JSON.stringify({ credited_invoice_id: invoice.id, notes: reason }) : null
  const emailRequestBody = invoice
    ? JSON.stringify({
        credited_invoice_id: invoice.id,
        notes: reason,
        email_subject: emailOverride?.subject ?? null,
        email_body: emailOverride?.body ?? null,
      })
    : null
  const pdf = useInvoicePdfPreview(previewBody)

  const accountingMethod = companySettings?.accounting_method === 'cash' ? 'cash' : 'accrual'
  // A credit note reverses what was booked: under kontantmetoden an unpaid,
  // unbooked original has nothing to reverse.
  const books = invoice ? creditNoteNeedsJournalEntry(accountingMethod, invoice) : false
  const channelContext: ChannelContext = {
    documentType: 'invoice',
    canEmail,
    isSandbox,
    customerSelected: Boolean(customer),
    customerEmail: customer?.email ?? null,
    peppolReady: false,
  }
  const channelOptions = resolveChannelOptions(channelContext)
  const channel = resolveEffectiveChannel(channelChoice, channelContext)
  const emailBlock = channelOptions.find((option) => option.channel === 'email')?.reason ?? null
  const primaryLabel = tShell(resolveSendLabel({ documentType: 'invoice', channel, booksOnIssue: books }))

  const extraCc = parseInvoiceRecipientText(extraCcText)
  const invalidExtraCc = extraCc.find((address) => !EMAIL_PATTERN.test(address)) ?? null
  const extraCcError = invalidExtraCc ? tShell('email_copy_invalid', { address: invalidExtraCc }) : null

  function requestIntent(intent: CreditIntent) {
    if (!invoice || !canWrite || isSubmitting) return
    if (intent.kind === 'send') setChannelChoice(intent.channel)
    setConfirmIntent(intent)
  }

  // Cmd/Ctrl+Enter opens the confirm, as in the editor.
  const requestRef = useRef(requestIntent)
  const channelRef = useRef(channel)
  useEffect(() => {
    requestRef.current = requestIntent
    channelRef.current = channel
  })
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.defaultPrevented) return
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return
      event.preventDefault()
      requestRef.current({ kind: 'send', channel: channelRef.current })
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  async function createWithoutSending() {
    if (!invoice) return
    setIsSubmitting(true)
    try {
      const response = await fetch('/api/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credited_invoice_id: invoice.id, reason }),
      })
      // Map the parsed body plus the status: the route answers with the
      // canonical { error: { code, message } } envelope.
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        toast({
          title: t('create_failed_title'),
          description: getErrorMessage(body, { locale, statusCode: response.status }),
          variant: 'destructive',
        })
        setIsSubmitting(false)
        return
      }
      const creditNote = (body as { data: Invoice }).data
      toast({
        title: t('created_toast_title'),
        description: creditNote.invoice_number
          ? t('created_toast_description', { number: creditNote.invoice_number })
          : undefined,
      })
      setConfirmIntent(null)
      router.replace(`/invoices/${creditNote.id}`)
    } catch (error) {
      toast({ title: t('create_failed_title'), description: getErrorMessage(error, { locale }), variant: 'destructive' })
      setIsSubmitting(false)
    }
  }

  async function send(channel: EditorChannel) {
    if (!invoice) return
    setIsSubmitting(true)
    try {
      const result = await persistAndSend({
        mode: 'create',
        documentType: 'invoice',
        payload: { credited_invoice_id: invoice.id, reason },
        channel,
        email:
          channel === 'email'
            ? {
                additional_cc: isCompanyAdmin ? extraCc : undefined,
                email_subject: emailOverride?.subject,
                email_body: emailOverride?.body,
              }
            : undefined,
      })
      if (!result.ok) {
        const description = getErrorMessage(result.error ?? new Error(`HTTP ${result.status}`), {
          locale,
          context: 'invoice',
          statusCode: result.status || undefined,
        })
        if (result.invoiceId) {
          // The credit note exists now: its own page sends it.
          toast({
            title: tShell('toast_saved_not_sent_title'),
            description: tShell('toast_saved_not_sent', { error: description }),
            variant: 'destructive',
          })
          setConfirmIntent(null)
          router.replace(`/invoices/${result.invoiceId}`)
          return
        }
        toast({ title: t('create_failed_title'), description, variant: 'destructive' })
        setIsSubmitting(false)
        return
      }
      const booked = books && !result.partial
      const marked = channel === 'manual'
      toast({
        title: tShell(
          marked
            ? booked ? 'toast_marked_book_title' : 'toast_marked_title'
            : booked ? 'toast_sent_book_title' : 'toast_sent_title',
        ),
        description: result.partial
          ? marked
            ? tSend('mark_partial_success')
            : tSend('partial_success', { message: result.message ?? tShell('toast_sent_title') })
          : channel === 'email'
            ? result.message ?? undefined
            : undefined,
        ...(result.partial ? { variant: 'destructive' as const } : {}),
      })
      setConfirmIntent(null)
      router.replace(
        marked && !result.partial
          ? `/invoices/${result.invoiceId}?download=1`
          : `/invoices/${result.invoiceId}`,
      )
    } catch (error) {
      // persistAndSend reports every failed request in its result; anything
      // else must not leave the confirm busy with Avbryt disabled.
      toast({ title: t('create_failed_title'), description: getErrorMessage(error, { locale }), variant: 'destructive' })
      setIsSubmitting(false)
    }
  }

  if (!invoice) return <InvoiceEditorShellSkeleton />

  const items = invoice.items ?? []
  const productCount = items.filter((item) => item.line_type !== 'text').length
  const today = new Date().toISOString().slice(0, 10)
  const vatByRate = new Map<number, number>()
  for (const item of items) {
    if (item.line_type === 'text') continue
    const rate = item.vat_rate ?? 0
    vatByRate.set(rate, (vatByRate.get(rate) ?? 0) + Math.abs(item.vat_amount ?? 0))
  }
  const statusLabel =
    invoice.status === 'paid' ? t('status_paid') : invoice.status === 'overdue' ? t('status_overdue') : t('status_unpaid')
  const customerLine = customer
    ? [
        customer.customer_type === 'individual' ? '' : customer.org_number ?? '',
        [customer.address_line1, [customer.postal_code, customer.city].filter(Boolean).join(' ')]
          .filter(Boolean)
          .join(', '),
        customer.email ?? '',
      ]
        .filter(Boolean)
        .join(' · ')
    : ''

  const statusLine = resolveEditorStatusLine({
    nextStep: { kind: 'ready' },
    missing: [],
    documentType: 'invoice',
    pageCount: pdf.pageCount,
    previewFailed: Boolean(pdf.error),
    notes: reason,
    productRowCount: productCount,
    hasDeduction: false,
  })
  const renderStatusLine = (className?: string) => (
    <EditorStatusLine
      status={statusLine}
      describeStep={() => ({ prefix: '', label: '' })}
      onStep={() => undefined}
      canAddPayee={false}
      onAddPayee={() => undefined}
      className={className}
    />
  )

  // ===== Confirm ===========================================================
  const confirmChannel = confirmIntent?.kind === 'send' ? confirmIntent.channel : null
  const customerName = customer?.name ?? ''
  const doc = t('doc_lower')
  const confirmTitle =
    confirmIntent?.kind === 'create'
      ? tShell('confirm_title_create', { doc, number: creditNumber ?? '', customer: customerName })
      : confirmChannel === 'email'
        ? tShell('confirm_title_email', { doc, number: creditNumber ?? '', customer: customerName })
        : tShell('confirm_title_manual', { doc, number: creditNumber ?? '', customer: customerName })
  const confirmRows: Array<{ label: string; value: string }> = []
  if (confirmChannel === 'email') {
    confirmRows.push({
      label: tShell('confirm_row_to'),
      value: [tShell('confirm_to_with_pdf', { email: customer?.email ?? '' }), ...(isCompanyAdmin ? extraCc : [])].join(', '),
    })
  } else if (confirmChannel) {
    confirmRows.push({ label: tShell('confirm_row_channel'), value: tShell('confirm_channel_manual') })
  }
  confirmRows.push({ label: tShell('confirm_row_number'), value: creditNumber ?? '' })
  confirmRows.push({ label: t('to_credit'), value: formatCurrency(-Math.abs(invoice.total), currency) })
  let confirmVoucher: ConfirmVoucher | null = null
  if (confirmIntent?.kind === 'create') {
    confirmVoucher = { kind: 'note', text: tShell('confirm_create_note') }
  } else if (confirmChannel) {
    if (!books) {
      confirmVoucher = { kind: 'note', text: t('voucher_not_booked') }
    } else {
      // No legal form, no proposal: the accounts depend on it, and a guess
      // would show a reversal that is not the one booked.
      const entityType = companySettings?.entity_type ?? company?.entity_type
      const lines = isEntityType(entityType)
        ? proposeCreditNoteSendLines({ ...invoice, customer: invoice.customer ?? undefined }, { entityType, today })
        : []
      const names = new Map(accounts.map((account) => [account.account_number, account.account_name]))
      confirmVoucher =
        lines.length > 0
          ? {
              kind: 'lines',
              date: today,
              lines: lines.map((line) => ({
                account: line.account_number,
                name: names.get(line.account_number) ?? line.line_description,
                debit: parseFloat(line.debit_amount) || 0,
                credit: parseFloat(line.credit_amount) || 0,
              })),
            }
          : { kind: 'note', text: tShell('confirm_voucher_foreign') }
    }
  }
  const confirmLabel =
    confirmIntent?.kind === 'create'
      ? tShell('action_create_without_sending')
      : tShell(resolveSendLabel({ documentType: 'invoice', channel: confirmChannel ?? channel, booksOnIssue: books }))

  const menu: { channels: TopBarMenuEntry[]; actions: TopBarMenuEntry[] } = {
    channels: channelOptions.map((option) => ({
      key: option.channel,
      label: tShell(`channel_${option.channel}`),
      selected: option.channel === channel,
      disabled: !option.available || !canWrite,
      reason: option.reason ? tShell(EMAIL_BLOCK_KEYS[option.reason]) : null,
      onSelect: () => requestIntent({ kind: 'send', channel: option.channel }),
    })),
    actions: [
      {
        key: 'create',
        label: tShell('action_create_without_sending'),
        disabled: !canWrite,
        onSelect: () => requestIntent({ kind: 'create' }),
      },
    ],
  }

  return (
    <>
      <InvoiceEditorShell
        pane={pane}
        onPaneChange={setPane}
        renderTopBar={(paneSwitch) => (
          <EditorTopBar
            breadcrumb={{ label: t('breadcrumb_invoice', { number: originalNumber ?? '' }), href: `/invoices/${invoice.id}` }}
            title={t('title_short')}
            documentTypes={null}
            documentType="invoice"
            onDocumentTypeChange={() => undefined}
            help={<p>{t('warning_description')}</p>}
            meta={creditNumber ? t('meta', { number: creditNumber }) : ''}
            paneSwitch={paneSwitch}
            primary={{
              label: primaryLabel,
              onClick: () => requestIntent({ kind: 'send', channel }),
              disabled: isSubmitting || !canWrite,
              loading: isSubmitting && confirmIntent === null,
              title: !canWrite ? t('viewer_disabled_tooltip') : undefined,
              locked: !canWrite,
            }}
            menu={menu}
          />
        )}
        preview={
          <EditorPreviewPane
            documentLabel={t('doc_label')}
            pdf={pdf}
            preliminaryNumber={null}
            statusLine={renderStatusLine()}
            renderEmail={() => (
              <EditorEmailPreview
                requestBody={emailRequestBody}
                unavailableReason={
                  channel === 'email'
                    ? null
                    : emailBlock
                      ? tShell(EMAIL_BLOCK_KEYS[emailBlock])
                      : tShell('email_unavailable_manual')
                }
                onUseEmail={channel !== 'email' && !emailBlock ? () => setChannelChoice('email') : null}
                override={emailOverride}
                onOverrideChange={setEmailOverride}
                canAddCopies={isCompanyAdmin}
                extraCcText={extraCcText}
                onExtraCcTextChange={setExtraCcText}
                extraCcError={extraCcError}
              />
            )}
          />
        }
        form={
          <div className="space-y-8">
            {/* What is credited: one line of context, read only. */}
            <div className="flex items-center gap-3 rounded-lg border border-border px-4 py-3 text-[13px]" data-ph-mask="">
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0">
                {t('credits_line', {
                  number: originalNumber ?? '',
                  date: formatDate(invoice.invoice_date),
                  amount: formatCurrency(Math.abs(invoice.total), currency),
                  status: statusLabel,
                })}
              </span>
            </div>

            <EditorSection label={t('customer_label')}>
              <div className="rounded-lg border border-border bg-secondary/35 px-4 py-3" data-ph-mask="">
                <p className="text-[15px]">{customer?.name ?? ''}</p>
                {customerLine && <p className="text-[12.5px] text-muted-foreground">{customerLine}</p>}
              </div>
              <p className="mt-3 text-[12.5px] text-muted-foreground">
                {t('details_line', {
                  date: formatDate(today),
                  currency,
                  language: customer?.language === 'en' ? t('language_en') : t('language_sv'),
                })}
              </p>
            </EditorSection>

            <EditorSection
              label={t('rows_title')}
              aside={t('rows_from', { count: productCount, number: originalNumber ?? '' })}
            >
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-border text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                    <th className="px-2 pb-2 text-left font-normal">{t('th_description')}</th>
                    <th className="px-2 pb-2 text-right font-normal">{t('th_quantity')}</th>
                    <th className="px-2 pb-2 text-right font-normal">{t('th_unit_price')}</th>
                    <th className="px-2 pb-2 text-right font-normal">{t('th_amount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) =>
                    item.line_type === 'text' ? (
                      <tr key={item.id} className="border-b border-border">
                        <td colSpan={4} className="px-2 py-2 italic text-muted-foreground">
                          {item.description}
                        </td>
                      </tr>
                    ) : (
                      <tr key={item.id} className="border-b border-border align-top">
                        <td className="px-2 py-2">
                          <span className="block">{item.description}</span>
                          {hasLineDiscount(item.discount_percent) && (
                            <Badge variant="secondary" className="mt-1 tabular-nums">
                              {t('badge_discount', { percent: item.discount_percent ?? 0 })}
                            </Badge>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                          -{Math.abs(item.quantity)} {item.unit}
                        </td>
                        <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                          {formatCurrency(item.unit_price, currency)}
                        </td>
                        <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                          {formatCurrency(-Math.abs(item.line_total), currency)}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
              <p className="mt-3 text-[12.5px] text-muted-foreground">
                {t('rows_note', { number: originalNumber ?? '' })}
              </p>

              <dl className="ml-auto mt-6 grid w-full max-w-xs grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1 text-[13px] tabular-nums">
                <dt className="text-muted-foreground">{t('subtotal')}</dt>
                <dd className="text-right">{formatCurrency(-Math.abs(invoice.subtotal), currency)}</dd>
                {Array.from(vatByRate.entries())
                  .sort(([a], [b]) => b - a)
                  .filter(([, amount]) => amount > 0)
                  .map(([rate, amount]) => (
                    <div key={rate} className="contents">
                      <dt className="text-muted-foreground">{t('vat_at_rate', { rate })}</dt>
                      <dd className="text-right">{formatCurrency(-amount, currency)}</dd>
                    </div>
                  ))}
                {currency !== 'SEK' && invoice.total_sek ? (
                  <>
                    <dt className="text-muted-foreground">{t('in_sek', { rate: invoice.exchange_rate ?? 1 })}</dt>
                    <dd className="text-right">{formatCurrency(-Math.abs(invoice.total_sek))}</dd>
                  </>
                ) : null}
                <dt className="mt-2 border-t border-border pt-2 font-display text-xl">{t('to_credit')}</dt>
                <dd className="mt-2 border-t border-border pt-2 text-right font-display text-xl">
                  {formatCurrency(-Math.abs(invoice.total), currency)}
                </dd>
              </dl>
            </EditorSection>

            <EditorSection label={t('reason_card_title')} aside={t('reason_card_description')}>
              <AutoGrowTextarea
                id="credit-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder={t('reason_placeholder')}
                aria-label={t('reason_label')}
                className={NOTE_INPUT_CLASS}
              />
            </EditorSection>

            {renderStatusLine(cn('@min-[900px]:hidden'))}
          </div>
        }
      />

      <SendConfirmDialog
        open={confirmIntent !== null}
        onOpenChange={(open) => {
          if (!open && !isSubmitting) setConfirmIntent(null)
        }}
        title={confirmTitle}
        rows={confirmRows}
        voucher={confirmVoucher}
        confirmLabel={confirmLabel}
        confirmDisabled={!canWrite || (confirmChannel === 'email' && isCompanyAdmin && extraCcError !== null)}
        busy={isSubmitting}
        onConfirm={() => {
          if (confirmIntent?.kind === 'create') void createWithoutSending()
          else if (confirmIntent?.kind === 'send') void send(confirmIntent.channel)
        }}
      />
    </>
  )
}
