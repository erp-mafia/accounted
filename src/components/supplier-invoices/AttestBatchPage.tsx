'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { BrandWordmark } from '@/components/branding/BrandWordmark'
import { AttnLine } from '@/components/ui/attn-line'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { AttestBatchDecisionResult, AttestBatchInvoiceView, AttestBatchPageData } from '@/lib/supplier-invoices/attest-batch-route'
import { formatCurrency, formatDate } from '@/lib/utils'

/**
 * The page the batched attest mail opens, without a login: every invoice the
 * mail listed, each ticked for approval, with its document a click away.
 * One button approves them all; an invoice can be left for later (untick it)
 * or rejected with a comment. The answers go through the link's token route
 * as the attester's own, invoice by invoice, the same as Attestera / Neka on
 * the invoice page, and the page shows how each went.
 */
export function AttestBatchPage({ token, initial }: { token: string; initial: AttestBatchPageData }) {
  const t = useTranslations('attest_batch_page')
  const locale = useLocale() as ErrorLocale
  const [data, setData] = useState(initial)
  const [approve, setApprove] = useState<Set<string>>(
    () => new Set(initial.invoices.filter((i) => i.state === 'open' && i.may_approve).map((i) => i.id)),
  )
  // Invoice id to the comment of a rejection.
  const [reject, setReject] = useState<Map<string, string>>(new Map())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [failures, setFailures] = useState<Map<string, string>>(new Map())
  const [answered, setAnswered] = useState<{ approved: number; rejected: number } | null>(null)

  const open = data.invoices.filter((i) => i.state === 'open')
  const approveIds = open.filter((i) => i.may_approve && approve.has(i.id) && !reject.has(i.id)).map((i) => i.id)
  const rejectIds = open.filter((i) => i.may_reject && reject.has(i.id)).map((i) => i.id)
  const allApprovable = open.filter((i) => i.may_approve)
  const approvesAll = rejectIds.length === 0 && approveIds.length === allApprovable.length && allApprovable.length === open.length

  const supplierOf = (invoice: AttestBatchInvoiceView) => invoice.supplier_name ?? t('supplier_fallback')
  const labelOf = (invoice: AttestBatchInvoiceView) =>
    invoice.supplier_invoice_number ? t('invoice_number', { number: invoice.supplier_invoice_number }) : t('arrival_number', { number: invoice.arrival_number })

  function toggleApprove(id: string, on: boolean) {
    setApprove((current) => {
      const next = new Set(current)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function setRejection(id: string, comment: string | null) {
    setReject((current) => {
      const next = new Map(current)
      if (comment === null) next.delete(id)
      else next.set(id, comment)
      return next
    })
  }

  async function submit() {
    if (approveIds.length + rejectIds.length === 0) {
      setError(t('nothing_selected'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const decisions = [
        ...approveIds.map((id) => ({ invoice_id: id, decision: 'approve' as const })),
        ...rejectIds.map((id) => ({ invoice_id: id, decision: 'reject' as const, comment: reject.get(id)?.trim() || null })),
      ]
      const res = await fetch(`/api/attest/lista/${encodeURIComponent(token)}/decisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decisions }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok || !body?.data) {
        setError(getErrorMessage(body, { statusCode: res.status, locale, context: 'supplier_invoice' }))
        return
      }
      const results = (body.data.results ?? []) as AttestBatchDecisionResult[]
      const failed = new Map<string, string>()
      for (const result of results) {
        if (!result.ok) failed.set(result.invoice_id, getErrorMessage({ error: { code: result.code } }, { locale, context: 'supplier_invoice' }))
      }
      setFailures(failed)
      setAnswered({
        approved: results.filter((r) => r.ok && r.decision === 'approved').length,
        rejected: results.filter((r) => r.ok && r.decision === 'rejected').length,
      })
      setData(body.data.page as AttestBatchPageData)
      // What is still open was left on purpose (or failed): nothing is ticked for it again by itself.
      setApprove(new Set())
      setReject(new Map())
    } catch (err) {
      setError(getErrorMessage(err, { locale, context: 'supplier_invoice' }))
    } finally {
      setBusy(false)
    }
  }

  const [only] = data.invoices
  const title =
    data.invoices.length === 1 && only
      ? t('title_one', { supplier: supplierOf(only), amount: formatCurrency(only.total, only.currency) })
      : t('title_many', { count: data.invoices.length })

  function stateLine(invoice: AttestBatchInvoiceView): string | null {
    switch (invoice.state) {
      case 'approved':
        return t('state_approved')
      case 'attested':
        return t('state_attested')
      case 'rejected':
        return t('state_rejected')
      case 'closed':
        return invoice.reason === 'registrant'
          ? t('state_registrant')
          : invoice.reason === 'limit' || invoice.reason === 'key_limit'
            ? t('state_limit')
            : invoice.reason === 'other_step'
              ? t('state_other_step')
              : t('state_closed')
      default:
        return !invoice.may_approve && invoice.may_reject ? t('limit_reject_only') : null
    }
  }

  const submitLabel =
    rejectIds.length === 0
      ? approvesAll
        ? t('submit_approve_all', { count: approveIds.length })
        : t('submit_approve_some', { count: approveIds.length })
      : approveIds.length === 0
        ? t('submit_reject', { count: rejectIds.length })
        : t('submit_mixed', { approve: approveIds.length, reject: rejectIds.length })

  return (
    <main className="min-h-dvh bg-background px-4 py-10 md:px-6">
      <div className="mx-auto w-full max-w-2xl space-y-6 stagger-enter">
        <header className="space-y-4">
          <BrandWordmark size="inline" />
          <div className="space-y-1">
            <p className="text-[12.5px] uppercase tracking-wider text-muted-foreground">{t('eyebrow', { company: data.company_name })}</p>
            <h1 className="font-display text-2xl tracking-tight" data-ph-mask="">
              {title}
            </h1>
            <p className="text-[13px] text-muted-foreground">{data.kind === 'reminder' ? t('lead_reminder') : t('lead')}</p>
          </div>
        </header>

        <ul className="divide-y divide-border rounded-lg border border-border" data-ph-mask="">
          {data.invoices.map((invoice) => {
            const rejecting = reject.has(invoice.id)
            const line = stateLine(invoice)
            const failure = failures.get(invoice.id)
            const checkboxId = `attest-${invoice.id}`
            return (
              <li key={invoice.id} className="space-y-3 p-4">
                <div className="flex items-start gap-3">
                  {invoice.state === 'open' && invoice.may_approve ? (
                    <Checkbox
                      id={checkboxId}
                      className="mt-1"
                      checked={approve.has(invoice.id) && !rejecting}
                      disabled={rejecting}
                      onCheckedChange={(checked) => toggleApprove(invoice.id, checked === true)}
                      aria-label={t('approve_label', { supplier: supplierOf(invoice) })}
                    />
                  ) : (
                    <span className="h-4 w-4 shrink-0" aria-hidden="true" />
                  )}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-baseline justify-between gap-4">
                      {invoice.state === 'open' && invoice.may_approve ? (
                        <label htmlFor={checkboxId} className="truncate text-[13px] font-medium">
                          {supplierOf(invoice)}
                        </label>
                      ) : (
                        <span className="truncate text-[13px] font-medium">{supplierOf(invoice)}</span>
                      )}
                      <span className="text-[13px] font-medium tabular-nums">{formatCurrency(invoice.total, invoice.currency)}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted-foreground">
                      <span>{labelOf(invoice)}</span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">{t('due', { date: formatDate(invoice.due_date) })}</span>
                      {invoice.overdue && invoice.state !== 'attested' && <Badge variant="warning">{t('overdue')}</Badge>}
                      {invoice.registered_by && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{t('registered_by', { name: invoice.registered_by })}</span>
                        </>
                      )}
                      {invoice.stage && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{t(invoice.stage === 'pre' ? 'stage_pre' : 'stage_final')}</span>
                        </>
                      )}
                      {invoice.acts_for_name && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{t('acts_for', { name: invoice.acts_for_name })}</span>
                        </>
                      )}
                    </div>
                    {line && <p className="text-[12.5px] text-muted-foreground">{line}</p>}
                    {failure && <AttnLine>{t('result_failed', { message: failure })}</AttnLine>}
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {invoice.has_document && (
                        <a
                          href={`/api/attest/lista/${encodeURIComponent(token)}/document/${encodeURIComponent(invoice.id)}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[12.5px] text-muted-foreground underline-offset-4 hover:underline"
                        >
                          {t('open_document')}
                        </a>
                      )}
                      {invoice.state === 'open' && invoice.may_reject && !rejecting && (
                        <Button type="button" size="sm" variant="outline" onClick={() => setRejection(invoice.id, '')}>
                          {t('reject')}
                        </Button>
                      )}
                      {rejecting && (
                        <Button type="button" size="sm" variant="outline" onClick={() => setRejection(invoice.id, null)}>
                          {t('undo_reject')}
                        </Button>
                      )}
                    </div>
                    {rejecting && (
                      <Textarea
                        value={reject.get(invoice.id) ?? ''}
                        onChange={(e) => setRejection(invoice.id, e.target.value)}
                        maxLength={1000}
                        placeholder={t('comment_placeholder')}
                        aria-label={t('comment_label', { supplier: supplierOf(invoice) })}
                      />
                    )}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>

        {answered && (
          <section className="space-y-1 rounded-lg border border-border p-6">
            <h2 className="font-display text-xl tracking-tight">{t('done_title')}</h2>
            <p className="text-[13px] text-muted-foreground">{t('done_counts', { approved: answered.approved, rejected: answered.rejected })}</p>
            {open.length === 0 && <p className="text-[13px] text-muted-foreground">{t('all_done')}</p>}
          </section>
        )}

        {open.length > 0 && (
          <section className="space-y-3">
            {error && <AttnLine>{error}</AttnLine>}
            <Button type="button" onClick={() => void submit()} loading={busy} disabled={approveIds.length + rejectIds.length === 0}>
              {submitLabel}
            </Button>
            <p className="text-[12.5px] text-muted-foreground">{t('expires', { date: formatDate(data.expires_at) })}</p>
          </section>
        )}
      </div>
    </main>
  )
}
