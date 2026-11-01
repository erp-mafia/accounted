'use client'

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { HelpPopover } from '@/components/ui/help-popover'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { BankMark } from '@/components/banks/BankMark'
import { BrandWordmark } from '@/components/branding/BrandWordmark'
import { formatSigningLinkExpiry } from '@/lib/payments/orders/signing-link-expiry'
import { parsePaymentSigningReturn, stripPaymentSigningReturn, type PaymentSigningReturn } from '@/lib/payments/orders/return-url'
import { formatCurrency, formatDate } from '@/lib/utils'
import { BankIdSigningFlow, type SigningFlowStage } from './BankIdSigningFlow'
import {
  createSigningLinkClient,
  forgetSigningLinkPersonalNumber,
  recallSigningLinkPersonalNumber,
  type SigningLinkPageData,
} from './signing-links-client'

/** Session storage has no change events within a tab: read once per render, nothing to subscribe to. */
const noSubscription = () => () => {}

export interface PaymentSigningLinkPageProps {
  token: string
  /** The basket as the server read it for this request (lib/payments/orders/signing-links.ts describePaymentSigningLink). */
  initial: SigningLinkPageData
}

/**
 * The page a firmatecknare opens from a payment signing link, without an
 * Accounted login: "{sender} har förberett {n} betalningar från {company}",
 * the basket (payee, account, date, reference, amount) and the total, the
 * bank and the account paying, the sender's note, then the same BankID
 * signing as on Betalningar (QR on a desktop, this device on a phone, the
 * bank's own page for a bank that signs there). Every call goes through the
 * link's token routes; the personnummer is typed here, sent to the bank and
 * never stored. A bank that signs on its own page sends the browser back to
 * this link with the signing named (?signing=<batch>&result=ok|error), and
 * the flow resumes at its poll. When an order left 'approved' another way the
 * page says so and offers nothing to sign. A link that asks for the second
 * signature (state second_signature) signs the link's signing as the other
 * signatory.
 */
export function PaymentSigningLinkPage({ token, initial }: PaymentSigningLinkPageProps) {
  const t = useTranslations('payment_signing_page')
  const searchParams = useSearchParams()
  const client = useMemo(() => createSigningLinkClient(token), [token])
  const data = initial
  const [stage, setStage] = useState<SigningFlowStage>('method')

  // The return parameters are read once and dropped from the URL: a reload
  // after that opens the link afresh, never the bank's answer a second time.
  const [returned] = useState<PaymentSigningReturn | null>(() => parsePaymentSigningReturn(searchParams))
  useEffect(() => {
    if (returned) window.history.replaceState(window.history.state, '', stripPaymentSigningReturn(window.location.href))
  }, [returned])

  // The number typed before the bank's own page took over this tab. Session
  // storage does not exist on the server: undefined until the browser read it.
  const recalled = useSyncExternalStore(
    noSubscription,
    () => recallSigningLinkPersonalNumber(token),
    () => undefined,
  )
  const [typedForResume, setTypedForResume] = useState('')
  const [resumeNumber, setResumeNumber] = useState<string | null>(null)

  useEffect(() => {
    if (stage === 'done') forgetSigningLinkPersonalNumber(token)
  }, [stage, token])

  const orders = data.orders.map((o) => ({ id: o.payment_order_id, payee_name: o.payee_name, amount: o.amount, currency: o.currency }))
  const account = [data.account.name, data.account.iban].filter(Boolean).join(' ')

  // A signing of this link waits at the bank: poll it (BankID may be open, or
  // the bank's page just answered), or sign it again while its payments wait
  // there unsigned.
  // A link for the second signature signs its signing as the other signatory.
  const signing = data.signing
  const waitingSigning = data.state === 'in_signing' && signing?.status === 'awaiting_signature'
  const resume: PaymentSigningReturn | null =
    (data.state !== 'in_signing' && data.state !== 'second_signature') || !signing
      ? null
      : returned && returned.batchId === signing.batch_id
        ? returned
        : waitingSigning
          ? { batchId: signing.batch_id, result: 'ok', code: null }
          : null
  const pendingBatchId = data.state === 'in_signing' && signing && !resume ? signing.batch_id : null
  const secondSignatureBatchId = data.state === 'second_signature' && signing && !resume ? signing.batch_id : null
  const resumeNeedsNumber = resume !== null && recalled !== undefined && !recalled && !resumeNumber

  const header = (
    <header className="space-y-4">
      <BrandWordmark size="inline" />
      <div className="space-y-1">
        <p className="text-[12.5px] uppercase tracking-wider text-muted-foreground">{t('eyebrow')}</p>
        <h1 className="font-display text-2xl tracking-tight" data-ph-mask="">
          {data.company_name}
        </h1>
        <p className="text-[13px] text-muted-foreground" data-ph-mask="">
          {t('prepared_by', { requester: data.requester, count: data.order_count, company: data.company_name })}
        </p>
      </div>
    </header>
  )

  const basket = (
    <section className="space-y-4 rounded-lg border border-border p-6">
      <div className="flex items-center gap-2 text-[13px]">
        <span className="text-muted-foreground">{t('from_account')}</span>
        <BankMark bankName={data.bank_name} size={16} />
        <span className="tabular-nums" data-ph-mask="">
          {account || data.bank_name || t('account_fallback')}
        </span>
      </div>
      {data.note && (
        <div className="space-y-1">
          <p className="text-[12.5px] text-muted-foreground">{t('note_heading', { requester: data.requester })}</p>
          <p className="whitespace-pre-line border-l-2 border-border pl-3 text-[13px]" data-ph-mask="">
            {data.note}
          </p>
        </div>
      )}
      <ul className="stagger-enter text-[13px]" data-ph-mask="">
        {data.orders.map((o) => (
          <li key={o.payment_order_id} className="flex items-start justify-between gap-4 border-b border-border py-2">
            <span className="min-w-0">
              <span className="block truncate">{o.payee_name}</span>
              <span className="block truncate text-[12.5px] tabular-nums text-muted-foreground">
                {[o.payee_label, formatDate(o.requested_execution_date), o.reference_type === 'ocr' ? t('reference_ocr', { value: o.reference }) : o.reference]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
            <span className="shrink-0 tabular-nums">{formatCurrency(o.amount, o.currency)}</span>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between text-[13px]">
        <span className="text-muted-foreground">{t('total')}</span>
        <span className="font-medium tabular-nums">{formatCurrency(data.total_amount, data.currency)}</span>
      </div>
    </section>
  )

  let body: React.ReactNode
  if (data.state === 'changed') {
    body = (
      <section className="space-y-2 rounded-lg border border-border p-6">
        <h2 className="font-display text-xl tracking-tight">{t('changed_title')}</h2>
        <p className="text-[13px] text-muted-foreground">{t('changed_body')}</p>
      </section>
    )
  } else if (data.state === 'done') {
    const key =
      signing?.status === 'awaiting_second_signer'
        ? data.second_signature_here
          ? 'done_second_signer_here_body'
          : 'done_second_signer_body'
        : signing?.status === 'rejected'
          ? 'done_rejected_body'
          : 'done_body'
    body = (
      <section className="space-y-2 rounded-lg border border-border p-6">
        <h2 className="font-display text-xl tracking-tight">{t('done_title')}</h2>
        <p className="text-[13px] text-muted-foreground">{t(key, { requester: data.requester })}</p>
      </section>
    )
  } else if (resume && recalled === undefined) {
    body = (
      <section className="space-y-3 rounded-lg border border-border p-6">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-8 w-full" />
      </section>
    )
  } else if (resumeNeedsNumber) {
    // Back on the link with a signing at the bank and no number kept: the
    // poll needs the PSU, so the person types it once more.
    body = (
      <section className="space-y-4 rounded-lg border border-border p-6">
        <p className="text-[13px]">{t('resume_intro')}</p>
        <label className="block space-y-2 text-[13px]">
          <span className="text-muted-foreground">{t('personal_number_label')}</span>
          <Input
            inputMode="numeric"
            autoComplete="off"
            value={typedForResume}
            onChange={(e) => setTypedForResume(e.target.value)}
            placeholder="ÅÅÅÅMMDD-NNNN"
            className="w-[200px] tabular-nums"
          />
        </label>
        <Button onClick={() => setResumeNumber(typedForResume.trim())} disabled={typedForResume.trim().length < 10}>
          {t('resume_continue')}
        </Button>
      </section>
    )
  } else {
    body = (
      <section className="space-y-4 rounded-lg border border-border p-6">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-xl tracking-tight">{stage === 'done' ? t('signed_title') : t('sign_title')}</h2>
          {stage !== 'done' && (
            <HelpPopover className="shrink-0">
              <p>{t('help_signer')}</p>
            </HelpPopover>
          )}
        </div>
        <BankIdSigningFlow
          orders={orders}
          signerKnown={false}
          bankName={data.bank_name}
          closeButton={null}
          client={client}
          resume={resume}
          pendingBatchId={pendingBatchId}
          secondSignatureBatchId={secondSignatureBatchId}
          offerSecondSignature={data.state === 'second_signature'}
          initialPersonalNumber={resumeNumber ?? recalled ?? null}
          onStageChange={setStage}
        />
      </section>
    )
  }

  return (
    <main className="min-h-dvh bg-background px-4 py-10 md:px-6">
      <div className="mx-auto w-full max-w-xl space-y-6">
        {header}
        {data.state !== 'done' && basket}
        {body}
        <p className="text-[12.5px] text-muted-foreground">
          {(data.state === 'ready' || data.state === 'in_signing' || data.state === 'second_signature') && stage !== 'done'
            ? `${t('expires', { date: formatSigningLinkExpiry(data.expires_at) })} `
            : ''}
          {t('footer_provider')}
        </p>
      </div>
    </main>
  )
}
