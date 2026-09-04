'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Download, AlertCircle, AlertTriangle } from 'lucide-react'
import {
  DeclarationRutaRow,
  formatWholeKronor,
} from '@/components/reports/DeclarationRutaRow'
import type { NEDeclaration } from '@/lib/reports/ne-bilaga/types'
import { parseApiError } from './api-error'

export function NEDeclarationView({ periodId }: { periodId: string }) {
  // Fetch outcome tagged with the key it was requested under: switching
  // fiscal year discards stale responses instead of leaving last year's
  // declaration on screen (same pattern as the momsdeklaration view).
  const [result, setResult] = useState<{
    key: string
    data?: NEDeclaration
    error?: string
  } | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  const fetchKey = periodId ? `${periodId}:${retryKey}` : null

  useEffect(() => {
    if (!fetchKey || !periodId) return
    let cancelled = false
    fetch(`/api/reports/ne-bilaga?period_id=${periodId}`)
      .then(async (res) => {
        const json = await res.json().catch(() => null)
        if (cancelled) return
        if (!res.ok || json?.error) {
          setResult({
            key: fetchKey,
            error: parseApiError(json?.error, 'Kunde inte hämta NE-bilaga'),
          })
        } else {
          setResult({ key: fetchKey, data: json.data })
        }
      })
      .catch(() => {
        if (!cancelled) setResult({ key: fetchKey, error: 'Kunde inte hämta NE-bilaga' })
      })
    return () => {
      cancelled = true
    }
  }, [fetchKey, periodId])

  const upToDate = result !== null && result.key === fetchKey
  const data = result?.data ?? null
  const error = upToDate ? (result.error ?? null) : null
  const loading = fetchKey !== null && !upToDate

  const downloadSRU = async () => {
    setDownloading(true)
    setDownloadError(null)
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
      setDownloadError('Kunde inte ladda ner SRU-filer')
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

  if (error) {
    return (
      <div className="flex flex-wrap items-center gap-3 py-4 text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span className="text-sm">{error}</span>
        <Button variant="outline" onClick={() => setRetryKey((k) => k + 1)}>
          Försök igen
        </Button>
      </div>
    )
  }

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-64" />
      </div>
    )
  }

  if (!data) return null

  return (
    <div
      className={`space-y-8 transition-opacity duration-150 ${loading ? 'opacity-60' : ''}`}
    >
      {/* Header: company, year, and the filing artifact */}
      <div className="px-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-sans text-sm font-medium">NE-bilaga (Enskild firma)</h3>
              <p className="text-sm text-muted-foreground mt-1">
                {data.companyInfo.companyName} · {data.fiscalYear.name}
                {data.companyInfo.orgNumber && ` · Org.nr: ${data.companyInfo.orgNumber}`}
              </p>
            </div>
            <Button variant="outline" onClick={downloadSRU} disabled={downloading}>
              <Download className="h-4 w-4 mr-2" />
              {downloading ? 'Laddar ner...' : 'Ladda ner SRU-fil'}
            </Button>
          </div>
          {downloadError && (
            <div role="alert" className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 mt-1 shrink-0" />
              {downloadError}
            </div>
          )}
      </div>

      {/* Warnings */}
      {data.warnings.length > 0 && (
        <div className="flex items-start gap-2 px-1">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-attn" aria-hidden="true" />
          <div className="space-y-1">
            <p className="text-[12.5px] font-medium leading-5 text-attn">
              {data.warnings.length}{' '}
              {data.warnings.length === 1 ? 'varning' : 'varningar'}
            </p>
            {data.warnings.map((warning, i) => (
              <p key={i} className="text-[12.5px] leading-5 text-muted-foreground">{warning}</p>
            ))}
          </div>
        </div>
      )}

      {/* Revenue section */}
      <section>
        <div className="mb-1 flex items-center gap-2 px-1">
          <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">Intäkter</h3>
          <div className="h-px flex-1 bg-border/60" />
        </div>
        <div className="px-1 pt-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-0">Post</TableHead>
                <TableHead className="px-0 text-right">Belopp</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {revenueRutor.map((ruta) => (
                <DeclarationRutaRow
                  key={ruta}
                  code={ruta}
                  label={rutaLabels[ruta]}
                  amount={data.rutor[ruta]}
                  accounts={data.breakdown[ruta]?.accounts || []}
                />
              ))}
            </TableBody>
            <tfoot>
              <tr className="border-t font-medium">
                <td className="py-2">Summa intäkter</td>
                <td className="py-2 text-right tabular-nums">
                  {formatWholeKronor(
                    data.rutor.R1 + data.rutor.R2 + data.rutor.R3 + data.rutor.R4
                  )}
                </td>
              </tr>
            </tfoot>
          </Table>
        </div>
      </section>

      {/* Expenses section */}
      <section>
        <div className="mb-1 flex items-center gap-2 px-1">
          <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">Kostnader</h3>
          <div className="h-px flex-1 bg-border/60" />
        </div>
        <div className="px-1 pt-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-0">Post</TableHead>
                <TableHead className="px-0 text-right">Belopp</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {expenseRutor.map((ruta) => (
                // Costs display negated: the signed value keeps its true sign
                // when an expense ruta carries a credit balance.
                <DeclarationRutaRow
                  key={ruta}
                  code={ruta}
                  label={rutaLabels[ruta]}
                  amount={-data.rutor[ruta]}
                  accounts={(data.breakdown[ruta]?.accounts || []).map((acc) => ({
                    ...acc,
                    amount: -acc.amount,
                  }))}
                />
              ))}
            </TableBody>
            <tfoot>
              <tr className="border-t font-medium">
                <td className="py-2">Summa kostnader</td>
                <td className="py-2 text-right tabular-nums">
                  {formatWholeKronor(
                    -(data.rutor.R5 + data.rutor.R6 + data.rutor.R7 +
                      data.rutor.R8 + data.rutor.R9 + data.rutor.R10)
                  )}
                </td>
              </tr>
            </tfoot>
          </Table>
        </div>
      </section>

      {/* Result: the emphasized document foot (house skv-foot idiom). */}
      <div className="flex items-baseline gap-3 border-t-2 border-foreground/80 px-1 pt-3">
        <span className="font-mono text-xs text-muted-foreground">R11</span>
        <span className="flex-1 text-sm font-medium">Årets resultat</span>
        <span
          className={`text-sm font-semibold tabular-nums ${
            data.rutor.R11 >= 0 ? '' : 'text-destructive'
          }`}
        >
          {formatWholeKronor(data.rutor.R11)}
        </span>
      </div>
    </div>
  )
}
