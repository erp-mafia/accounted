'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { ProviderDocumentMatchReview } from '@/lib/providers/document-match-review'

/** Re-read current source metadata so the full list survives leaving the import result. */
export function UnmatchedProviderDocuments({consentId}:{consentId:string}) {
  const t=useTranslations('extensions')
  const [open,setOpen]=useState(false)
  const [offset,setOffset]=useState(0)
  const [draft,setDraft]=useState('')
  const [query,setQuery]=useState('')
  const [reload,setReload]=useState(0)
  const [data,setData]=useState<ProviderDocumentMatchReview|null>(null)
  const [loading,setLoading]=useState(false)
  const [error,setError]=useState<string|null>(null)
  useEffect(()=>{
    if(!open)return
    const controller=new AbortController()
    const params=new URLSearchParams({consentId,offset:String(offset),query})
    void fetch('/api/extensions/ext/arcim-migration/unmatched-documents?'+params,
      {signal:controller.signal,cache:'no-store'})
      .then(async response=>{
        const body=await response.json()
        if(!response.ok)throw new Error(getErrorMessage(body))
        if(!controller.signal.aborted)setData(body.data)
      }).catch(e=>{if(!controller.signal.aborted)setError(getErrorMessage(e))})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false)})
    return()=>controller.abort()
  },[consentId,open,offset,query,reload,t])

  const beginRead = () => {setLoading(true);setError(null)}

  return <section className="space-y-3" aria-label={t('ext_arcim_documents_review_title')}>
    <Button variant="outline" size="sm" aria-expanded={open} onClick={()=>{if(!open)beginRead();setOpen(value=>!value)}}>
      {t(open?'ext_arcim_documents_review_hide':'ext_arcim_documents_review_show')}
    </Button>
    {open && <div className="space-y-4" aria-busy={loading}>
      <p className="text-sm text-muted-foreground">{t('ext_arcim_documents_review_current')}</p>
      <form className="flex flex-wrap items-center gap-2" onSubmit={event=>{event.preventDefault();beginRead();setOffset(0);setQuery(draft.trim());setReload(n=>n+1)}}>
        <Input className="min-w-0 flex-1" type="search" maxLength={200} value={draft} onChange={event=>setDraft(event.target.value)}
          aria-label={t('ext_arcim_documents_review_search')} placeholder={t('ext_arcim_documents_review_search')} />
        <Button variant="outline" size="sm" disabled={loading} type="submit">{t('ext_arcim_documents_review_search_action')}</Button>
      </form>
      {error ? <div className="space-y-2" role="alert">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={()=>{beginRead();setReload(n=>n+1)}}>{t('ext_arcim_documents_review_retry')}</Button>
      </div> : loading ? <div className="space-y-3" role="status" aria-label={t('ext_arcim_documents_review_loading')}>
        <Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" />
      </div> : data && <>
        <p className="text-sm tabular-nums" aria-live="polite">{t('ext_arcim_documents_review_total',{count:data.total})}</p>
        <ul className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
          {Object.entries(data.reasonCounts).map(([reason,count])=><li key={reason}>{t(`ext_arcim_documents_reason_${reason}`)}: {count}</li>)}
        </ul>
        {!data.items.length && <p className="text-sm text-muted-foreground">{t(data.total===0?'ext_arcim_documents_review_resolved':'ext_arcim_documents_review_empty')}</p>}
        <ul className="divide-y divide-border" data-ph-mask="">
          {data.items.map(row=><li key={`${row.uploadId}:${row.voucher}:${row.date}:${row.dateTo}`} className="space-y-2 py-3 text-sm">
            <p className="break-words font-medium">{row.fileName || t('ext_arcim_documents_review_unnamed')}</p>
            <p className="text-xs tabular-nums text-muted-foreground">{row.voucher || t('ext_arcim_documents_review_no_ref')}{row.date ? ` · ${row.date}${row.dateTo ? ` - ${row.dateTo}` : ''}` : ''}</p>
            <p>{t(`ext_arcim_documents_reason_detail_${row.reason}`)}</p>
            {!!row.candidates.length && <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t('ext_arcim_documents_review_candidates',{count:row.candidateCount})}</p>
              <ul className="space-y-1">{row.candidates.map(candidate=><li key={candidate.id}>
                <Link className="underline underline-offset-4" href={`/bookkeeping/${candidate.id}`} target="_blank" rel="noopener noreferrer">
                  {candidate.label} · {candidate.date} · {t(candidate.reversed?'ext_arcim_documents_review_reversed':'ext_arcim_documents_review_posted')}
                </Link>
              </li>)}</ul>
              {row.candidateCount>row.candidates.length && <p className="text-xs text-muted-foreground">{t('ext_arcim_documents_review_more_candidates',{count:row.candidateCount-row.candidates.length})}</p>}
            </div>}
            <details className="text-xs text-muted-foreground"><summary>{t('ext_arcim_documents_review_source_id')}</summary><p className="break-all">{row.uploadId}</p></details>
          </li>)}
        </ul>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs tabular-nums text-muted-foreground">{t('ext_arcim_documents_review_page',{
            from:data.items.length ? offset+1 : 0,to:Math.min(offset+data.items.length,data.filteredTotal),total:data.filteredTotal,
          })}</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={offset===0} onClick={()=>{beginRead();setOffset(Math.max(0,offset-data.limit))}}>{t('ext_arcim_documents_review_previous')}</Button>
            <Button variant="outline" size="sm" disabled={offset+data.items.length>=data.filteredTotal} onClick={()=>{beginRead();setOffset(offset+data.limit)}}>{t('ext_arcim_documents_review_next')}</Button>
          </div>
        </div>
      </>}
    </div>}
  </section>
}
