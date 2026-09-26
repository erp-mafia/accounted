'use client'

import { useCallback, useEffect, useState } from 'react'
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
import { useToast } from '@/components/ui/use-toast'
import DocumentViewerPane from '@/components/bookkeeping/DocumentViewerPane'
import { DefList, DefRow, Section, SourceLink, inlineHref } from './DefList'
import { DocumentDecision } from './DocumentDecision'
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
  // A person can say the document is something else at any time, not only while Arkiv still has a question about it;
  // a document held at the door gets its one question here too.
  const [deciding, setDeciding] = useState<'held' | 'type' | null>(null)
  const { toast } = useToast()

  const load = useCallback(async () => {
    const res = await fetch(`/api/arkiv/documents/${documentId}`)
    if (!res.ok) throw new Error(String(res.status))
    const { data } = (await res.json()) as { data: DocumentRecordView }
    return data
  }, [documentId])
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
    load()
      .then((data) => {
        if (!cancelled) setView(data)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [load])

  if (failed) return <p className="text-[13px] text-muted-foreground">{t('load_failed')}</p>
  if (!view) return <Skeleton className="h-40 w-full" />

  const typeLabel = view.doc_type && (DOC_TYPES as readonly string[]).includes(view.doc_type) ? t(`types.${view.doc_type}` as never) : t('type_unknown')
  const signals = view.classification?.signals ?? []
  // What the classifier noticed (a scan without a text layer, several documents in one file) belongs with the other facts about the file.
  const meta = [
    typeLabel,
    view.file_name !== view.title ? view.file_name : null,
    formatDateLong(view.created_at, locale),
    view.page_count ? t('decision_pages', { count: view.page_count }) : null,
    ...signals.map((s) => t(`signal_${s}` as never)),
  ]
    .filter(Boolean)
    .join(' · ')
  const multiPage = (view.page_count ?? 0) > 1
  const hasLinks = !!view.journal_entry || !!view.agreement || view.links.length > 0
  const MONEY_FIELD = /amount|total|price|fee|rent|salary|balance|principal|premium/
  const fieldValue = (f: { field: string; value: unknown }) =>
    typeof f.value === 'number' && MONEY_FIELD.test(f.field) ? formatCurrency(f.value, 'SEK', { minimumFractionDigits: 2 }) : String(f.value)
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
          // One action: the viewer below has its own "open in a new tab" link, so the header asks the document's one open question.
          view.admission_state === 'held' ? (
            <Button size="sm" onClick={() => setDeciding('held')}>
              {t('graph_waiting_held')}
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setDeciding('type')}>
              {/* A booked document is not a question: the verifikat already says what it is. */}
              {(view.doc_type && view.doc_type !== 'other') || view.journal_entry ? t('record_change_type') : t('linked_say_what')}
            </Button>
          )
        }
      />
      <DocumentDecision
        doc={
          deciding
            ? { document_id: view.document_id, file_name: view.file_name, created_at: view.created_at, page_count: view.page_count, doc_type: view.doc_type, question: deciding, summary: view.classification?.summary ?? null, suggested_type: view.classification?.suggested_type ?? null, mime_type: view.mime_type }
            : null
        }
        onClose={() => setDeciding(null)}
        onSaved={(message) => {
          setDeciding(null)
          toast({ title: message })
          load()
            .then(setView)
            .catch(() => setFailed(true))
        }}
        onFailed={() => toast({ title: t('action_failed'), variant: 'destructive' })}
      />
      {view.classification?.summary && (
        <Section title={t('record_classification')}>
          {/* Written by a model, so it says so: the document itself, beside it, is the source (founder: raw first). */}
          <p className="m-0 text-[13px]">{view.classification.summary}</p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">{t('record_classification_note')}</p>
        </Section>
      )}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
        {/* The document itself, first: what was read from it sits beside it. */}
        <div className="lg:sticky lg:top-4 lg:self-start">
          <DocumentViewerPane documentId={view.document_id} fileName={view.file_name} page={initialPage} className="h-[72vh]" />
        </div>
        <div className="space-y-8">
        {view.record && (
        <Section title={t('record_fields')} help={t('record_fields_help')}>
          {(
            <DefList className="text-[13px]">
              {fields.map((f) => {
                const fact = factOfField.get(f.field)
                return (
                  <DefRow
                    key={f.field}
                    label={fieldLabel(f.field)}
                    source={multiPage && f.page ? <SourceLink href={inlineHref(view.document_id, f.page)} label={t('source_page_short_only', { page: f.page })} /> : undefined}
                  >
                    {fieldValue(f)}
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
                    <td className={`${TD_CLASS} pr-0 text-right tabular-nums`}>{li.line_total != null ? formatCurrency(li.line_total, 'SEK', { minimumFractionDigits: 2 }) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
        )}
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
          {hasLinks && (
          <Section title={t('record_links')}>
            <DefList className="text-[13px]">
              {view.journal_entry && (
                <DefRow label={t('linked_verifikat')}>
                  <Link href={`/bookkeeping/${view.journal_entry.id}`} className={QUIET_LINK_CLASS}>
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
            </DefList>
          </Section>
          )}
        </div>
      </div>
    </div>
  )
}
