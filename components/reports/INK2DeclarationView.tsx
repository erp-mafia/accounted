'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Download, AlertCircle, AlertTriangle, Info } from 'lucide-react'
import {
  DeclarationRutaRow,
  formatWholeKronor,
} from '@/components/reports/DeclarationRutaRow'
import type { INK2Declaration } from '@/lib/reports/ink2/types'
import {
  INK2R_RUTA_LABELS,
  INK2R_ASSET_CODES,
  INK2R_EQUITY_LIABILITY_CODES,
  INK2R_INCOME_CODES,
} from '@/lib/reports/ink2/types'

/** API errors may be a plain string or the canonical { code, message } envelope. */
function parseApiError(error: unknown, fallback: string): string {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return fallback
}

export function INK2DeclarationView({ periodId }: { periodId: string }) {
  // Fetch outcome tagged with the key it was requested under: switching
  // fiscal year discards stale responses instead of leaving last year's
  // declaration on screen (same pattern as the momsdeklaration view).
  const [result, setResult] = useState<{
    key: string
    data?: INK2Declaration
    error?: string
  } | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  const fetchKey = periodId ? `${periodId}:${retryKey}` : null

  useEffect(() => {
    if (!fetchKey || !periodId) return
    let cancelled = false
    fetch(`/api/reports/ink2?period_id=${periodId}`)
      .then(async (res) => {
        const json = await res.json().catch(() => null)
        if (cancelled) return
        if (!res.ok || json?.error) {
          setResult({
            key: fetchKey,
            error: parseApiError(json?.error, 'Kunde inte hämta INK2-deklaration'),
          })
        } else {
          setResult({ key: fetchKey, data: json.data })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResult({ key: fetchKey, error: 'Kunde inte hämta INK2-deklaration' })
        }
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
      const res = await fetch(`/api/reports/ink2?period_id=${periodId}&format=sru`)
      if (!res.ok) throw new Error('Download failed')
      const blob = await res.blob()
      const filename = res.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] || 'INK2_SRU.zip'
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

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 flex flex-wrap items-center gap-3 text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="text-sm">{error}</span>
          <Button variant="outline" onClick={() => setRetryKey((k) => k + 1)}>
            Försök igen
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (loading && !data) {
    return (
      <Card>
        <CardContent className="p-6 space-y-4">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-64" />
        </CardContent>
      </Card>
    )
  }

  if (!data) return null

  return (
    <div
      className={`space-y-8 transition-opacity duration-150 ${loading ? 'opacity-60' : ''}`}
    >
      {/* Header: company, year, filing artifact, and how to file it */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">INK2 (Aktiebolag)</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                {data.companyInfo.companyName} · {data.fiscalYear.name}
                {data.companyInfo.orgNumber && ` · Org.nr: ${data.companyInfo.orgNumber}`}
              </p>
            </div>
            <Button variant="outline" onClick={downloadSRU} disabled={downloading}>
              <Download className="h-4 w-4 mr-2" />
              {downloading ? 'Laddar ner...' : 'Ladda ner SRU-filer'}
            </Button>
          </div>
          {downloadError && (
            <div role="alert" className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 mt-1 shrink-0" />
              {downloadError}
            </div>
          )}
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3">
            <Info className="h-4 w-4 mt-1 shrink-0 text-muted-foreground" />
            <div className="text-sm text-muted-foreground space-y-2">
              <p>
                INK2 visar det bokföringsmässiga resultatet baserat på din bokföring.
              </p>
              <ol className="list-decimal pl-6 space-y-1">
                <li>Ladda ner SRU-filerna (en ZIP med INFO.SRU och BLANKETTER.SRU).</li>
                <li>
                  Ladda upp båda filerna till{' '}
                  <a
                    href="https://www1.skatteverket.se/fv/fv_web/start.do"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-2 text-foreground"
                  >
                    Skatteverkets filöverföringstjänst
                  </a>.
                </li>
              </ol>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Warnings */}
      {data.warnings.length > 0 && (
        <Card>
          <CardContent className="py-4">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-1 shrink-0 text-warning" />
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {data.warnings.length}{' '}
                  {data.warnings.length === 1 ? 'varning' : 'varningar'}
                </p>
                {data.warnings.map((warning, i) => (
                  <p key={i} className="text-sm text-muted-foreground">{warning}</p>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Assets section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tillgångar</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-0">Post</TableHead>
                <TableHead className="px-0 text-right">Belopp</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {INK2R_ASSET_CODES.map((code) => (
                <DeclarationRutaRow
                  key={code}
                  code={code}
                  label={INK2R_RUTA_LABELS[code]}
                  amount={data.ink2r[code]}
                  accounts={data.breakdown[code]?.accounts || []}
                />
              ))}
            </TableBody>
            <tfoot>
              <tr className="border-t font-medium">
                <td className="py-2">Summa tillgångar</td>
                <td className="py-2 text-right tabular-nums">
                  {formatWholeKronor(data.totals.totalAssets)}
                </td>
              </tr>
            </tfoot>
          </Table>
        </CardContent>
      </Card>

      {/* Equity & Liabilities section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Eget kapital och skulder</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-0">Post</TableHead>
                <TableHead className="px-0 text-right">Belopp</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {INK2R_EQUITY_LIABILITY_CODES.map((code) => (
                <DeclarationRutaRow
                  key={code}
                  code={code}
                  label={INK2R_RUTA_LABELS[code]}
                  amount={data.ink2r[code]}
                  accounts={data.breakdown[code]?.accounts || []}
                />
              ))}
            </TableBody>
            <tfoot>
              <tr className="border-t font-medium">
                <td className="py-2">Summa eget kapital och skulder</td>
                <td className="py-2 text-right tabular-nums">
                  {formatWholeKronor(data.totals.totalEquityLiabilities)}
                </td>
              </tr>
            </tfoot>
          </Table>
        </CardContent>
      </Card>

      {/* Income Statement section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Resultaträkning</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-0">Post</TableHead>
                <TableHead className="px-0 text-right">Belopp</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {INK2R_INCOME_CODES.map((code) => (
                <DeclarationRutaRow
                  key={code}
                  code={code}
                  label={INK2R_RUTA_LABELS[code]}
                  amount={data.ink2r[code]}
                  accounts={data.breakdown[code]?.accounts || []}
                />
              ))}
            </TableBody>
            <tfoot>
              <tr className="border-t font-medium">
                <td className="py-2">Rörelseresultat</td>
                <td
                  className={`py-2 text-right tabular-nums ${
                    data.totals.operatingResult >= 0 ? 'text-success' : 'text-destructive'
                  }`}
                >
                  {formatWholeKronor(data.totals.operatingResult)}
                </td>
              </tr>
              <tr className="border-t font-medium">
                <td className="py-2">Årets resultat</td>
                <td
                  className={`py-2 text-right tabular-nums ${
                    data.totals.resultAfterFinancial >= 0 ? 'text-success' : 'text-destructive'
                  }`}
                >
                  {formatWholeKronor(data.totals.resultAfterFinancial)}
                </td>
              </tr>
            </tfoot>
          </Table>
        </CardContent>
      </Card>

      {/* INK2S summary */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">INK2S: Skattemässiga justeringar</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            Grundläggande justeringar beräknas automatiskt. Manuella justeringar
            (periodiseringsfonder, koncernbidrag m.m.) hanteras av din
            redovisningskonsult.
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-0">Post</TableHead>
                <TableHead className="px-0 text-right">Belopp</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {/* At most one of 4.1/4.2 is nonzero: render only that one. A
                  zero-result year has both at 0, so both render then, or the
                  table would be nothing but its total row. */}
              <DeclarationRutaRow
                code="4.1"
                label="Årets resultat (vinst)"
                amount={data.ink2s['7650']}
                hideWhenZero={data.ink2s['7750'] !== 0}
              />
              <DeclarationRutaRow
                code="4.2"
                label="Årets resultat (förlust)"
                amount={data.ink2s['7750']}
                hideWhenZero={data.ink2s['7650'] !== 0}
              />
              <DeclarationRutaRow
                code="4.3a"
                label="Skatt på årets resultat (ej avdragsgill)"
                amount={data.ink2s['7651']}
              />
            </TableBody>
            <tfoot>
              <tr className="border-t font-medium">
                <td className="py-2">
                  {data.ink2s['8020'] > 0 ? 'Överskott (punkt 1.1)' : 'Underskott (punkt 1.2)'}
                </td>
                <td
                  className={`py-2 text-right tabular-nums ${
                    data.ink2s['8020'] > 0 ? 'text-success' : 'text-destructive'
                  }`}
                >
                  {formatWholeKronor(
                    data.ink2s['8020'] > 0 ? data.ink2s['8020'] : data.ink2s['8021']
                  )}
                </td>
              </tr>
            </tfoot>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
