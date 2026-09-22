'use client'

import { useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { SlideOver, SlideOverBody, SlideOverContent, SlideOverFooter, SlideOverHeader } from '@/components/ui/slide-over'
import type { ExtractionView } from '@/app/api/documents/[id]/extraction/route'
import { DOC_TYPES, type DocType } from '@/lib/documents/classify/taxonomy'
import { primaryFields, schemaForType } from '@/lib/documents/extract/schemas'
import { formatDateLong } from '@/lib/utils'
import { DefList, DefRow, SourceLink, inlineHref } from './DefList'
import { useFieldLabel } from './useFieldLabel'

/**
 * The decision sheet (canvas artboard Granska): one document, the type we
 * believe it is with the nearest alternatives, what was read from it with
 * its page, the fields where two readings disagreed, what saving will do,
 * and one primary action. Answers up to three questions in one save: does
 * it belong here, what is it, which reading is right.
 */
export interface DecisionDocument {
  document_id: string
  file_name: string
  created_at: string
  page_count: number | null
  doc_type: string | null
  /** The question the row came from. */
  question: 'held' | 'type' | 'fields'
  relevance_reason?: string | null
  addressed_to?: string | null
  summary?: string | null
  suggested_type?: string | null
}

const GROUPS: string[][] = [
  ['receipt', 'supplier_invoice', 'credit_note', 'customer_invoice'],
  ['bank_statement', 'tax_account_statement'],
  ['registration.bolagsverket', 'filing.bolagsverket', 'decision.skatteverket'],
  ['minutes.board', 'minutes.agm', 'share_subscription_list', 'annual_report'],
]

/** The types a person is most likely to pick instead: the rest of the group, or the closest three otherwise. */
function alternatives(type: DocType | null): DocType[] {
  if (!type || type === 'other') return ['supplier_invoice', 'receipt', 'agreement.other']
  const group = type.startsWith('agreement.') ? DOC_TYPES.filter((t) => t.startsWith('agreement.')) : (GROUPS.find((g) => g.includes(type)) ?? [])
  return group.filter((t) => t !== type).slice(0, 3) as DocType[]
}

function effectKey(type: DocType | null): string {
  if (!type) return 'decision_effect_generic'
  if (type.startsWith('agreement.')) return 'decision_effect_agreement'
  if (type === 'registration.bolagsverket' || type === 'filing.bolagsverket' || type === 'decision.skatteverket') return 'decision_effect_authority'
  if (type === 'receipt' || type === 'supplier_invoice' || type === 'credit_note') return 'decision_effect_underlag'
  return 'decision_effect_generic'
}

async function post(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(String(res.status))
}

const asText = (value: unknown): string => (value == null ? '' : String(value))

export function DocumentDecision({
  doc,
  onClose,
  onSaved,
  onFailed,
}: {
  doc: DecisionDocument | null
  onClose: () => void
  onSaved: (message: string) => void
  onFailed: () => void
}) {
  const t = useTranslations('arkiv')
  const locale = useLocale()
  const fieldLabel = useFieldLabel()
  const [extraction, setExtraction] = useState<ExtractionView | null | undefined>(undefined)
  const [chosen, setChosen] = useState<DocType | null>(null)
  const [picks, setPicks] = useState<Record<string, string>>({})
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [custom, setCustom] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!doc) return
    let cancelled = false
    setExtraction(undefined)
    setChosen((doc.doc_type as DocType | null) ?? null)
    setPicks({})
    setReason('')
    setShowAll(false)
    setCustom({})
    fetch(`/api/documents/${doc.document_id}/extraction`)
      .then(async (res) => {
        if (res.status === 404) return null
        if (!res.ok) throw new Error(String(res.status))
        const { data } = (await res.json()) as { data: ExtractionView }
        return data
      })
      .then((data) => {
        if (cancelled) return
        setExtraction(data)
        if (data) setPicks(Object.fromEntries(data.review_fields.map((name) => [name, asText(data.payload[name]?.value)])))
      })
      .catch(() => {
        if (!cancelled) setExtraction(null)
      })
    return () => {
      cancelled = true
    }
  }, [doc, setShowAll, setCustom])

  const options = useMemo(() => {
    const current = (doc?.doc_type as DocType | null) ?? null
    const list = [current, ...alternatives(current)].filter((x): x is DocType => !!x)
    if (chosen && !list.includes(chosen)) list.unshift(chosen)
    return [...new Set(list)]
  }, [doc, chosen])

  if (!doc) return null

  const settledAll = extraction ? extraction.fields.filter((f) => extraction.payload[f.name]?.value != null && !extraction.review_fields.includes(f.name)) : []
  const primary = extraction ? primaryFields(schemaForType(extraction.schema_type)) : new Set<string>()
  const settled = showAll ? settledAll : settledAll.filter((f) => primary.has(f.name)).slice(0, 5)
  const reviewFields = extraction?.review_fields ?? []
  const highlight = extraction
    ? (reviewFields.map((n) => extraction.payload[n]?.readings?.find((r) => r.quote)?.quote).find(Boolean) ??
      settled.map((f) => extraction.payload[f.name]?.quote).find(Boolean) ??
      null)
    : null
  const title = doc.question === 'held' ? t('held_title') : doc.question === 'type' ? t('unclassified_title') : t('fields_title')
  const meta = [doc.page_count ? t('decision_pages', { count: doc.page_count }) : null, t('decision_uploaded', { date: formatDateLong(doc.created_at, locale) })]
    .filter(Boolean)
    .join(' · ')
  const typeLabel = (type: DocType) => t(`types.${type}` as never)

  const save = async () => {
    if (!chosen) return
    setBusy(true)
    try {
      if (doc.question === 'held') await post(`/api/documents/${doc.document_id}/admission`, { decision: 'admit', reason: reason.trim() || undefined })
      if (chosen !== doc.doc_type || doc.question === 'type') await post(`/api/documents/${doc.document_id}/classification`, { doc_type: chosen })
      if (reviewFields.length) {
        const fields = Object.fromEntries(reviewFields.map((name) => [name, picks[name]?.trim() || null]))
        await post(`/api/documents/${doc.document_id}/extraction/fields`, { fields })
      }
      onSaved(doc.question === 'held' ? t('admitted') : doc.question === 'type' ? t('type_saved') : t('fields_saved'))
    } catch {
      onFailed()
    } finally {
      setBusy(false)
    }
  }
  const discard = async () => {
    setBusy(true)
    try {
      await post(`/api/documents/${doc.document_id}/admission`, { decision: 'discard' })
      onSaved(t('discarded'))
    } catch {
      onFailed()
    } finally {
      setBusy(false)
    }
  }

  return (
    <SlideOver open onOpenChange={(open) => !open && onClose()}>
      <SlideOverContent className="w-[640px]">
        <SlideOverHeader kicker={meta} title={title} />
        <SlideOverBody className="space-y-4">
          <div className="grid gap-5 sm:grid-cols-[190px_minmax(0,1fr)]">
            <div className="h-[250px] rounded-lg border border-border bg-secondary p-3.5">
              <div className="mb-2 h-[5px] w-[60%] rounded-sm bg-border" />
              <div className="mb-1.5 h-[5px] w-[90%] rounded-sm bg-border" />
              <div className="mb-3 h-[5px] w-[84%] rounded-sm bg-border" />
              {highlight ? (
                <div className="rounded-sm border-[1.5px] border-attn/70 bg-attn/10 px-1.5 py-1 text-[9.5px] leading-snug">
                  {highlight.length > 160 ? `${highlight.slice(0, 159)}…` : highlight}
                </div>
              ) : (
                <div className="h-[5px] w-[70%] rounded-sm bg-border" />
              )}
              <div className="mt-3 h-[5px] w-[88%] rounded-sm bg-border" />
              <div className="mt-1.5 h-[5px] w-[76%] rounded-sm bg-border" />
              <p className="mt-3.5 text-[11px] text-muted-foreground">
                <a href={inlineHref(doc.document_id, null)} target="_blank" rel="noreferrer" className="underline decoration-border underline-offset-2 hover:text-foreground">
                  {t('record_open_document')}
                </a>
              </p>
            </div>
            <div className="min-w-0 space-y-3.5">
              <div>
                <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{t('decision_we_think')}</p>
                <div className="flex flex-wrap gap-1.5">
                  {options.map((type) => (
                    <Button key={type} size="sm" variant={chosen === type ? 'default' : 'outline'} onClick={() => setChosen(type)}>
                      {typeLabel(type)}
                    </Button>
                  ))}
                  {showAll ? (
                    <Select value={chosen ?? undefined} onValueChange={(v) => setChosen(v as DocType)}>
                      <SelectTrigger className="h-8 w-56 rounded-full text-[13px]">
                        <SelectValue placeholder={t('decision_other')} />
                      </SelectTrigger>
                      <SelectContent>
                        {DOC_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>
                            {typeLabel(type)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => setShowAll(true)}>
                      {t('decision_other')}
                    </Button>
                  )}
                </div>
                {(doc.relevance_reason || doc.summary || doc.suggested_type) && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {doc.question === 'held' ? (doc.relevance_reason ?? doc.summary) : doc.suggested_type ? t('suggested', { label: doc.suggested_type }) : doc.summary}
                    {doc.addressed_to ? ` ${t('addressed_to', { name: doc.addressed_to })}` : ''}
                  </p>
                )}
                {doc.question === 'held' && (
                  <Input
                    id={`reason-${doc.document_id}`}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder={t('reason_placeholder')}
                    className="mt-2 h-8 text-[13px]"
                  />
                )}
              </div>

              {extraction === undefined ? (
                <Skeleton className="h-16 w-full" />
              ) : extraction ? (
                <div>
                  <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{t('record_fields')}</p>
                  <DefList className="text-[13px]">
                    {settled.map((f) => (
                      <DefRow
                        key={f.name}
                        label={fieldLabel(f.name)}
                        labelWidth={120}
                        source={
                          extraction.payload[f.name]?.page ? (
                            <SourceLink
                              href={inlineHref(doc.document_id, extraction.payload[f.name]?.page)}
                              label={t('source_page_short_only', { page: extraction.payload[f.name]?.page ?? 0 })}
                            />
                          ) : undefined
                        }
                      >
                        {asText(extraction.payload[f.name]?.normalized ?? extraction.payload[f.name]?.value)}
                      </DefRow>
                    ))}
                    {reviewFields.map((name) => {
                      const failed = extraction.validation.find((c) => c.field === name)
                      const readings = (extraction.payload[name]?.readings ?? []).filter((r) => r.value != null)
                      return (
                        <div key={name} className="border-b border-border py-2 last:border-b-0">
                          <div className="grid items-baseline gap-x-4" style={{ gridTemplateColumns: '120px minmax(0, 1fr)' }}>
                            <dt className="text-[12.5px] text-muted-foreground">{fieldLabel(name)}</dt>
                            <dd className="m-0">
                              <Badge variant="warning">
                                {failed?.check === 'audit' ? t('decision_audit') : failed ? t(`checks.${failed.check}` as never) : t('decision_two_readings')}
                              </Badge>
                            </dd>
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            {readings.map((r, i) => (
                              <Button
                                key={i}
                                size="sm"
                                variant={picks[name] === asText(r.value) ? 'default' : 'outline'}
                                onClick={() => setPicks((p) => ({ ...p, [name]: asText(r.value) }))}
                                title={r.quote ?? undefined}
                              >
                                {asText(r.value)}
                                {r.page != null ? ` · ${t('source_page_short_only', { page: r.page })}` : ''}
                              </Button>
                            ))}
                            {custom[name] || readings.length === 0 ? (
                              <Input
                                id={`field-${doc.document_id}-${name}`}
                                value={picks[name] ?? ''}
                                onChange={(e) => setPicks((p) => ({ ...p, [name]: e.target.value }))}
                                placeholder={t('decision_own_value')}
                                className="h-8 w-44 text-[13px]"
                              />
                            ) : (
                              <button
                                type="button"
                                className="text-xs text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground"
                                onClick={() => setCustom((c) => ({ ...c, [name]: true }))}
                              >
                                {t('decision_custom_value')}
                              </button>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </DefList>
                  {settledAll.length > settled.length || showAll ? (
                    <button
                      type="button"
                      className="mt-1 text-xs text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground"
                      onClick={() => setShowAll((v) => !v)}
                    >
                      {showAll ? t('show_fewer_fields') : t('show_all_fields', { count: settledAll.length })}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
          <p className="m-0 text-[13px] text-muted-foreground">{t(effectKey(chosen) as never)}</p>
        </SlideOverBody>
        <SlideOverFooter>
          {doc.question === 'held' && (
            <Button variant="outline" disabled={busy} onClick={discard} className="mr-auto">
              {t('discard')}
            </Button>
          )}
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('decision_skip')}
          </Button>
          <Button disabled={busy || !chosen} onClick={save}>
            {doc.question === 'fields' && chosen === doc.doc_type ? t('confirm_fields') : chosen ? t('decision_save_as', { type: typeLabel(chosen) }) : t('save_type')}
          </Button>
        </SlideOverFooter>
      </SlideOverContent>
    </SlideOver>
  )
}
