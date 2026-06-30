'use client'

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Download, AlertCircle } from 'lucide-react'
import { AccountNumber } from '@/components/ui/account-number'
import type { NEDeclaration } from '@/lib/reports/ne-bilaga/types'
import { formatCurrency } from '@/lib/utils'

export function NEDeclarationView({ periodId }: { periodId: string }) {
  const [data, setData] = useState<NEDeclaration | null>(null)
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchDeclaration = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/reports/ne-bilaga?period_id=${periodId}`)
      const result = await res.json()
      if (result.error) {
        setError(result.error)
      } else {
        setData(result.data)
      }
    } catch {
      setError('Kunde inte hämta NE-bilaga')
    } finally {
      setLoading(false)
    }
  }

  const downloadSRU = async () => {
    setDownloading(true)
    try {
      const res = await fetch(`/api/reports/ne-bilaga?period_id=${periodId}&format=sru`)
      if (!res.ok) throw new Error('Download failed')
      const blob = await res.blob()
      const filename = res.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] || 'NE_SRU.zip'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      setError('Kunde inte ladda ner SRU-filer')
    } finally {
      setDownloading(false)
    }
  }

  // NE ruta labels
  const rutaLabels: Record<string, string> = {
    R1: 'Försäljning med moms (25%)',
    R2: 'Momsfria intäkter',
    R3: 'Bil/bostadsförmån',
    R4: 'Ränteintäkter',
    R5: 'Varuinköp',
    R6: 'Övriga kostnader',
    R7: 'Lönekostnader',
    R8: 'Räntekostnader',
    R9: 'Avskrivningar fastighet',
    R10: 'Avskrivningar övriga tillgångar',
    R11: 'Årets resultat',
  }

  // Categorize rutor
  const revenueRutor = ['R1', 'R2', 'R3', 'R4'] as const
  const expenseRutor = ['R5', 'R6', 'R7', 'R8', 'R9', 'R10'] as const

  return (
    <div className="space-y-4">
      {/* Info card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">NE-bilaga (Enskild firma)</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            NE-bilagan används för att deklarera resultat från enskild näringsverksamhet.
            Uppgifterna hämtas från bokföringen för valt räkenskapsår.
          </p>
          <div className="flex gap-2">
            <Button onClick={fetchDeclaration} disabled={loading}>
              {loading ? 'Laddar...' : 'Hämta NE-bilaga'}
            </Button>
            {data && (
              <Button variant="outline" onClick={downloadSRU} disabled={downloading}>
                <Download className="h-4 w-4 mr-2" />
                {downloading ? 'Laddar ner...' : 'Ladda ner SRU-fil'}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card>
          <CardContent className="p-8 text-center text-destructive">
            <AlertCircle className="h-6 w-6 mx-auto mb-2" />
            {error}
          </CardContent>
        </Card>
      )}

      {data && (
        <>
          {/* Warnings */}
          {data.warnings.length > 0 && (
            <Card className="border-border">
              <CardContent className="py-4">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-5 w-5 text-warning mt-0.5" />
                  <div>
                    {data.warnings.map((warning, i) => (
                      <p key={i} className="text-sm text-foreground">{warning}</p>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Company info */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>
                  {data.companyInfo.companyName}
                </CardTitle>
                <Badge variant="secondary">
                  {data.fiscalYear.name}
                </Badge>
              </div>
              {data.companyInfo.orgNumber && (
                <p className="text-sm text-muted-foreground">
                  Org.nr: {data.companyInfo.orgNumber}
                </p>
              )}
            </CardHeader>
          </Card>

          {/* Revenue section */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Intäkter</CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <tbody>
                  {revenueRutor.map((ruta) => {
                    const value = data.rutor[ruta]
                    const breakdown = data.breakdown[ruta]
                    return (
                      <NEDeclarationRow
                        key={ruta}
                        ruta={ruta}
                        label={rutaLabels[ruta]}
                        amount={value}
                        accounts={breakdown?.accounts || []}
                      />
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 font-semibold">
                    <td className="py-2">Summa intäkter</td>
                    <td className="py-2 text-right tabular-nums">
                      {formatCurrency(
                        data.rutor.R1 + data.rutor.R2 + data.rutor.R3 + data.rutor.R4
                      )}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </CardContent>
          </Card>

          {/* Expenses section */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Kostnader</CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <tbody>
                  {expenseRutor.map((ruta) => {
                    const value = data.rutor[ruta]
                    const breakdown = data.breakdown[ruta]
                    return (
                      <NEDeclarationRow
                        key={ruta}
                        ruta={ruta}
                        label={rutaLabels[ruta]}
                        amount={value}
                        accounts={breakdown?.accounts || []}
                        isExpense
                      />
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 font-semibold">
                    <td className="py-2">Summa kostnader</td>
                    <td className="py-2 text-right tabular-nums">
                      -{formatCurrency(
                        data.rutor.R5 + data.rutor.R6 + data.rutor.R7 +
                        data.rutor.R8 + data.rutor.R9 + data.rutor.R10
                      )}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </CardContent>
          </Card>

          {/* Result */}
          <Card className="border-2">
            <CardContent className="py-4">
              <div className="flex justify-between items-center">
                <div>
                  <span className="font-mono text-xs bg-muted px-1 rounded mr-2">R11</span>
                  <span className="font-display text-xl">Årets resultat</span>
                </div>
                <span
                  className={`font-display text-2xl tabular-nums ${
                    data.rutor.R11 >= 0 ? 'text-success' : 'text-destructive'
                  }`}
                >
                  {formatCurrency(data.rutor.R11)}
                </span>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {!data && !loading && !error && (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            Klicka &quot;Hämta NE-bilaga&quot; för att generera deklarationsunderlaget.
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function NEDeclarationRow({
  ruta,
  label,
  amount,
  accounts,
  isExpense,
}: {
  ruta: string
  label: string
  amount: number
  accounts: Array<{ accountNumber: string; accountName: string; amount: number }>
  isExpense?: boolean
}) {
  const [expanded, setExpanded] = useState(false)

  // Don't show rows with zero values
  if (amount === 0 && accounts.length === 0) return null

  return (
    <>
      <tr
        className="border-b cursor-pointer hover:bg-muted/50"
        onClick={() => accounts.length > 0 && setExpanded(!expanded)}
      >
        <td className="py-2">
          <span className="font-mono text-xs bg-muted px-1 rounded mr-2">{ruta}</span>
          {label}
          {accounts.length > 0 && (
            <span className="text-xs text-muted-foreground ml-2">
              ({accounts.length} konton)
            </span>
          )}
        </td>
        <td className="py-2 text-right tabular-nums">
          {isExpense && amount > 0 ? '-' : ''}{formatCurrency(Math.abs(amount))}
        </td>
      </tr>
      {expanded && accounts.length > 0 && (
        <tr>
          <td colSpan={2} className="py-2 pl-8 bg-muted/30">
            <table className="w-full text-xs">
              <tbody>
                {accounts.map((acc) => (
                  <tr key={acc.accountNumber}>
                    <td className="py-1"><AccountNumber number={acc.accountNumber} name={acc.accountName} size="sm" /></td>
                    <td className="py-1">{acc.accountName}</td>
                    <td className="py-1 text-right">
                      {isExpense && acc.amount > 0 ? '-' : ''}{formatCurrency(Math.abs(acc.amount))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  )
}
