'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { QUIET_LINK_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import type { FactListItem } from '@/app/api/arkiv/facts/route'

/**
 * "Vad din agent vet" > Fakta: the live facts about the company that the
 * assistant answers from, each with its document and page, and a way to
 * revert a wrong one to the reading before it.
 */
export function AgentFactsPanel() {
  const t = useTranslations('arkiv')
  const { toast } = useToast()
  const [facts, setFacts] = useState<FactListItem[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [reverting, setReverting] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/arkiv/facts?subject_kind=company')
      if (res.status === 404) {
        setFacts([])
        return
      }
      if (!res.ok) throw new Error(String(res.status))
      const { data } = (await res.json()) as { data: FactListItem[] }
      setFacts(data)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const revert = async (factId: string) => {
    setBusy(true)
    try {
      const res = await fetch(`/api/arkiv/facts/${factId}/revert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) })
      if (!res.ok) throw new Error(String(res.status))
      toast({ title: t('facts_reverted') })
      setReverting(null)
      setReason('')
      await load()
    } catch {
      toast({ title: t('action_failed'), variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  if (failed) return <p className="text-[13px] text-muted-foreground">{t('load_failed')}</p>
  if (!facts) return <Skeleton className="h-24 w-full" />
  if (facts.length === 0) return <EmptyState title={t('facts_empty_title')} description={t('facts_empty_body')} />

  return (
    <div className="space-y-3">
      <p className="max-w-[65ch] text-[13px] text-muted-foreground">{t('facts_help')}</p>
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th className={`${TH_CLASS} pl-0`}>{t('facts_col_fact')}</th>
            <th className={TH_CLASS}>{t('facts_col_value')}</th>
            <th className={`${TH_CLASS} pr-0`}>{t('facts_col_source')}</th>
          </tr>
        </thead>
        <tbody>
          {facts.map((f) => (
            <tr key={f.fact_id} className="hover:bg-secondary/35">
              <td className={`${TD_CLASS} pl-0 text-muted-foreground`}>{f.label}</td>
              <td className={TD_CLASS}>
                <span className="tabular-nums">{f.value_text}</span>
                {f.valid_from ? <span className="ml-2 text-xs text-muted-foreground">{t('agreement_valid_from', { date: f.valid_from })}</span> : null}
                {f.earlier_readings > 0 ? (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {t('facts_earlier', { count: f.earlier_readings })}
                    {reverting === f.fact_id ? null : (
                      <button type="button" className={`${QUIET_LINK_CLASS} ml-2`} onClick={() => setReverting(f.fact_id)}>
                        {t('facts_revert')}
                      </button>
                    )}
                  </span>
                ) : null}
                {reverting === f.fact_id && (
                  <div className="mt-2 flex items-center gap-2">
                    <Input id={`revert-${f.fact_id}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('facts_revert_reason')} className="h-8 w-64 text-[13px]" />
                    <Button size="sm" disabled={busy || !reason.trim()} onClick={() => revert(f.fact_id)}>
                      {t('facts_revert')}
                    </Button>
                  </div>
                )}
              </td>
              <td className={`${TD_CLASS} pr-0 text-xs text-muted-foreground`}>
                {f.source.document_id ? (
                  <a href={`/api/documents/${f.source.document_id}/inline${f.source.page ? `#page=${f.source.page}` : ''}`} target="_blank" rel="noreferrer" className={QUIET_LINK_CLASS}>
                    {f.source.file_name ?? t('record_open_document')}
                    {f.source.page ? `, s. ${f.source.page}` : ''}
                  </a>
                ) : (
                  t(`record_source_${f.source_kind}` as never)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Link href="/arkiv" className={`${QUIET_LINK_CLASS} text-xs`}>
        {t('facts_open_arkiv')}
      </Link>
    </div>
  )
}
