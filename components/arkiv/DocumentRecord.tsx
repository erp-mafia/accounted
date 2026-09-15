'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import type { DocumentRecordView } from '@/app/api/arkiv/documents/[id]/route'
import { DOC_TYPES } from '@/lib/documents/classify/taxonomy'
import { formatDateLong } from '@/lib/utils'
import { Section } from './AgreementRecord'
import { useFieldLabel } from './FieldReview'

const inlineHref = (documentId: string, page: number | null) => `/api/documents/${documentId}/inline${page ? `#page=${page}` : ''}`

/** A registration, a decision or any other document as a record: what it is, what was read, the facts it established, what it is tied to. */
export function DocumentRecord({ documentId }: { documentId: string }) {
  const t = useTranslations('arkiv')
  const locale = useLocale()
  const fieldLabel = useFieldLabel()
  const [view, setView] = useState<DocumentRecordView | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/arkiv/documents/${documentId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const { data } = (await res.json()) as { data: DocumentRecordView }
        if (!cancelled) setView(data)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [documentId])

  if (failed) return <p className="text-[13px] text-muted-foreground">{t('load_failed')}</p>
  if (!view) return <Skeleton className="h-40 w-full" />

  const typeLabel = view.doc_type && (DOC_TYPES as readonly string[]).includes(view.doc_type) ? t(`types.${view.doc_type}` as never) : t('types.other')
  const meta = [typeLabel, formatDateLong(view.created_at, locale), view.page_count ? `${view.page_count} s.` : null].filter(Boolean).join(' · ')

  return (
    <div className="space-y-8">
      <PageHeader
        title={view.file_name}
        description={meta}
        action={
          <Button asChild variant="outline" size="sm">
            <a href={inlineHref(view.document_id, null)} target="_blank" rel="noreferrer">
              {t('record_open_document')}
            </a>
          </Button>
        }
      />
      {view.classification?.summary && (
        <Section title={t('record_classification')}>
          <p className="text-[13px]">{view.classification.summary}</p>
        </Section>
      )}
      <div className="grid gap-8 lg:grid-cols-2">
        <Section title={t('record_facts')}>
          {view.facts.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">{view.record ? t('facts_empty_title') : t('record_no_record')}</p>
          ) : (
            <dl className="m-0 grid grid-cols-[160px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
              {view.facts.map((f) => (
                <div key={f.fact_id} className="contents">
                  <dt className="text-muted-foreground">{f.label}</dt>
                  <dd className={`m-0 ${f.superseded_by ? 'text-muted-foreground' : ''}`}>
                    <span className="tabular-nums">{f.value_text}</span>
                    {f.superseded_by ? <span className="ml-2 text-xs">{t('record_replaced')}</span> : null}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </Section>
        <Section title={t('record_fields')}>
          {!view.record ? (
            <p className="text-[13px] text-muted-foreground">{t('record_no_record')}</p>
          ) : (
            <dl className="m-0 grid grid-cols-[160px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
              {view.record.fields
                .filter((f) => f.value != null)
                .map((f) => (
                  <div key={f.field} className="contents">
                    <dt className="text-muted-foreground">{fieldLabel(f.field)}</dt>
                    <dd className="m-0">
                      <span className="tabular-nums">{String(f.value)}</span>
                      {f.under_review ? <span className="ml-2 text-xs text-warning">{t('record_under_review')}</span> : null}
                      {f.page ? (
                        <a href={inlineHref(view.document_id, f.page)} target="_blank" rel="noreferrer" className={`${QUIET_LINK_CLASS} ml-2 text-xs`}>
                          {t('record_open_page', { page: f.page })}
                        </a>
                      ) : null}
                    </dd>
                  </div>
                ))}
            </dl>
          )}
        </Section>
      </div>
      <Section title={t('record_links')}>
        <dl className="m-0 grid grid-cols-[160px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
          {view.journal_entry && (
            <div className="contents">
              <dt className="text-muted-foreground">{t('linked_verifikat')}</dt>
              <dd className="m-0">
                <Link href={`/bookkeeping?entry=${view.journal_entry.id}`} className={QUIET_LINK_CLASS}>
                  {t('record_verifikat', { voucher: view.journal_entry.voucher })}
                </Link>
              </dd>
            </div>
          )}
          {view.agreement && (
            <div className="contents">
              <dt className="text-muted-foreground">{t('linked_agreement')}</dt>
              <dd className="m-0">
                <Link href={`/arkiv/avtal/${view.agreement.id}`} className={QUIET_LINK_CLASS}>
                  {view.agreement.title}
                </Link>
              </dd>
            </div>
          )}
          {view.links
            .filter((l) => l.target_kind !== 'agreement')
            .map((l) => (
              <div key={l.link_id} className="contents">
                <dt className="text-muted-foreground">{l.target_kind === 'party' ? t('col_counterparty') : t('cluster_tillgangar')}</dt>
                <dd className="m-0">
                  {l.href ? (
                    <Link href={l.href} className={QUIET_LINK_CLASS}>
                      {l.label ?? l.target_id}
                    </Link>
                  ) : (
                    (l.label ?? l.target_id)
                  )}
                  <span className="ml-2 text-xs text-muted-foreground">{l.basis === 'proven' ? '' : `(${l.method})`}</span>
                </dd>
              </div>
            ))}
        </dl>
      </Section>
    </div>
  )
}
