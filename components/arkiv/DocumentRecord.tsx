'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { QUIET_LINK_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import type { DocumentRecordView } from '@/app/api/arkiv/documents/[id]/route'
import type { DocumentTextView } from '@/app/api/documents/[id]/text/route'
import { DOC_TYPES } from '@/lib/documents/classify/taxonomy'
import { primaryFields, schemaForType } from '@/lib/documents/extract/schemas'
import { formatCurrency, formatDateLong } from '@/lib/utils'
import { DefList, DefRow, Section, SourceLink, inlineHref } from './DefList'
import { useFieldLabel } from './useFieldLabel'

/**
 * A registration, a decision or any other document as a record (canvas
 * artboard Avtal, applied to a document): what it is, what was read from it
 * with its page, the rows of a receipt or invoice, and what it is tied to.
 * A field that became a fact about the company says so on its row instead
 * of being listed twice. `initialPage` (from a search hit) opens the text
 * at that page.
 */
export function DocumentRecord({ documentId, initialPage = null }: { documentId: string; initialPage?: number | null }) {
  const t = useTranslations('arkiv')
  const locale = useLocale()
  const fieldLabel = useFieldLabel()
  const [view, setView] = useState<DocumentRecordView | null>(null)
  const [failed, setFailed] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [text, setText] = useState<DocumentTextView | null>(null)
  const [textOpen, setTextOpen] = useState(false)
  const [reading, setReading] = useState(false)

  const loadText = () => {
    setReading(true)
    return fetch(`/api/documents/${documentId}/text`)
      .then(async (res) => (res.ok ? ((await res.json()) as { data: DocumentTextView }).data : null))
      .then((data) => {
        if (data) {
          setText(data)
          setTextOpen(true)
        }
      })
      .catch(() => undefined)
      .finally(() => setReading(false))
  }

  useEffect(() => {
    if (initialPage) void loadText()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, initialPage])

  // The page is on screen only once both the record and its text are: the text is the smaller fetch and lands first.
  useEffect(() => {
    if (!initialPage || !view || !text || !textOpen) return
    document.getElementById(`arkiv-page-${initialPage}`)?.scrollIntoView({ block: 'start' })
  }, [initialPage, view, text, textOpen])

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
  const meta = [
    typeLabel,
    view.file_name !== view.title ? view.file_name : null,
    formatDateLong(view.created_at, locale),
    view.page_count ? t('decision_pages', { count: view.page_count }) : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const signals = view.classification?.signals ?? []
  const multiPage = (view.page_count ?? 0) > 1
  const allFields = (view.record?.fields ?? []).filter((f) => f.value != null)
  const primary = primaryFields(schemaForType(view.record?.schema_type))
  const fields = showAll ? allFields : allFields.filter((f) => primary.has(f.field) || f.under_review)
  const folded = allFields.length - fields.length
  // A fact whose value is a field's value is that field, established: it shows on the row.
  const factOfField = new Map<string, DocumentRecordView['facts'][number]>()
  const loose: DocumentRecordView['facts'] = []
  for (const fact of view.facts) {
    const field = allFields.find((f) => String(f.value) === fact.value_text && !factOfField.has(f.field))
    if (field) factOfField.set(field.field, fact)
    else loose.push(fact)
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title={view.title}
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

      <div className="grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Section title={t('record_fields')} help={t('record_fields_help')}>
          {!view.record ? (
            <p className="text-[13px] text-muted-foreground">{t('record_no_record')}</p>
          ) : (
            <DefList className="text-[13px]">
              {fields.map((f) => {
                const fact = factOfField.get(f.field)
                return (
                  <DefRow
                    key={f.field}
                    label={fieldLabel(f.field)}
                    source={multiPage && f.page ? <SourceLink href={inlineHref(view.document_id, f.page)} label={t('source_page_short_only', { page: f.page })} /> : undefined}
                  >
                    {String(f.value)}
                    {f.under_review ? (
                      <Badge variant="warning" className="ml-2">
                        {t('record_under_review')}
                      </Badge>
                    ) : null}
                    {fact ? (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {t('record_fact_chip')}
                        {fact.valid_from ? ` ${t('agreement_valid_from', { date: fact.valid_from })}` : ''}
                        {fact.superseded_by ? `, ${t('record_replaced')}` : ''}
                      </span>
                    ) : null}
                  </DefRow>
                )
              })}
            </DefList>
          )}
          {view.record && (folded > 0 || showAll) ? (
            <button
              type="button"
              className="text-xs text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground"
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? t('show_fewer_fields') : t('show_all_fields', { count: allFields.length })}
            </button>
          ) : null}
          {view.line_items.length > 0 && (
            <table className="mt-4 w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={`${TH_CLASS} pl-0`}>{t('record_line_items')}</th>
                  <th className={`${TH_CLASS} text-right`}>{t('col_quantity')}</th>
                  <th className={`${TH_CLASS} text-right`}>{t('col_vat_rate')}</th>
                  <th className={`${TH_CLASS} pr-0 text-right`}>{t('col_amount')}</th>
                </tr>
              </thead>
              <tbody>
                {view.line_items.map((li, i) => (
                  <tr key={i}>
                    <td className={`${TD_CLASS} whitespace-normal pl-0`}>{li.description}</td>
                    <td className={`${TD_CLASS} text-right tabular-nums`}>{li.quantity ?? ''}</td>
                    <td className={`${TD_CLASS} text-right tabular-nums`}>{li.vat_rate != null ? `${li.vat_rate} %` : ''}</td>
                    <td className={`${TD_CLASS} pr-0 text-right tabular-nums`}>{li.line_total != null ? formatCurrency(li.line_total, 'SEK') : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <div className="space-y-8">
          {loose.length > 0 && (
            <Section title={t('record_facts')} help={t('facts_help')}>
              <DefList className="text-[13px]">
                {loose.map((f) => (
                  <DefRow key={f.fact_id} label={f.label} muted={f.superseded_by}>
                    {f.value_text}
                    {f.valid_from ? <span className="ml-2 text-xs text-muted-foreground">{t('agreement_valid_from', { date: f.valid_from })}</span> : null}
                    {f.superseded_by ? <span className="ml-2 text-xs">{t('record_replaced')}</span> : null}
                  </DefRow>
                ))}
              </DefList>
            </Section>
          )}
          <Section title={t('record_text')} help={t('record_text_help')}>
            {!text ? (
              <div className="space-y-1.5">
                {view.read.state !== 'read' ? (
                  <p className="text-[12.5px] text-muted-foreground">
                    {t(`record_text_${view.read.state}` as never)}
                    {view.read.lane === 'history_tied' ? ` ${t('record_text_lane_tied')}` : ''}
                  </p>
                ) : null}
                <button
                  type="button"
                  disabled={reading}
                  className="text-xs text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground disabled:opacity-50"
                  onClick={() => void loadText()}
                >
                  {reading ? t('record_text_reading') : view.read.state === 'read' ? t('record_text_show') : t('record_text_read_now')}
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                {(textOpen ? text.pages : text.pages.slice(0, 1)).map((p) => (
                  <div key={p.page_no} id={`arkiv-page-${p.page_no}`} className={p.page_no === initialPage ? 'scroll-mt-4 border-l-2 border-foreground pl-3' : undefined}>
                    {text.pages.length > 1 ? (
                      <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{t('source_page_short_only', { page: p.page_no })}</div>
                    ) : null}
                    <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap rounded-sm bg-secondary px-4 py-3 font-sans text-[12.5px] leading-relaxed">
                      {textOpen ? p.text : p.text.slice(0, 1500)}
                    </pre>
                  </div>
                ))}
                {(!textOpen && (text.pages.length > 1 || (text.pages[0]?.text.length ?? 0) > 1500)) || text.truncated ? (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground"
                    onClick={() => setTextOpen((v) => !v)}
                  >
                    {textOpen ? t('show_fewer_fields') : t('record_text_all', { count: text.page_count ?? text.pages.length })}
                  </button>
                ) : null}
              </div>
            )}
          </Section>
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
      </div>
    </div>
  )
}
