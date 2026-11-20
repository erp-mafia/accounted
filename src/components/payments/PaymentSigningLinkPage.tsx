'use client'

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { HelpPopover } from '@/components/ui/help-popover'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { BankMark } from '@/components/banks/BankMark'
import { useBranding } from '@/lib/branding/brand-context'
import { Label } from '@/components/ui/label'
import { StatusGlyph } from '@/components/ui/status-glyph'
import {
  StandaloneFacts,
  StandaloneFrom,
  StandaloneHeading,
  StandaloneLabel,
  StandaloneOutcome,
  StandalonePage,
  StandaloneSmall,
} from '@/components/standalone/StandalonePage'
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
  const tSigning = useTranslations('signing_page')
  const { appName } = useBranding()
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

  const signable = data.state !== 'changed' && data.state !== 'done'

  const basket = (
    <>
      <StandaloneFacts
        className="mt-5"
        rows={[
          {
            label: t('from_account'),
            value: (
              <span className="inline-flex items-center gap-2">
                <BankMark bankName={data.bank_name} size={16} />
                {account || data.bank_name || t('account_fallback')}
              </span>
            ),
          },
        ]}
      />
      {data.note && (
        <div className="mt-4">
          <StandaloneLabel>{t('note_heading', { requester: data.requester })}</StandaloneLabel>
          <p className="mt-0.5 whitespace-pre-line text-sm text-foreground" data-ph-mask="">
            {data.note}
          </p>
        </div>
      )}
      <ul className="stagger-enter mt-4 border-t-hairline text-sm" data-ph-mask="">
        {data.orders.map((o) => (
          <li key={o.payment_order_id} className="flex items-start justify-between gap-4 border-b-hairline py-2">
            <span className="min-w-0">
              <span className="block truncate">{o.payee_name}</span>
              <span className="block truncate text-xs tabular-nums text-muted-foreground">
                {[o.payee_label, formatDate(o.requested_execution_date), o.reference_type === 'ocr' ? t('reference_ocr', { value: o.reference }) : o.reference]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
            <span className="shrink-0 tabular-nums">{formatCurrency(o.amount, o.currency)}</span>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between py-2 text-sm">
        <span className="font-medium text-strong">{t('total')}</span>
        <span className="font-medium tabular-nums text-strong">{formatCurrency(data.total_amount, data.currency)}</span>
      </div>
    </>
  )

  let body: React.ReactNode
  if (data.state === 'changed') {
    body = (
      <StandaloneOutcome className="mt-5 border-t-hairline pt-4" title={t('changed_title')}>
        {t('changed_body')}
      </StandaloneOutcome>
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
      <StandaloneOutcome
        className="mt-5 border-t-hairline pt-4"
        mark={key === 'done_body' ? <StatusGlyph tone="ok" size={16} /> : undefined}
        title={t('done_title')}
      >
        {t(key, { requester: data.requester })}
      </StandaloneOutcome>
    )
  } else if (resume && recalled === undefined) {
    body = (
      <section className="mt-5 space-y-3" aria-busy="true">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-8 w-full" />
      </section>
    )
  } else if (resumeNeedsNumber) {
    // Back on the link with a signing at the bank and no number kept: the
    // poll needs the PSU, so the person types it once more.
    body = (
      <section className="mt-5 flex flex-col gap-3">
        <p className="text-sm text-foreground">{t('resume_intro')}</p>
        <div className="space-y-2">
          <Label htmlFor="resume-personal-number">{t('personal_number_label')}</Label>
          <Input
            id="resume-personal-number"
            inputMode="numeric"
            autoComplete="off"
            value={typedForResume}
            onChange={(e) => setTypedForResume(e.target.value)}
            placeholder="ÅÅÅÅMMDD-NNNN"
            className="h-11 tabular-nums"
          />
        </div>
        <Button size="lg" className="w-full" onClick={() => setResumeNumber(typedForResume.trim())} disabled={typedForResume.trim().length < 10}>
          {t('resume_continue')}
        </Button>
      </section>
    )
  } else {
    body = (
      // The flow's footer bleeds 20px (a dialog's inset): on a phone the
      // panel's inset is 16px, so the section adds the missing 4px.
      <section className="mt-5 border-t-hairline pt-4 max-sm:px-1">
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
    <StandalonePage width="link" brand={false}>
      <StandaloneFrom name={data.company_name} via={tSigning('via', { platform: appName })} />
      <div className="mt-5 flex items-start gap-2">
        <StandaloneHeading
          className="min-w-0 flex-1"
          eyebrow={t('eyebrow')}
          title={signable && stage === 'done' ? t('signed_title') : t('sign_title')}
          sub={
            <span data-ph-mask="">
              {t('prepared_by', { requester: data.requester, count: data.order_count, company: data.company_name })}
            </span>
          }
        />
        {signable && stage !== 'done' && (
          <HelpPopover className="mt-5 shrink-0">
            <p>{t('help_signer')}</p>
          </HelpPopover>
        )}
      </div>
      {data.state !== 'done' && (
        <p className="mt-2 font-display text-2xl tabular-nums text-strong" data-ph-mask="">
          {formatCurrency(data.total_amount, data.currency)}
        </p>
      )}
      {data.state !== 'done' && basket}
      {body}
      <StandaloneSmall>
        {(data.state === 'ready' || data.state === 'in_signing' || data.state === 'second_signature') && stage !== 'done'
          ? `${t('expires', { date: formatSigningLinkExpiry(data.expires_at) })} `
          : ''}
        {t('footer_provider')}
      </StandaloneSmall>
    </StandalonePage>
  )
}
