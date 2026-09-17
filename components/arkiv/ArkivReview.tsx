'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { HelpPopover } from '@/components/ui/help-popover'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { DOC_TYPES } from '@/lib/documents/classify/taxonomy'
import type { FieldReviewDocument, ReviewDocument } from '@/app/api/arkiv/review/route'
import type { FindingView } from '@/app/api/arkiv/findings/route'
import { DocumentDecision, type DecisionDocument } from './DocumentDecision'
import { inlineHref, shortFileName } from './DefList'
import { useFieldLabel } from './useFieldLabel'

interface ReviewData {
  held: ReviewDocument[]
  unclassified: ReviewDocument[]
  fields: FieldReviewDocument[]
}

async function send(method: 'POST' | 'PUT', url: string, body: unknown): Promise<void> {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(String(res.status))
}

/**
 * Granska (canvas artboard Granska): the questions Arkiv has for a person,
 * as rows grouped by question. A document row opens the decision sheet;
 * a finding row carries its own actions.
 */
export function ArkivReview() {
  const t = useTranslations('arkiv')
  const { toast } = useToast()
  const [data, setData] = useState<ReviewData | null>(null)
  const [findings, setFindings] = useState<FindingView[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState<DecisionDocument | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const fieldLabel = useFieldLabel()

  const load = useCallback(async () => {
    try {
      const [review, found] = await Promise.all([fetch('/api/arkiv/review'), fetch('/api/arkiv/findings')])
      if (!review.ok || !found.ok) throw new Error('load')
      setData(((await review.json()) as { data: ReviewData }).data)
      setFindings(((await found.json()) as { data: FindingView[] }).data)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const typeLabel = (type: string | null) => (type && (DOC_TYPES as readonly string[]).includes(type) ? t(`types.${type}` as never) : t('type_unknown'))
  const docMeta = (d: { file_name: string; page_count: number | null; doc_type: string | null }) =>
    [d.page_count ? t('decision_pages', { count: d.page_count }) : null, d.doc_type ? typeLabel(d.doc_type) : null].filter(Boolean).join(', ')

  const closeFinding = async (f: FindingView, resolution: 'applied' | 'dismissed', note?: DismissNote) => {
    setBusy(f.finding_id)
    try {
      if (resolution === 'applied' && f.kind === 'settings_mismatch') {
        await send('PUT', '/api/settings', { [String(f.detail.field)]: f.detail.proposed })
      }
      await send('POST', `/api/arkiv/findings/${f.finding_id}`, note ? { resolution, note } : { resolution })
      toast({ title: resolution === 'applied' ? t('finding_applied') : t('finding_dismissed') })
      await load()
    } catch {
      toast({ title: t('action_failed'), variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  const total = data ? data.held.length + data.unclassified.length + data.fields.length + (findings?.length ?? 0) : 0

  return (
    <div className="space-y-6">
      <PageHeader title={t('review_title')} help={<HelpPopover>{t('review_help')}</HelpPopover>} />

      {failed && <p className="text-[13px] text-muted-foreground">{t('load_failed')}</p>}
      {!data && !failed && (
        <div className="space-y-3">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-6 w-2/3" />
        </div>
      )}

      {data && (
        <div>
          <div className="flex items-baseline justify-between border-b border-border px-1 pb-2.5">
            <h2 className="text-sm font-medium">{t('review_title')}</h2>
            <span className="text-xs text-muted-foreground">{t('review_count', { count: total })}</span>
          </div>
          {total === 0 && <p className="px-1 py-6 text-[13px] text-muted-foreground">{t('review_all_clear')}</p>}

          {data.held.length > 0 && (
            <Group title={t('held_title')}>
              {data.held.map((d) => (
                <Row key={d.document_id} onClick={() => setOpen({ ...d, question: 'held' })} label={`${shortFileName(d.file_name, 48)}: ${t('held_row', { meta: docMeta(d) })}`} />
              ))}
            </Group>
          )}
          {data.unclassified.length > 0 && (
            <Group title={t('unclassified_title')} id="typ">
              {data.unclassified.map((d) => (
                <Row
                  key={d.document_id}
                  onClick={() => setOpen({ ...d, question: 'type' })}
                  label={t('unclassified_row', { file: shortFileName(d.file_name, 48), meta: docMeta(d) })}
                />
              ))}
            </Group>
          )}
          {data.fields.length > 0 && (
            <Group title={t('fields_title')} id="falt">
              {data.fields.map((d) => (
                <Row
                  key={d.document_id}
                  onClick={() =>
                    setOpen({ document_id: d.document_id, file_name: d.file_name, created_at: d.created_at, page_count: d.page_count, doc_type: d.doc_type, question: 'fields' })
                  }
                  label={t('fields_row', {
                    count: d.review_fields.length,
                    file: shortFileName(d.file_name, 40),
                    fields: d.review_fields.slice(0, 3).map(fieldLabel).join(', ').toLowerCase(),
                  })}
                  count={d.review_fields.length}
                />
              ))}
            </Group>
          )}
          {findings && findings.length > 0 && (
            <Group title={t('findings_title')} id="fynd">
              {findings.map((f) => (
                <FindingRow key={f.finding_id} finding={f} busy={busy === f.finding_id} onClose={(resolution, note) => closeFinding(f, resolution, note)} />
              ))}
            </Group>
          )}
        </div>
      )}

      <DocumentDecision
        doc={open}
        onClose={() => setOpen(null)}
        onSaved={(message) => {
          toast({ title: message })
          setOpen(null)
          void load()
        }}
        onFailed={() => toast({ title: t('action_failed'), variant: 'destructive' })}
      />
    </div>
  )
}

function Group({ title, id, children }: { title: string; id?: string; children: React.ReactNode }) {
  return (
    <section id={id}>
      <div className="px-1 pb-1 pt-5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">{title}</div>
      {children}
    </section>
  )
}

function Row({ label, count, onClick }: { label: string; count?: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 border-b border-border px-1 py-3.5 text-left text-[13.5px] transition-colors duration-150 hover:bg-secondary/35"
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count != null && count > 1 ? <Badge variant="secondary">{count}</Badge> : null}
    </button>
  )
}

/** One finding of the nightly lint with what to do about it. */
type DismissNote = 'not_exists' | 'not_applicable'

function FindingRow({ finding, busy, onClose }: { finding: FindingView; busy: boolean; onClose: (resolution: 'applied' | 'dismissed', note?: DismissNote) => void }) {
  const t = useTranslations('arkiv')
  const d = finding.detail
  const settingValue = (value: unknown): string => {
    if (typeof value === 'boolean') return value ? t('finding_yes') : t('finding_no')
    if (d.field === 'moms_period' && typeof value === 'string') return t(`finding_moms_${value}` as never)
    if (d.field === 'accounting_method' && typeof value === 'string') return t(`finding_method_${value}` as never)
    return String(value ?? '')
  }
  let text = ''
  let href: string | null = null
  let external = false
  switch (finding.kind) {
    case 'settings_mismatch':
      text = t('finding_settings_mismatch', { field: t(`finding_field_${String(d.field)}` as never), current: settingValue(d.current), proposed: settingValue(d.proposed) })
      href = d.source_document_id ? inlineHref(String(d.source_document_id), typeof d.page === 'number' ? d.page : null) : null
      external = true
      break
    case 'agreement_ending':
      text = t('finding_agreement_ending', { title: String(d.title), date: String(d.ends_on) })
      href = `/arkiv/avtal/${finding.subject_id}`
      break
    case 'agreement_no_counterparty':
      text = t('finding_agreement_no_counterparty', { title: String(d.title), name: String(d.counterparty_name ?? '') })
      href = `/arkiv/avtal/${finding.subject_id}`
      break
    case 'agreement_duplicate':
      text = t('finding_agreement_duplicate', { titles: ((d.titles as string[] | undefined) ?? []).join(', ') })
      href = `/arkiv/avtal/${finding.subject_id}`
      break
    case 'duplicate_document':
      text = t('finding_duplicate_document', { files: ((d.file_names as string[] | undefined) ?? []).map((f) => shortFileName(f, 30)).join(', ') })
      href = `/arkiv/dokument/${finding.subject_id}`
      break
    case 'document_stuck':
      text = t('finding_document_stuck', { file: shortFileName(String(d.file_name), 40), step: String(d.step) })
      href = `/arkiv/dokument/${finding.subject_id}`
      break
    case 'document_expected': {
      // What the books say should exist: the evidence is months of money, never one transaction.
      const evidence = (d.evidence ?? {}) as { cost_months?: number; balance_months?: number }
      text = t('finding_document_expected', { what: t(`finding_expected_${String(d.rule)}` as never), months: String(Math.max(evidence.cost_months ?? 0, evidence.balance_months ?? 0)) })
      break
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-1 py-3 text-[13.5px]">
      <span className="min-w-0 flex-1">
        {text}
        {href ? (
          external ? (
            <a href={href} target="_blank" rel="noreferrer" className="ml-2 text-xs text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground">
              {t('record_open_document')}
            </a>
          ) : (
            <Link href={href} className="ml-2 text-xs text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground">
              {t('graph_open')}
            </Link>
          )
        ) : null}
      </span>
      <div className="flex items-center gap-3">
        {finding.kind === 'document_expected' ? (
          <>
            <button
              type="button"
              disabled={busy}
              className="text-xs text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground disabled:opacity-50"
              onClick={() => onClose('dismissed', 'not_exists')}
            >
              {t('finding_not_exists')}
            </button>
            <button
              type="button"
              disabled={busy}
              className="text-xs text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground disabled:opacity-50"
              onClick={() => onClose('dismissed', 'not_applicable')}
            >
              {t('finding_not_applicable')}
            </button>
            <Button size="sm" asChild>
              <Link href="/arkiv">{t('finding_upload')}</Link>
            </Button>
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            className="text-xs text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground disabled:opacity-50"
            onClick={() => onClose('dismissed')}
          >
            {t('finding_dismiss')}
          </button>
        )}
        {finding.kind === 'settings_mismatch' && (
          <Button size="sm" disabled={busy} onClick={() => onClose('applied')}>
            {t('finding_apply')}
          </Button>
        )}
      </div>
    </div>
  )
}
