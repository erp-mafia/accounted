'use client'

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Download, Loader2, CheckCircle2, ChevronDown, Info } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'

type PaymentFormat = 'bg_lb' | 'pain001'

interface PaymentFilePanelProps {
  salaryRunId: string
  periodLabel: string
  paymentFileFormat: string | null
  paymentFileGeneratedAt: string | null
  defaultFormat: PaymentFormat
  readOnly?: boolean
  onDownloaded?: () => void
}

const FORMAT_LABEL: Record<PaymentFormat, string> = {
  bg_lb: 'Bankgirot LB-fil',
  pain001: 'SEPA pain.001 (XML)',
}

const FORMAT_DESCRIPTION: Record<PaymentFormat, string> = {
  bg_lb: 'Standard för Swedbank, SEB, Handelsbanken, Nordea m.fl. Kräver bankgironummer hos Bankgirot.',
  pain001: 'ISO 20022. För banker som inte är anslutna till Bankgirot, eller internationell SEPA.',
}

const BANK_INSTRUCTIONS: Record<PaymentFormat, Array<{ bank: string; steps: string }>> = {
  bg_lb: [
    { bank: 'Swedbank Företag', steps: 'Företagsbetalningar → Importera fil → välj LB-format → ladda upp och signera med BankID.' },
    { bank: 'SEB Företag', steps: 'Betalningar → Filöverföring → välj Bankgiro LB → ladda upp och attestera.' },
    { bank: 'Handelsbanken', steps: 'Betala → Filimport → välj LB → kontrollera summor → signera.' },
    { bank: 'Nordea Företag', steps: 'Filimport → Bankgiro LB → ladda upp → attestera betalningen.' },
  ],
  pain001: [
    { bank: 'SEB', steps: 'Betalningar → Importera SEPA / ISO 20022 (pain.001) → ladda upp och signera.' },
    { bank: 'Handelsbanken', steps: 'Betala → Filimport → ISO 20022 → välj pain.001.' },
    { bank: 'Nordea', steps: 'Filimport → Format pain.001.001.03 → ladda upp → attestera.' },
  ],
}

export function PaymentFilePanel({
  salaryRunId,
  periodLabel,
  paymentFileFormat,
  paymentFileGeneratedAt,
  defaultFormat,
  readOnly,
  onDownloaded,
}: PaymentFilePanelProps) {
  const { toast } = useToast()
  const [format, setFormat] = useState<PaymentFormat>(defaultFormat)
  const [downloading, setDownloading] = useState(false)
  const [showInstructions, setShowInstructions] = useState(false)

  const endpoint =
    format === 'bg_lb'
      ? `/api/salary/runs/${salaryRunId}/payment/bg-lb`
      : `/api/salary/runs/${salaryRunId}/payment/pain001`

  async function handleDownload() {
    setDownloading(true)
    try {
      const res = await fetch(endpoint)
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
      const ext = format === 'bg_lb' ? 'txt' : 'xml'
      a.download = `lon_${periodLabel}.${ext}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast({ title: 'Betalfil nedladdad' })
      onDownloaded?.()
    } finally {
      setDownloading(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Betalfil till bank</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {paymentFileFormat && paymentFileGeneratedAt && (
          <div className="flex items-start gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 mt-0.5 text-success" />
            <div>
              Senast genererad:{' '}
              <span className="text-foreground">
                {FORMAT_LABEL[paymentFileFormat as PaymentFormat] ?? paymentFileFormat}
              </span>{' '}
              ({new Date(paymentFileGeneratedAt).toLocaleString('sv-SE')})
            </div>
          </div>
        )}

        {!readOnly && (
          <>
            <div className="space-y-1">
              <label className="text-sm font-medium">Format</label>
              <Select value={format} onValueChange={(v) => setFormat(v as PaymentFormat)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bg_lb">{FORMAT_LABEL.bg_lb}</SelectItem>
                  <SelectItem value="pain001">{FORMAT_LABEL.pain001}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{FORMAT_DESCRIPTION[format]}</p>
            </div>

            <div className="flex justify-end">
              <Button onClick={handleDownload} disabled={downloading}>
                {downloading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Download className="mr-2 h-4 w-4" />
                )}
                Ladda ner betalfil
              </Button>
            </div>

            <button
              type="button"
              onClick={() => setShowInstructions(s => !s)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              aria-expanded={showInstructions}
            >
              <ChevronDown className={`h-3 w-3 transition-transform ${showInstructions ? 'rotate-180' : ''}`} />
              Så importerar du filen i din bank
            </button>

            {showInstructions && (
              <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-xs">
                {BANK_INSTRUCTIONS[format].map(b => (
                  <div key={b.bank}>
                    <strong className="text-foreground">{b.bank}.</strong>{' '}
                    <span className="text-muted-foreground">{b.steps}</span>
                  </div>
                ))}
                <p className="pt-1 text-muted-foreground border-t mt-2">
                  Beloppen är förifyllda: kvar är att signera med BankID i banken.
                </p>
              </div>
            )}

            <div className="flex items-start gap-2 rounded-md border border-dashed bg-muted/20 p-3 text-xs text-muted-foreground">
              <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                <strong className="text-foreground">Open Payments / direktbetalning</strong> via PSD2 (utan filimport)
                är planerat för framtiden via Enable Banking. Initiering kräver separat PIS-avtal: vi följer upp när
                tillräckligt många kunder använder lönebetalfiler regelbundet.
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
