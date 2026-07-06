'use client'

import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import React, { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  AlertCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  Gavel,
  Link2,
  Link2Off,
  Loader2,
  FileCheck,
  Lock,
  Unlock,
  Send,
  ShieldAlert,
  Trash2,
} from 'lucide-react'
import type { VatDeclarationRutor, VatPeriodType } from '@/types'
import { formatRedovisare, formatRedovisningsperiod } from '@/lib/skatteverket/format'
import {
  runVatDeclarationChecks,
  type VatDeclarationCheck,
} from '@/lib/reports/vat-declaration-checks'
import type { RcBasisGap } from '@/lib/reports/rc-basis-gaps'
import { formatDate } from '@/lib/utils'

interface SkatteverketStatus {
  connected: boolean
  expired?: boolean
  canRefresh?: boolean
  scope?: string
  expiresAt?: string
}

/**
 * Codes from /lib/api-client.ts's SkatteverketAuthError that mean "the user
 * needs to reconnect with BankID before this action can succeed". When the API
 * returns one of these codes we flip the local status.expired flag so the
 * "Session utgången" badge + "Förnya session" button surface, even if the
 * upstream /status endpoint hasn't reflected the change yet.
 */
const AUTH_RECONNECT_CODES = new Set([
  'NOT_CONNECTED',
  'SESSION_EXPIRED',
  'REFRESH_EXHAUSTED',
  'TOKEN_REVOKED',
  'TOKEN_CORRUPTED',
  'MISSING_SCOPE',
])

// Shape per Skatteverket Momsdeklaration v1.0.24 RAML
// (kontrollResultat.resultat[].{kod, status, beskrivning})
interface KontrollResult {
  kod: string
  status: 'ERROR' | 'WARNING'
  beskrivning: string
}

interface SkatteverketPanelProps {
  periodType: VatPeriodType
  year: number
  period: number
  hasData: boolean
  /**
   * Calculated rutor for the current period. Used to run local pre-flight
   * checks before Skatteverket sees the payload: SKV only validates internal
   * arithmetic consistency, so we have to catch "ruta 30-32 present but
   * 20-24 empty" locally before letting the user submit.
   */
  rutor?: VatDeclarationRutor | null
}

function formatAmount(amount: number): string {
  return amount.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const SKV_ENABLED = ENABLED_EXTENSION_IDS.has('skatteverket')

export function SkatteverketPanel(props: SkatteverketPanelProps) {
  if (!SKV_ENABLED) return null
  return <SkatteverketPanelInner {...props} />
}

function SkatteverketPanelInner({ periodType, year, period, hasData, rutor }: SkatteverketPanelProps) {
  const [status, setStatus] = useState<SkatteverketStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [kontroller, setKontroller] = useState<KontrollResult[]>([])
  const [signeringslank, setSigneringslank] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState<{
    kvittensnummer?: string
    tidpunkt?: string
  } | null>(null)

  // Local sanity checks against the calculated declaration, run before any
  // SKV call. SKV's "OK" only confirms arithmetic: these checks confirm
  // the declaration looks plausible (no orphaned RC output, no missing
  // basis, no summaMoms drift).
  const localChecks: VatDeclarationCheck[] = rutor ? runVatDeclarationChecks(rutor) : []
  const localErrors = localChecks.filter((c) => c.status === 'ERROR')
  const localBlocked = localErrors.length > 0

  // Per-voucher RC basis gap detection: fetched whenever a RC_BASIS_MISSING
  // warning fires so we can show the user exactly which verifikationer are
  // missing the basbelopp pair and offer a one-click correction.
  const hasRcBasisWarning = localChecks.some((c) => c.code === 'RC_BASIS_MISSING')
  const [gaps, setGaps] = useState<RcBasisGap[]>([])
  const [gapsLoading, setGapsLoading] = useState(false)
  const [fixingId, setFixingId] = useState<string | null>(null)
  const [gapSelections, setGapSelections] = useState<
    Record<string, { supplierType: 'eu_business' | 'non_eu_business' | 'swedish_business'; supplyType: 'service' | 'goods' }>
  >({})

  useEffect(() => {
    if (!hasRcBasisWarning) {
      setGaps([])
      return
    }
    let cancelled = false
    setGapsLoading(true)
    fetch(
      `/api/reports/vat-declaration/rc-basis-gaps?periodType=${periodType}&year=${year}&period=${period}`,
    )
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        setGaps(j?.data?.gaps || [])
      })
      .catch(() => {
        if (cancelled) return
        setGaps([])
      })
      .finally(() => {
        if (cancelled) return
        setGapsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [hasRcBasisWarning, periodType, year, period])

  const handleFixGap = async (gap: RcBasisGap) => {
    const sel = gapSelections[gap.entryId] ?? { supplierType: 'eu_business', supplyType: 'service' as const }
    setFixingId(gap.entryId)
    setError(null)
    try {
      const res = await fetch('/api/reports/vat-declaration/rc-basis-gaps/fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entryId: gap.entryId,
          supplierType: sel.supplierType,
          supplyType: sel.supplyType,
        }),
      })
      const result = await res.json()
      if (!res.ok) {
        setError(result?.error || 'Kunde inte korrigera verifikationen')
      } else {
        setGaps((prev) => prev.filter((g) => g.entryId !== gap.entryId))
        setSuccess(
          `Verifikation ${gap.voucherSeries}-${gap.voucherNumber} korrigerad. Storno + ny verifikation skapad. Ladda om sidan för att uppdatera rutorna.`,
        )
      }
    } catch {
      setError('Kunde inte korrigera verifikationen')
    } finally {
      setFixingId(null)
    }
  }

  /**
   * Apply an API JSON error result. When the error indicates the SKV session
   * has expired/been revoked/lost scope, immediately reflect that in the
   * local status so the "Förnya session" CTA appears next to the message:
   * the user shouldn't have to wait for /status to catch up.
   */
  const applyApiError = useCallback((result: { error?: string; code?: string } | null) => {
    if (!result?.error) return false
    setError(result.error)
    if (result.code && AUTH_RECONNECT_CODES.has(result.code)) {
      setStatus((prev) => prev ? { ...prev, expired: true } : prev)
    }
    return true
  }, [])

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/extensions/ext/skatteverket/status')
      if (res.ok) {
        const data = await res.json()
        setStatus(data)
      }
    } catch {
      // Extension might not be enabled
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchStatus()

    // Check URL params for OAuth callback results
    const params = new URLSearchParams(window.location.search)
    if (params.get('skv_connected') === 'true') {
      setSuccess('Ansluten till Skatteverket')
      fetchStatus()
      // Clean URL
      const url = new URL(window.location.href)
      url.searchParams.delete('skv_connected')
      window.history.replaceState({}, '', url.toString())
    }
    const skvError = params.get('skv_error')
    if (skvError) {
      setError(decodeURIComponent(skvError))
      const url = new URL(window.location.href)
      url.searchParams.delete('skv_error')
      window.history.replaceState({}, '', url.toString())
    }
  }, [fetchStatus])

  const handleConnect = () => {
    // return_to brings the user back to the momsdeklaration after the BankID
    // round-trip; the authorize route's default otherwise lands on the report
    // library. The callback appends skv_connected/skv_error itself.
    window.location.href =
      '/api/extensions/ext/skatteverket/authorize?return_to=' +
      encodeURIComponent('/reports/vat-declaration')
  }

  const handleDisconnect = async () => {
    setActionLoading('disconnect')
    setError(null)
    try {
      const res = await fetch('/api/extensions/ext/skatteverket/disconnect', {
        method: 'POST',
      })
      if (res.ok) {
        setStatus({ connected: false })
        setSuccess(null)
        setKontroller([])
        setSigneringslank(null)
        setSubmitted(null)
      }
    } catch {
      setError('Kunde inte koppla bort')
    } finally {
      setActionLoading(null)
    }
  }

  const handleValidate = async () => {
    if (localBlocked) {
      setError(
        'Lokala kontroller hittade fel i bokföringen. Åtgärda dessa innan ' +
        'du skickar till Skatteverket.',
      )
      return
    }
    setActionLoading('validate')
    setError(null)
    setKontroller([])
    try {
      const res = await fetch('/api/extensions/ext/skatteverket/declaration/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ periodType, year, period }),
      })
      const result = await res.json()
      if (applyApiError(result)) {
        // surfaced + status updated; nothing more to do
      } else {
        const controls: KontrollResult[] = result.data?.kontrollResultat?.resultat || []
        setKontroller(controls)
        if (controls.length === 0) {
          // SKV's OK only confirms arithmetic: it does NOT confirm that the
          // declaration is materially correct. We say so explicitly so the
          // user doesn't read this as a green light for actual filing.
          setSuccess(
            'Skatteverket har inga tekniska invändningar mot deklarationen. ' +
            'Kontrollera siffrorna i förhandsgranskningen innan du skickar in.',
          )
        } else {
          const errors = controls.filter(k => k.status === 'ERROR')
          if (errors.length > 0) {
            setError(`${errors.length} valideringsfel hittades`)
          } else {
            setSuccess('Skatteverket har inga tekniska invändningar (med varningar)')
          }
        }
      }
    } catch {
      setError('Kunde inte validera deklarationen')
    } finally {
      setActionLoading(null)
    }
  }

  const handleSaveDraft = async () => {
    if (localBlocked) {
      setError(
        'Lokala kontroller hittade fel i bokföringen. Åtgärda dessa innan ' +
        'du sparar utkastet hos Skatteverket.',
      )
      return
    }
    setActionLoading('draft')
    setError(null)
    try {
      const res = await fetch('/api/extensions/ext/skatteverket/declaration/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ periodType, year, period }),
      })
      const result = await res.json()
      if (applyApiError(result)) {
        // surfaced + status updated; nothing more to do
      } else {
        const controls: KontrollResult[] = result.data?.kontrollResultat?.resultat || []
        setKontroller(controls)
        const errors = controls.filter(k => k.status === 'ERROR')
        if (errors.length === 0) {
          setSuccess('Utkast sparat i Eget utrymme hos Skatteverket')
        } else {
          setError(`Utkastet sparades men har ${errors.length} valideringsfel`)
        }
      }
    } catch {
      setError('Kunde inte spara utkast')
    } finally {
      setActionLoading(null)
    }
  }

  const handleLock = async () => {
    setActionLoading('lock')
    setError(null)
    try {
      const res = await fetch(
        `/api/extensions/ext/skatteverket/declaration/lock?redovisare=${encodeURIComponent(
          await getRedovisare()
        )}&redovisningsperiod=${getRedovisningsperiod()}`,
        { method: 'PUT' }
      )
      const result = await res.json()
      if (applyApiError(result)) {
        // surfaced + status updated; nothing more to do
      } else if (result.data?.signeringsLank) {
        setSigneringslank(result.data.signeringsLank)
        setSuccess('Utkastet är låst. Öppna signeringslänken för att signera med BankID.')
      }
    } catch {
      setError('Kunde inte låsa utkastet')
    } finally {
      setActionLoading(null)
    }
  }

  const handleUnlock = async () => {
    setActionLoading('unlock')
    setError(null)
    try {
      const res = await fetch(
        `/api/extensions/ext/skatteverket/declaration/lock?redovisare=${encodeURIComponent(
          await getRedovisare()
        )}&redovisningsperiod=${getRedovisningsperiod()}`,
        { method: 'DELETE' }
      )
      const result = await res.json()
      if (applyApiError(result)) {
        // surfaced + status updated; nothing more to do
      } else {
        setSigneringslank(null)
        setSuccess('Utkastet har låsts upp')
      }
    } catch {
      setError('Kunde inte låsa upp utkastet')
    } finally {
      setActionLoading(null)
    }
  }

  const handleCheckSubmitted = async () => {
    setActionLoading('check')
    setError(null)
    try {
      const res = await fetch(
        `/api/extensions/ext/skatteverket/declaration/submitted?redovisare=${encodeURIComponent(
          await getRedovisare()
        )}&redovisningsperiod=${getRedovisningsperiod()}`
      )
      const result = await res.json()
      if (applyApiError(result)) {
        // surfaced + status updated; nothing more to do
      } else if (result.data) {
        setSubmitted(result.data)
        setSuccess('Deklarationen har lämnats in')
      } else {
        setSuccess('Ingen inlämnad deklaration hittades för denna period')
      }
    } catch {
      setError('Kunde inte kontrollera inlämningsstatus')
    } finally {
      setActionLoading(null)
    }
  }

  const handleDeleteDraft = async () => {
    setActionLoading('delete')
    setError(null)
    try {
      const res = await fetch(
        `/api/extensions/ext/skatteverket/declaration/draft?redovisare=${encodeURIComponent(
          await getRedovisare()
        )}&redovisningsperiod=${getRedovisningsperiod()}`,
        { method: 'DELETE' }
      )
      if (res.status === 204 || res.ok) {
        setKontroller([])
        setSigneringslank(null)
        setSuccess('Utkastet har raderats från Eget utrymme')
      } else {
        const result = await res.json().catch(() => ({}))
        if (!applyApiError(result)) {
          setError(`Kunde inte radera utkast (${res.status})`)
        }
      }
    } catch {
      setError('Kunde inte radera utkast')
    } finally {
      setActionLoading(null)
    }
  }

  const handleFetchDraft = async () => {
    setActionLoading('fetchDraft')
    setError(null)
    try {
      const res = await fetch(
        `/api/extensions/ext/skatteverket/declaration/draft?redovisare=${encodeURIComponent(
          await getRedovisare()
        )}&redovisningsperiod=${getRedovisningsperiod()}`
      )
      const result = await res.json()
      if (applyApiError(result)) {
        // surfaced + status updated; nothing more to do
      } else if (!result.data) {
        setSuccess('Inget sparat utkast hittades för perioden')
      } else {
        const locked = result.data?.locked ? ' (låst)' : ''
        const summa = result.data?.momsuppgift?.summaMoms
        const summaLabel = summa !== undefined ? `, summaMoms = ${formatAmount(summa)}` : ''
        setSuccess(`Sparat utkast hittades${locked}${summaLabel}`)
      }
    } catch {
      setError('Kunde inte hämta utkast')
    } finally {
      setActionLoading(null)
    }
  }

  const handleFetchDecided = async () => {
    setActionLoading('fetchDecided')
    setError(null)
    try {
      const res = await fetch(
        `/api/extensions/ext/skatteverket/declaration/decided?redovisare=${encodeURIComponent(
          await getRedovisare()
        )}&redovisningsperiod=${getRedovisningsperiod()}`
      )
      const result = await res.json()
      if (applyApiError(result)) {
        // surfaced + status updated; nothing more to do
      } else if (!result.data) {
        setSuccess('Inget beslut hittades för perioden')
      } else {
        const tid = result.data?.beslutadTidpunkt
        const tidLabel = tid ? ` (beslutad ${new Date(tid).toLocaleDateString('sv-SE')})` : ''
        setSuccess(`Beslut hittades${tidLabel}`)
      }
    } catch {
      setError('Kunde inte hämta beslutade uppgifter')
    } finally {
      setActionLoading(null)
    }
  }

  // Helper to get redovisare from settings
  const getRedovisare = async (): Promise<string> => {
    const res = await fetch('/api/settings')
    const { data } = await res.json()
    if (!data?.org_number) throw new Error('Organisationsnummer saknas')
    return formatRedovisare(data.org_number, data.entity_type)
  }

  const getRedovisningsperiod = (): string => {
    return formatRedovisningsperiod(periodType, year, period)
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Kontrollerar Skatteverket-anslutning...
        </CardContent>
      </Card>
    )
  }

  // Not connected
  if (!status?.connected) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <FileCheck className="h-5 w-5" />
            Skicka till Skatteverket
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/5 rounded-lg p-3">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            Anslut till Skatteverket med BankID för att skicka momsdeklarationen direkt.
          </p>
          <Button onClick={handleConnect} className="gap-2">
            <Link2 className="h-4 w-4" />
            Anslut med BankID
          </Button>
        </CardContent>
      </Card>
    )
  }

  // Connected: show actions
  const hasErrors = kontroller.some(k => k.status === 'ERROR')
  const hasWarnings = kontroller.some(k => k.status === 'WARNING')

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <FileCheck className="h-5 w-5" />
            Skicka till Skatteverket
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="success" className="gap-1">
              <CheckCircle2 className="h-3 w-3" />
              Ansluten
            </Badge>
            {status.expired && (
              <>
                <Badge variant="destructive" className="gap-1">
                  <AlertCircle className="h-3 w-3" />
                  Session utgången
                </Badge>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleConnect}
                  className="gap-1.5 h-7"
                >
                  <Link2 className="h-3.5 w-3.5" />
                  Förnya session
                </Button>
              </>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Messages */}
        {error && (
          <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/5 rounded-lg p-3">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {success && !error && (
          <div className="flex items-start gap-2 text-sm text-success bg-success/5 rounded-lg p-3">
            <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{success}</span>
          </div>
        )}

        {/* Local pre-flight check results: surfaced separately from SKV's
            kontroller so the user knows these are Accounted's own sanity checks,
            not Skatteverket's. ERRORs block the submit/validate buttons. */}
        {localChecks.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Lokala kontroller
            </p>
            {localChecks.map((c, i) => (
              <div
                key={`${c.code}-${i}`}
                className={`flex items-start gap-2 text-sm rounded-lg p-3 ${
                  c.status === 'ERROR'
                    ? 'bg-destructive/5 text-destructive'
                    : 'bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-200'
                }`}
              >
                {c.status === 'ERROR' ? (
                  <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
                ) : (
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                )}
                <div>
                  <span className="font-mono text-xs mr-1.5">{c.code}</span>
                  {c.message}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Per-voucher RC basis gaps: concrete list of verifikationer that
            triggered RC_BASIS_MISSING, with a one-click korrigera action. */}
        {hasRcBasisWarning && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Verifikationer som saknar basbelopp
            </p>
            {gapsLoading ? (
              <div className="text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Söker berörda verifikationer...
              </div>
            ) : gaps.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Inga verifikationer hittades. Bristen kan ligga utanför perioden
                eller i bokföring som inte är posted.
              </p>
            ) : (
              <div className="space-y-2">
                {gaps.map((gap) => {
                  const sel = gapSelections[gap.entryId] ?? {
                    supplierType: 'eu_business' as const,
                    supplyType: 'service' as const,
                  }
                  return (
                    <div
                      key={gap.entryId}
                      className="rounded-lg border bg-card p-3 space-y-2"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium">
                            Verifikation {gap.voucherSeries}-{gap.voucherNumber}
                            <span className="text-muted-foreground font-normal">
                              {' · '}
                              {formatDate(gap.entryDate)}
                            </span>
                          </p>
                          <p className="text-sm text-muted-foreground truncate">
                            {gap.description}
                          </p>
                          <p className="text-xs text-muted-foreground mt-1 tabular-nums">
                            {gap.rcOutputAccount} har{' '}
                            {gap.rcOutputAmount.toLocaleString('sv-SE', {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}{' '}
                            kr fiktiv moms: saknar basbelopp{' '}
                            {gap.expectedBasisAmount.toLocaleString('sv-SE', {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}{' '}
                            kr
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          className="text-xs border rounded px-2 py-1 bg-background"
                          value={sel.supplierType}
                          onChange={(e) => {
                            const next = e.target.value as typeof sel.supplierType
                            setGapSelections((prev) => ({
                              ...prev,
                              [gap.entryId]: {
                                supplierType: next,
                                // Non-EU + goods is import VAT, not RC: coerce back
                                // to service so the user can't submit an invalid combo.
                                supplyType: next === 'non_eu_business' ? 'service' : sel.supplyType,
                              },
                            }))
                          }}
                          disabled={fixingId === gap.entryId}
                        >
                          <option value="eu_business">EU-leverantör</option>
                          <option value="non_eu_business">Utanför EU</option>
                          <option value="swedish_business">Svensk RC</option>
                        </select>
                        <select
                          className="text-xs border rounded px-2 py-1 bg-background"
                          value={sel.supplyType}
                          onChange={(e) =>
                            setGapSelections((prev) => ({
                              ...prev,
                              [gap.entryId]: {
                                ...sel,
                                supplyType: e.target.value as typeof sel.supplyType,
                              },
                            }))
                          }
                          disabled={fixingId === gap.entryId}
                        >
                          <option value="service">Tjänst</option>
                          {/* Non-EU goods is import VAT, not reverse charge: hide the
                              option for that combination so the fix endpoint never
                              has to reject it. */}
                          {sel.supplierType !== 'non_eu_business' && (
                            <option value="goods">Vara</option>
                          )}
                        </select>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleFixGap(gap)}
                          disabled={fixingId !== null}
                          className="gap-1.5 h-7"
                        >
                          {fixingId === gap.entryId ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <CheckCircle2 className="h-3 w-3" />
                          )}
                          Korrigera
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Validation results from Skatteverket */}
        {kontroller.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Skatteverkets valideringsresultat
            </p>
            {kontroller.map((k, i) => (
              <div
                key={`${k.kod}-${i}`}
                className={`flex items-start gap-2 text-sm rounded-lg p-3 ${
                  k.status === 'ERROR'
                    ? 'bg-destructive/5 text-destructive'
                    : 'bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-200'
                }`}
              >
                {k.status === 'ERROR' ? (
                  <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
                ) : (
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                )}
                <div>
                  <span className="font-mono text-xs mr-1.5">{k.kod}</span>
                  {k.beskrivning}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Submitted confirmation */}
        {submitted && (
          <div className="rounded-lg border p-3 space-y-1">
            <p className="text-sm font-medium flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4 text-success" />
              Inlämnad
            </p>
            {submitted.kvittensnummer && (
              <p className="text-xs text-muted-foreground">
                Kvittensnummer: <span className="font-mono">{submitted.kvittensnummer}</span>
              </p>
            )}
            {submitted.tidpunkt && (
              <p className="text-xs text-muted-foreground">
                Tidpunkt: {new Date(submitted.tidpunkt).toLocaleString('sv-SE')}
              </p>
            )}
          </div>
        )}

        {/* Signing link */}
        {signeringslank && (
          <div className="rounded-lg border border-success/30 bg-success/5 p-3 space-y-2">
            <p className="text-sm font-medium">Utkastet är låst och redo att signeras</p>
            <p className="text-xs text-muted-foreground">
              Öppna länken nedan och signera med BankID på Skatteverkets sida.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => window.open(signeringslank, '_blank')}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Öppna signeringssidan
            </Button>
          </div>
        )}

        {/* Forward-lifecycle buttons */}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            variant="outline"
            size="sm"
            onClick={handleValidate}
            disabled={!hasData || localBlocked || actionLoading !== null}
            className="gap-1.5"
            title={localBlocked ? 'Åtgärda lokala kontrollfel innan validering' : undefined}
          >
            {actionLoading === 'validate' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FileCheck className="h-3.5 w-3.5" />
            )}
            Validera
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={handleSaveDraft}
            disabled={!hasData || localBlocked || actionLoading !== null}
            className="gap-1.5"
            title={localBlocked ? 'Åtgärda lokala kontrollfel innan inlämning' : undefined}
          >
            {actionLoading === 'draft' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            Spara utkast
          </Button>

          <Button
            size="sm"
            onClick={handleLock}
            disabled={!hasData || hasErrors || actionLoading !== null}
            className="gap-1.5"
            title={hasErrors ? 'Valideringsfel måste åtgärdas först' : ''}
          >
            {actionLoading === 'lock' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Lock className="h-3.5 w-3.5" />
            )}
            Lås och signera
          </Button>
        </div>

        {/* Read-only fetches from Skatteverket. */}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleFetchDraft}
            disabled={actionLoading !== null}
            className="gap-1.5 text-muted-foreground"
            title="Hämta sparat utkast från Eget utrymme"
          >
            {actionLoading === 'fetchDraft' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            Hämta utkast
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={handleCheckSubmitted}
            disabled={actionLoading !== null}
            className="gap-1.5 text-muted-foreground"
            title="Kontrollera om en signerad deklaration har lämnats in"
          >
            {actionLoading === 'check' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )}
            Kontrollera inlämning
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={handleFetchDecided}
            disabled={actionLoading !== null}
            className="gap-1.5 text-muted-foreground"
            title="Hämta Skatteverkets beslut för perioden"
          >
            {actionLoading === 'fetchDecided' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Gavel className="h-3.5 w-3.5" />
            )}
            Hämta beslut
          </Button>
        </div>

        {/* Recovery / cleanup buttons. Always visible when connected so
           the user can back out of a locked or stale draft state without
           depending on local UI state surviving a reload. SKV returns
           404/409 if the action isn't applicable; we surface that as an
           error message rather than hiding the button. */}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleUnlock}
            disabled={actionLoading !== null}
            className="gap-1.5 text-muted-foreground"
            title="Lås upp en låst period så att utkastet kan ändras eller raderas"
          >
            {actionLoading === 'unlock' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Unlock className="h-3.5 w-3.5" />
            )}
            Lås upp
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={handleDeleteDraft}
            disabled={actionLoading !== null}
            className="gap-1.5 text-muted-foreground"
            title="Radera sparat utkast från Skatteverkets Eget utrymme"
          >
            {actionLoading === 'delete' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            Radera utkast
          </Button>
        </div>

        {/* Disconnect */}
        <div className="pt-2 border-t">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDisconnect}
            disabled={actionLoading !== null}
            className="gap-1.5 text-muted-foreground hover:text-destructive"
          >
            {actionLoading === 'disconnect' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Link2Off className="h-3.5 w-3.5" />
            )}
            Koppla bort Skatteverket
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
