'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Skeleton } from "@/components/ui/skeleton"
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { ArrowLeft, CheckCircle, CreditCard, FileText, Trash2, Lock, Undo2, Info } from 'lucide-react'
import AgentSparkleButton from '@/components/agent/AgentSparkleButton'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatDate } from '@/lib/utils'
import Link from 'next/link'
import { AccountNumber } from '@/components/ui/account-number'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import type { SupplierInvoice, SupplierInvoiceItem, SupplierInvoicePayment } from '@/types'

function formatAmount(amount: number): string {
  return amount.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const statusVariants: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'destructive'> = {
  registered: 'secondary',
  approved: 'default',
  paid: 'success',
  partially_paid: 'warning',
  overdue: 'destructive',
  disputed: 'destructive',
  credited: 'secondary',
  reversed: 'secondary',
}

const statusLabels: Record<string, string> = {
  registered: 'Registrerad',
  approved: 'Godkänd',
  paid: 'Betald',
  partially_paid: 'Delbetald',
  overdue: 'Förfallen',
  disputed: 'Tvist',
  credited: 'Krediterad',
  reversed: 'Makulerad',
}

export default function SupplierInvoiceDetailPage() {
  const { canWrite } = useCanWrite()
  const params = useParams()
  const router = useRouter()
  const { toast } = useToast()
  const [invoice, setInvoice] = useState<SupplierInvoice | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isPayDialogOpen, setIsPayDialogOpen] = useState(false)
  const [payAmount, setPayAmount] = useState('')
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().split('T')[0])
  const [isProcessing, setIsProcessing] = useState(false)
  const [duplicateCandidates, setDuplicateCandidates] = useState<
    Array<{
      id: string
      date: string
      amount: number
      description: string | null
      merchant_name: string | null
    }> | null
  >(null)
  const { dialogProps: confirmDialogProps, confirm: confirmAction } = useDestructiveConfirm()

  async function fetchInvoice() {
    setIsLoading(true)
    const res = await fetch(`/api/supplier-invoices/${params.id}`)
    const { data, error } = await res.json()
    if (error) {
      toast({ title: 'Kunde inte ladda leverantörsfaktura', description: error, variant: 'destructive' })
    } else {
      setInvoice(data)
      setPayAmount(String(data.remaining_amount))
      setPaymentDate(new Date().toISOString().split('T')[0])
    }
    setIsLoading(false)
  }

  useEffect(() => {
    fetchInvoice()
  }, [params.id])

  async function handleApprove() {
    setIsProcessing(true)
    const res = await fetch(`/api/supplier-invoices/${params.id}/approve`, { method: 'POST' })
    const result = await res.json()
    if (!res.ok) {
      toast({ title: 'Godkännande misslyckades', description: getErrorMessage(result, { context: 'supplier_invoice' }), variant: 'destructive' })
    } else {
      toast({ title: 'Godkänd', description: 'Fakturan har godkänts' })
      fetchInvoice()
    }
    setIsProcessing(false)
  }

  async function handleMarkPaid(force: boolean = false) {
    setIsProcessing(true)
    const res = await fetch(`/api/supplier-invoices/${params.id}/mark-paid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: parseFloat(payAmount), payment_date: paymentDate, ...(force ? { force: true } : {}) }),
    })
    const result = await res.json()
    if (!res.ok) {
      if (result?.error?.code === 'SI_PAID_LIKELY_DUPLICATE' && Array.isArray(result.error.details?.candidates)) {
        setDuplicateCandidates(result.error.details.candidates)
        setIsPayDialogOpen(false)
      } else {
        toast({ title: 'Betalning misslyckades', description: getErrorMessage(result, { context: 'supplier_invoice' }), variant: 'destructive' })
      }
    } else {
      toast({
        title: result.status === 'paid' ? 'Betald' : 'Delbetalning registrerad',
        description: `${formatAmount(parseFloat(payAmount))} kr registrerat`,
      })
      setIsPayDialogOpen(false)
      setDuplicateCandidates(null)
      fetchInvoice()
    }
    setIsProcessing(false)
  }

  async function handleCredit() {
    const ok = await confirmAction({
      title: 'Registrera kreditfaktura',
      description: 'En kreditfaktura skapas som reverserar den ursprungliga fakturan. Denna åtgärd kan inte ångras.',
      confirmLabel: 'Registrera kreditfaktura',
      variant: 'warning',
    })
    if (!ok) return
    setIsProcessing(true)
    const res = await fetch(`/api/supplier-invoices/${params.id}/credit`, { method: 'POST' })
    const result = await res.json()
    if (!res.ok) {
      toast({ title: 'Kreditering misslyckades', description: getErrorMessage(result, { context: 'supplier_invoice' }), variant: 'destructive' })
    } else {
      toast({ title: 'Kreditfaktura registrerad' })
      fetchInvoice()
    }
    setIsProcessing(false)
  }

  async function handleDelete() {
    const ok = await confirmAction({
      title: 'Ta bort faktura',
      description: 'Fakturan och tillhörande data tas bort permanent. Denna åtgärd kan inte ångras.',
      confirmLabel: 'Ta bort',
      variant: 'destructive',
    })
    if (!ok) return
    const res = await fetch(`/api/supplier-invoices/${params.id}`, { method: 'DELETE' })
    const result = await res.json()
    if (!res.ok) {
      toast({ title: 'Kunde inte ta bort faktura', description: getErrorMessage(result, { context: 'supplier_invoice' }), variant: 'destructive' })
    } else {
      toast({ title: 'Borttagen' })
      router.push('/supplier-invoices')
    }
  }

  async function handleUncredit() {
    const ok = await confirmAction({
      title: 'Ångra kreditering',
      description:
        'Kreditfakturan tas bort och dess verifikation makuleras (storno). Originalfakturan återställs så att fakturanumret blir ledigt igen.',
      confirmLabel: 'Ångra kreditering',
      variant: 'warning',
    })
    if (!ok) return
    setIsProcessing(true)
    const res = await fetch(`/api/supplier-invoices/${params.id}/uncredit`, { method: 'POST' })
    const result = await res.json()
    if (!res.ok) {
      toast({
        title: 'Kunde inte ångra kreditering',
        description: getErrorMessage(result, { context: 'supplier_invoice' }),
        variant: 'destructive',
      })
    } else {
      toast({
        title: 'Kreditering ångrad',
        description: 'Originalfakturan är återställd och numret är ledigt.',
      })
      fetchInvoice()
    }
    setIsProcessing(false)
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Card className="animate-pulse"><CardContent className="h-48" /></Card>
      </div>
    )
  }

  if (!invoice) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Fakturan hittades inte</p>
        <Button variant="outline" className="mt-4" onClick={() => router.push('/supplier-invoices')}>
          Tillbaka
        </Button>
      </div>
    )
  }

  const items = (invoice.items || []) as SupplierInvoiceItem[]
  const payments = (invoice.payments || []) as SupplierInvoicePayment[]

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center gap-3 sm:gap-4 min-w-0">
          <Button variant="ghost" size="icon" className="shrink-0" onClick={() => router.push('/supplier-invoices')} aria-label="Tillbaka till leverantörsfakturor">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <h1 className="font-display text-2xl sm:text-3xl font-medium tracking-tight">
                Ankomst #{invoice.arrival_number}
              </h1>
              <Badge variant={statusVariants[invoice.status] || 'secondary'}>
                {statusLabels[invoice.status] || invoice.status}
              </Badge>
            </div>
            <p className="text-muted-foreground text-sm sm:text-base truncate">
              {invoice.supplier?.name} | Faktura {invoice.supplier_invoice_number}
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          <AgentSparkleButton
            intentId="supplier_invoice.review"
            intentArgs={{ supplier_invoice_id: invoice.id }}
            contextRef={`supplier_invoice:${invoice.id}`}
            size="default"
          />
          {invoice.status === 'registered' && !invoice.is_credit_note && (
            <>
              <Button
                onClick={handleApprove}
                disabled={isProcessing || !canWrite}
                title={!canWrite ? 'Du har endast läsbehörighet i detta företag' : undefined}
              >
                {canWrite ? <CheckCircle className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
                Godkänn
              </Button>
              <Button
                variant="destructive"
                size="icon"
                onClick={handleDelete}
                disabled={isProcessing || !canWrite}
                title={!canWrite ? 'Du har endast läsbehörighet i detta företag' : undefined}
              >
                {canWrite ? <Trash2 className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
              </Button>
            </>
          )}
          {['approved', 'overdue', 'partially_paid'].includes(invoice.status) && (
            <>
              <Button
                onClick={() => setIsPayDialogOpen(true)}
                disabled={isProcessing || !canWrite}
                title={!canWrite ? 'Du har endast läsbehörighet i detta företag' : undefined}
              >
                {canWrite ? <CreditCard className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
                Markera betald
              </Button>
              {invoice.status !== 'partially_paid' && (
                <Button
                  variant="outline"
                  onClick={handleCredit}
                  disabled={isProcessing || !canWrite}
                  title={!canWrite ? 'Du har endast läsbehörighet i detta företag' : undefined}
                >
                  {canWrite ? <FileText className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
                  Kreditfaktura
                </Button>
              )}
            </>
          )}
          {invoice.status === 'credited' && !invoice.is_credit_note && (
            <Button
              variant="outline"
              onClick={handleUncredit}
              disabled={isProcessing || !canWrite}
              title={!canWrite ? 'Du har endast läsbehörighet i detta företag' : undefined}
            >
              {canWrite ? <Undo2 className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
              Ångra kreditering
            </Button>
          )}
        </div>
      </div>

      {/* Credit note banner — explain why this row has no edit/delete affordances and where to undo */}
      {invoice.is_credit_note && (
        <div className="rounded-lg border bg-muted/40 p-4 flex gap-3 text-sm">
          <Info className="h-5 w-5 shrink-0 text-muted-foreground mt-0.5" />
          <div className="space-y-1">
            <p className="font-medium">Detta är en kreditfaktura</p>
            <p className="text-muted-foreground">
              Den är kopplad till{' '}
              {(invoice as SupplierInvoice & { credited_original?: { id: string; supplier_invoice_number: string; arrival_number: number } }).credited_original ? (
                <Link
                  href={`/supplier-invoices/${(invoice as SupplierInvoice & { credited_original: { id: string; supplier_invoice_number: string; arrival_number: number } }).credited_original.id}`}
                  className="text-primary hover:underline font-medium"
                >
                  faktura {(invoice as SupplierInvoice & { credited_original: { id: string; supplier_invoice_number: string; arrival_number: number } }).credited_original.supplier_invoice_number}
                </Link>
              ) : (
                <span>originalfakturan</span>
              )}
              . För att ta bort kreditfakturan och frigöra fakturanumret, gå till originalet och välj &quot;Ångra kreditering&quot;.
            </p>
          </div>
        </div>
      )}

      {/* Invoice details */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Fakturainformation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Ankomstnummer</span>
              <span className="font-mono">{invoice.arrival_number}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Fakturanummer</span>
              <span>{invoice.supplier_invoice_number}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Fakturadatum</span>
              <span className="tabular-nums">{formatDate(invoice.invoice_date)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Förfallodatum</span>
              <span className="tabular-nums">{formatDate(invoice.due_date)}</span>
            </div>
            {invoice.delivery_date && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Leveransdatum</span>
                <span>{invoice.delivery_date}</span>
              </div>
            )}
            {invoice.payment_reference && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">OCR/referens</span>
                <span className="font-mono">{invoice.payment_reference}</span>
              </div>
            )}
            {invoice.reverse_charge && (
              <div className="mt-2">
                <Badge variant="warning">Omvänd skattskyldighet</Badge>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Belopp</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Netto (exkl. moms)</span>
              <span className="font-mono">{formatAmount(invoice.subtotal)} {invoice.currency}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Moms</span>
              <span className="font-mono">{formatAmount(invoice.vat_amount)} {invoice.currency}</span>
            </div>
            <div className="flex justify-between font-bold text-base pt-2 border-t">
              <span>Totalt</span>
              <span className="font-mono">{formatAmount(invoice.total)} {invoice.currency}</span>
            </div>
            <div className="flex justify-between pt-2">
              <span className="text-muted-foreground">Betalt</span>
              <span className="font-mono text-success">{formatAmount(invoice.paid_amount)} {invoice.currency}</span>
            </div>
            <div className="flex justify-between font-semibold">
              <span>Kvar att betala</span>
              <span className="font-mono">{formatAmount(invoice.remaining_amount)} {invoice.currency}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Supplier info */}
      {invoice.supplier && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Leverantör</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <Link href={`/suppliers/${invoice.supplier.id}`} className="text-primary hover:underline font-medium">
              {invoice.supplier.name}
            </Link>
            <div className="text-muted-foreground mt-1">
              {invoice.supplier.org_number && <span>Org.nr: {invoice.supplier.org_number} | </span>}
              {invoice.supplier.email}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Line items */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Rader</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Desktop table */}
          <div className="hidden sm:block">
            <table className="w-full text-sm">
              <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="pb-2">Beskrivning</th>
                  <th className="pb-2 w-16 text-right">Antal</th>
                  <th className="pb-2 w-16">Enhet</th>
                  <th className="pb-2 w-28 text-right">À-pris</th>
                  <th className="pb-2 w-20">Konto</th>
                  <th className="pb-2 w-16 text-right">Moms%</th>
                  <th className="pb-2 w-28 text-right">Belopp</th>
                  <th className="pb-2 w-24 text-right">Moms</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b last:border-0">
                    <td className="py-2">{item.description}</td>
                    <td className="py-2 text-right">{item.quantity}</td>
                    <td className="py-2">{item.unit}</td>
                    <td className="py-2 text-right font-mono">{formatAmount(item.unit_price)}</td>
                    <td className="py-2"><AccountNumber number={item.account_number} /></td>
                    <td className="py-2 text-right">{Math.round(item.vat_rate * 100)}%</td>
                    <td className="py-2 text-right font-mono">{formatAmount(item.line_total)}</td>
                    <td className="py-2 text-right font-mono">{formatAmount(item.vat_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Mobile cards */}
          <div className="sm:hidden space-y-3">
            {items.map((item) => (
              <div key={item.id} className="border rounded-lg p-3 space-y-1.5">
                <div className="font-medium text-sm">{item.description}</div>
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>{item.quantity} {item.unit} × {formatAmount(item.unit_price)}</span>
                  <span className="font-mono">{formatAmount(item.line_total)} kr</span>
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span><AccountNumber number={item.account_number} /> · {Math.round(item.vat_rate * 100)}% moms</span>
                  <span className="font-mono">moms {formatAmount(item.vat_amount)}</span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Payment history */}
      {payments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Betalningshistorik</CardTitle>
          </CardHeader>
          <CardContent>
            {/* Desktop table */}
            <div className="hidden sm:block">
              <table className="w-full text-sm">
                <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                  <tr className="border-b text-left">
                    <th className="pb-2">Datum</th>
                    <th className="pb-2 text-right">Belopp</th>
                    <th className="pb-2">Verifikation</th>
                    <th className="pb-2">Anteckning</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id} className="border-b last:border-0">
                      <td className="py-2 tabular-nums">{formatDate(p.payment_date)}</td>
                      <td className="py-2 text-right font-mono">{formatAmount(p.amount)} {p.currency}</td>
                      <td className="py-2">
                        {p.journal_entry_id ? (
                          <Link href={`/bookkeeping/${p.journal_entry_id}`} className="text-primary hover:underline font-mono text-xs">
                            {p.journal_entry_id.substring(0, 8)}...
                          </Link>
                        ) : '-'}
                      </td>
                      <td className="py-2 text-muted-foreground">{p.notes || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Mobile cards */}
            <div className="sm:hidden space-y-3">
              {payments.map((p) => (
                <div key={p.id} className="border rounded-lg p-3 space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="tabular-nums">{formatDate(p.payment_date)}</span>
                    <span className="font-mono font-medium">{formatAmount(p.amount)} {p.currency}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    {p.journal_entry_id ? (
                      <Link href={`/bookkeeping/${p.journal_entry_id}`} className="text-primary hover:underline font-mono">
                        {p.journal_entry_id.substring(0, 8)}...
                      </Link>
                    ) : <span>-</span>}
                    <span>{p.notes || ''}</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Journal entries (sambandskrav) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Verifikationer (sambandskrav)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {invoice.registration_journal_entry_id ? (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Registreringsverifikation</span>
              <Link
                href={`/bookkeeping/${invoice.registration_journal_entry_id}`}
                className="text-primary hover:underline font-mono"
              >
                {invoice.registration_journal_entry_id.substring(0, 8)}...
              </Link>
            </div>
          ) : (
            <p className="text-muted-foreground">Ingen registreringsverifikation (kontantmetoden)</p>
          )}
          {invoice.payment_journal_entry_id && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Betalningsverifikation</span>
              <Link
                href={`/bookkeeping/${invoice.payment_journal_entry_id}`}
                className="text-primary hover:underline font-mono"
              >
                {invoice.payment_journal_entry_id.substring(0, 8)}...
              </Link>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Notes */}
      {invoice.notes && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Anteckningar</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{invoice.notes}</p>
          </CardContent>
        </Card>
      )}

      <DestructiveConfirmDialog {...confirmDialogProps} />

      {/* Pay Dialog */}
      <Dialog open={isPayDialogOpen} onOpenChange={setIsPayDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Markera som betald</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="payment-date">Betalningsdatum</Label>
              <Input
                id="payment-date"
                type="date"
                value={paymentDate}
                max={new Date().toISOString().split('T')[0]}
                onChange={(e) => setPaymentDate(e.target.value)}
                className="w-full sm:w-48"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="payment-amount">Belopp att betala</Label>
              <Input
                id="payment-amount"
                type="number"
                step="0.01"
                value={payAmount}
                onChange={(e) => setPayAmount(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Kvar att betala: {formatAmount(invoice.remaining_amount)} {invoice.currency}
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsPayDialogOpen(false)}>
                Avbryt
              </Button>
              <Button onClick={() => handleMarkPaid(false)} disabled={isProcessing}>
                {isProcessing ? 'Bearbetar...' : 'Registrera betalning'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Duplicate-payment warning dialog */}
      <Dialog
        open={duplicateCandidates !== null}
        onOpenChange={(open) => {
          if (!open) setDuplicateCandidates(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Möjlig dubbelbetalning</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Vi hittade {duplicateCandidates?.length === 1 ? 'en banktransaktion' : 'banktransaktioner'} som
              verkar matcha denna betalning. Länka den befintliga transaktionen istället för att skapa en ny
              verifikation.
            </p>
            <div className="space-y-2 rounded-md border bg-muted/30 p-3">
              {duplicateCandidates?.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <div className="font-medium tabular-nums">{formatDate(c.date)}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {c.merchant_name || c.description || 'Banktransaktion'}
                    </div>
                  </div>
                  <div className="tabular-nums font-medium">
                    {formatAmount(Math.abs(c.amount))} {invoice.currency}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => router.push(`/transactions?highlight=${c.id}`)}
                  >
                    Gå till
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={() => setDuplicateCandidates(null)}>
                Avbryt
              </Button>
              <Button
                variant="outline"
                onClick={() => handleMarkPaid(true)}
                disabled={isProcessing}
              >
                {isProcessing ? 'Bearbetar...' : 'Skapa ny verifikation ändå'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
