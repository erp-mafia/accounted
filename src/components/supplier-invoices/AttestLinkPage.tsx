'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useBranding } from '@/lib/branding/brand-context'
import {
  StandaloneFacts,
  StandaloneFile,
  StandaloneFrom,
  StandaloneHeading,
  StandaloneLabel,
  StandaloneOutcome,
  StandalonePage,
  StandaloneSmall,
} from '@/components/standalone/StandalonePage'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { StatusGlyph } from '@/components/ui/status-glyph'
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
  const tSigning = useTranslations('signing_page')
  const tCommon = useTranslations('common')
  const { appName } = useBranding()
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

  const documentHref = `/api/attest/${encodeURIComponent(token)}/document`
  const amount = formatCurrency(data.invoice.total, data.invoice.currency)

  let decisionBlock: React.ReactNode
  if (done) {
    decisionBlock = (
      <StandaloneOutcome
        className="mt-5 border-t-hairline pt-4"
        mark={done.decision === 'approved' ? <StatusGlyph tone="ok" size={16} /> : undefined}
        title={done.decision === 'approved' ? t('done_approved_title') : t('done_rejected_title')}
      >
        {done.decision === 'rejected'
          ? t('done_rejected_body')
          : done.attested
            ? t('done_attested_body')
            : t('done_waiting_body', { count: done.remaining })}
      </StandaloneOutcome>
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
                : data.reason === 'other_step'
                  ? 'state_other_step'
                  : 'state_not_allowed'
    decisionBlock = <StandaloneOutcome className="mt-5 border-t-hairline pt-4" title={t(key)} />
  } else {
    const options = [
      ...(data.may_approve ? [{ value: 'approve' as const, label: t('choice_approve') }] : []),
      ...(data.may_reject ? [{ value: 'reject' as const, label: t('choice_reject') }] : []),
    ]
    decisionBlock = (
      <section className="mt-5 flex flex-col gap-3">
        {!data.may_approve && overLimit && <p className="text-sm text-foreground">{t('limit_reject_only')}</p>}
        {data.may_approve && data.acts_for_name && (
          <p className="text-sm text-foreground" data-ph-mask="">
            {t('acts_for', { name: data.acts_for_name })}
          </p>
        )}
        {options.length > 1 && (
          <div>
            <StandaloneLabel className="mb-1.5">{t('decision_label')}</StandaloneLabel>
            <SegmentedControl
              aria-label={t('decision_label')}
              value={choice}
              onChange={setChoice}
              options={options}
              className="pointer-coarse:h-12"
            />
          </div>
        )}
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
        <Button type="button" size="lg" className="w-full" onClick={() => void submit()} loading={busy}>
          {choice === 'approve' ? t('submit_approve') : t('submit_reject')}
        </Button>
      </section>
    )
  }

  const open = !done && data.state === 'open'

  return (
    <StandalonePage width="link" brand={false}>
      <StandaloneFrom name={data.company_name} via={tSigning('via', { platform: appName })} />
      <StandaloneHeading
        className="mt-5"
        eyebrow={t('eyebrow', { company: data.company_name })}
        title={<span data-ph-mask="">{t('title', { supplier, amount: '' }).trim()}</span>}
      />
      <p className="mt-2 font-display text-2xl tabular-nums text-strong" data-ph-mask="">
        {amount}
      </p>
      <StandaloneFacts
        className="mt-5"
        rows={[
          {
            label: data.invoice.supplier_invoice_number ? t('invoice_label') : t('arrival_label'),
            value: data.invoice.supplier_invoice_number ?? data.invoice.arrival_number,
          },
          { label: t('invoice_date'), value: formatDate(data.invoice.invoice_date) },
          { label: t('due_date'), value: formatDate(data.invoice.due_date) },
          data.registered_by ? { label: t('registered_by_label'), value: data.registered_by } : null,
        ]}
      />
      {(data.stage || data.remaining_names.length > 0) && open && (
        <p className="mt-2 text-xs text-muted-foreground" data-ph-mask="">
          {[
            data.stage ? t(data.stage === 'pre' ? 'stage_pre' : 'stage_final') : null,
            data.remaining_names.length > 0
              ? data.mode === 'all'
                ? t('waiting_all', { names: data.remaining_names.join(', ') })
                : t('waiting_any', { names: data.remaining_names.join(', ') })
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      <div className="mt-4">
        {data.invoice.has_document ? (
          <StandaloneFile name={t('document_title')} href={documentHref} openLabel={tCommon('open')} />
        ) : (
          <p className="text-xs text-muted-foreground">{t('no_document')}</p>
        )}
      </div>
      {decisionBlock}
      {open && <StandaloneSmall>{t('expires', { date: formatDate(data.expires_at) })}</StandaloneSmall>}
      {/* The file itself, inline where a screen has room for it: on a phone
          the row above opens it in the phone's own viewer. */}
      {data.invoice.has_document && (
        <iframe
          src={documentHref}
          title={t('document_title')}
          className="mt-5 hidden h-[560px] w-full rounded-lg bg-control shadow-raised sm:block"
        />
      )}
    </StandalonePage>
  )
}
