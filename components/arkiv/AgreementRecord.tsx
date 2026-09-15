'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { HelpPopover } from '@/components/ui/help-popover'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { QUIET_LINK_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import type { AgreementFactView, AgreementRecordView } from '@/app/api/arkiv/agreements/[id]/route'
import { formatCurrency } from '@/lib/utils'
import { AgreementLinksGraph, type LinkNode } from './AgreementLinksGraph'
import { DefList, DefRow, Section, SourceLink, inlineHref, shortFileName } from './DefList'

/**
 * The agreement page (canvas artboard Avtal): facts with their source page,
 * what the agreement is tied to, the excerpt the amount was read from,
 * expected payments, the dates in Viktiga datum, the history of readings
 * and what refers to the agreement.
 */
export function AgreementRecord({ agreementId }: { agreementId: string }) {
  const t = useTranslations('arkiv')
  const locale = useLocale()
  const [view, setView] = useState<AgreementRecordView | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/arkiv/agreements/${agreementId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const { data } = (await res.json()) as { data: AgreementRecordView }
        if (!cancelled) setView(data)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [agreementId])

  if (failed) return <p className="text-[13px] text-muted-foreground">{t('load_failed')}</p>
  if (!view) return <Skeleton className="h-40 w-full" />

  const today = new Date().toISOString().slice(0, 10)
  const validity =
    view.starts_on && view.ends_on
      ? t('agreement_valid_between', { from: view.starts_on, to: view.ends_on })
      : view.ends_on
        ? t('agreement_valid_until', { to: view.ends_on })
        : view.starts_on
          ? t('agreement_valid_from', { date: view.starts_on })
          : null
  const meta = [view.counterparty.name, validity].filter(Boolean).join(' · ')
  const sourceFile = shortFileName(view.source.file_name)
  const sourceOf = (f: AgreementFactView) => {
    if (!f.source.document_id) return null
    const own = f.source.document_id === view.source.document_id
    const file = shortFileName(view.documents.find((d) => d.document_id === f.source.document_id)?.file_name ?? view.source.file_name)
    const label = f.source.page ? (own ? t('source_page_short_only', { page: f.source.page }) : t('source_ref', { file, page: f.source.page })) : own ? t('graph_open') : file
    return <SourceLink href={inlineHref(f.source.document_id, f.source.page)} label={label} />
  }
  const amountLabel =
    view.amount != null ? `${formatCurrency(view.amount, view.currency)}${view.period && view.period !== 'one_time' ? t(`period_short_${view.period}` as never) : ''}` : null

  const monthOf = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(locale, { month: 'long', timeZone: 'UTC' })
  const what = (o: AgreementRecordView['obligations'][number]) => {
    if (o.kind !== 'payment') return t(`obligation_kind_${o.kind}` as never)
    const noun = t(`payment_noun_${view.kind}` as never)
    return view.period === 'one_time' || view.period == null ? noun : `${noun} ${monthOf(o.due_on)}`
  }
  const statusOf = (o: AgreementRecordView['obligations'][number]) => {
    const prefix = o.direction === 'in' ? 'obligation_in_' : 'obligation_'
    if (o.status === 'expected' && o.due_on < today) return t(`${prefix}waiting` as never)
    return t(`${prefix}${o.status}` as never)
  }

  // Sections that would only say "nothing": shown when the kind carries money or dates, hidden otherwise.
  const PAYING_KINDS = ['rental', 'lease', 'loan', 'subscription', 'insurance', 'customer', 'investment']
  const showPayments = view.obligations.length > 0 || PAYING_KINDS.includes(view.kind)
  const showDates = view.deadlines.length > 0 || !!view.ends_on
  const showHistory = view.history.length > 0
  const nodes: Array<LinkNode & { role: 'counterparty' | 'document_1' | 'source' | 'document_2' | 'payments' | 'deposit' | 'asset' | 'notice' }> = []
  if (view.counterparty.name)
    nodes.push({
      role: 'counterparty',
      key: 'party',
      label: view.counterparty.name,
      href: view.counterparty.party_id ? `/parties/${view.counterparty.party_id}` : null,
      color: 'dark',
    })
  const others = view.documents.filter((d) => d.document_id !== view.source.document_id)
  if (others[0])
    nodes.push({ role: 'document_1', key: others[0].document_id, label: shortFileName(others[0].file_name), href: `/arkiv/dokument/${others[0].document_id}`, color: 'sage' })
  if (others[1])
    nodes.push({ role: 'document_2', key: others[1].document_id, label: shortFileName(others[1].file_name), href: `/arkiv/dokument/${others[1].document_id}`, color: 'sage' })
  nodes.push({
    role: 'source',
    key: 'source',
    label: sourceFile,
    sub: [t('graph_node_document'), amountLabel ? `${amountLabel}${view.source.page ? t('source_page_short', { page: view.source.page }) : ''}` : null].filter(Boolean).join(' · '),
    href: inlineHref(view.source.document_id, view.source.page),
    external: true,
    color: 'sage',
    lit: true,
  })
  const payments = view.obligations.filter((o) => o.kind === 'payment' || o.kind === 'amortisation' || o.kind === 'interest')
  if (payments.length) nodes.push({ role: 'payments', key: 'payments', label: t('graph_node_payments', { count: payments.length }), color: 'grey', stream: true })
  const deposit = view.obligations.find((o) => o.kind === 'deposit' || o.kind === 'first_payment' || o.kind === 'residual')
  if (deposit)
    nodes.push({ role: 'deposit', key: 'deposit', label: `${t(`obligation_kind_${deposit.kind}` as never)} ${formatCurrency(deposit.amount, deposit.currency)}`, color: 'dark' })
  if (view.assets[0]) nodes.push({ role: 'asset', key: view.assets[0].asset_id, label: view.assets[0].label, href: '/assets', color: 'dark' })
  const notice = view.deadlines.find((d) => d.title.toLowerCase().includes('säga upp')) ?? view.deadlines[0]
  if (notice) nodes.push({ role: 'notice', key: notice.id, label: `${t('graph_node_deadline')} ${notice.due_date}`, href: '/deadlines', color: 'ochre' })

  return (
    <div className="space-y-8">
      <PageHeader
        title={view.title}
        help={<HelpPopover>{t('agreement_help')}</HelpPopover>}
        description={meta}
        action={
          <Button asChild size="sm">
            <a href={inlineHref(view.source.document_id, view.source.page)} target="_blank" rel="noreferrer">
              {t('record_open_document')}
            </a>
          </Button>
        }
      />

      <div className="grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_460px]">
        <Section title={t('agreement_facts')} help={t('agreement_facts_help')}>
          {view.facts.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">{t('record_no_record')}</p>
          ) : (
            <DefList className="text-[13px]">
              {view.facts.map((f) => (
                <DefRow key={f.fact_id} label={f.label} source={sourceOf(f)}>
                  {f.value_text}
                  {f.valid_from ? <span className="ml-2 text-xs text-muted-foreground">{t('agreement_valid_from', { date: f.valid_from })}</span> : null}
                </DefRow>
              ))}
            </DefList>
          )}
        </Section>

        <div className="space-y-4">
          <Section title={t('record_links')}>
            <AgreementLinksGraph title={view.title} nodes={nodes} />
          </Section>
          <div className="space-y-2.5 rounded-lg border border-border p-4">
            <div className="rounded-sm bg-secondary px-4 py-3.5">
              <div className="mb-2 h-[5px] w-[46%] rounded-sm bg-border" />
              <div className="mb-1.5 h-[5px] w-[88%] rounded-sm bg-border" />
              <div className="mb-2.5 h-[5px] w-[80%] rounded-sm bg-border" />
              <div className="w-[84%] rounded-sm border-[1.5px] border-attn/70 bg-attn/10 px-2 py-1 text-[11px] leading-snug">{view.source.quote ?? sourceFile}</div>
              <div className="mt-2.5 h-[5px] w-[84%] rounded-sm bg-border" />
            </div>
            <p className="m-0 text-xs text-muted-foreground">
              {view.source.page
                ? t('agreement_source_note', { file: sourceFile, page: view.source.page, field: view.source.field ? t(`fields.${view.source.field}` as never).toLowerCase() : '' })
                : t('agreement_source_note_nopage', { file: sourceFile, field: view.source.field ? t(`fields.${view.source.field}` as never).toLowerCase() : '' })}
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-x-10 gap-y-8 lg:grid-cols-2">
        {showPayments && (
          <Section title={t('agreement_expected_payments')} help={t('agreement_payments_help')}>
            {view.obligations.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">{t('agreement_no_payments')}</p>
            ) : (
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className={`${TH_CLASS} pl-0`}>{t('col_date')}</th>
                    <th className={TH_CLASS}>{t('col_what')}</th>
                    <th className={`${TH_CLASS} text-right`}>{t('col_amount')}</th>
                    <th className={`${TH_CLASS} pr-0`}>{t('col_status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {view.obligations.slice(0, 12).map((o) => (
                    <tr key={o.id}>
                      <td className={`${TD_CLASS} pl-0 tabular-nums`}>{o.due_on}</td>
                      <td className={TD_CLASS}>{what(o)}</td>
                      <td className={`${TD_CLASS} text-right tabular-nums`}>
                        {formatCurrency(o.amount, o.currency)}
                        {o.estimate ? '*' : ''}
                      </td>
                      <td className={`${TD_CLASS} pr-0 ${o.status === 'missed' ? 'text-destructive' : 'text-muted-foreground'}`}>{statusOf(o)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {view.obligations.some((o) => o.estimate) ? <p className="m-0 text-xs text-muted-foreground">{t('agreement_estimate_note')}</p> : null}
          </Section>
        )}

        {showDates && (
          <Section title={t('agreement_dates')} help={t('agreement_dates_help')}>
            {view.deadlines.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">{t('agreement_no_dates')}</p>
            ) : (
              <DefList className="text-[13px]">
                {view.deadlines.map((d) => (
                  <DefRow
                    key={d.id}
                    label={<span className="tabular-nums">{d.due_date}</span>}
                    source={d.page ? <SourceLink href={inlineHref(view.source.document_id, d.page)} label={t('source_page_short_only', { page: d.page })} /> : undefined}
                  >
                    <Link href="/deadlines" className={QUIET_LINK_CLASS}>
                      {d.title}
                    </Link>
                  </DefRow>
                ))}
              </DefList>
            )}
          </Section>
        )}
        {showHistory && (
          <Section title={t('agreement_history')} help={t('agreement_history_help')}>
            {view.history.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">{t('agreement_no_history')}</p>
            ) : (
              <DefList className="text-[13px]">
                {view.history.slice(0, 20).map((f) => (
                  <DefRow
                    key={f.fact_id}
                    label={f.sys_to ? t('agreement_until', { date: f.sys_to.slice(0, 10) }) : f.valid_from ? t('agreement_from', { date: f.valid_from }) : f.label}
                    source={sourceOf(f)}
                    muted
                  >
                    {f.label} {f.value_text}
                  </DefRow>
                ))}
              </DefList>
            )}
          </Section>
        )}
        <Section title={t('agreement_referenced_by')} help={t('agreement_referenced_help')}>
          <DefList className="text-[13px]">
            <DefRow label={t('linked_verifikat')}>{t('agreement_verifikat', { count: view.verifikat_count })}</DefRow>
            {view.counterparty.name ? (
              <DefRow label={t('col_counterparty')}>
                {view.counterparty.party_id ? (
                  <Link href={`/parties/${view.counterparty.party_id}`} className={QUIET_LINK_CLASS}>
                    {view.counterparty.name}
                  </Link>
                ) : (
                  view.counterparty.name
                )}
              </DefRow>
            ) : null}
            {view.assets.length ? <DefRow label={t('cluster_tillgangar')}>{view.assets.map((a) => a.label).join(' · ')}</DefRow> : null}
            <DefRow label={t('col_document')}>
              <span className="space-x-0">
                {view.documents.map((d, i) => (
                  <span key={d.document_id}>
                    {i > 0 ? ' · ' : ''}
                    <Link href={`/arkiv/dokument/${d.document_id}`} className={QUIET_LINK_CLASS}>
                      {shortFileName(d.file_name)}
                    </Link>
                  </span>
                ))}
              </span>
            </DefRow>
          </DefList>
        </Section>
      </div>
    </div>
  )
}
