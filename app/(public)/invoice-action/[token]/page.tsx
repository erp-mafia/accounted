'use client'

import { useState, useEffect, use } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatCurrency, formatDate } from '@/lib/utils'
import {
  Loader2,
  CheckCircle,
  AlertCircle,
  FileText,
  MessageSquare,
} from 'lucide-react'

interface InvoiceData {
  invoiceNumber: string
  invoiceDate: string
  dueDate: string
  total: number
  currency: string
  customerName: string
  reminderLevel: number
  alreadyResponded: boolean
  previousResponse: 'marked_paid' | 'disputed' | null
  // Dröjsmålsränta + lagstadgad påminnelseavgift (Räntelagen §6, Lag 1981:739).
  // Default to 0 for older reminders sent before the surcharge feature shipped.
  interestAmount: number
  interestRate: number
  interestFromDate: string | null
  interestDays: number | null
  reminderFee: number
  totalDue: number
}

export default function InvoiceActionPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)

  const [invoice, setInvoice] = useState<InvoiceData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  useEffect(() => {
    fetchInvoiceData()
  }, [token])

  async function fetchInvoiceData() {
    try {
      const response = await fetch(`/api/invoices/reminders/action?token=${token}`)
      const data = await response.json()

      if (!response.ok) {
        setError(data.error || 'Kunde inte hämta fakturainformation')
        return
      }

      setInvoice(data)
    } catch {
      setError('Ett fel uppstod. Försök igen senare.')
    } finally {
      setIsLoading(false)
    }
  }

  async function handleAction(action: 'marked_paid' | 'disputed') {
    setIsSubmitting(true)
    setError(null)

    try {
      const response = await fetch('/api/invoices/reminders/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, action })
      })

      const data = await response.json()

      if (!response.ok) {
        setError(data.error || 'Kunde inte spara ditt svar')
        return
      }

      setSuccessMessage(data.message)
      if (invoice) {
        setInvoice({ ...invoice, alreadyResponded: true, previousResponse: action })
      }
    } catch {
      setError('Ett fel uppstod. Försök igen senare.')
    } finally {
      setIsSubmitting(false)
    }
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto mb-4" />
          <p className="text-muted-foreground">Laddar...</p>
        </div>
      </div>
    )
  }

  if (error && !invoice) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center">
            <AlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
            <h2 className="text-lg font-semibold mb-2">Ogiltig länk</h2>
            <p className="text-muted-foreground">{error}</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!invoice) {
    return null
  }

  // Already responded view
  if (invoice.alreadyResponded || successMessage) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center">
            <CheckCircle className="h-12 w-12 text-success mx-auto mb-4" />
            <h2 className="text-lg font-semibold mb-2">Tack för ditt svar!</h2>
            <p className="text-muted-foreground mb-4">
              {successMessage || (
                invoice.previousResponse === 'marked_paid'
                  ? 'Vi har noterat att du har betalat fakturan.'
                  : 'Vi har noterat din invändning och kommer att kontakta dig.'
              )}
            </p>
            <div className="bg-muted rounded-lg p-4 text-left">
              <p className="text-sm text-muted-foreground">Faktura</p>
              <p className="font-medium">{invoice.invoiceNumber}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Calculate days overdue
  const dueDate = new Date(invoice.dueDate)
  const now = new Date()
  const daysOverdue = Math.floor((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white py-12 px-4">
      <div className="max-w-lg mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">
            Betalningspåminnelse
          </h1>
          <p className="text-muted-foreground">
            Faktura {invoice.invoiceNumber}
          </p>
        </div>

        {/* Invoice Summary Card */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Fakturainformation
            </CardTitle>
            <CardDescription>
              Till: {invoice.customerName}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-muted-foreground">Fakturadatum</p>
                <p className="font-medium">{formatDate(invoice.invoiceDate)}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Förfallodatum</p>
                <p className="font-medium text-destructive">{formatDate(invoice.dueDate)}</p>
              </div>
            </div>

            <div className="bg-destructive/5 border border-destructive/15 rounded-lg p-4 space-y-3">
              <p className="text-sm text-destructive">
                Förfallen med {daysOverdue} dagar
              </p>

              {(invoice.interestAmount > 0 || invoice.reminderFee > 0) && (
                <div className="space-y-1 text-sm tabular-nums">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Ursprungligt belopp</span>
                    <span>{formatCurrency(invoice.total, invoice.currency)}</span>
                  </div>
                  {invoice.interestAmount > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        Dröjsmålsränta
                        {invoice.interestRate > 0 && invoice.interestDays != null
                          ? ` (${(invoice.interestRate * 100).toLocaleString('sv-SE', { maximumFractionDigits: 2 })}% per år, ${invoice.interestDays} dagar)`
                          : ''}
                      </span>
                      <span>{formatCurrency(invoice.interestAmount, invoice.currency)}</span>
                    </div>
                  )}
                  {invoice.reminderFee > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Påminnelseavgift</span>
                      <span>{formatCurrency(invoice.reminderFee, invoice.currency)}</span>
                    </div>
                  )}
                  <div className="border-t border-destructive/20 pt-2 mt-2" />
                </div>
              )}

              <p className="text-2xl font-bold text-destructive tabular-nums">
                {formatCurrency(invoice.totalDue || invoice.total, invoice.currency)}
              </p>
              {(invoice.interestAmount > 0 || invoice.reminderFee > 0) && (
                <p className="text-xs text-muted-foreground">
                  Att betala (inkl. dröjsmålsränta och påminnelseavgift)
                </p>
              )}
            </div>

            {error && (
              <div className="bg-destructive/10 text-destructive text-sm p-3 rounded-lg">
                {error}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Action Card */}
        <Card>
          <CardHeader>
            <CardTitle>Vad vill du göra?</CardTitle>
            <CardDescription>
              Välj ett alternativ nedan
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button
              className="w-full justify-start h-auto py-4 px-4"
              variant="outline"
              onClick={() => handleAction('marked_paid')}
              disabled={isSubmitting}
            >
              <CheckCircle className="h-5 w-5 mr-3 text-success" />
              <div className="text-left">
                <p className="font-medium">Jag har betalat</p>
                <p className="text-sm text-muted-foreground font-normal">
                  Betalningen är redan genomförd
                </p>
              </div>
              {isSubmitting && <Loader2 className="h-4 w-4 ml-auto animate-spin" />}
            </Button>

            <Button
              className="w-full justify-start h-auto py-4 px-4"
              variant="outline"
              onClick={() => handleAction('disputed')}
              disabled={isSubmitting}
            >
              <MessageSquare className="h-5 w-5 mr-3 text-orange-600" />
              <div className="text-left">
                <p className="font-medium">Kontakta avsändaren</p>
                <p className="text-sm text-muted-foreground font-normal">
                  Jag har frågor eller invändningar
                </p>
              </div>
              {isSubmitting && <Loader2 className="h-4 w-4 ml-auto animate-spin" />}
            </Button>
          </CardContent>
        </Card>

        {/* Footer note */}
        <p className="text-center text-sm text-muted-foreground mt-6">
          Om du redan har betalat kan det ta några dagar innan betalningen registreras.
        </p>
      </div>
    </div>
  )
}
