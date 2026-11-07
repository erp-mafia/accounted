'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useCompany } from '@/contexts/CompanyContext'
import { Button } from '@/components/ui/button'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import type { HistoricalReceivableFinding } from '@/lib/providers/historical-receivable-findings'

const ROOT = '/api/extensions/ext/arcim-migration/migration-jobs/historical-findings'
type Finding = Omit<HistoricalReceivableFinding, 'payloadHash'>
interface Reviewed { origin: 'incomplete_invoice' | 'voucher_only'; id: string; invoice_number: string; payment_date: string; payment_amount_sek: number; customer_name: string; payment_journal_entry_id: string }

export default function HistoricalReceivableFindings({ jobId, onApproved }: { jobId: string; onApproved: () => void }) {
  const t = useTranslations('extensions')
  const { role } = useCompany()
  const [findings, setFindings] = useState<Finding[]>([])
  const [reviewed, setReviewed] = useState<Reviewed[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const [selected, setSelected] = useState<Finding | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  const load = useCallback(async (after?: string) => {
    setLoading(true); setError(false)
    try {
      const response = await fetch(`${ROOT}?jobId=${encodeURIComponent(jobId)}${after ? `&after=${encodeURIComponent(after)}` : ''}`, { cache: 'no-store' })
      if (!response.ok) throw new Error('Review unavailable')
      const { data } = await response.json()
      setFindings(data.findings); setReviewed(data.reviewed); setNext(data.next); setTotal(data.total)
    } catch { setError(true) }
    finally { setLoading(false) }
  }, [jobId])
  useEffect(() => { void load() }, [load])

  async function approve() {
    if (!selected || busy) return
    setBusy(true); setError(false)
    try {
      const response = await fetch(`${ROOT}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, paymentEntryId: selected.paymentEntryId }) })
      if (!response.ok) throw new Error('Evidence changed')
      setSelected(null)
      await load()
      onApproved()
    } catch { setError(true) }
    finally { setBusy(false) }
  }

  return <section className="space-y-4 border-t border-border pt-6" aria-label={t('ext_arcim_historical_title')}>
    <h3 className="font-medium">{t('ext_arcim_historical_title')}</h3>
    <p className="text-sm text-muted-foreground">{t('ext_arcim_historical_description')}</p>
    {loading && <p role="status" className="text-sm">{t('ext_arcim_historical_loading')}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{t('ext_arcim_historical_error')}</p>}
    {!loading && !error && !findings.length && <p className="text-sm">{t('ext_arcim_historical_none')}</p>}
    {!!total && <p className="text-sm">{t('ext_arcim_historical_count', { count: total })}</p>}
    {findings.map(finding => <div key={finding.paymentEntryId} className="space-y-2 border-b border-border pb-4" data-ph-mask="">
      <p className="font-medium">{t(finding.origin === 'voucher_only' ? 'ext_arcim_historical_reference' : 'ext_arcim_historical_invoice', { number: finding.invoiceNumber })} · {finding.customer}</p>
      <p className="text-sm">{finding.paymentDate} · {finding.paymentAmount} SEK</p>
      <p className="text-sm text-muted-foreground">{t(finding.origin === 'incomplete_invoice' ? 'ext_arcim_historical_partial' : 'ext_arcim_historical_voucher_only')}</p>
      <p className="text-sm">{finding.description}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Link className="text-sm underline" href={`/bookkeeping/${finding.paymentEntryId}`} target="_blank" rel="noopener noreferrer">
          {t('ext_arcim_historical_open', { voucher: finding.voucher || finding.paymentDate })}
        </Link>
        <Button variant="outline" disabled={busy || role === 'viewer'} onClick={() => setSelected(finding)}>{t('ext_arcim_historical_review')}</Button>
      </div>
    </div>)}
    {next && <Button variant="outline" disabled={loading || busy} onClick={() => { void load(next) }}>{t('ext_arcim_historical_next')}</Button>}
    <Button variant="ghost" disabled={loading || busy} onClick={() => { void load() }}>{t('ext_arcim_historical_reload')}</Button>
    {reviewed.length > 0 && <div className="space-y-2">
      <h4 className="text-sm font-medium">{t('ext_arcim_historical_approved')}</h4>
      {reviewed.map(row => <p key={row.id} className="text-sm" data-ph-mask="">
        <Link className="underline" href={`/bookkeeping/${row.payment_journal_entry_id}`}>
          {t(row.origin === 'voucher_only' ? 'ext_arcim_historical_reference' : 'ext_arcim_historical_invoice', { number: row.invoice_number })} · {row.customer_name} · {row.payment_date}
        </Link>
      </p>)}
    </div>}
    <ConfirmationDialog open={!!selected} onOpenChange={open => { if (!open && !busy) setSelected(null) }}
      isSubmitting={busy} title={t('ext_arcim_historical_confirm_title')} confirmLabel={t('ext_arcim_historical_approve')}
      onConfirm={() => { void approve() }}>
      {selected && <div className="space-y-3" data-ph-mask="">
        <p>{t(selected.origin === 'voucher_only' ? 'ext_arcim_historical_reference' : 'ext_arcim_historical_invoice', { number: selected.invoiceNumber })} · {selected.customer}</p>
        <p>{selected.paymentDate} · {selected.paymentAmount} SEK · {selected.voucher}</p>
        <p>{t('ext_arcim_historical_confirm_description')}</p>
        {error && <p role="alert" className="text-sm text-destructive">{t('ext_arcim_historical_error')}</p>}
      </div>}
    </ConfirmationDialog>
  </section>
}
