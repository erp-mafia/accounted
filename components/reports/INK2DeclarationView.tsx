'use client'

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Download, AlertCircle, Info } from 'lucide-react'
import { AccountNumber } from '@/components/ui/account-number'
import { formatCurrency } from '@/lib/utils'
import type { INK2Declaration, INK2RSRUCode } from '@/lib/reports/ink2/types'
import {
  INK2R_RUTA_LABELS,
  INK2R_ASSET_CODES,
  INK2R_EQUITY_LIABILITY_CODES,
  INK2R_INCOME_CODES,
} from '@/lib/reports/ink2/types'

export function INK2DeclarationView({ periodId }: { periodId: string }) {
  const [data, setData] = useState<INK2Declaration | null>(null)
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchDeclaration = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/reports/ink2?period_id=${periodId}`)
      const result = await res.json()
      if (result.error) {
        setError(result.error)
      } else {
        setData(result.data)
      }
    } catch {
      setError('Kunde inte hämta INK2-deklaration')
    } finally {
      setLoading(false)
    }
  }

  const downloadSRU = async () => {
    setDownloading(true)
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
      setError('Kunde inte ladda ner SRU-filer')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Info card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">INK2 (Aktiebolag)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-2 mb-4 p-3 bg-primary/10 rounded-md">
            <Info className="h-4 w-4 text-primary mt-0.5 shrink-0" />
            <div className="text-sm text-primary space-y-1">
              <p>
                INK2 visar det bokföringsmässiga resultatet baserat på din bokföring.
                Skattemässiga justeringar (ej avdragsgilla kostnader, periodiseringsfonder m.m.)
                hanteras av din revisor/redovisningskonsult.
              </p>
              <p>
                SRU-filen laddas ner som en ZIP med INFO.SRU och BLANKETTER.SRU.
                Ladda upp båda filerna till{' '}
                <a
                  href="https://www1.skatteverket.se/fv/fv_web/start.do"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  Skatteverkets filöverföringstjänst
                </a>.
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={fetchDeclaration} disabled={loading}>
              {loading ? 'Laddar...' : 'Hämta INK2'}
            </Button>
            {data && (
              <Button variant="outline" onClick={downloadSRU} disabled={downloading}>
                <Download className="h-4 w-4 mr-2" />
                {downloading ? 'Laddar ner...' : 'Ladda ner SRU-filer'}
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
              <CardTitle>
                {data.companyInfo.companyName}
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                {data.fiscalYear.name}
                {data.companyInfo.orgNumber && ` · Org.nr: ${data.companyInfo.orgNumber}`}
              </p>
            </CardHeader>
          </Card>

          {/* Assets section */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Tillgångar</CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <tbody>
                  {INK2R_ASSET_CODES.map((code) => (
                    <INK2DeclarationRow
                      key={code}
                      code={code}
                      label={INK2R_RUTA_LABELS[code]}
                      amount={data.ink2r[code]}
                      accounts={data.breakdown[code]?.accounts || []}
                    />
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 font-semibold">
                    <td className="py-2">Summa tillgångar</td>
                    <td className="py-2 text-right tabular-nums">
                      {formatCurrency(data.totals.totalAssets)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </CardContent>
          </Card>

          {/* Equity & Liabilities section */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Eget kapital och skulder</CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <tbody>
                  {INK2R_EQUITY_LIABILITY_CODES.map((code) => (
                    <INK2DeclarationRow
                      key={code}
                      code={code}
                      label={INK2R_RUTA_LABELS[code]}
                      amount={data.ink2r[code]}
                      accounts={data.breakdown[code]?.accounts || []}
                    />
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 font-semibold">
                    <td className="py-2">Summa eget kapital och skulder</td>
                    <td className="py-2 text-right tabular-nums">
                      {formatCurrency(data.totals.totalEquityLiabilities)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </CardContent>
          </Card>

          {/* Income Statement section */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Resultaträkning</CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <tbody>
                  {INK2R_INCOME_CODES.map((code) => (
                    <INK2DeclarationRow
                      key={code}
                      code={code}
                      label={INK2R_RUTA_LABELS[code]}
                      amount={data.ink2r[code]}
                      accounts={data.breakdown[code]?.accounts || []}
                    />
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t font-medium">
                    <td className="py-2">Rörelseresultat</td>
                    <td className={`py-2 text-right ${data.totals.operatingResult >= 0 ? 'text-success' : 'text-destructive'}`}>
                      {formatCurrency(data.totals.operatingResult)}
                    </td>
                  </tr>
                  <tr className="border-t-2 font-semibold">
                    <td className="py-2">Årets resultat</td>
                    <td className={`py-2 text-right ${data.totals.resultAfterFinancial >= 0 ? 'text-success' : 'text-destructive'}`}>
                      {formatCurrency(data.totals.resultAfterFinancial)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </CardContent>
          </Card>

          {/* INK2S summary */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">INK2S: Skattemässiga justeringar</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-start gap-2 mb-4 p-3 bg-primary/10 rounded-md">
                <Info className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                <p className="text-sm text-primary">
                  Grundläggande justeringar beräknas automatiskt. Manuella justeringar
                  (periodiseringsfonder, koncernbidrag m.m.) hanteras av din redovisningskonsult.
                </p>
              </div>
              <table className="w-full text-sm">
                <tbody>
                  <tr className="border-b">
                    <td className="py-2">
                      <span className="font-mono text-xs bg-muted px-1 rounded mr-2">4.1</span>
                      Årets resultat (vinst)
                    </td>
                    <td className="py-2 text-right">{formatCurrency(data.ink2s['7650'])}</td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2">
                      <span className="font-mono text-xs bg-muted px-1 rounded mr-2">4.2</span>
                      Årets resultat (förlust)
                    </td>
                    <td className="py-2 text-right">{formatCurrency(data.ink2s['7750'])}</td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2">
                      <span className="font-mono text-xs bg-muted px-1 rounded mr-2">4.3a</span>
                      Skatt på årets resultat (ej avdragsgill)
                    </td>
                    <td className="py-2 text-right">{formatCurrency(data.ink2s['7651'])}</td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr className="border-t-2 font-semibold">
                    <td className="py-2">
                      {data.ink2s['8020'] > 0 ? 'Överskott (punkt 1.1)' : 'Underskott (punkt 1.2)'}
                    </td>
                    <td className={`py-2 text-right ${data.ink2s['8020'] > 0 ? 'text-success' : 'text-destructive'}`}>
                      {formatCurrency(data.ink2s['8020'] > 0 ? data.ink2s['8020'] : data.ink2s['8021'])}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </CardContent>
          </Card>
        </>
      )}

      {!data && !loading && !error && (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            Klicka &quot;Hämta INK2&quot; för att generera deklarationsunderlaget.
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function INK2DeclarationRow({
  code,
  label,
  amount,
  accounts,
}: {
  code: INK2RSRUCode
  label: string
  amount: number
  accounts: Array<{ accountNumber: string; accountName: string; amount: number }>
}) {
  const [expanded, setExpanded] = useState(false)

  if (amount === 0 && accounts.length === 0) return null

  return (
    <>
      <tr
        className="border-b cursor-pointer hover:bg-muted/50"
        onClick={() => accounts.length > 0 && setExpanded(!expanded)}
      >
        <td className="py-2">
          <span className="font-mono text-xs bg-muted px-1 rounded mr-2">{code}</span>
          {label}
          {accounts.length > 0 && (
            <span className="text-xs text-muted-foreground ml-2">
              ({accounts.length} konton)
            </span>
          )}
        </td>
        <td className="py-2 text-right tabular-nums">
          {formatCurrency(amount)}
        </td>
      </tr>
      {expanded && accounts.length > 0 && (
        <tr>
          <td colSpan={2} className="py-2 pl-8 bg-muted/30">
            <table className="w-full text-xs">
              <tbody>
                {accounts.map((acc) => (
                  <tr key={acc.accountNumber}>
                    <td className="py-1">
                      <AccountNumber number={acc.accountNumber} name={acc.accountName} size="sm" />
                    </td>
                    <td className="py-1">{acc.accountName}</td>
                    <td className="py-1 text-right tabular-nums">
                      {formatCurrency(acc.amount)}
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
