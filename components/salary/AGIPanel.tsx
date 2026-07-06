'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  Link2,
  Link2Off,
  Loader2,
  Lock,
  PlugZap,
  Send,
  ShieldAlert,
  Unlock,
} from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'

interface AGIPanelProps {
  salaryRunId: string
  /** Skatteverket arbetsgivare ID (12-digit): formatted by parent. */
  arbetsgivare: string
  /** YYYYMM */
  period: string
  /** Already-cached run-level signals for showing what step we're at. */
  agiGeneratedAt?: string | null
  agiSubmittedAt?: string | null
  /** When true, write actions are hidden. */
  readOnly?: boolean
  /** Called after a state-changing action so parent can refresh. */
  onChange?: () => void
}

interface ConnectionStatus {
  connected: boolean
  expired?: boolean
  canRefresh?: boolean
  scope?: string
  expiresAt?: string
}

/**
 * Per-rule validation finding from Skatteverket's kontrollresultat. Maps to
 * either a kontrollfel item (per-period) or a top-level fel item. We
 * normalize both into one shape for rendering.
 */
interface KontrollFinding {
  kod?: string                     // textNyckel/kontrollnyckel from kontrollfel
  status: 'STOPP' | 'ARENDE' | 'WARNING'
  beskrivning: string              // felmeddelande
  uppgiftsTyp?: string             // 'HU' | 'IU' | 'FU'
  specifikationsnummer?: number
  identifierare?: string
}

/**
 * Local submission state mirrored in extension_data under
 * `agi_submission_{period}`. Matches the `status` enum the index.ts handlers
 * write back. Strict superset of what the UI actually keys off.
 */
interface SubmissionState {
  status?:
    | 'underlag_submitted'         // POST /underlag returned an inlamningId
    | 'underlag_rejected'          // kontrollresultat surfaced stoppande fel
    | 'awaiting_signing'           // skapaGranskningsunderlag returned a link
    | 'signed'                     // kvittenser shows uuidKvittens for the period
  signeringslank?: string
  kvittensnummer?: string
  signeradAv?: string
  signeradTid?: string
  inlamningId?: number
  tillstand?: string
  meddelande?: string
  /** ISO timestamp the submission record was last written by the extension. */
  updatedAt?: string
}

/** Subset of SkatteverketAGIKontrollresultat we use in the panel. */
interface Kontrollresultat {
  status: 'PROCESSING' | 'DONE_SUCCESS' | 'DONE_FAILED' | 'DONE_REJECTED'
  kontrollrapport?: {
    bearbetningsfel?: Array<{ felmeddelande: string }>
    valideringsfel?: Array<{ felmeddelande: string }>
    redovisningsperioder?: Array<{
      perioder: Array<{
        kontrollfel: Array<{
          textNyckel?: string
          kontrollnyckel?: string
          felmeddelande: string
          felstatus: 'STOPP' | 'ARENDE'
          uppgiftsTyp?: string
          specifikationsnummer?: number
          identifierare?: string
        }>
      }>
    }>
  }
}

const ENABLED_KEY = 'EXTENSION_DISABLED'

export function AGIPanel(props: AGIPanelProps) {
  const {
    salaryRunId,
    arbetsgivare,
    period,
    agiGeneratedAt,
    agiSubmittedAt,
    readOnly,
    onChange,
  } = props

  const t = useTranslations('salary_agi')
  const hasSkatteverket = useCapability(CAPABILITY.skatteverket)

  const [extensionDisabled, setExtensionDisabled] = useState(false)
  const [status, setStatus] = useState<ConnectionStatus | null>(null)
  const [submission, setSubmission] = useState<SubmissionState | null>(null)
  const [kontroller, setKontroller] = useState<KontrollFinding[]>([])
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const fetchStatus = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/extensions/ext/skatteverket/status')
      if (res.status === 503) {
        const data = await res.json().catch(() => ({}))
        if (data?.code === ENABLED_KEY) {
          setExtensionDisabled(true)
          return
        }
      }
      if (res.ok) {
        const next = await res.json() as ConnectionStatus
        setStatus(next)
        // Clear stale session-expired error after a successful reconnect.
        // The browser bfcache can restore React state from before the OAuth
        // round-trip, leaving the old "Sessionen har gått ut" message in
        // place even though the token is now fresh. This wipes the error
        // only when (a) there's currently an error and (b) the new status
        // says we're healthy: never silently swallowing unrelated errors.
        const isHealthy = next.connected && !next.expired && next.canRefresh !== false
        if (isHealthy) {
          setError(prev =>
            prev && /sessionen har gått ut|logga in med bankid igen/i.test(prev)
              ? null
              : prev,
          )
        }
      }
    } catch {
      // ignore: UI shows the not-connected state
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchSubmission = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/extensions/ext/skatteverket/agi/status?period=${period}`,
      )
      if (res.ok) {
        const json = await res.json()
        setSubmission(json.data ?? null)
      }
    } catch {
      // ignore
    }
  }, [period])

  useEffect(() => {
    fetchStatus()
    fetchSubmission()
  }, [fetchStatus, fetchSubmission])

  // Listen for OAuth completion from the BankID popup. When the popup posts
  // back a success/error message we re-fetch status so the panel flips from
  // "expired" / not-connected to "Ansluten" without a full page reload.
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return
      if (event.data?.type === 'skatteverket-oauth-success') {
        setError(null)
        setSuccess(t('oauth_success'))
        fetchStatus()
      } else if (event.data?.type === 'skatteverket-oauth-error') {
        const reason =
          typeof event.data.reason === 'string' && event.data.reason
            ? event.data.reason
            : t('oauth_error_fallback')
        setError(reason)
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [fetchStatus, t])

  // Drop a stale "AGI-XML saknas" error once the run's AGI is (re)generated.
  // That error is set when "Skicka in underlag" runs before the XML exists; if
  // the file is then generated out-of-band (MCP, the download button, another
  // tab) the parent refreshes `agiGeneratedAt` and this clears the now-wrong
  // message without forcing a full reload, mirroring the session-expired
  // self-heal in fetchStatus above.
  useEffect(() => {
    if (!agiGeneratedAt) return
    setError(prev =>
      prev && /agi-xml saknas|inte genererats/i.test(prev) ? null : prev,
    )
  }, [agiGeneratedAt])

  // Background kvittens-polling timers (see scheduleKvittensPolls below).
  // Held in a ref so the unmount-cleanup effect can cancel them if the
  // user leaves the page mid-signing.
  const kvittensTimers = useRef<ReturnType<typeof setTimeout>[]>([])
  useEffect(() => {
    return () => {
      for (const t of kvittensTimers.current) clearTimeout(t)
      kvittensTimers.current = []
    }
  }, [])

  /**
   * Silently ask Skatteverket whether this period's granskningsunderlag has
   * been signed. The kvittenser handler stamps salary_runs.agi_submitted_at
   * and flips the local submission state to 'signed' the instant it sees a
   * uuidKvittens, so a positive result transitions the panel out of
   * awaiting_signing on its own (the action buttons then disappear via the
   * isSigned gate). Returns true iff a signed kvittens was observed. No-ops
   * (returns false) until we have the arbetsgivare id.
   *
   * Shared by the post-link background timers (scheduleKvittensPolls) and the
   * auto-detect effect that runs on mount / tab refocus.
   */
  const checkKvittens = useCallback(async (): Promise<boolean> => {
    if (!arbetsgivare) return false
    try {
      const res = await fetch(
        `/api/extensions/ext/skatteverket/agi/kvittenser?arbetsgivare=${encodeURIComponent(arbetsgivare)}&period=${period}`,
      )
      if (!res.ok) return false
      const json = await res.json()
      const signed = !!json.data?.kvittenser?.[0]?.uuidKvittens
      await fetchSubmission()
      if (signed) {
        // Replace any lingering "Granskningsunderlag klart…" / stale error
        // with an unambiguous confirmation. Mirrors handleCheckSubmitted.
        setError(null)
        setSuccess(t('signed_success'))
        onChange?.()
      }
      return signed
    } catch {
      return false
    }
  }, [arbetsgivare, period, fetchSubmission, onChange, t])

  /**
   * Background-poll /agi/kvittenser at 30s, 2 min, and 5 min after the user
   * receives a signing link: a timer-based fallback to the focus-driven
   * auto-detect below. The kvittenser handler stamps salary_runs.agi_submitted_at
   * when it observes a uuidKvittens, critical for the audit trail (BFL 5 kap /
   * BFNAR 2013:2): a NULL agi_submitted_at after a real filing would
   * misrepresent the behandlingshistorik. Stops scheduling once observed.
   */
  const scheduleKvittensPolls = useCallback(() => {
    for (const t of kvittensTimers.current) clearTimeout(t)
    kvittensTimers.current = []

    const poll = async () => {
      // checkKvittens is silent on failure: the "Hämta kvittens" button
      // remains the explicit recovery path.
      const signed = await checkKvittens()
      if (signed) {
        // Cancel any remaining timers: the kvittens has been recorded
        // server-side and further polls are wasted requests.
        for (const t of kvittensTimers.current) clearTimeout(t)
        kvittensTimers.current = []
      }
    }

    kvittensTimers.current.push(setTimeout(poll, 30_000))
    kvittensTimers.current.push(setTimeout(poll, 120_000))
    kvittensTimers.current.push(setTimeout(poll, 300_000))
  }, [checkKvittens])

  // Auto-detect a Mina Sidor BankID signature so the panel reflects "signed"
  // without the user having to click "Hämta kvittens". While we sit in
  // awaiting_signing the user has typically opened the signing link (which
  // opens a new tab), signed on Skatteverket's site, and come back. We re-check
  // the kvittens (a) once on entering awaiting_signing (covering a reload
  // after signing) and (b) whenever the tab regains focus (covering the
  // sign-in-the-other-tab-then-return flow). A found kvittens flips the local
  // state to 'signed', hiding the signing actions. The ref makes the on-enter
  // check fire once per episode even if checkKvittens's identity churns (its
  // onChange dep is an unmemoized parent callback).
  const signCheckedRef = useRef(false)
  useEffect(() => {
    if (submission?.status !== 'awaiting_signing') {
      signCheckedRef.current = false
      return
    }
    if (!signCheckedRef.current) {
      signCheckedRef.current = true
      checkKvittens()
    }
    function onVisible() {
      if (document.visibilityState === 'visible') checkKvittens()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [submission?.status, checkKvittens])

  const handleDisconnect = useCallback(async () => {
    setActionLoading('disconnect')
    setError(null)
    setSuccess(null)
    try {
      const res = await fetch('/api/extensions/ext/skatteverket/disconnect', {
        method: 'POST',
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        setError(json.error || t('disconnect_failed_status', { status: res.status }))
        return
      }
      setSuccess(t('disconnect_success'))
      await fetchStatus()
      await fetchSubmission()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('disconnect_failed'))
    } finally {
      setActionLoading(null)
    }
  }, [fetchStatus, fetchSubmission, t])

  const handleConnect = () => {
    // Open the BankID OAuth flow in a centered popup. The callback page
    // detects `window.opener` and posts back a `skatteverket-oauth-success`
    // (or `-error`) message, then closes itself: see the postMessage
    // listener below. `return_to` is still passed so the popup-less fallback
    // path (e.g. popup blockers) lands on the salary run page rather than
    // the default /reports tab.
    const returnTo = typeof window !== 'undefined'
      ? window.location.pathname + window.location.search
      : ''
    const url = `/api/extensions/ext/skatteverket/authorize${
      returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : ''
    }`
    const w = 600
    const h = 750
    const left = window.screenX + (window.outerWidth - w) / 2
    const top = window.screenY + (window.outerHeight - h) / 2
    const popup = window.open(
      url,
      'skatteverket-oauth',
      `width=${w},height=${h},left=${left},top=${top}`,
    )
    if (!popup) {
      // Popup blocked: fall back to a full-page navigation.
      window.location.href = url
    }
  }

  /**
   * Flatten a kontrollresultat response into a list of findings the panel
   * can render. We surface validering+bearbetningsfel and per-period
   * kontrollfel under one shape so the UI doesn't need to walk three nested
   * arrays per render.
   */
  function extractFindings(kr: Kontrollresultat | undefined): KontrollFinding[] {
    if (!kr?.kontrollrapport) return []
    const out: KontrollFinding[] = []
    for (const f of kr.kontrollrapport.bearbetningsfel ?? []) {
      out.push({ status: 'STOPP', beskrivning: f.felmeddelande })
    }
    for (const f of kr.kontrollrapport.valideringsfel ?? []) {
      out.push({ status: 'STOPP', beskrivning: f.felmeddelande })
    }
    for (const rp of kr.kontrollrapport.redovisningsperioder ?? []) {
      for (const p of rp.perioder ?? []) {
        for (const kf of p.kontrollfel ?? []) {
          out.push({
            kod: kf.textNyckel ?? kf.kontrollnyckel,
            status: kf.felstatus,
            beskrivning: kf.felmeddelande,
            uppgiftsTyp: kf.uppgiftsTyp,
            specifikationsnummer: kf.specifikationsnummer,
            identifierare: kf.identifierare,
          })
        }
      }
    }
    return out
  }

  /**
   * Step 1: POST the stored XML underlag, then poll kontrollresultat until
   * status flips out of PROCESSING. Skatteverket's spec says polling is
   * usually instantaneous, but we cap at 8 attempts × 1s to be safe.
   *
   * On DONE_SUCCESS the underlag is auto-persisted by SKV: no /spara call.
   * Calling /spara when there are no errors returns 400 felkod 20
   * ("Inlämningen är redan sparad/borttagen eller innehöll inga felaktiga
   * underlag") because /spara is specifically for re-persisting rejected
   * underlag so the user can fix them later in Mina Sidor. Successful
   * underlag move straight to the granskningsunderlag step.
   *
   * On DONE_REJECTED we surface the validation findings; the user can still
   * choose to save (so they can fix it in Mina Sidor) or abort.
   */
  // Always-free: generate + download the AGI XML so the user can file manually
  // in Skatteverket's e-service. AGI is a mandatory statutory filing, so this
  // path must never be paywalled: only the direct API submission below is paid.
  const handleDownloadXml = async () => {
    setActionLoading('download')
    setError(null)
    try {
      const res = await fetch(`/api/salary/runs/${salaryRunId}/agi/xml`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || t('xml_generate_failed'))
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `AGI_${period ?? 'underlag'}.xml`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      onChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('xml_download_failed'))
    } finally {
      setActionLoading(null)
    }
  }

  const handleSubmit = async () => {
    setActionLoading('submit')
    setError(null)
    setSuccess(null)
    setKontroller([])
    try {
      const submitRes = await fetch('/api/extensions/ext/skatteverket/agi/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ salaryRunId }),
      })
      const submitJson = await submitRes.json()
      if (!submitRes.ok || submitJson.error) {
        setError(submitJson.error || t('submit_failed_status', { status: submitRes.status }))
        return
      }
      const inlamningId = submitJson.data?.inlamningId as number | undefined
      if (!inlamningId) {
        setError(t('submit_missing_id'))
        return
      }

      // Poll kontrollresultat until DONE_*
      let kr: Kontrollresultat | undefined
      for (let attempt = 0; attempt < 8; attempt++) {
        const krRes = await fetch(
          `/api/extensions/ext/skatteverket/agi/kontrollresultat?inlamningId=${inlamningId}`,
        )
        const krJson = await krRes.json()
        if (!krRes.ok || krJson.error) {
          setError(krJson.error || t('kontrollresultat_failed_status', { status: krRes.status }))
          return
        }
        kr = krJson.data as Kontrollresultat
        if (kr.status !== 'PROCESSING') break
        await new Promise(r => setTimeout(r, 1000))
      }
      if (!kr || kr.status === 'PROCESSING') {
        setError(t('still_processing'))
        return
      }

      const findings = extractFindings(kr)
      setKontroller(findings)

      if (kr.status === 'DONE_SUCCESS') {
        setSuccess(t('underlag_accepted'))
      } else if (kr.status === 'DONE_REJECTED') {
        setError(t('underlag_rejected_error', { count: findings.filter(f => f.status === 'STOPP').length }))
      } else {
        setError(t('underlag_failed'))
      }

      await fetchSubmission()
      onChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('submit_failed'))
    } finally {
      setActionLoading(null)
    }
  }

  /**
   * Step 2: skapaGranskningsunderlag: returns the Mina Sidor deep-link the
   * user opens to sign with BankID. Defaults to `lasPeriod=true` so the
   * period is locked while the signing window is open.
   */
  const handleCreateSigningLink = async () => {
    setActionLoading('granskning')
    setError(null)
    setSuccess(null)
    try {
      const res = await fetch(
        `/api/extensions/ext/skatteverket/agi/granskningsunderlag?arbetsgivare=${encodeURIComponent(arbetsgivare)}&period=${period}`,
        { method: 'POST' },
      )
      const json = await res.json()
      if (!res.ok || json.error) {
        setError(json.error || t('signing_link_failed_status', { status: res.status }))
        return
      }
      if (json.data?.tillstand === 'INCORRECT_DATA') {
        setError(t('incorrect_data_error', { message: json.data.meddelande || t('incorrect_data_fallback') }))
      } else {
        setSuccess(t('signing_link_ready'))
        // The user typically opens the link, signs in Mina Sidor, then
        // returns later (or never). Auto-poll so we capture the kvittens
        // (and stamp agi_submitted_at) without forcing the user to come
        // back and click "Hämta kvittens".
        scheduleKvittensPolls()
      }
      await fetchSubmission()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('signing_link_failed'))
    } finally {
      setActionLoading(null)
    }
  }

  const handleUnlock = async () => {
    setActionLoading('unlock')
    setError(null)
    setSuccess(null)
    try {
      const res = await fetch(
        `/api/extensions/ext/skatteverket/agi/lasUpp?arbetsgivare=${encodeURIComponent(arbetsgivare)}&period=${period}`,
        { method: 'POST' },
      )
      const json = await res.json()
      if (!res.ok || json.error) {
        setError(json.error || t('unlock_failed_status', { status: res.status }))
        return
      }
      setSuccess(t('unlock_success'))
      await fetchSubmission()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('unlock_failed'))
    } finally {
      setActionLoading(null)
    }
  }

  /**
   * Step 3 (post-signing): poll /agi/kvittenser to detect that the user has
   * signed in Mina Sidor. Once a kvittens turns up, the index.ts handler
   * mirrors it onto agi_declarations and flips the local submission state
   * to 'signed'.
   */
  const handleCheckSubmitted = async () => {
    setActionLoading('check')
    setError(null)
    setSuccess(null)
    try {
      const res = await fetch(
        `/api/extensions/ext/skatteverket/agi/kvittenser?arbetsgivare=${encodeURIComponent(arbetsgivare)}&period=${period}`,
      )
      const json = await res.json()
      if (!res.ok || json.error) {
        setError(json.error || t('kvittens_fetch_failed'))
        return
      }
      const kvittens = json.data?.kvittenser?.[0]
      if (kvittens?.uuidKvittens) {
        setSuccess(t('signed_success'))
      } else {
        setSuccess(t('no_kvittens_yet'))
      }
      await fetchSubmission()
      onChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('check_status_failed'))
    } finally {
      setActionLoading(null)
    }
  }

  // ── Render branches ─────────────────────────────────────────────

  if (extensionDisabled) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <div className="flex items-start gap-2">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              {t('disabled_before')}
              <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">SKATTEVERKET_ENABLED</code>
              {t('disabled_after')}
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('title')}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> {t('loading_status')}
        </CardContent>
      </Card>
    )
  }

  if (!status?.connected) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {t('connect_description')}
          </p>
          {!readOnly && (
            <Button onClick={handleConnect}>
              <Link2 className="mr-2 h-4 w-4" />
              {t('connect_button')}
            </Button>
          )}
        </CardContent>
      </Card>
    )
  }

  const subState = submission?.status
  const awaitingSigning = subState === 'awaiting_signing'
  const underlagSubmitted = subState === 'underlag_submitted'
  const underlagRejected = subState === 'underlag_rejected'
  const isSigned = subState === 'signed' || !!agiSubmittedAt
  // The submission state is keyed by PERIOD; AGI generation is keyed by RUN.
  // If the run's AGI was (re)generated AFTER this signing draft was created,
  // the locked underlag at Skatteverket reflects superseded figures and must
  // not be signed: surface a warning and steer the user to unlock + resubmit
  // rather than presenting it as ready to sign (avoids filing stale amounts).
  const draftUpdatedAt = submission?.updatedAt ? new Date(submission.updatedAt) : null
  const draftIsStale =
    awaitingSigning &&
    !!agiGeneratedAt &&
    !!draftUpdatedAt &&
    !Number.isNaN(draftUpdatedAt.getTime()) &&
    new Date(agiGeneratedAt).getTime() > draftUpdatedAt.getTime()
  // Tokens issued before the agd scope was added to DEFAULT_SCOPES will
  // 403 with invalid_scope at submission time: surface that proactively
  // so the user reconnects before hitting the deadline rather than at it.
  const missingAgdScope =
    typeof status?.scope === 'string' &&
    !status.scope.split(/\s+/).filter(Boolean).includes('agd')

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span>{t('title')}</span>
          <span className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
            <span className="flex items-center gap-1">
              <CheckCircle2 className="h-3.5 w-3.5 text-success" />
              {t('connected')}
            </span>
            {!readOnly && (
              <button
                type="button"
                onClick={handleDisconnect}
                disabled={actionLoading === 'disconnect'}
                className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground transition-colors hover:border-destructive/50 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                title={t('disconnect_title')}
              >
                {actionLoading === 'disconnect' ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <PlugZap className="h-3 w-3" />
                )}
                {t('disconnect_button')}
              </button>
            )}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Expired-session banner: the token row exists (so status.connected
            is true) but the access token is past expiry and either has no
            refresh token or has burned through its 10-refresh budget. The
            only fix is a fresh BankID round-trip. */}
        {(status?.expired === true || status?.canRefresh === false) && !readOnly && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-900/40 dark:bg-amber-900/20">
            <p className="text-sm font-medium">{t('expired_banner_title')}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('expired_banner_description')}
            </p>
            <Button size="sm" variant="outline" className="mt-2" onClick={handleConnect}>
              <Link2 className="mr-1.5 h-3.5 w-3.5" />
              {t('reconnect_button')}
            </Button>
          </div>
        )}

        {/* Missing-scope banner: proactive nudge before the user hits a
            403 invalid_scope at submission time. The agd scope was added
            after some users had already connected, so their stored token
            grants moms/skattekonto but not AGI. */}
        {missingAgdScope && !readOnly && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-900/40 dark:bg-amber-900/20">
            <p className="text-sm font-medium">
              {t('missing_scope_title')}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('missing_scope_description')}
            </p>
            <a
              href="/settings/tax"
              className="mt-2 inline-flex items-center gap-1 text-sm font-medium hover:underline"
            >
              {t('open_settings')} <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        )}

        {/* Status summary */}
        <div className="space-y-1.5 text-sm">
          <StatusRow
            ok={!!agiGeneratedAt}
            okText={agiGeneratedAt ? t('file_generated', { date: new Date(agiGeneratedAt).toLocaleString('sv-SE') }) : ''}
            pendingText={t('file_not_generated')}
          />
          <StatusRow
            ok={isSigned}
            okText={
              submission?.kvittensnummer
                ? t('submitted_with_kvittens', { kvittens: submission.kvittensnummer })
                : agiSubmittedAt
                  ? t('submitted_at', { date: new Date(agiSubmittedAt).toLocaleString('sv-SE') })
                  : t('submitted')
            }
            pendingText={
              awaitingSigning
                ? draftIsStale
                  ? t('pending_stale_draft')
                  : t('pending_awaiting_signature')
                : underlagSubmitted
                  ? t('pending_underlag_submitted')
                  : t('pending_not_submitted')
            }
          />
        </div>

        {/* Signing link: only shown for the happy path. The link in
            `signeringslank` is also reused by the INCORRECT_DATA branch
            below to surface a felrapport URL, which deserves a distinct
            treatment so the user understands they must fix errors before
            BankID signing is even possible. */}
        {submission?.signeringslank && awaitingSigning && !draftIsStale && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/40 dark:bg-amber-900/20">
            <p className="text-sm font-medium">{t('draft_locked_title')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('draft_locked_description')}
            </p>
            <a
              href={submission.signeringslank}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-amber-900 hover:underline dark:text-amber-200"
            >
              {t('open_signing_link')} <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        )}

        {/* Stale-draft guard: the signing draft at Skatteverket predates the
            current run's AGI generation, so it carries superseded figures.
            We deliberately do NOT surface "Öppna signeringslänk" here: signing
            it would file the old amounts. The "Lås upp" button below releases
            the SKV lock; the user then re-submits the freshly generated XML. */}
        {awaitingSigning && draftIsStale && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-900/40 dark:bg-amber-900/20">
            <p className="text-sm font-medium">{t('stale_draft_title')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('stale_draft_description', {
                generatedAt: agiGeneratedAt ? new Date(agiGeneratedAt).toLocaleString('sv-SE') : '',
                draftCreatedAt: submission?.updatedAt
                  ? ` (${new Date(submission.updatedAt).toLocaleString('sv-SE')})`
                  : '',
              })}{' '}
              {t('stale_draft_click')}{' '}
              <span className="font-medium">{t('unlock_button')}</span>{' '}
              {t('stale_draft_then')}{' '}
              <span className="font-medium">{t('submit_button')}</span>{' '}
              {t('stale_draft_to_sign')}
            </p>
          </div>
        )}

        {/* INCORRECT_DATA branch: skapaGranskningsunderlag returned 409 with
            a felrapport link. The user must open the link in Mina Sidor to
            see what's wrong, fix it, and then re-submit. Without this UI the
            link would be permanently unreachable even though the extension
            persisted it. */}
        {submission?.signeringslank && underlagRejected && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-sm font-medium text-destructive">
              {t('incorrect_data_title')}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {submission.meddelande || t('incorrect_data_description')}
            </p>
            <a
              href={submission.signeringslank}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-destructive hover:underline"
            >
              {t('open_error_report')} <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        )}

        {kontroller.length > 0 && (
          <div className="space-y-1 rounded-md border bg-muted/30 p-2.5">
            {kontroller.map((k, i) => (
              <div
                key={i}
                className={`flex items-start gap-2 text-xs ${
                  k.status === 'STOPP' ? 'text-destructive' : 'text-amber-700 dark:text-amber-400'
                }`}
              >
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  {k.kod && <span className="font-mono">{k.kod} </span>}
                  {k.uppgiftsTyp && <span className="text-muted-foreground">[{k.uppgiftsTyp}{k.specifikationsnummer ? ` #${k.specifikationsnummer}` : ''}] </span>}
                  {k.beskrivning}
                </span>
              </div>
            ))}
          </div>
        )}

        {error && (() => {
          // When the underlying token is expired or its refresh budget is
          // exhausted, the only fix is for the user to re-do the BankID OAuth
          // flow. Surface a reconnect button right next to the error so they
          // don't have to hunt for it in settings.
          const sessionExpired =
            /sessionen har gått ut|logga in med bankid igen/i.test(error) ||
            status?.expired === true ||
            status?.canRefresh === false
          return (
            <div className="rounded-md bg-destructive/10 p-2.5 text-sm text-destructive">
              <AlertCircle className="mr-1 inline h-3.5 w-3.5" />
              {error}
              {sessionExpired && !readOnly && (
                <div className="mt-2">
                  <Button size="sm" variant="outline" onClick={handleConnect}>
                    <Link2 className="mr-1.5 h-3.5 w-3.5" />
                    {t('reconnect_button')}
                  </Button>
                </div>
              )}
            </div>
          )
        })()}
        {success && !error && (
          <div className="rounded-md bg-emerald-50 p-2.5 text-sm text-emerald-900 dark:bg-emerald-900/20 dark:text-emerald-300">
            <CheckCircle2 className="mr-1 inline h-3.5 w-3.5" />
            {success}
          </div>
        )}

        {!readOnly && !isSigned && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={handleDownloadXml}
              disabled={actionLoading === 'download'}
              title={t('download_xml_title')}
            >
              {actionLoading === 'download' ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="mr-1.5 h-3.5 w-3.5" />
              )}
              {t('download_xml_button')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleSubmit}
              disabled={actionLoading === 'submit' || !hasSkatteverket}
              title={
                !hasSkatteverket
                  ? t('submit_upgrade_title')
                  : undefined
              }
            >
              {actionLoading === 'submit' ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="mr-1.5 h-3.5 w-3.5" />
              )}
              {t('submit_button')}
            </Button>
            <Button
              size="sm"
              onClick={handleCreateSigningLink}
              disabled={actionLoading === 'granskning' || !underlagSubmitted}
            >
              {actionLoading === 'granskning' ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Lock className="mr-1.5 h-3.5 w-3.5" />
              )}
              {t('signing_link_button')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleCheckSubmitted}
              disabled={actionLoading === 'check'}
            >
              {actionLoading === 'check' ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="mr-1.5 h-3.5 w-3.5" />
              )}
              {t('check_kvittens_button')}
            </Button>
            {awaitingSigning && (
              <Button
                size="sm"
                variant="ghost"
                onClick={handleUnlock}
                disabled={actionLoading === 'unlock'}
              >
                {actionLoading === 'unlock' ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Unlock className="mr-1.5 h-3.5 w-3.5" />
                )}
                {t('unlock_button')}
              </Button>
            )}
          </div>
        )}

        {!readOnly && !isSigned && !hasSkatteverket && (
          <p className="text-xs text-muted-foreground">
            {t('upgrade_hint_before')}{' '}
            <a href="/settings/billing" className="font-medium underline hover:no-underline">
              {t('upgrade_hint_link')}
            </a>{' '}
            {t('upgrade_hint_after')}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function StatusRow({
  ok,
  okText,
  pendingText,
}: {
  ok: boolean
  okText: string
  pendingText: string
}) {
  return (
    <div className="flex items-center gap-2">
      {ok ? (
        <CheckCircle2 className="h-4 w-4 text-success" />
      ) : (
        <Link2Off className="h-4 w-4 text-muted-foreground" />
      )}
      <span className="text-muted-foreground">{ok ? okText : pendingText}</span>
    </div>
  )
}
