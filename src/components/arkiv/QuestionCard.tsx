'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { DOC_TYPES } from '@/lib/documents/classify/taxonomy'
import type { ArkivQuestion, QuestionFinding } from '@/lib/arkiv/questions'
import type { Reading } from '@/lib/documents/extract/fields'
import { inlineHref, shortFileName } from './DefList'
import type { DecisionDocument } from './DocumentDecision'
import { useFieldLabel } from './useFieldLabel'

/**
 * One question Arkiv has for a person (phase 9d, "ask at the door"): the
 * question in a sentence with the answer we would give, why we ask, one tap,
 * and then what happens, stated in the card. The decision sheet stays one
 * link away for an answer that is not on a chip. Used by Granska and by the
 * Underlag rail, so a question reads the same wherever it is met.
 */
export const QUIET_ACTION_CLASS = 'text-xs text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground disabled:opacity-50'

type DismissNote = 'not_exists' | 'not_applicable'

async function send(method: 'POST' | 'PUT', url: string, body: unknown): Promise<void> {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(String(res.status))
}

const asText = (value: string | number | null): string => (value == null ? '' : String(value))

/** The decision sheet's view of a question: the same document, opened on the question it came from. Null for a finding. */
export function decisionDocumentFor(question: ArkivQuestion): DecisionDocument | null {
  if (question.kind === 'finding') return null
  if (question.kind === 'field') {
    const d = question.document
    return { document_id: d.document_id, file_name: d.file_name, created_at: d.created_at, page_count: d.page_count, doc_type: d.doc_type, question: 'fields' }
  }
  const d = question.document
  return {
    document_id: d.document_id,
    file_name: d.file_name,
    created_at: d.created_at,
    page_count: d.page_count,
    doc_type: d.doc_type,
    question: question.kind,
    relevance_reason: d.relevance_reason,
    addressed_to: d.addressed_to,
    summary: d.summary,
    suggested_type: d.suggested_type,
  }
}
/** A reading fits a chip: a long clause from a contract is cut, the full text stays on the chip's title. */
const shortValue = (value: string | number | null, max = 48): string => {
  const text = asText(value).trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

export function QuestionCard({
  question,
  onMore,
  onAnswered,
  compact = false,
}: {
  question: ArkivQuestion
  /** The answer is not on a chip: open the decision sheet for this question. */
  onMore?: (question: ArkivQuestion) => void
  /** Answered with one tap and saved; the card keeps showing what happens next. */
  onAnswered?: (question: ArkivQuestion) => void
  compact?: boolean
}) {
  const t = useTranslations('arkiv')
  const fieldLabel = useFieldLabel()
  const [busy, setBusy] = useState(false)
  const [then, setThen] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const typeLabel = (type: string | null) => (type && (DOC_TYPES as readonly string[]).includes(type) ? t(`types.${type}` as never) : t('type_unknown'))
  const readingLabel = (r: Reading) => `${shortValue(r.value)}${r.page != null ? ` · ${t('source_page_short_only', { page: r.page })}` : ''}`

  const act = async (work: () => Promise<void>, consequence: string) => {
    setBusy(true)
    setFailed(false)
    try {
      await work()
      setThen(consequence)
      onAnswered?.(question)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  let sentence = ''
  let why: string | null = null
  let chips: React.ReactNode = null
  let more: React.ReactNode = onMore ? (
    <button type="button" className={QUIET_ACTION_CLASS} disabled={busy} onClick={() => onMore(question)}>
      {t('question_more')}
    </button>
  ) : null

  if (question.kind === 'held') {
    const d = question.document
    sentence = t('question_held', { title: shortFileName(d.title, 48) })
    why = d.relevance_reason ?? (d.addressed_to ? t('addressed_to', { name: d.addressed_to }) : d.summary)
    chips = (
      <>
        <Button size="sm" disabled={busy} onClick={() => act(() => send('POST', `/api/documents/${d.document_id}/admission`, { decision: 'admit' }), t('then_admitted'))}>
          {t('question_held_yes')}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => send('POST', `/api/documents/${d.document_id}/admission`, { decision: 'discard' }), t('discarded'))}>
          {t('question_held_no')}
        </Button>
      </>
    )
  } else if (question.kind === 'type') {
    const d = question.document
    const proposed = question.proposed
    why = d.summary
    if (proposed) {
      const label = typeLabel(proposed)
      sentence = t('question_type', { title: shortFileName(d.title, 48), type: label })
      chips = (
        <>
          <Button size="sm" disabled={busy} onClick={() => act(() => send('POST', `/api/documents/${d.document_id}/classification`, { doc_type: proposed }), t('then_typed', { type: label }))}>
            {t('question_type_yes', { type: label })}
          </Button>
          {onMore ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onMore(question)}>
              {t('question_type_no')}
            </Button>
          ) : null}
        </>
      )
      more = null
    } else {
      sentence = t('question_type_open', { title: shortFileName(d.title, 48) })
      chips = onMore ? (
        <Button size="sm" disabled={busy} onClick={() => onMore(question)}>
          {t('question_type_pick')}
        </Button>
      ) : null
      more = null
    }
  } else if (question.kind === 'field') {
    const d = question.document
    const label = fieldLabel(question.field)
    const [first, second] = question.readings
    sentence = first ? t('question_field', { title: shortFileName(d.title, 48), field: label, value: readingLabel(first) }) : t('question_field_open', { title: shortFileName(d.title, 48), field: label })
    why = question.check ? t(`checks.${question.check}` as never) : first && second ? t('question_two_readings', { a: readingLabel(first), b: readingLabel(second) }) : null
    const after = (value: string) => `${t('then_field', { field: label, value })}${question.remaining > 0 ? ` ${t('then_field_more', { count: question.remaining })}` : ''}`
    const save = (r: Reading) => act(() => send('POST', `/api/documents/${d.document_id}/extraction/fields`, { fields: { [question.field]: r.value } }), after(shortValue(r.value)))
    chips = (
      <>
        {question.readings.length === 1 && first ? (
          // One reading to confirm: the sentence already says the value, the chip says yes.
          <Button size="sm" disabled={busy} title={first.quote ?? asText(first.value)} onClick={() => save(first)}>
            {t('question_yes')}
          </Button>
        ) : (
          question.readings.map((r, i) => (
            <Button key={i} size="sm" variant={i === 0 ? 'default' : 'outline'} disabled={busy} title={r.quote ?? asText(r.value)} onClick={() => save(r)}>
              {readingLabel(r)}
            </Button>
          ))
        )}
        {onMore ? (
          <button type="button" className={QUIET_ACTION_CLASS} disabled={busy} onClick={() => onMore(question)}>
            {t('question_field_other')}
          </button>
        ) : null}
      </>
    )
    more = null
  } else {
    return <FindingQuestion finding={question.finding} compact={compact} busy={busy} then={then} failed={failed} onClose={(resolution, note) => act(() => closeFinding(question.finding, resolution, note), resolution === 'applied' ? t('finding_applied') : t('then_noted'))} />
  }

  return (
    <div className={cn('border-b border-border px-1', compact ? 'py-2.5' : 'py-3')}>
      <div className="text-[13px]">{sentence}</div>
      {why ? <div className="mt-0.5 text-[12.5px] text-muted-foreground">{why}</div> : null}
      {then ? (
        <div className="mt-2 text-[12.5px]">{then}</div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {chips}
          {more}
        </div>
      )}
      {failed ? <div className="mt-1 text-[12.5px] text-destructive">{t('action_failed')}</div> : null}
    </div>
  )
}

async function closeFinding(f: QuestionFinding, resolution: 'applied' | 'dismissed', note?: DismissNote): Promise<void> {
  // A settings mismatch applied is the setting changed first, then the finding closed as applied.
  if (resolution === 'applied' && f.kind === 'settings_mismatch') await send('PUT', '/api/settings', { [String(f.detail.field)]: f.detail.proposed })
  await send('POST', `/api/arkiv/findings/${f.finding_id}`, note ? { resolution, note } : { resolution })
}

/** One finding of the nightly lint with what to do about it, and what was done. */
function FindingQuestion({
  finding,
  compact,
  busy,
  then,
  failed,
  onClose,
}: {
  finding: QuestionFinding
  compact: boolean
  busy: boolean
  then: string | null
  failed: boolean
  onClose: (resolution: 'applied' | 'dismissed', note?: DismissNote) => void
}) {
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
      href = finding.subject_id ? `/arkiv/avtal/${finding.subject_id}` : null
      break
    case 'agreement_no_counterparty':
      text = t('finding_agreement_no_counterparty', { title: String(d.title), name: String(d.counterparty_name ?? '') })
      href = finding.subject_id ? `/arkiv/avtal/${finding.subject_id}` : null
      break
    case 'agreement_duplicate':
      text = t('finding_agreement_duplicate', { titles: ((d.titles as string[] | undefined) ?? []).join(', ') })
      href = finding.subject_id ? `/arkiv/avtal/${finding.subject_id}` : null
      break
    case 'duplicate_document':
      text = t('finding_duplicate_document', { files: ((d.file_names as string[] | undefined) ?? []).map((f) => shortFileName(f, 30)).join(', ') })
      href = finding.subject_id ? `/arkiv/dokument/${finding.subject_id}` : null
      break
    case 'document_stuck':
      text = t('finding_document_stuck', { file: shortFileName(String(d.file_name), 40), step: String(d.step) })
      href = finding.subject_id ? `/arkiv/dokument/${finding.subject_id}` : null
      break
    case 'document_expected': {
      // What the books say should exist: the evidence is months of money, never one transaction.
      const evidence = (d.evidence ?? {}) as { cost_months?: number; balance_months?: number }
      text = t('finding_document_expected', { what: t(`finding_expected_${String(d.rule)}` as never), months: String(Math.max(evidence.cost_months ?? 0, evidence.balance_months ?? 0)) })
      break
    }
  }
  return (
    <div className={cn('border-b border-border px-1', compact ? 'py-2.5' : 'py-3')}>
      <div className="text-[13px]">
        {text}
        {href ? (
          external ? (
            <a href={href} target="_blank" rel="noreferrer" className={`ml-2 ${QUIET_ACTION_CLASS}`}>
              {t('record_open_document')}
            </a>
          ) : (
            <Link href={href} className={`ml-2 ${QUIET_ACTION_CLASS}`}>
              {t('graph_open')}
            </Link>
          )
        ) : null}
      </div>
      {then ? (
        <div className="mt-2 text-[12.5px]">{then}</div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {finding.kind === 'document_expected' ? (
            <>
              <Button size="sm" asChild>
                <Link href="/arkiv">{t('finding_upload')}</Link>
              </Button>
              <button type="button" disabled={busy} className={QUIET_ACTION_CLASS} onClick={() => onClose('dismissed', 'not_exists')}>
                {t('finding_not_exists')}
              </button>
              <button type="button" disabled={busy} className={QUIET_ACTION_CLASS} onClick={() => onClose('dismissed', 'not_applicable')}>
                {t('finding_not_applicable')}
              </button>
            </>
          ) : (
            <>
              {finding.kind === 'settings_mismatch' ? (
                <Button size="sm" disabled={busy} onClick={() => onClose('applied')}>
                  {t('finding_apply')}
                </Button>
              ) : null}
              <button type="button" disabled={busy} className={QUIET_ACTION_CLASS} onClick={() => onClose('dismissed')}>
                {t('finding_dismiss')}
              </button>
            </>
          )}
        </div>
      )}
      {failed ? <div className="mt-1 text-[12.5px] text-destructive">{t('action_failed')}</div> : null}
    </div>
  )
}
