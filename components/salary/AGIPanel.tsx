'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Circle,
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
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { useToast } from '@/components/ui/use-toast'
import { UpgradeNote } from '@/components/billing/UpgradeNote'
import { useCapability } from '@/contexts/CompanyContext'
import { isAllowedSkvPopupOrigin } from '@/lib/skatteverket/popup-origin'
import { CAPABILITY } from '@/lib/entitlements/keys'
import {
  resolveRunAgiSubmission,
  type AgiSubmissionState,
} from '@/lib/salary/agi-submission-state'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

interface AGIPanelProps {
  salaryRunId: string
  /** Skatteverket arbetsgivare ID (12-digit): formatted by parent. */
  arbetsgivare: string
  /** YYYYMM */
  period: string
  /** Already-cached run-level signals for showing what step we're at. */
  agiGeneratedAt?: string | null
  agiSubmittedAt?: string | null
  /**
   * Per-period submission record, owned by the parent (via useAgiSubmission)
   * so the progress rail and hero can render the same state machine.
   *
   * Deliberately period-scoped, matching Skatteverket: the underlag, the
   * granskningsunderlag lock and lasUpp all address a redovisningsperiod, not
   * a run. What is run-scoped is the filing receipt, and the panel narrows the
   * record itself (see `runSubmission` below) rather than asking the parent to.
   */
  submission: AgiSubmissionState | null
  /** Refetch the submission record after a state-changing action. */
  onRefreshSubmission: () => void
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

/** One-click chain steps, in execution order. */
const CHAIN_STEPS = ['generate', 'submit', 'kontroll', 'link'] as const
type ChainStep = (typeof CHAIN_STEPS)[number]

interface ChainProgress {
  current: ChainStep
  failed: boolean
  done: boolean
}

/**
 * Sentinel for chain aborts where the failing step already surfaced its
 * error via setError/setKontroller: the catch block must not overwrite it.
 */
class ChainFailed extends Error {}

/**
 * Extract a human message from either the canonical { error: { message } }
 * envelope (internal routes) or a plain { error: string } (extension routes).
 */
function errText(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const err = (data as { error?: unknown }).error
  if (typeof err === 'string') return err
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message
  }
  return null
}

export function AGIPanel(props: AGIPanelProps) {
  const {
    salaryRunId,
    arbetsgivare,
    period,
    agiGeneratedAt,
    agiSubmittedAt,
    submission,
    onRefreshSubmission,
    readOnly,
    onChange,
  } = props

  const t = useTranslations('salary_agi')
  const { toast } = useToast()
  const hasSkatteverket = useCapability(CAPABILITY.skatteverket)

  const [extensionDisabled, setExtensionDisabled] = useState(false)
  const [status, setStatus] = useState<ConnectionStatus | null>(null)
  const [kontroller, setKontroller] = useState<KontrollFinding[]>([])
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [chain, setChain] = useState<ChainProgress | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  // True while an OAuth tab opened from this panel is still alive. Disables
  // the connect buttons so a second click cannot start a parallel flow: each
  // /authorize call overwrites the stored oauth_state + PKCE verifier, so a
  // parallel flow guarantees a CSRF failure for whichever tab finishes last.
  const [connecting, setConnecting] = useState(false)

  // "2026-06" for user-facing copy; the period prop is compact YYYYMM.
  const prettyPeriod = `${period.slice(0, 4)}-${period.slice(4)}`

  // ── Derived filing state (needed by hooks, so derived before any return) ──
  // Two scopes live side by side below, deliberately.
  //
  // PERIOD scope (`submission`): the in-flight machine. Skatteverket locks a
  // redovisningsperiod, not a run, so when a corrected month holds two runs the
  // second one must still see, and be able to unlock, the draft that blocks it.
  const subState = submission?.status
  const awaitingSigning = subState === 'awaiting_signing'
  const underlagSubmitted = subState === 'underlag_submitted'
  const underlagRejected = subState === 'underlag_rejected'
  // RUN scope (`runSubmission`): the filing receipt. A correction is a complete
  // replacement declaration for the same period (same specifikationsnummer per
  // employee) filed on its own, so it gets its OWN kvittens. Reading the period
  // record raw here would render the correction as already filed and print the
  // superseded declaration's kvittensnummer on it.
  const runSubmission = resolveRunAgiSubmission(
    { id: salaryRunId, agi_generated_at: agiGeneratedAt, agi_submitted_at: agiSubmittedAt },
    submission,
  )
  const isSigned = runSubmission?.status === 'signed' || !!agiSubmittedAt
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

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  // Handle of the OAuth tab opened by handleConnect: used to verify the
  // sender identity of incoming postMessages and to detect abandonment.
  const popupRef = useRef<Window | null>(null)
  const watchTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const delayedRefetchRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stopWatchingOauthTab = useCallback(() => {
    if (watchTimerRef.current) {
      clearInterval(watchTimerRef.current)
      watchTimerRef.current = null
    }
    setConnecting(false)
  }, [])

  useEffect(() => {
    return () => {
      if (watchTimerRef.current) clearInterval(watchTimerRef.current)
      if (delayedRefetchRef.current) clearTimeout(delayedRefetchRef.current)
    }
  }, [])

  // Listen for OAuth completion from the BankID popup. When the popup posts
  // back a success/error message we re-fetch status so the panel flips from
  // "expired" / not-connected to "Ansluten" without a full page reload.
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      // The popup runs on the pinned SKV OAuth host, which differs from the
      // app origin after the app.accounted.se cutover.
      if (!isAllowedSkvPopupOrigin(event.origin, window.location.origin)) return
      // Source-identity check: only the popup this component opened can
      // trigger the handler; a window reference cannot be forged by other
      // same-origin scripts.
      if (!popupRef.current || event.source !== popupRef.current) return
      if (event.data?.type === 'skatteverket-oauth-success') {
        stopWatchingOauthTab()
        setError(null)
        setSuccess(t('oauth_success'))
        fetchStatus()
        // Verified success: rebroadcast as an internal DOM event so passive
        // consumers (e.g. the salary page) can react without trusting raw
        // postMessage.
        window.dispatchEvent(new CustomEvent('skatteverket-connection-updated'))
        // The post-connect refresh (skattekonto sync, AGI settle, token
        // health) now runs server-side AFTER the callback responds, so the
        // status fetched above predates it. Refetch once more when it has
        // plausibly settled so synced data and health flags show up
        // without a manual reload.
        if (delayedRefetchRef.current) clearTimeout(delayedRefetchRef.current)
        delayedRefetchRef.current = setTimeout(() => {
          fetchStatus()
          window.dispatchEvent(new CustomEvent('skatteverket-connection-updated'))
        }, 15_000)
      } else if (event.data?.type === 'skatteverket-oauth-error') {
        stopWatchingOauthTab()
        const reason =
          typeof event.data.reason === 'string' && event.data.reason
            ? event.data.reason
            : t('oauth_error_fallback')
        setError(reason)
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [fetchStatus, stopWatchingOauthTab, t])

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

  // Loud success when the filing completes: a poll (live timers, tab refocus,
  // or the parent's refresh) flips isSigned while the user is on the page.
  // The ref starts null so an already-signed run doesn't toast on mount.
  const prevSignedRef = useRef<boolean | null>(null)
  useEffect(() => {
    if (prevSignedRef.current === false && isSigned) {
      toast({
        title: t('toast_signed_title'),
        description: t('toast_signed_description', { period: prettyPeriod }),
      })
    }
    prevSignedRef.current = isSigned
  }, [isSigned, toast, t, prettyPeriod])

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
      onRefreshSubmission()
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
  }, [arbetsgivare, period, onRefreshSubmission, onChange, t])

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
    // No disconnect while an OAuth tab is in flight: the callback completing
    // right after the disconnect would silently recreate the tokens.
    if (connecting) return
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
      onRefreshSubmission()
    } catch (e) {
      setError(e instanceof Error ? getUserErrorMessage(e) : t('disconnect_failed'))
    } finally {
      setActionLoading(null)
    }
  }, [connecting, fetchStatus, onRefreshSubmission, t])

  const handleConnect = () => {
    // Open the BankID OAuth flow in a NEW TAB, not a popup. The old 600x750
    // popup could not fit Skatteverket's consent page: the approve button
    // sat below the fold and users got stranded mid-consent. A tab gets the
    // full viewport (and behaves natively on mobile). The callback page
    // detects `window.opener` and posts back a `skatteverket-oauth-success`
    // (or `-error`) message, then closes itself: see the postMessage
    // listener below. `return_to` is still passed so the tab-blocked
    // fallback path lands on the salary run page rather than the default
    // /reports tab.
    const returnTo = typeof window !== 'undefined'
      ? window.location.pathname + window.location.search
      : ''
    const url = `/api/extensions/ext/skatteverket/authorize${
      returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : ''
    }`
    const tab = window.open(url, '_blank')
    popupRef.current = tab
    if (!tab) {
      // Tab blocked: fall back to a full-page navigation.
      window.location.href = url
      return
    }
    setConnecting(true)
    // Detect abandonment: if the tab goes away without posting a message
    // (closed manually, stranded on Skatteverket's side), re-enable the
    // buttons and refresh status. This also fires after a successful
    // self-close; the extra status fetch is harmless.
    if (watchTimerRef.current) clearInterval(watchTimerRef.current)
    watchTimerRef.current = setInterval(() => {
      if (popupRef.current?.closed) {
        stopWatchingOauthTab()
        fetchStatus()
      }
    }, 1000)
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
   * The XML must exist in agi_declarations before anything can be submitted.
   * The internal xml route both generates and persists it (and stamps
   * agi_generated_at); the response body, the downloadable file itself, is
   * discarded here: "Ladda ner AGI-fil" remains the way to get a copy.
   */
  async function ensureAgiGenerated(): Promise<boolean> {
    if (agiGeneratedAt) return true
    const res = await fetch(`/api/salary/runs/${salaryRunId}/agi/xml`)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(errText(data) || t('xml_generate_failed'))
      return false
    }
    onChange?.() // parent refetches the run so agiGeneratedAt flips
    return true
  }

  /**
   * POST the stored XML underlag, then poll kontrollresultat until status
   * flips out of PROCESSING. Skatteverket's spec says polling is usually
   * instantaneous, but we cap at 8 attempts × 1s to be safe.
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
   *
   * Failures surface via setError/setKontroller and return false. Shared by
   * the one-click chain and the advanced "Skicka in underlag" button;
   * `onKontrollPhase` lets the chain advance its stepper when polling starts.
   */
  async function runSubmitUnderlag(onKontrollPhase?: () => void): Promise<boolean> {
    setKontroller([])
    const submitRes = await fetch('/api/extensions/ext/skatteverket/agi/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ salaryRunId }),
    })
    const submitJson = await submitRes.json()
    if (!submitRes.ok || submitJson.error) {
      setError(submitJson.error || t('submit_failed_status', { status: submitRes.status }))
      return false
    }
    const inlamningId = submitJson.data?.inlamningId as number | undefined
    if (!inlamningId) {
      setError(t('submit_missing_id'))
      return false
    }

    // Poll kontrollresultat until DONE_*
    onKontrollPhase?.()
    let kr: Kontrollresultat | undefined
    for (let attempt = 0; attempt < 8; attempt++) {
      const krRes = await fetch(
        `/api/extensions/ext/skatteverket/agi/kontrollresultat?inlamningId=${inlamningId}`,
      )
      const krJson = await krRes.json()
      if (!krRes.ok || krJson.error) {
        setError(krJson.error || t('kontrollresultat_failed_status', { status: krRes.status }))
        return false
      }
      kr = krJson.data as Kontrollresultat
      if (kr.status !== 'PROCESSING') break
      await new Promise(r => setTimeout(r, 1000))
    }
    if (!kr || kr.status === 'PROCESSING') {
      setError(t('still_processing'))
      return false
    }

    const findings = extractFindings(kr)
    setKontroller(findings)

    if (kr.status === 'DONE_SUCCESS') return true
    if (kr.status === 'DONE_REJECTED') {
      setError(t('underlag_rejected_error', { count: findings.filter(f => f.status === 'STOPP').length }))
    } else {
      setError(t('underlag_failed'))
    }
    return false
  }

  /**
   * skapaGranskningsunderlag: returns the Mina Sidor deep-link the user opens
   * to sign with BankID. Defaults to `lasPeriod=true` so the period is locked
   * while the signing window is open. Returns the link on success ('' when
   * the response carried none: the signing-link card renders it after the
   * submission refresh) and null on failure (error already surfaced).
   */
  async function runCreateSigningLink(): Promise<string | null> {
    const res = await fetch(
      `/api/extensions/ext/skatteverket/agi/granskningsunderlag?arbetsgivare=${encodeURIComponent(arbetsgivare)}&period=${period}`,
      { method: 'POST' },
    )
    const json = await res.json()
    if (!res.ok || json.error) {
      setError(json.error || t('signing_link_failed_status', { status: res.status }))
      return null
    }
    if (json.data?.tillstand === 'INCORRECT_DATA') {
      setError(t('incorrect_data_error', { message: json.data.meddelande || t('incorrect_data_fallback') }))
      return null
    }
    // The user typically opens the link, signs in Mina Sidor, then returns
    // later (or never). Auto-poll so we capture the kvittens (and stamp
    // agi_submitted_at) without forcing the user to click "Hämta kvittens".
    scheduleKvittensPolls()
    return typeof json.data?.link === 'string' ? json.data.link : ''
  }

  /**
   * One-click filing: generate (if missing) → POST underlag → poll kontroll →
   * create signing link → hand over to BankID signing in Mina Sidor.
   *
   * The signing link opens in a tab we open synchronously at click time:
   * window.open after the async chain would be popup-blocked. On failure the
   * placeholder tab is closed and the error renders in the panel; if the
   * popup was blocked outright, the signing-link card (rendered from the
   * refreshed submission state) is the fallback path.
   */
  const handleSubmitChain = async () => {
    setActionLoading('chain')
    setError(null)
    setSuccess(null)
    let signingTab: Window | null = null
    try {
      signingTab = window.open('', '_blank')
      if (signingTab) {
        signingTab.document.title = t('chain_tab_title')
        signingTab.document.body.textContent = t('chain_tab_body')
      }
    } catch {
      signingTab = null
    }
    try {
      setChain({ current: 'generate', failed: false, done: false })
      if (!(await ensureAgiGenerated())) throw new ChainFailed()

      setChain({ current: 'submit', failed: false, done: false })
      const submitted = await runSubmitUnderlag(() =>
        setChain({ current: 'kontroll', failed: false, done: false }),
      )
      if (!submitted) throw new ChainFailed()

      setChain({ current: 'link', failed: false, done: false })
      const link = await runCreateSigningLink()
      if (link === null) throw new ChainFailed()

      setChain({ current: 'link', failed: false, done: true })
      setSuccess(t('chain_ready_to_sign'))
      if (signingTab && link) {
        signingTab.location.replace(link)
        signingTab = null // handed over to Skatteverket: don't close it below
      } else {
        signingTab?.close()
        signingTab = null
      }
      onRefreshSubmission()
      onChange?.()
    } catch (e) {
      signingTab?.close()
      setChain(prev => (prev ? { ...prev, failed: true } : prev))
      if (!(e instanceof ChainFailed)) {
        setError(e instanceof Error ? getUserErrorMessage(e) : t('submit_failed'))
      }
      onRefreshSubmission()
    } finally {
      setActionLoading(null)
    }
  }

  // Always-free: generate + download the AGI XML so the user can file manually
  // in Skatteverket's e-service. AGI is a mandatory statutory filing, so this
  // path must never be paywalled: only the direct API submission is paid.
  const handleDownloadXml = async () => {
    setActionLoading('download')
    setError(null)
    try {
      const res = await fetch(`/api/salary/runs/${salaryRunId}/agi/xml`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(errText(data) || t('xml_generate_failed'))
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
      setError(e instanceof Error ? getUserErrorMessage(e) : t('xml_download_failed'))
    } finally {
      setActionLoading(null)
    }
  }

  /** Advanced/recovery variant: submit the underlag without continuing the chain. */
  const handleSubmit = async () => {
    setActionLoading('submit')
    setError(null)
    setSuccess(null)
    try {
      if (!(await ensureAgiGenerated())) return
      const ok = await runSubmitUnderlag()
      if (ok) setSuccess(t('underlag_accepted'))
      onRefreshSubmission()
      onChange?.()
    } catch (e) {
      setError(e instanceof Error ? getUserErrorMessage(e) : t('submit_failed'))
    } finally {
      setActionLoading(null)
    }
  }

  /** Advanced/recovery variant: create the signing link on its own. */
  const handleCreateSigningLink = async () => {
    setActionLoading('granskning')
    setError(null)
    setSuccess(null)
    try {
      const link = await runCreateSigningLink()
      if (link !== null) setSuccess(t('signing_link_ready'))
      onRefreshSubmission()
    } catch (e) {
      setError(e instanceof Error ? getUserErrorMessage(e) : t('signing_link_failed'))
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
      onRefreshSubmission()
    } catch (e) {
      setError(e instanceof Error ? getUserErrorMessage(e) : t('unlock_failed'))
    } finally {
      setActionLoading(null)
    }
  }

  /**
   * Post-signing recovery: poll /agi/kvittenser to detect that the user has
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
      onRefreshSubmission()
      onChange?.()
    } catch (e) {
      setError(e instanceof Error ? getUserErrorMessage(e) : t('check_status_failed'))
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
              <code className="mx-1 rounded-sm bg-muted px-1 py-0.5 text-xs">SKATTEVERKET_ENABLED</code>
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
            <Button onClick={handleConnect} disabled={connecting}>
              <Link2 className="mr-2 h-4 w-4" />
              {connecting ? t('connect_waiting') : t('connect_button')}
            </Button>
          )}
        </CardContent>
      </Card>
    )
  }

  // Tokens issued before the agd scope was added to DEFAULT_SCOPES will
  // 403 with invalid_scope at submission time: surface that proactively
  // so the user reconnects before hitting the deadline rather than at it.
  const missingAgdScope =
    typeof status?.scope === 'string' &&
    !status.scope.split(/\s+/).filter(Boolean).includes('agd')

  // Recovery states expose the advanced actions on their own: the stale-draft
  // and error-report guidance below reference them by name.
  const forcedAdvanced = draftIsStale || underlagRejected
  const advancedOpen = showAdvanced || forcedAdvanced

  const signedAtRaw = runSubmission?.signeradTid ?? agiSubmittedAt ?? null
  const signedAtText = signedAtRaw ? new Date(signedAtRaw).toLocaleString('sv-SE') : null

  const chainStepState = (step: ChainStep): 'done' | 'running' | 'failed' | 'upcoming' => {
    if (!chain) return 'upcoming'
    const idx = CHAIN_STEPS.indexOf(step)
    const currentIdx = CHAIN_STEPS.indexOf(chain.current)
    if (idx < currentIdx || (idx === currentIdx && chain.done)) return 'done'
    if (idx === currentIdx) return chain.failed ? 'failed' : 'running'
    return 'upcoming'
  }

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
                disabled={actionLoading === 'disconnect' || connecting}
                className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground transition-colors hover:border-destructive/50 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
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
        {/* Filed: the terminal state deserves more than a gray status row.
            Kvittensnummer + signature metadata come from the run-scoped
            record; a run stamped only via agi_submitted_at (e.g. cron
            reconciliation with an evicted cache, or an original whose cached
            receipt a later correction has replaced) still gets the card, just
            without a number: better than showing another declaration's. */}
        {isSigned && (
          <div className="rounded-lg border border-border bg-muted/30 p-4">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" />
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {t('success_card_title', { period: prettyPeriod })}
                </p>
                {runSubmission?.kvittensnummer && (
                  <p className="text-sm text-muted-foreground tabular-nums">
                    {t('success_card_kvittens', { kvittens: runSubmission.kvittensnummer })}
                  </p>
                )}
                {(runSubmission?.signeradAv || signedAtText) && (
                  <p className="text-sm text-muted-foreground">
                    {runSubmission?.signeradAv
                      ? signedAtText
                        ? t('success_card_signed_by_at', {
                            name: runSubmission.signeradAv,
                            date: signedAtText,
                          })
                        : t('success_card_signed_by', { name: runSubmission.signeradAv })
                      : t('success_card_signed_at', { date: signedAtText ?? '' })}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Expired-session banner: the token row exists (so status.connected
            is true) but the access token is past expiry and either has no
            refresh token or has burned through its 10-refresh budget. The
            only fix is a fresh BankID round-trip. */}
        {(status?.expired === true || status?.canRefresh === false) && !readOnly && (
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <p className="text-sm font-medium">{t('expired_banner_title')}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('expired_banner_description')}
            </p>
            <Button size="sm" variant="outline" className="mt-2" onClick={handleConnect} disabled={connecting}>
              <Link2 className="mr-1.5 h-3.5 w-3.5" />
              {connecting ? t('connect_waiting') : t('reconnect_button')}
            </Button>
          </div>
        )}

        {/* Missing-scope banner: proactive nudge before the user hits a
            403 invalid_scope at submission time. The agd scope was added
            after some users had already connected, so their stored token
            grants moms/skattekonto but not AGI. */}
        {missingAgdScope && !readOnly && (
          <div className="rounded-lg border border-border bg-muted/30 p-3">
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
              runSubmission?.kvittensnummer
                ? t('submitted_with_kvittens', { kvittens: runSubmission.kvittensnummer })
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
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <p className="text-sm font-medium">
              <InfoTooltip variant="help" content={t('granskningsunderlag_gloss')}>
                {t('draft_locked_title')}
              </InfoTooltip>
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('draft_locked_description')}
            </p>
            <a
              href={submission.signeringslank}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-sm font-medium hover:underline"
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
          <div className="rounded-lg border border-border bg-muted/30 p-3">
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
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
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
          <div className="space-y-1 rounded-lg border bg-muted/30 p-3">
            {kontroller.map((k, i) => (
              <div
                key={i}
                className={`flex items-start gap-2 text-xs ${
                  k.status === 'STOPP' ? 'text-destructive' : 'text-warning'
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
            <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="mr-1 inline h-3.5 w-3.5" />
              {error}
              {sessionExpired && !readOnly && (
                <div className="mt-2">
                  <Button size="sm" variant="outline" onClick={handleConnect} disabled={connecting}>
                    <Link2 className="mr-1.5 h-3.5 w-3.5" />
                    {connecting ? t('connect_waiting') : t('reconnect_button')}
                  </Button>
                </div>
              )}
            </div>
          )
        })()}
        {success && !error && (
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
            <CheckCircle2 className="mr-1 inline h-3.5 w-3.5 text-success" />
            {success}
          </div>
        )}

        {!readOnly && !isSigned && (
          <div className="space-y-3">
            {/* Primary path: one click runs the whole filing chain. Hidden
                while a signing draft is open at SKV (the period is locked,
                so a resubmission would be refused): the signing-link card
                above is the CTA then, and the stale-draft recovery goes
                through the advanced actions per the guidance text. The
                XML download stays free for manual filing regardless. */}
            <div className="flex flex-wrap items-center gap-2">
              {!awaitingSigning && (
                <Button
                  onClick={handleSubmitChain}
                  disabled={actionLoading !== null || !hasSkatteverket}
                >
                  {actionLoading === 'chain' ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="mr-2 h-4 w-4" />
                  )}
                  {t('chain_button')}
                </Button>
              )}
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
            </div>

            {chain && (
              <ol className="space-y-1.5 rounded-lg border border-border bg-muted/30 p-3">
                {CHAIN_STEPS.map(step => {
                  const state = chainStepState(step)
                  return (
                    <li key={step} className="flex items-center gap-2 text-xs">
                      {state === 'done' ? (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
                      ) : state === 'running' ? (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                      ) : state === 'failed' ? (
                        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                      ) : (
                        <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                      )}
                      <span className={state === 'upcoming' ? 'text-muted-foreground' : ''}>
                        {t(`chain_step_${step}`)}
                      </span>
                    </li>
                  )
                })}
              </ol>
            )}

            {/* Recovery/expert actions: each is one step of the chain above,
                for resuming after a partial failure. Auto-expanded when a
                recovery state (stale draft, rejected underlag) references
                them by name. */}
            <div>
              {!forcedAdvanced && (
                <button
                  type="button"
                  onClick={() => setShowAdvanced(v => !v)}
                  className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  {advancedOpen ? t('advanced_hide') : t('advanced_show')}
                </button>
              )}
              {advancedOpen && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleSubmit}
                    disabled={actionLoading !== null || !hasSkatteverket}
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
                    variant="outline"
                    onClick={handleCreateSigningLink}
                    disabled={actionLoading !== null || !underlagSubmitted}
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
                    disabled={actionLoading !== null}
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
                      disabled={actionLoading !== null}
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
            </div>
          </div>
        )}

        {!readOnly && !isSigned && !hasSkatteverket && (
          <UpgradeNote>{t('upgrade_note')}</UpgradeNote>
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
