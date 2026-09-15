'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { HelpPopover } from '@/components/ui/help-popover'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { DOC_TYPES, type DocType } from '@/lib/documents/classify/taxonomy'
import type { FieldReviewDocument, ReviewDocument } from '@/app/api/arkiv/review/route'
import { formatDateLong } from '@/lib/utils'
import { FieldReview, useFieldLabel } from './FieldReview'

interface ReviewData {
  held: ReviewDocument[]
  unclassified: ReviewDocument[]
  fields: FieldReviewDocument[]
}

async function post(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(json.error ?? String(res.status))
  }
}

export function ArkivReview() {
  const t = useTranslations('arkiv')
  const locale = useLocale()
  const { toast } = useToast()
  const [data, setData] = useState<ReviewData | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [types, setTypes] = useState<Record<string, DocType>>({})
  const [openFields, setOpenFields] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/arkiv/review')
      if (!res.ok) throw new Error(String(res.status))
      const json = (await res.json()) as { data: ReviewData }
      setData(json.data)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (id: string, fn: () => Promise<void>, doneMessage: string) => {
    setBusy(id)
    try {
      await fn()
      toast({ title: doneMessage })
      await load()
    } catch {
      toast({ title: t('action_failed'), variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  const typeLabel = (type: string | null) => (type && (DOC_TYPES as readonly string[]).includes(type) ? t(`types.${type}` as never) : type ?? t('types.other'))
  const fieldLabel = useFieldLabel()

  return (
    <div className="space-y-8">
      <PageHeader title={t('review_title')} help={<HelpPopover>{t('review_help')}</HelpPopover>} />

      {failed && <p className="attn">{t('load_failed')}</p>}
      {!data && !failed && (
        <div className="space-y-3">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-6 w-2/3" />
        </div>
      )}

      {data && (
        <>
          <section className="space-y-2">
            <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">{t('held_title')}</h2>
            {data.held.length === 0 ? (
              <EmptyState title={t('held_empty_title')} description={t('held_empty_body')} />
            ) : (
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className={`${TH_CLASS} pl-0`}>{t('col_document')}</th>
                    <th className={TH_CLASS}>{t('col_reason')}</th>
                    <th className={`${TH_CLASS} pr-0 text-right`}>{t('col_answer')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.held.map((d) => (
                    <tr key={d.document_id} className="hover:bg-secondary/35">
                      <td className={`${TD_CLASS} pl-0`}>
                        <div className="truncate" title={d.file_name}>
                          {d.file_name}
                        </div>
                        <div className="text-xs text-muted-foreground tabular-nums">
                          {formatDateLong(d.created_at, locale)}
                          {d.doc_type ? ` · ${typeLabel(d.doc_type)}` : ''}
                        </div>
                      </td>
                      <td className={`${TD_CLASS} max-w-md whitespace-normal text-muted-foreground`}>
                        {d.relevance_reason ?? d.summary ?? ''}
                        {d.addressed_to ? ` ${t('addressed_to', { name: d.addressed_to })}` : ''}
                      </td>
                      <td className={`${TD_CLASS} pr-0`}>
                        <div className="flex flex-col items-end gap-2">
                          <Input
                            id={`reason-${d.document_id}`}
                            value={reasons[d.document_id] ?? ''}
                            onChange={(e) => setReasons((r) => ({ ...r, [d.document_id]: e.target.value }))}
                            placeholder={t('reason_placeholder')}
                            className="h-8 w-64 text-[13px]"
                          />
                          <div className="flex gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy === d.document_id}
                              onClick={() => act(d.document_id, () => post(`/api/documents/${d.document_id}/admission`, { decision: 'discard' }), t('discarded'))}
                            >
                              {t('discard')}
                            </Button>
                            <Button
                              size="sm"
                              disabled={busy === d.document_id}
                              onClick={() =>
                                act(
                                  d.document_id,
                                  () => post(`/api/documents/${d.document_id}/admission`, { decision: 'admit', reason: reasons[d.document_id] || undefined }),
                                  t('admitted'),
                                )
                              }
                            >
                              {t('admit')}
                            </Button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="space-y-2" id="typ">
            <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">{t('unclassified_title')}</h2>
            {data.unclassified.length === 0 ? (
              <EmptyState title={t('unclassified_empty_title')} description={t('unclassified_empty_body')} />
            ) : (
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className={`${TH_CLASS} pl-0`}>{t('col_document')}</th>
                    <th className={TH_CLASS}>{t('col_model_says')}</th>
                    <th className={`${TH_CLASS} pr-0 text-right`}>{t('col_type')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.unclassified.map((d) => {
                    const chosen = types[d.document_id] ?? (d.doc_type as DocType | null) ?? 'other'
                    return (
                      <tr key={d.document_id} className="hover:bg-secondary/35">
                        <td className={`${TD_CLASS} pl-0`}>
                          <div className="truncate" title={d.file_name}>
                            {d.file_name}
                          </div>
                          <div className="text-xs text-muted-foreground tabular-nums">{formatDateLong(d.created_at, locale)}</div>
                        </td>
                        <td className={`${TD_CLASS} max-w-md whitespace-normal text-muted-foreground`}>
                          {d.suggested_type ? t('suggested', { label: d.suggested_type }) : d.summary ?? ''}
                        </td>
                        <td className={`${TD_CLASS} pr-0`}>
                          <div className="flex items-center justify-end gap-2">
                            <Select value={chosen} onValueChange={(v) => setTypes((s) => ({ ...s, [d.document_id]: v as DocType }))}>
                              <SelectTrigger className="h-8 w-56 text-[13px]">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {DOC_TYPES.map((type) => (
                                  <SelectItem key={type} value={type}>
                                    {t(`types.${type}` as never)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Button
                              size="sm"
                              disabled={busy === d.document_id}
                              onClick={() => act(d.document_id, () => post(`/api/documents/${d.document_id}/classification`, { doc_type: chosen }), t('type_saved'))}
                            >
                              {t('save_type')}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </section>

          <section className="space-y-2" id="falt">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">{t('fields_title')}</h2>
              <HelpPopover>{t('fields_help')}</HelpPopover>
            </div>
            {data.fields.length === 0 ? (
              <EmptyState title={t('fields_empty_title')} description={t('fields_empty_body')} />
            ) : (
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className={`${TH_CLASS} pl-0`}>{t('col_document')}</th>
                    <th className={TH_CLASS}>{t('col_fields')}</th>
                    <th className={`${TH_CLASS} pr-0 text-right`}>{t('col_answer')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.fields.map((d) => (
                    <Fragment key={d.document_id}>
                      <tr className="hover:bg-secondary/35">
                        <td className={`${TD_CLASS} pl-0`}>
                          <div className="truncate" title={d.file_name}>
                            {d.file_name}
                          </div>
                          <div className="text-xs text-muted-foreground tabular-nums">
                            {formatDateLong(d.created_at, locale)}
                            {d.doc_type ? ` · ${typeLabel(d.doc_type)}` : ''}
                          </div>
                        </td>
                        <td className={`${TD_CLASS} max-w-md whitespace-normal text-muted-foreground`}>{d.review_fields.map(fieldLabel).join(', ')}</td>
                        <td className={`${TD_CLASS} pr-0 text-right`}>
                          <Button variant="outline" size="sm" onClick={() => setOpenFields((o) => (o === d.document_id ? null : d.document_id))}>
                            {openFields === d.document_id ? t('close_fields') : t('open_fields')}
                          </Button>
                        </td>
                      </tr>
                      {openFields === d.document_id && (
                        <tr>
                          <td colSpan={3} className="pb-3 pl-0 pr-0">
                            <FieldReview
                              documentId={d.document_id}
                              onSaved={() => {
                                toast({ title: t('fields_saved') })
                                setOpenFields(null)
                                void load()
                              }}
                              onFailed={() => toast({ title: t('action_failed'), variant: 'destructive' })}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  )
}
