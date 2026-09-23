'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useCompany } from '@/contexts/CompanyContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { formatCurrency, formatDate } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { SUBLEDGER_COLUMNS, type SubledgerRow, type SubledgerResult } from '@/lib/import/subledger/schema'

type Preview = SubledgerResult & { source_rows: SubledgerRow[] }

/** Review and confirm an import against the active company and posted balances. */
export default function SubledgerImport() {
  const t = useTranslations('subledgerImport')
  const locale = useLocale() === 'en' ? 'en' : 'sv'
  const { company } = useCompany()
  const [kind, setKind] = useState<'customer' | 'supplier'>('customer')
  const [date, setDate] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [completed, setCompleted] = useState(false)
  // Company navigation remounts this component through the parent key. Also
  // compare IDs before every request so a retained preview can never be used.
  const currentPreview = preview?.company_id === company?.id ? preview : null

  /** Discard approval state whenever the import inputs change. */
  function reset() { setPreview(null); setCompleted(false); setError(''); setConfirm(false) }
  /** Download the canonical column headers without customer data. */
  function template() {
    const url = URL.createObjectURL(new Blob(['\uFEFF' + SUBLEDGER_COLUMNS.join(';') + '\r\n'], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'accounted-subledger.csv'
    anchor.click(); URL.revokeObjectURL(url)
  }
  /** Preview the uploaded file or execute the previously reviewed rows and token. */
  async function submit(execute: boolean) {
    if (!company || !file || (execute && !currentPreview)) return
    setBusy(true); setError(''); setConfirm(false)
    try {
      let body: BodyInit
      let headers: HeadersInit | undefined
      if (execute && currentPreview) {
        headers = { 'Content-Type': 'application/json' }
        body = JSON.stringify({ company_id: company.id, kind: currentPreview.kind, snapshot_date: currentPreview.snapshot_date,
          rows: currentPreview.source_rows, execute: true, preview_token: currentPreview.token })
      } else {
        const form = new FormData()
        form.set('file', file); form.set('company_id', company.id); form.set('kind', kind); form.set('snapshot_date', date)
        body = form
      }
      const response = await fetch('/api/import/subledger', { method: 'POST', headers, body })
      const result = await response.json()
      if (!response.ok) { setError((result.error?.details?.row ? t('rowError', { row: result.error.details.row }) + ' ' : '') + getErrorMessage(result.error, { locale })); setPreview(null); return }
      setPreview(result.data)
      setCompleted(execute || result.data.already_imported)
    } catch (err) { setError(getErrorMessage(err, { locale })) }
    finally { setBusy(false) }
  }

  return <div className="space-y-6">
    <div className="flex items-center justify-between gap-4">
      <div className="text-sm">{company?.name} <span className="text-muted-foreground">{company?.org_number}</span></div>
      <div className="flex items-center gap-2">
        <InfoTooltip content={t('help')} />
        <Button variant="outline" onClick={template}>{t('template')}</Button>
      </div>
    </div>
    <div className="grid gap-4 md:grid-cols-3">
      <div className="space-y-2"><Label htmlFor="subledger-kind">{t('kind')}</Label>
        <Select value={kind} disabled={busy} onValueChange={value => { reset(); setKind(value as typeof kind) }}>
          <SelectTrigger id="subledger-kind"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="customer">{t('customer')}</SelectItem><SelectItem value="supplier">{t('supplier')}</SelectItem></SelectContent>
        </Select>
      </div>
      <div className="space-y-2"><Label htmlFor="subledger-date">{t('date')}</Label>
        <Input id="subledger-date" type="date" value={date} disabled={busy} onChange={event => { reset(); setDate(event.target.value) }} />
      </div>
      <div className="space-y-2"><Label htmlFor="subledger-file">{t('file')}</Label>
        <Input id="subledger-file" type="file" accept=".csv,.xlsx" disabled={busy} onChange={event => { reset(); setFile(event.target.files?.[0] ?? null) }} />
      </div>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex justify-end gap-3">
      <Button variant="outline" disabled={!company || !file || !date || busy} onClick={() => submit(false)}>{busy ? t('working') : t('preview')}</Button>
      {currentPreview && !completed && <Button disabled={busy || Number(currentPreview.difference) !== 0} onClick={() => setConfirm(true)}>{t('import')}</Button>}
    </div>
    {currentPreview && <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {(['ledger_balance', 'existing_balance', 'imported_balance', 'difference'] as const).map(key => <div key={key}>
          <div className="text-xs text-muted-foreground">{t(key)}</div>
          <div className="font-display text-xl tabular-nums">{formatCurrency(Number(currentPreview[key]))}</div>
        </div>)}
      </div>
      {currentPreview.kind === 'customer' && currentPreview.next_invoice_number_after !== currentPreview.next_invoice_number_before && <p className="text-sm">{t('numbering', { before: (currentPreview.invoice_number_prefix ?? '') + String(currentPreview.next_invoice_number_before).padStart(3, '0'), after: (currentPreview.invoice_number_prefix ?? '') + String(currentPreview.next_invoice_number_after).padStart(3, '0') })}</p>}
      {completed ? <p role="status" className="text-sm">{t(currentPreview.already_imported ? 'alreadyImported' : 'completed', { count: currentPreview.imported })}</p>
        : Number(currentPreview.difference) !== 0 && <p className="attn">{t('unreconciled')}</p>}
      <div className="overflow-x-auto"><table className="w-full border-collapse text-[13px]">
        <thead><tr>{['invoice', 'party', 'invoiceDate', 'dueDate', 'total', 'vat', 'remaining'].map(key => <th key={key} className={TH_CLASS}>{t(key)}</th>)}</tr></thead>
        <tbody>{currentPreview.rows.map((row, index) => {
          const source = currentPreview.source_rows[index]
          return <tr key={index} className="hover:bg-secondary/35">
            <td className={TD_CLASS} title={`${source.voucher_series}${source.voucher_number} (${source.voucher_year})`}>{row.invoice_number}</td>
            <td className={TD_CLASS}>{row.counterparty_name}</td>
            <td className={`${TD_CLASS} tabular-nums`}>{formatDate(source.invoice_date)}</td>
            <td className={`${TD_CLASS} tabular-nums`}>{formatDate(source.due_date)}</td>
            {[source.total, source.vat_amount, row.remaining_amount].map((value, i) => <td key={i} className={`${TD_CLASS} text-right tabular-nums`}>{formatCurrency(Number(value))}</td>)}
          </tr>
        })}</tbody>
      </table></div>
    </>}
    <Dialog open={confirm} onOpenChange={setConfirm}><DialogContent>
      <DialogHeader><DialogTitle>{t('confirmTitle')}</DialogTitle>
        <DialogDescription>{t('confirmDescription', { company: currentPreview?.company_name ?? '', count: currentPreview?.imported ?? 0, amount: formatCurrency(Number(currentPreview?.imported_balance ?? 0)) })}</DialogDescription>
      </DialogHeader>
      <DialogFooter><Button variant="outline" onClick={() => setConfirm(false)}>{t('cancel')}</Button><Button disabled={busy} onClick={() => submit(true)}>{t('import')}</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>
}
