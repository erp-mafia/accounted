'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { QUIET_LINK_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import type { AgreementFactView, AgreementRecordView } from '@/app/api/arkiv/agreements/[id]/route'
import { formatCurrency, formatDateLong } from '@/lib/utils'

const inlineHref = (documentId: string, page: number | null) => `/api/documents/${documentId}/inline${page ? `#page=${page}` : ''}`

/**
 * The agreement page (canvas artboard Avtal): facts with their source page,
 * the source excerpt, expected payments, the dates in Viktiga datum, the
 * history of readings and what refers to the agreement.
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

  const meta = [view.counterparty.name, view.starts_on && view.ends_on ? `${view.starts_on} till ${view.ends_on}` : view.ends_on ? `till ${view.ends_on}` : null].filter(Boolean).join(' · ')
  const sourceOf = (f: AgreementFactView) => (f.source.document_id ? <a href={inlineHref(f.source.document_id, f.source.page)} target="_blank" rel="noreferrer" className={`${QUIET_LINK_CLASS} ml-2 text-xs`}>{f.source.page ? t('record_open_page', { page: f.source.page }) : t('record_open_document')}</a> : null)

  return (
    <div className="space-y-8">
      <PageHeader
        title={view.title}
        description={meta}
        action={
          <Button asChild variant="outline" size="sm">
            <a href={inlineHref(view.source.document_id, view.source.page)} target="_blank" rel="noreferrer">
              {t('record_open_document')}
            </a>
          </Button>
        }
      />

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_460px]">
        <Section title={t('agreement_facts')}>
          {view.facts.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">{t('record_no_record')}</p>
          ) : (
            <dl className="m-0 grid grid-cols-[160px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
              {view.facts.map((f) => (
                <FactRow key={f.fact_id} fact={f} source={sourceOf(f)} />
              ))}
            </dl>
          )}
        </Section>
        <div className="rounded-lg border border-border p-4">
          <div className="rounded-sm bg-secondary p-4 text-[12px] leading-relaxed">
            {view.source.quote ? <span className="rounded-sm border border-warning/60 bg-warning/10 px-1.5 py-0.5">{view.source.quote}</span> : <span className="text-muted-foreground">{view.source.file_name}</span>}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {view.source.page ? t('agreement_source_note', { file: view.source.file_name, page: view.source.page, field: view.source.field ?? '' }) : t('agreement_source_note_nopage', { file: view.source.file_name, field: view.source.field ?? '' })}
          </p>
        </div>
      </div>

      <div className="grid gap-8 lg:grid-cols-2">
        <Section title={t('agreement_expected_payments')}>
          {view.obligations.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">{t('agreement_no_payments')}</p>
          ) : (
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={`${TH_CLASS} pl-0`}>{t('col_date')}</th>
                  <th className={TH_CLASS}>{t('col_type')}</th>
                  <th className={`${TH_CLASS} text-right`}>{t('col_amount')}</th>
                  <th className={`${TH_CLASS} pr-0`}>{t('col_linked')}</th>
                </tr>
              </thead>
              <tbody>
                {view.obligations.slice(0, 12).map((o) => (
                  <tr key={o.id}>
                    <td className={`${TD_CLASS} pl-0 tabular-nums`}>{formatDateLong(o.due_on, locale)}</td>
                    <td className={`${TD_CLASS} text-muted-foreground`}>{t(`fields.${o.kind === 'payment' ? 'amount' : o.kind}` as never, undefined as never) || o.kind}</td>
                    <td className={`${TD_CLASS} text-right tabular-nums`}>
                      {formatCurrency(o.amount, o.currency)}
                      {o.estimate ? '*' : ''}
                    </td>
                    <td className={`${TD_CLASS} pr-0 ${o.status === 'missed' ? 'text-destructive' : 'text-muted-foreground'}`}>{t(`obligation_${o.status}` as never)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
        <Section title={t('agreement_dates')}>
          {view.deadlines.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">{t('agreement_no_dates')}</p>
          ) : (
            <dl className="m-0 grid grid-cols-[120px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
              {view.deadlines.map((d) => (
                <div key={d.id} className="contents">
                  <dt className="tabular-nums text-muted-foreground">{d.due_date}</dt>
                  <dd className="m-0">
                    <Link href="/deadlines" className={QUIET_LINK_CLASS}>
                      {d.title}
                    </Link>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </Section>
        <Section title={t('agreement_history')}>
          {view.history.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">{t('agreement_no_history')}</p>
          ) : (
            <dl className="m-0 grid grid-cols-[160px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
              {view.history.slice(0, 20).map((f) => (
                <FactRow key={f.fact_id} fact={f} source={sourceOf(f)} muted />
              ))}
            </dl>
          )}
        </Section>
        <Section title={t('agreement_referenced_by')}>
          <dl className="m-0 grid grid-cols-[160px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
            <div className="contents">
              <dt className="text-muted-foreground">{t('linked_verifikat')}</dt>
              <dd className="m-0">{t('agreement_verifikat', { count: view.verifikat_count })}</dd>
            </div>
            <div className="contents">
              <dt className="text-muted-foreground">{t('col_document')}</dt>
              <dd className="m-0 space-y-0.5">
                {view.documents.map((d) => (
                  <div key={d.document_id}>
                    <Link href={`/arkiv/dokument/${d.document_id}`} className={QUIET_LINK_CLASS}>
                      {d.file_name}
                    </Link>
                  </div>
                ))}
              </dd>
            </div>
            {view.counterparty.party_id && (
              <div className="contents">
                <dt className="text-muted-foreground">{t('col_counterparty')}</dt>
                <dd className="m-0">
                  <Link href={`/parties/${view.counterparty.party_id}`} className={QUIET_LINK_CLASS}>
                    {view.counterparty.name}
                  </Link>
                </dd>
              </div>
            )}
          </dl>
        </Section>
      </div>
    </div>
  )
}

function FactRow({ fact, source, muted }: { fact: AgreementFactView; source: React.ReactNode; muted?: boolean }) {
  const t = useTranslations('arkiv')
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{fact.label}</dt>
      <dd className={`m-0 ${muted ? 'text-muted-foreground' : ''}`}>
        <span className="tabular-nums">{fact.value_text}</span>
        {fact.valid_from ? <span className="ml-2 text-xs text-muted-foreground">{t('agreement_valid_from', { date: fact.valid_from })}</span> : null}
        {muted && fact.sys_to ? <span className="ml-2 text-xs">{t('agreement_believed_until', { date: fact.sys_to.slice(0, 10) })}</span> : null}
        {source}
      </dd>
    </div>
  )
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 space-y-3">
      <h2 className="border-b border-border pb-2 text-sm font-medium">{title}</h2>
      {children}
    </section>
  )
}
