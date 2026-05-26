'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { AccountNumber } from '@/components/ui/account-number'
import { AlertCircle, ChevronDown, ChevronRight, Link2, Unlink, Play, Eye } from 'lucide-react'
import { formatCurrency, formatDate } from '@/lib/utils'
import { CashAccountSelector } from '@/components/common/CashAccountSelector'

function formatAmount(amount: number): string {
  return amount.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const METHOD_LABELS: Record<string, string> = {
  auto_exact: 'Exakt matchning',
  auto_date_range: 'Datumintervall',
  auto_reference: 'Referensmatchning',
  auto_fuzzy: 'Ungefärlig matchning',
  manual: 'Manuell',
}

// ============================================================
// Types
// ============================================================

interface ReconciliationStatus {
  bank_transaction_total: number
  /**
   * @deprecated Kept on the server response for back-compat. The UI no longer
   * reads it — `gl_1930_period_movement` is required.
   */
  gl_1930_balance: number
  gl_1930_period_movement: number
  gl_1930_opening_balance: number
  difference: number
  is_reconciled: boolean
  matched_count: number
  unmatched_transaction_count: number
  unmatched_gl_line_count: number
}

interface UnlinkedGLLine {
  line_id: string
  journal_entry_id: string
  debit_amount: number
  credit_amount: number
  line_description: string | null
  entry_date: string
  voucher_number: number
  voucher_series: string
  entry_description: string
  source_type: string
}

interface UnmatchedTransaction {
  id: string
  date: string
  description: string
  amount: number
  reference: string | null
  currency: string
}

interface MatchedTransaction {
  id: string
  date: string
  description: string
  amount: number
  reconciliation_method: string | null
  journal_entry_id: string | null
}

interface DryRunMatch {
  transaction_id: string
  transaction_date: string
  transaction_description: string
  transaction_amount: number
  journal_entry_id: string
  voucher_number: number
  voucher_series: string
  entry_date: string
  entry_description: string
  method: string
  confidence: number
}

// ============================================================
// Component
// ============================================================

export function BankReconciliationView() {
  const [status, setStatus] = useState<ReconciliationStatus | null>(null)
  const [unmatchedTx, setUnmatchedTx] = useState<UnmatchedTransaction[]>([])
  const [glLines, setGlLines] = useState<UnlinkedGLLine[]>([])
  const [matchedTx, setMatchedTx] = useState<MatchedTransaction[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [accountNumber, setAccountNumber] = useState('1930')

  const [dryRunResults, setDryRunResults] = useState<DryRunMatch[] | null>(null)
  const [runLoading, setRunLoading] = useState(false)
  const [applyLoading, setApplyLoading] = useState(false)
  const [linkLoading, setLinkLoading] = useState<string | null>(null)
  const [unlinkLoading, setUnlinkLoading] = useState<string | null>(null)

  const [showMatched, setShowMatched] = useState(false)
  const [selectedMatch, setSelectedMatch] = useState<Record<string, string>>({})

  const fetchAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (dateFrom) params.set('date_from', dateFrom)
      if (dateTo) params.set('date_to', dateTo)
      params.set('account_number', accountNumber)
      const qs = `?${params}`

      const [statusRes, glRes, unmatchedRes, matchedRes] = await Promise.all([
        fetch(`/api/reconciliation/bank/status${qs}`),
        fetch(`/api/reconciliation/bank/unmatched-entries${qs}`),
        fetch(`/api/transactions?unmatched=true&currency=SEK${dateFrom ? `&date_from=${dateFrom}` : ''}${dateTo ? `&date_to=${dateTo}` : ''}`),
        fetch(`/api/transactions?reconciled=true&currency=SEK${dateFrom ? `&date_from=${dateFrom}` : ''}${dateTo ? `&date_to=${dateTo}` : ''}`),
      ])

      const [statusData, glData, unmatchedData, matchedData] = await Promise.all([
        statusRes.json(),
        glRes.json(),
        unmatchedRes.json(),
        matchedRes.json(),
      ])

      if (statusData.data) setStatus(statusData.data)
      setGlLines(glData.data || [])
      setUnmatchedTx(unmatchedData.data || [])
      setMatchedTx(matchedData.data || [])
    } catch (e) {
      console.error('[reconciliation] fetchAll failed', e)
      setError('Kunde inte hämta avstämningsdata')
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo, accountNumber])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  const handleDryRun = async () => {
    setRunLoading(true)
    setDryRunResults(null)
    try {
      const res = await fetch('/api/reconciliation/bank/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
          account_number: accountNumber,
          dry_run: true,
        }),
      })
      const result = await res.json()
      if (result.data?.matches) {
        setDryRunResults(result.data.matches)
      }
    } catch {
      setError('Kunde inte köra förhandsgranskning')
    } finally {
      setRunLoading(false)
    }
  }

  const handleApply = async () => {
    setApplyLoading(true)
    try {
      await fetch('/api/reconciliation/bank/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
          account_number: accountNumber,
          dry_run: false,
        }),
      })
      setDryRunResults(null)
      await fetchAll()
    } catch {
      setError('Kunde inte tillämpa matchningar')
    } finally {
      setApplyLoading(false)
    }
  }

  const handleManualLink = async (transactionId: string) => {
    const journalEntryId = selectedMatch[transactionId]
    if (!journalEntryId) return

    setLinkLoading(transactionId)
    try {
      const res = await fetch('/api/reconciliation/bank/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transaction_id: transactionId,
          journal_entry_id: journalEntryId,
        }),
      })
      const result = await res.json()
      if (result.error) {
        setError(result.error)
      } else {
        setSelectedMatch((prev) => {
          const next = { ...prev }
          delete next[transactionId]
          return next
        })
        await fetchAll()
      }
    } catch {
      setError('Kunde inte matcha transaktion')
    } finally {
      setLinkLoading(null)
    }
  }

  const handleUnlink = async (transactionId: string) => {
    setUnlinkLoading(transactionId)
    try {
      const res = await fetch('/api/reconciliation/bank/unlink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction_id: transactionId }),
      })
      const result = await res.json()
      if (result.error) {
        setError(result.error)
      } else {
        await fetchAll()
      }
    } catch {
      setError('Kunde inte avmatcha transaktion')
    } finally {
      setUnlinkLoading(null)
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          Laddar bankavstämning...
        </CardContent>
      </Card>
    )
  }

  if (error && !status) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-destructive">
          <AlertCircle className="h-6 w-6 mx-auto mb-2" />
          {error}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {error && (
        <Card>
          <CardContent className="py-3 text-center text-destructive text-sm">
            <AlertCircle className="h-4 w-4 inline mr-1" />
            {error}
            <Button variant="ghost" size="sm" className="ml-2" onClick={() => setError(null)}>
              Stäng
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Status Card */}
      {status && (
        <Card className="border-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Avstämning mot <AccountNumber number="1930" /></CardTitle>
              {status.is_reconciled ? (
                <Badge className="bg-success/10 text-success">Avstämd</Badge>
              ) : (
                <Badge variant="destructive">Ej avstämd</Badge>
              )}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Endast konto <AccountNumber number="1930" /> ingår i denna avstämning. Övriga bankkonton (t.ex. Plusgiro <AccountNumber number="1920" />, kreditkort <AccountNumber number="1940" /> eller valutakonton) måste avstämmas separat.
            </p>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span>Banktransaktioner i perioden</span>
                <span className="font-mono">{formatCurrency(status.bank_transaction_total)}</span>
              </div>
              <div className="flex justify-between">
                <span>Bokfört på <AccountNumber number="1930" /> i perioden</span>
                <span className="font-mono">
                  {formatCurrency(status.gl_1930_period_movement)}
                </span>
              </div>
              <div className="flex justify-between pt-2 border-t font-semibold">
                <span>Differens</span>
                <span>
                  {formatCurrency(status.difference)}
                </span>
              </div>
              {status.gl_1930_opening_balance !== 0 && (
                <p className="pt-2 text-xs text-muted-foreground">
                  Ingående balans (IB) på <AccountNumber number="1930" />:{' '}
                  <span className="font-mono">{formatCurrency(status.gl_1930_opening_balance)}</span>
                  {' '}— räknas inte i avstämningen.
                </p>
              )}
              <div className="flex gap-4 pt-2 text-xs text-muted-foreground">
                <span>Matchade: {status.matched_count}</span>
                <span>Omatchade transaktioner: {status.unmatched_transaction_count}</span>
                <span>Omatchade verifikationer: {status.unmatched_gl_line_count}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Action Bar */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-end gap-4">
            <CashAccountSelector
              value={accountNumber}
              onChange={setAccountNumber}
            />
            <div>
              <Label>Datum från</Label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
            <div>
              <Label>Datum till</Label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
            <Button onClick={fetchAll} variant="outline">
              Filtrera
            </Button>
            <div className="flex-1" />
            <Button onClick={handleDryRun} disabled={runLoading} variant="outline">
              <Eye className="h-4 w-4 mr-2" />
              {runLoading ? 'Analyserar...' : 'Förhandsgranska'}
            </Button>
            {dryRunResults && dryRunResults.length > 0 && (
              <Button onClick={handleApply} disabled={applyLoading}>
                <Play className="h-4 w-4 mr-2" />
                {applyLoading ? 'Tillämpar...' : `Tillämpa ${dryRunResults.length} matchningar`}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Dry Run Preview */}
      {dryRunResults && dryRunResults.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              Förhandsgranskning — {dryRunResults.length} matchningar hittade
            </CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="py-2">Transaktion</th>
                  <th className="py-2 w-24">Datum</th>
                  <th className="py-2 w-28 text-right">Belopp</th>
                  <th className="py-2 w-8 text-center">&harr;</th>
                  <th className="py-2">Verifikation</th>
                  <th className="py-2 w-24">Datum</th>
                  <th className="py-2 w-28">Metod</th>
                </tr>
              </thead>
              <tbody>
                {dryRunResults.map((m) => (
                  <tr key={m.transaction_id} className="border-b last:border-0">
                    <td className="py-2 truncate max-w-[180px]">{m.transaction_description}</td>
                    <td className="py-2 tabular-nums">{formatDate(m.transaction_date)}</td>
                    <td className="py-2 text-right font-mono">{formatAmount(m.transaction_amount)}</td>
                    <td className="py-2 text-center text-muted-foreground">&harr;</td>
                    <td className="py-2">
                      <span className="font-mono text-xs">{m.voucher_series}{m.voucher_number}</span>
                      <span className="ml-2 text-muted-foreground truncate">{m.entry_description}</span>
                    </td>
                    <td className="py-2 tabular-nums">{formatDate(m.entry_date)}</td>
                    <td className="py-2">
                      <Badge variant="outline" className="text-xs">
                        {METHOD_LABELS[m.method] || m.method}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {dryRunResults && dryRunResults.length === 0 && (
        <Card>
          <CardContent className="p-6 text-center text-muted-foreground">
            Inga automatiska matchningar hittades.
          </CardContent>
        </Card>
      )}

      {/* Unmatched Transactions */}
      {unmatchedTx.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              Omatchade transaktioner ({unmatchedTx.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="py-2 w-24">Datum</th>
                  <th className="py-2">Beskrivning</th>
                  <th className="py-2 w-28 text-right">Belopp</th>
                  <th className="py-2 w-24">Referens</th>
                  <th className="py-2 w-64">Föreslå verifikation</th>
                  <th className="py-2 w-24"></th>
                </tr>
              </thead>
              <tbody>
                {unmatchedTx.map((tx) => (
                  <tr key={tx.id} className="border-b last:border-0">
                    <td className="py-2">{tx.date}</td>
                    <td className="py-2 truncate max-w-[200px]">{tx.description}</td>
                    <td className="py-2 text-right font-mono">
                      {formatCurrency(tx.amount)}
                    </td>
                    <td className="py-2 text-xs text-muted-foreground">{tx.reference || '—'}</td>
                    <td className="py-2">
                      <select
                        value={selectedMatch[tx.id] || ''}
                        onChange={(e) =>
                          setSelectedMatch((prev) => ({ ...prev, [tx.id]: e.target.value }))
                        }
                        className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
                      >
                        <option value="">Välj verifikation...</option>
                        {glLines.map((line) => {
                          const lineAmount = line.debit_amount > 0 ? line.debit_amount : -line.credit_amount
                          return (
                            <option key={line.line_id} value={line.journal_entry_id}>
                              {line.voucher_series}{line.voucher_number} | {formatDate(line.entry_date)} | {formatCurrency(lineAmount)} | {line.entry_description}
                            </option>
                          )
                        })}
                      </select>
                    </td>
                    <td className="py-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!selectedMatch[tx.id] || linkLoading === tx.id}
                        onClick={() => handleManualLink(tx.id)}
                      >
                        <Link2 className="h-3 w-3 mr-1" />
                        {linkLoading === tx.id ? '...' : 'Matcha'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* Unmatched GL Lines */}
      {glLines.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              Omatchade verifikationer på <AccountNumber number="1930" /> ({glLines.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="py-2 w-16">Ver.nr</th>
                  <th className="py-2 w-24">Datum</th>
                  <th className="py-2">Beskrivning</th>
                  <th className="py-2 w-28 text-right">Belopp</th>
                  <th className="py-2 w-24">Typ</th>
                </tr>
              </thead>
              <tbody>
                {glLines.map((line) => {
                  const amount = line.debit_amount > 0 ? line.debit_amount : -line.credit_amount
                  return (
                    <tr key={line.line_id} className="border-b last:border-0">
                      <td className="py-2 font-mono text-xs">
                        {line.voucher_series}{line.voucher_number}
                      </td>
                      <td className="py-2 tabular-nums">{formatDate(line.entry_date)}</td>
                      <td className="py-2 truncate max-w-[300px]">
                        {line.line_description || line.entry_description}
                      </td>
                      <td className="py-2 text-right font-mono">
                        {formatCurrency(amount)}
                      </td>
                      <td className="py-2 text-xs text-muted-foreground">{line.source_type}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* Recently Matched */}
      {matchedTx.length > 0 && (
        <Card>
          <CardHeader
            className="cursor-pointer"
            onClick={() => setShowMatched(!showMatched)}
          >
            <div className="flex items-center gap-2">
              {showMatched ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              <CardTitle className="text-lg">
                Matchade transaktioner ({matchedTx.length})
              </CardTitle>
            </div>
          </CardHeader>
          {showMatched && (
            <CardContent>
              <table className="w-full text-sm">
                <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                  <tr className="border-b text-left">
                    <th className="py-2 w-24">Datum</th>
                    <th className="py-2">Beskrivning</th>
                    <th className="py-2 w-28 text-right">Belopp</th>
                    <th className="py-2 w-32">Metod</th>
                    <th className="py-2 w-24"></th>
                  </tr>
                </thead>
                <tbody>
                  {matchedTx.map((tx) => (
                    <tr key={tx.id} className="border-b last:border-0">
                      <td className="py-2">{tx.date}</td>
                      <td className="py-2 truncate max-w-[300px]">{tx.description}</td>
                      <td className="py-2 text-right font-mono">
                        {formatCurrency(tx.amount)}
                      </td>
                      <td className="py-2">
                        {tx.reconciliation_method && (
                          <Badge variant="outline" className="text-xs">
                            {METHOD_LABELS[tx.reconciliation_method] || tx.reconciliation_method}
                          </Badge>
                        )}
                      </td>
                      <td className="py-2">
                        {tx.reconciliation_method && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={unlinkLoading === tx.id}
                            onClick={() => handleUnlink(tx.id)}
                          >
                            <Unlink className="h-3 w-3 mr-1" />
                            {unlinkLoading === tx.id ? '...' : 'Avmatcha'}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          )}
        </Card>
      )}

      {/* Empty state */}
      {unmatchedTx.length === 0 && glLines.length === 0 && matchedTx.length === 0 && !loading && (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            Inga transaktioner eller verifikationer att stämma av.
          </CardContent>
        </Card>
      )}
    </div>
  )
}
