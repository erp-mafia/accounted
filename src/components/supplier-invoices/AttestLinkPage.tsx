'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { BrandWordmark } from '@/components/branding/BrandWordmark'
import { AttnLine } from '@/components/ui/attn-line'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { AttestLinkPageData } from '@/lib/supplier-invoices/attest-link-route'
import { formatCurrency, formatDate } from '@/lib/utils'

/**
 * The page an attester opens from the attest mail, without an Accounted
 * login: the invoice (supplier, number, dates, amount) with its PDF, who
 * registered it, and nothing to fill in but the decision and an optional
 * comment. The decision goes through the link's token route as the
 * attester's own, the same as Attestera / Neka on the invoice page.
 */
export function AttestLinkPage({
  token,
  initial,
  preselected,
}: {
  token: string
  initial: AttestLinkPageData
  /** The button the mail's link came from: it only chooses which answer is offered first. */
  preselected: 'approve' | 'reject' | null
}) {
  const t = useTranslations('attest_link_page')
  const locale = useLocale() as ErrorLocale
  const data = initial
  const [picked, setPicked] = useState<'approve' | 'reject'>(preselected ?? 'approve')
  // An attester whose limit does not cover the invoice may still say no: only Neka is offered then.
  const choice: 'approve' | 'reject' = data.may_approve ? picked : 'reject'
  const setChoice = setPicked
  const overLimit = data.reason === 'limit' || data.reason === 'key_limit'
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ decision: 'approved' | 'rejected'; attested: boolean; remaining: number } | null>(null)

  const invoiceLabel = data.invoice.supplier_invoice_number
    ? t('invoice_number', { number: data.invoice.supplier_invoice_number })
    : t('arrival_number', { number: data.invoice.arrival_number })
  const supplier = data.invoice.supplier_name ?? t('supplier_fallback')

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/attest/${encodeURIComponent(token)}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: choice, comment: choice === 'reject' ? comment.trim() || null : null }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok || !body?.data) {
        setError(getErrorMessage(body, { statusCode: res.status, locale, context: 'supplier_invoice' }))
        return
      }
      setDone({ decision: body.data.decision, attested: !!body.data.attested, remaining: Number(body.data.remaining_count ?? 0) })
    } catch (err) {
      setError(getErrorMessage(err, { locale, context: 'supplier_invoice' }))
    } finally {
      setBusy(false)
    }
  }

  const header = (
    <header className="space-y-4">
      <BrandWordmark size="inline" />
      <div className="space-y-1">
        <p className="text-[12.5px] uppercase tracking-wider text-muted-foreground">{t('eyebrow', { company: data.company_name })}</p>
        <h1 className="font-display text-2xl tracking-tight" data-ph-mask="">
          {t('title', { supplier, amount: formatCurrency(data.invoice.total, data.invoice.currency) })}
        </h1>
        <p className="text-[13px] text-muted-foreground" data-ph-mask="">
          {data.registered_by ? t('registered_by', { name: data.registered_by }) : t('registered')}
        </p>
      </div>
    </header>
  )

  const facts = (
    <section className="space-y-2 rounded-lg border border-border p-6 text-[13px]" data-ph-mask="">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-muted-foreground">{invoiceLabel}</span>
        <span className="font-medium tabular-nums">{formatCurrency(data.invoice.total, data.invoice.currency)}</span>
      </div>
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-muted-foreground">{t('invoice_date')}</span>
        <span className="tabular-nums">{formatDate(data.invoice.invoice_date)}</span>
      </div>
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-muted-foreground">{t('due_date')}</span>
        <span className="tabular-nums">{formatDate(data.invoice.due_date)}</span>
      </div>
      {data.remaining_names.length > 0 && data.state === 'open' && (
        <p className="pt-2 text-[12.5px] text-muted-foreground">
          {data.mode === 'all' ? t('waiting_all', { names: data.remaining_names.join(', ') }) : t('waiting_any', { names: data.remaining_names.join(', ') })}
        </p>
      )}
    </section>
  )

  const documentFrame = data.invoice.has_document ? (
    <section className="space-y-2">
      <iframe
        src={`/api/attest/${encodeURIComponent(token)}/document`}
        title={t('document_title')}
        className="h-[560px] w-full rounded-lg border border-border bg-background"
      />
      <a href={`/api/attest/${encodeURIComponent(token)}/document`} target="_blank" rel="noreferrer" className="text-[12.5px] text-muted-foreground underline-offset-4 hover:underline">
        {t('open_document')}
      </a>
    </section>
  ) : (
    <p className="text-[12.5px] text-muted-foreground">{t('no_document')}</p>
  )

  let decisionBlock: React.ReactNode
  if (done) {
    decisionBlock = (
      <section className="space-y-2 rounded-lg border border-border p-6">
        <h2 className="font-display text-xl tracking-tight">{done.decision === 'approved' ? t('done_approved_title') : t('done_rejected_title')}</h2>
        <p className="text-[13px] text-muted-foreground">
          {done.decision === 'rejected'
            ? t('done_rejected_body')
            : done.attested
              ? t('done_attested_body')
              : t('done_waiting_body', { count: done.remaining })}
        </p>
      </section>
    )
  } else if (data.state !== 'open' || (!data.may_approve && !data.may_reject)) {
    const key =
      data.state === 'attested'
        ? 'state_attested'
        : data.state === 'closed'
          ? 'state_closed'
          : data.reason === 'already_given'
            ? 'state_already_given'
            : data.reason === 'registrant'
              ? 'state_registrant'
              : overLimit
                ? 'state_limit'
                : 'state_not_allowed'
    decisionBlock = (
      <section className="space-y-2 rounded-lg border border-border p-6">
        <p className="text-[13px] text-muted-foreground">{t(key)}</p>
      </section>
    )
  } else {
    decisionBlock = (
      <section className="space-y-4 rounded-lg border border-border p-6">
        {!data.may_approve && overLimit && <p className="text-[13px] text-muted-foreground">{t('limit_reject_only')}</p>}
        <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label={t('decision_label')}>
          {data.may_approve && (
            <Button type="button" size="sm" variant={choice === 'approve' ? 'default' : 'outline'} role="radio" aria-checked={choice === 'approve'} onClick={() => setChoice('approve')}>
              {t('choice_approve')}
            </Button>
          )}
          {data.may_reject && (
            <Button type="button" size="sm" variant={choice === 'reject' ? 'default' : 'outline'} role="radio" aria-checked={choice === 'reject'} onClick={() => setChoice('reject')}>
              {t('choice_reject')}
            </Button>
          )}
        </div>
        {choice === 'reject' && (
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={1000}
            placeholder={t('comment_placeholder')}
            aria-label={t('comment_label')}
          />
        )}
        {error && <AttnLine>{error}</AttnLine>}
        <Button type="button" onClick={() => void submit()} loading={busy}>
          {choice === 'approve' ? t('submit_approve') : t('submit_reject')}
        </Button>
        <p className="text-[12.5px] text-muted-foreground">{t('expires', { date: formatDate(data.expires_at) })}</p>
      </section>
    )
  }

  return (
    <main className="min-h-dvh bg-background px-4 py-10 md:px-6">
      <div className="mx-auto w-full max-w-2xl space-y-6 stagger-enter">
        {header}
        {facts}
        {decisionBlock}
        {documentFrame}
      </div>
    </main>
  )
}
