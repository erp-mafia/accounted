'use client'

import { useEffect, useState } from 'react'
import { useLocale } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  ArrowDownTrayIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
} from '@/components/icons'
import {
  DeclarationRutaRow,
  formatWholeKronor,
} from '@/components/reports/DeclarationRutaRow'
import { ReportExportMenu } from '@/components/reports/ReportExportMenu'
import type { INK2Declaration } from '@/lib/reports/ink2/types'
import {
  INK2R_RUTA_LABELS,
  INK2R_ASSET_CODES,
  INK2R_EQUITY_LIABILITY_CODES,
  INK2R_INCOME_CODES,
} from '@/lib/reports/ink2/types'
import { downloadFile, RENDERED_DOWNLOAD_TIMEOUT_MS } from '@/lib/browser/download-file'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'

export function INK2DeclarationView({ periodId }: { periodId: string }) {
  const errorLocale = useLocale() as ErrorLocale
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
            error: getErrorMessage(json, { locale: errorLocale, fallback: 'Kunde inte hämta INK2-deklaration' }),
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
  }, [fetchKey, periodId, errorLocale])

  const upToDate = result !== null && result.key === fetchKey
  const data = result?.data ?? null
  const error = upToDate ? (result.error ?? null) : null
  const loading = fetchKey !== null && !upToDate

  const downloadSRU = async () => {
    setDownloading(true)
    setDownloadError(null)
    try {
      const result = await downloadFile({
        url: `/api/reports/ink2?period_id=${periodId}&format=sru`,
        filename: 'INK2_SRU.zip',
        preferServerFilename: true,
        timeoutMs: RENDERED_DOWNLOAD_TIMEOUT_MS,
      })
      if (!result.ok) {
        setDownloadError(result.reason === 'server' ? result.message : 'Kunde inte ladda ner SRU-filer')
      }
    } catch {
      setDownloadError('Kunde inte ladda ner SRU-filer')
    } finally {
      setDownloading(false)
    }
  }

  if (error) {
    return (
      <div className="flex flex-wrap items-center gap-3 py-4 text-destructive">
        <ExclamationCircleIcon className="h-4 w-4 shrink-0" />
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
      {/* The filing artifact sits in the report shell's toolbar slot beside
          the other reports' exports. The page title, year picker and the
          "?" with the filing steps (Ink2FilingHelp) live in the top bar, so
          no second title block here; company and org.nr print on paper via
          ReportPrintHeader. */}
      <ReportExportMenu>
        <Button size="sm" variant="outline" onClick={downloadSRU} loading={downloading}>
          {!downloading && <ArrowDownTrayIcon className="h-4 w-4 mr-2" />}
          Ladda ner SRU-filer
        </Button>
      </ReportExportMenu>
      {downloadError && (
        <div role="alert" className="flex items-start gap-2 px-1 text-sm text-destructive">
          <ExclamationCircleIcon className="h-4 w-4 mt-1 shrink-0" />
          {downloadError}
        </div>
      )}

      {/* Warnings */}
      {data.warnings.length > 0 && (
        <div className="flex items-start gap-2 px-1">
          <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-attn" aria-hidden="true" />
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

      {/* Assets section */}
      <section>
        <div className="mb-1 flex items-center gap-2 px-1">
          <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">Tillgångar</h3>
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
        </div>
      </section>

      {/* Equity & Liabilities section */}
      <section>
        <div className="mb-1 flex items-center gap-2 px-1">
          <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">Eget kapital och skulder</h3>
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
        </div>
      </section>

      {/* Income Statement section */}
      <section>
        <div className="mb-1 flex items-center gap-2 px-1">
          <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">Resultaträkning</h3>
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
                    data.totals.aretsResultat >= 0 ? 'text-success' : 'text-destructive'
                  }`}
                >
                  {formatWholeKronor(data.totals.aretsResultat)}
                </td>
              </tr>
            </tfoot>
          </Table>
        </div>
      </section>

      {/* INK2S summary */}
      <section>
        <div className="mb-1 flex items-center gap-2 px-1">
          <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">INK2S: Skattemässiga justeringar</h3>
          <div className="h-px flex-1 bg-border/60" />
        </div>
        <div className="px-1 pt-2">
          <p className="text-sm text-muted-foreground mb-4">
            Grundläggande justeringar och de återläggningar som sparats i bokslutet
            beräknas automatiskt. Kontrollera övriga deklarationsjusteringar med din
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
              <DeclarationRutaRow
                code="4.3c"
                label="Andra ej avdragsgilla kostnader"
                amount={data.ink2s['7653']}
              />
              <DeclarationRutaRow
                code="4.5c"
                label="Andra ej skattepliktiga intäkter"
                amount={data.ink2s['7754']}
              />
              <DeclarationRutaRow
                code="4.14a"
                label="Outnyttjat underskott från föregående beskattningsår"
                amount={data.ink2s['7763']}
              />
            </TableBody>
            <tfoot>
              <tr className="border-t font-medium">
                <td className="py-2">
                  {data.ink2s['7670'] > 0 ? 'Överskott (punkt 1.1)' : 'Underskott (punkt 1.2)'}
                </td>
                <td
                  className={`py-2 text-right tabular-nums ${
                    data.ink2s['7670'] > 0 ? 'text-success' : 'text-destructive'
                  }`}
                >
                  {formatWholeKronor(
                    data.ink2s['7670'] > 0 ? data.ink2s['7670'] : data.ink2s['7770']
                  )}
                </td>
              </tr>
            </tfoot>
          </Table>
        </div>
      </section>
    </div>
  )
}
