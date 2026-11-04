'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const ROOT = '/api/extensions/ext/arcim-migration/migration-jobs/missing-fields'
interface MissingRecord { id: string; sourceId: string; supplier: string; date: string; total: number; currency: string }

export default function MigrationMissingFields({ jobId }: { jobId: string }) {
  const t = useTranslations('extensions')
  const [records, setRecords] = useState<MissingRecord[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [saved, setSaved] = useState(false)
  const load = useCallback(async (after?: string) => {
    setBusy(true); setError(false)
    try {
      let cursor = after
      // Skip pages whose old failures now resolve automatically through OCR.
      // Each response stays bounded and the user can page further if necessary.
      for (let page = 0; page < 20; page++) {
        const response = await fetch(`${ROOT}?jobId=${encodeURIComponent(jobId)}${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`, { cache: 'no-store' })
        if (!response.ok) throw new Error('Read failed')
        const body = await response.json()
        setRecords(body.data.records); setNext(body.data.next)
        if (body.data.records.length || !body.data.next) break
        cursor = body.data.next
      }
    } catch { setError(true) }
    finally { setBusy(false) }
  }, [jobId])
  useEffect(() => { void load() }, [load])

  async function save(record: MissingRecord) {
    setBusy(true); setError(false)
    try {
      const response = await fetch(ROOT, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, chunkId: record.id, correction: { invoiceNumber: values[record.id]?.trim() } }) })
      if (!response.ok) throw new Error('Save failed')
      setSaved(true)
      await load()
    } catch { setError(true) }
    finally { setBusy(false) }
  }

  if (!records.length && !next && !error && !saved) return null
  return <section className="space-y-4" aria-label={t('ext_arcim_missing_title')}>
    <h3 className="font-medium">{t('ext_arcim_missing_title')}</h3>
    <p className="text-sm text-muted-foreground">{t('ext_arcim_missing_description')}</p>
    {saved && <p role="status" className="text-sm">{t('ext_arcim_missing_saved')}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{t('ext_arcim_missing_error')}</p>}
    {records.map(record => <form key={record.id} className="space-y-2 border-b border-border pb-4"
      onSubmit={event => { event.preventDefault(); void save(record) }}>
      <p className="text-sm">{record.supplier} · {record.date} · {record.total} {record.currency}</p>
      <p className="break-all text-xs text-muted-foreground">{record.sourceId}</p>
      <Label htmlFor={`missing-number-${record.id}`}>{t('ext_arcim_missing_number')}</Label>
      <div className="flex gap-2">
        <Input id={`missing-number-${record.id}`} required maxLength={100} disabled={busy}
          value={values[record.id] ?? ''} onChange={event => setValues(prev => ({ ...prev, [record.id]: event.target.value }))} />
        <Button type="submit" variant="outline" disabled={busy || !values[record.id]?.trim()}>{t('ext_arcim_missing_save')}</Button>
      </div>
    </form>)}
    {next && <Button variant="outline" disabled={busy} onClick={() => { void load(next) }}>{t('ext_arcim_missing_next')}</Button>}
    {error && <Button variant="outline" disabled={busy} onClick={() => { void load() }}>{t('ext_arcim_missing_reload')}</Button>}
  </section>
}
