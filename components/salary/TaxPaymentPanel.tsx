'use client'

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Download, Loader2, CheckCircle2, ExternalLink } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatCurrency } from '@/lib/utils'

interface TaxPaymentPanelProps {
  /** YYYY-MM */
  period: string
  totalTax: number
  totalAvgifter: number
  paymentFileGeneratedAt: string | null
  taxPaidAt: string | null
  readOnly?: boolean
  onChange?: () => void
}

/**
 * Generates a Bankgirot LB-fil for paying skatt + arbetsgivaravgifter for an
 * AGI period to Skatteverket Bankgiro 5050-1055 with the company's
 * Skattekontot OCR.
 */
export function TaxPaymentPanel({
  period,
  totalTax,
  totalAvgifter,
  paymentFileGeneratedAt,
  taxPaidAt,
  readOnly,
  onChange,
}: TaxPaymentPanelProps) {
  const { toast } = useToast()
  const [downloading, setDownloading] = useState(false)
  const [marking, setMarking] = useState(false)
  const [paymentDeadline, setPaymentDeadline] = useState<string>('')

  useEffect(() => {
    const m = /^(\d{4})-(\d{2})$/.exec(period)
    if (!m) return
    const year = parseInt(m[1], 10)
    const month = parseInt(m[2], 10)
    const dlMonth = month === 12 ? 1 : month + 1
    const dlYear = month === 12 ? year + 1 : year
    setPaymentDeadline(`${dlYear}-${String(dlMonth).padStart(2, '0')}-12`)
  }, [period])

  const totalAmount = Math.round((totalTax + totalAvgifter) * 100) / 100

  const handleDownload = useCallback(async () => {
    setDownloading(true)
    try {
      const res = await fetch(`/api/skatteverket/tax-payments/${period}/payment-file`)
      if (!res.ok) {
        const result = await res.json().catch(() => ({ error: 'Kunde inte generera betalfil' }))
        toast({
          title: 'Betalfil kunde inte genereras',
          description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `bg_lb_skatt_${period}.txt`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast({ title: 'Betalfil för skatt nedladdad' })
      onChange?.()
    } finally {
      setDownloading(false)
    }
  }, [period, toast, onChange])

  const handleMarkPaid = useCallback(async () => {
    setMarking(true)
    try {
      const res = await fetch(`/api/skatteverket/tax-payments/${period}/mark-paid`, {
        method: 'POST',
      })
      if (!res.ok) {
        const result = await res.json().catch(() => ({ error: 'Kunde inte markera som betald' }))
        toast({
          title: 'Kunde inte markera som betald',
          description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      toast({ title: 'Markerad som betald' })
      onChange?.()
    } finally {
      setMarking(false)
    }
  }, [period, toast, onChange])

  if (totalAmount <= 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Inbetalning till Skattekontot</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Skatt</p>
            <p className="font-semibold tabular-nums">{formatCurrency(totalTax)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Arbetsgivaravgifter</p>
            <p className="font-semibold tabular-nums">{formatCurrency(totalAvgifter)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Totalt att betala</p>
            <p className="font-semibold tabular-nums">{formatCurrency(totalAmount)}</p>
          </div>
        </div>

        <div className="text-sm text-muted-foreground space-y-1">
          <p>
            Mottagare: <span className="text-foreground">Skatteverket Bankgiro 5050-1055</span>
          </p>
          <p>
            Förfallodag: <span className="text-foreground tabular-nums">{paymentDeadline}</span>
          </p>
          <p className="text-xs">
            Betalfil använder ditt Skattekonto-OCR (org-nummer + Luhn-kontrollsiffra). Skatteverket
            applicerar betalningen på det belopp du deklarerat i AGI för perioden.
          </p>
        </div>

        {paymentFileGeneratedAt && (
          <div className="flex items-start gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 mt-0.5 text-success" />
            <div>
              Betalfil senast genererad{' '}
              <span className="text-foreground">
                {new Date(paymentFileGeneratedAt).toLocaleString('sv-SE')}
              </span>
            </div>
          </div>
        )}

        {taxPaidAt && (
          <div className="flex items-start gap-2 text-sm text-success">
            <CheckCircle2 className="h-4 w-4 mt-0.5" />
            <div>
              Markerad som betald{' '}
              <span className="font-medium">{new Date(taxPaidAt).toLocaleString('sv-SE')}</span>
            </div>
          </div>
        )}

        {!readOnly && (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="sm" asChild>
              <a
                href="https://www.skatteverket.se/foretag/skatterochavdrag/skattekonto.4.18e1b10334ebe8bc80004481.html"
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="mr-2 h-4 w-4" />
                Skattekontot
              </a>
            </Button>
            <Button onClick={handleDownload} disabled={downloading || marking}>
              {downloading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-2 h-4 w-4" />
              )}
              Ladda ner betalfil
            </Button>
            {!taxPaidAt && (
              <Button
                variant="outline"
                onClick={handleMarkPaid}
                disabled={downloading || marking}
              >
                {marking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                Markera som betald
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
