'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import type { DocumentRecordView } from '@/app/api/arkiv/documents/[id]/route'
import { DOC_TYPES } from '@/lib/documents/classify/taxonomy'
import { formatDateLong } from '@/lib/utils'
import { DefList, DefRow, Section, SourceLink, inlineHref, shortFileName } from './DefList'
import { useFieldLabel } from './useFieldLabel'

/** A registration, a decision or any other document as a record (canvas artboard Avtal, applied to a document): what it is, what was read, the facts it established, what it is tied to. */
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

  const typeLabel = view.doc_type && (DOC_TYPES as readonly string[]).includes(view.doc_type) ? t(`types.${view.doc_type}` as never) : t('type_unknown')
  const meta = [typeLabel, formatDateLong(view.created_at, locale), view.page_count ? t('decision_pages', { count: view.page_count }) : null].filter(Boolean).join(' · ')
  const file = shortFileName(view.file_name)
  const signals = view.classification?.signals ?? []

  return (
    <div className="space-y-8">
      <PageHeader
        title={view.file_name}
        description={meta}
        action={
          <Button asChild size="sm">
            <a href={inlineHref(view.document_id, null)} target="_blank" rel="noreferrer">
              {t('record_open_document')}
            </a>
          </Button>
        }
      />
      {(view.classification?.summary || signals.length > 0) && (
        <Section title={t('record_classification')}>
          {view.classification?.summary ? <p className="m-0 text-[13px]">{view.classification.summary}</p> : null}
          {signals.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {signals.map((s) => (
                <Badge key={s} variant="outline" title={t(`signal_${s}_help` as never)}>
                  {t(`signal_${s}` as never)}
                </Badge>
              ))}
            </div>
          )}
        </Section>
      )}
      <div className="grid gap-x-10 gap-y-8 lg:grid-cols-2">
        <Section title={t('record_facts')} help={t('facts_help')}>
          {view.facts.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">{view.record ? t('facts_empty_title') : t('record_no_record')}</p>
          ) : (
            <DefList className="text-[13px]">
              {view.facts.map((f) => (
                <DefRow key={f.fact_id} label={f.label} muted={f.superseded_by}>
                  {f.value_text}
                  {f.valid_from ? <span className="ml-2 text-xs text-muted-foreground">{t('agreement_valid_from', { date: f.valid_from })}</span> : null}
                  {f.superseded_by ? <span className="ml-2 text-xs">{t('record_replaced')}</span> : null}
                </DefRow>
              ))}
            </DefList>
          )}
        </Section>
        <Section title={t('record_fields')} help={t('record_fields_help')}>
          {!view.record ? (
            <p className="text-[13px] text-muted-foreground">{t('record_no_record')}</p>
          ) : (
            <DefList className="text-[13px]">
              {view.record.fields
                .filter((f) => f.value != null)
                .map((f) => (
                  <DefRow
                    key={f.field}
                    label={fieldLabel(f.field)}
                    source={f.page ? <SourceLink href={inlineHref(view.document_id, f.page)} label={t('source_ref', { file, page: f.page })} /> : undefined}
                  >
                    {String(f.value)}
                    {f.under_review ? (
                      <Badge variant="warning" className="ml-2">
                        {t('record_under_review')}
                      </Badge>
                    ) : null}
                  </DefRow>
                ))}
            </DefList>
          )}
        </Section>
      </div>
      <Section title={t('record_links')}>
        <DefList className="text-[13px]">
          {view.journal_entry && (
            <DefRow label={t('linked_verifikat')}>
              <Link href={`/bookkeeping?entry=${view.journal_entry.id}`} className={QUIET_LINK_CLASS}>
                {t('record_verifikat', { voucher: view.journal_entry.voucher })}
              </Link>
            </DefRow>
          )}
          {view.agreement && (
            <DefRow label={t('linked_agreement')}>
              <Link href={`/arkiv/avtal/${view.agreement.id}`} className={QUIET_LINK_CLASS}>
                {view.agreement.title}
              </Link>
            </DefRow>
          )}
          {view.links
            .filter((l) => l.target_kind !== 'agreement')
            .map((l) => (
              <DefRow key={l.link_id} label={l.target_kind === 'party' ? t('col_counterparty') : t('cluster_tillgangar')}>
                {l.href ? (
                  <Link href={l.href} className={QUIET_LINK_CLASS}>
                    {l.label ?? l.target_id}
                  </Link>
                ) : (
                  (l.label ?? l.target_id)
                )}
                {l.basis !== 'proven' ? <span className="ml-2 text-xs text-muted-foreground">{t('link_guessed')}</span> : null}
              </DefRow>
            ))}
          {!view.journal_entry && !view.agreement && view.links.length === 0 ? <p className="m-0 py-2 text-[13px] text-muted-foreground">{t('record_no_links')}</p> : null}
        </DefList>
      </Section>
    </div>
  )
}
