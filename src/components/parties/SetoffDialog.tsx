'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { isIsoDateShaped } from '@/lib/invariants'
import type { CounterpartyPayable, CounterpartyReceivable } from '@/lib/invoices/counterparty-setoff/open-items'
import { setoffDefaultAmount } from '@/lib/invoices/counterparty-setoff/plan'
import { parseAmountInput } from '@/lib/money'
import { formatCurrency, formatDate, formatRowAmount } from '@/lib/utils'
import { postSetoff, type SetoffPreview } from './counterparty-client'

interface Props {
  partyId: string
  counterpartyName: string
  receivables: CounterpartyReceivable[]
  payables: CounterpartyPayable[]
  today: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}

/** The supplier invoice as the dossier names it: its printed number, else its löpnummer. */
export function payableLabel(p: Pick<CounterpartyPayable, 'number' | 'arrival_number'>, arrivalWord: string): string {
  if (p.number) return p.number
  return p.arrival_number != null ? `${arrivalWord} ${p.arrival_number}` : ''
}

/**
 * "Kvitta" (crm#1367): set one of the counterparty's open customer invoices
 * off against one of its open supplier invoices. The server's dry run says
 * what is booked and what each invoice is left with before the person
 * confirms; nothing is booked until then (convention 10, confirm up front).
 */
export function SetoffDialog({ partyId, counterpartyName, receivables, payables, today, open, onOpenChange, onDone }: Props) {
  const t = useTranslations('parties')
  const { toast } = useToast()
  const eligibleReceivables = useMemo(() => receivables.filter((r) => r.setoff_eligible), [receivables])
  const eligiblePayables = useMemo(() => payables.filter((p) => p.setoff_eligible), [payables])

  const [invoiceId, setInvoiceId] = useState('')
  const [supplierInvoiceId, setSupplierInvoiceId] = useState('')
  const [amountText, setAmountText] = useState('')
  const [setoffDate, setSetoffDate] = useState(today)
  const [note, setNote] = useState('')
  const [preview, setPreview] = useState<{ key: string; result: SetoffPreview | null; message: string | null } | null>(null)
  const [sending, setSending] = useState(false)

  const invoice = eligibleReceivables.find((r) => r.invoice_id === invoiceId) ?? null
  const payable = eligiblePayables.find((p) => p.supplier_invoice_id === supplierInvoiceId) ?? null

  const defaultAmountFor = (r: CounterpartyReceivable | null, p: CounterpartyPayable | null) =>
    r && p ? setoffDefaultAmount({ remaining: r.remaining_amount }, { remaining: p.remaining_amount }) : null

  // Start from a clean form each time the dialog opens: the oldest eligible
  // invoice on each side, the smaller remaining amount, today.
  const [openedFor, setOpenedFor] = useState(open)
  if (open !== openedFor) {
    setOpenedFor(open)
    if (open) {
      const r = eligibleReceivables[0] ?? null
      const p = eligiblePayables[0] ?? null
      setInvoiceId(r?.invoice_id ?? '')
      setSupplierInvoiceId(p?.supplier_invoice_id ?? '')
      const amount = defaultAmountFor(r, p)
      setAmountText(amount != null ? String(amount).replace('.', ',') : '')
      setSetoffDate(today)
      setNote('')
      setPreview(null)
    }
  }

  function choose(nextInvoiceId: string, nextSupplierInvoiceId: string) {
    setInvoiceId(nextInvoiceId)
    setSupplierInvoiceId(nextSupplierInvoiceId)
    const amount = defaultAmountFor(
      eligibleReceivables.find((r) => r.invoice_id === nextInvoiceId) ?? null,
      eligiblePayables.find((p) => p.supplier_invoice_id === nextSupplierInvoiceId) ?? null,
    )
    setAmountText(amount != null ? String(amount).replace('.', ',') : '')
  }

  const amount = parseAmountInput(amountText)
  const requestKey = JSON.stringify([invoiceId, supplierInvoiceId, amount, setoffDate])
  const ready = open && !!invoice && !!payable && amount != null && amount > 0 && isIsoDateShaped(setoffDate)

  // The server's dry run for the current choice: the same rules the booking uses.
  useEffect(() => {
    if (!ready || amount == null) return
    let cancelled = false
    const key = requestKey
    void postSetoff<SetoffPreview>(partyId, {
      invoice_id: invoiceId,
      supplier_invoice_id: supplierInvoiceId,
      amount,
      setoff_date: setoffDate,
      dry_run: true,
    }).then((answer) => {
      if (cancelled) return
      setPreview(answer.ok ? { key, result: answer.data, message: null } : { key, result: null, message: answer.message })
    })
    return () => {
      cancelled = true
    }
  }, [ready, requestKey, partyId, invoiceId, supplierInvoiceId, amount, setoffDate])

  const current = preview && preview.key === requestKey ? preview : null
  const result = current?.result ?? null

  async function send() {
    if (!ready || amount == null) return
    setSending(true)
    const answer = await postSetoff<{ journal_entry_id: string }>(partyId, {
      invoice_id: invoiceId,
      supplier_invoice_id: supplierInvoiceId,
      amount,
      setoff_date: setoffDate,
      ...(note.trim() ? { note: note.trim() } : {}),
    })
    setSending(false)
    if (answer.ok) {
      toast({ title: t('setoff_booked_toast'), description: t('setoff_booked_hint') })
      onOpenChange(false)
      onDone()
    } else {
      toast({ title: t('setoff_failed_toast'), description: answer.message ?? undefined, variant: 'destructive' })
    }
  }

  const arrivalWord = t('setoff_arrival_number')
  const summary = result
    ? [
        result.invoice.status_after === 'paid'
          ? t('setoff_summary_invoice_paid', { number: result.invoice.number ?? '' })
          : t('setoff_summary_invoice_left', {
              number: result.invoice.number ?? '',
              amount: formatCurrency(result.invoice.remaining_after),
            }),
        result.supplier_invoice.status_after === 'paid'
          ? t('setoff_summary_supplier_paid', { number: payableLabel(result.supplier_invoice, arrivalWord) })
          : t('setoff_summary_supplier_left', {
              number: payableLabel(result.supplier_invoice, arrivalWord),
              amount: formatCurrency(result.supplier_invoice.remaining_after),
            }),
        result.net.direction === 'we_pay'
          ? t('net_we_pay', { amount: formatCurrency(result.net.amount) })
          : result.net.direction === 'they_pay'
            ? t('net_they_pay', { name: counterpartyName, amount: formatCurrency(result.net.amount) })
            : t('net_settled'),
      ].join(' ')
    : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle>{t('setoff_title', { name: counterpartyName })}</DialogTitle>
          <DialogDescription>{t('setoff_description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="setoff-invoice">{t('setoff_invoice')}</Label>
            <select
              id="setoff-invoice"
              className="h-9 w-full rounded-lg px-3 text-sm bg-control shadow-raised"
              value={invoiceId}
              onChange={(e) => choose(e.target.value, supplierInvoiceId)}
            >
              {eligibleReceivables.map((r) => (
                <option key={r.invoice_id} value={r.invoice_id}>
                  {t('setoff_option', { number: r.number ?? '', date: formatDate(r.invoice_date), amount: formatCurrency(r.remaining_amount) })}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="setoff-supplier-invoice">{t('setoff_supplier_invoice')}</Label>
            <select
              id="setoff-supplier-invoice"
              className="h-9 w-full rounded-lg px-3 text-sm bg-control shadow-raised"
              value={supplierInvoiceId}
              onChange={(e) => choose(invoiceId, e.target.value)}
            >
              {eligiblePayables.map((p) => (
                <option key={p.supplier_invoice_id} value={p.supplier_invoice_id}>
                  {t('setoff_option', {
                    number: payableLabel(p, arrivalWord),
                    date: formatDate(p.invoice_date),
                    amount: formatCurrency(p.remaining_amount),
                  })}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="setoff-amount">{t('setoff_amount')}</Label>
              <Input id="setoff-amount" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="setoff-date">{t('setoff_date')}</Label>
              <Input id="setoff-date" type="date" value={setoffDate} max={today} onChange={(e) => setSetoffDate(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="setoff-note">{t('setoff_note')}</Label>
            <Textarea
              id="setoff-note"
              value={note}
              maxLength={500}
              rows={2}
              placeholder={t('setoff_note_placeholder')}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          {summary ? <p className="text-[13px]">{summary}</p> : null}
          {current?.message ? <p className="text-[13px] text-destructive">{current.message}</p> : null}

          {result && result.lines.length > 0 ? (
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="text-xs text-muted-foreground">
                  <th className="py-1 text-left font-normal">{t('setoff_preview_account')}</th>
                  <th className="py-1 text-right font-normal">{t('setoff_preview_debit')}</th>
                  <th className="py-1 text-right font-normal">{t('setoff_preview_credit')}</th>
                </tr>
              </thead>
              <tbody>
                {result.lines.map((line) => (
                  <tr key={line.account_number} className="border-t-hairline">
                    <td className="py-1 pr-3 tabular-nums">{line.account_number}</td>
                    <td className="py-1 text-right tabular-nums">{line.debit_amount > 0 ? formatRowAmount(line.debit_amount) : ''}</td>
                    <td className="py-1 text-right tabular-nums">{line.credit_amount > 0 ? formatRowAmount(line.credit_amount) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <p className="text-xs text-muted-foreground">{t('setoff_vat_note')}</p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
            {t('setoff_cancel')}
          </Button>
          <Button onClick={() => void send()} loading={sending} disabled={!ready || !result}>
            {t('setoff_confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
