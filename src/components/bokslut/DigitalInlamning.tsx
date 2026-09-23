'use client'

/**
 * Digital inlämning av årsredovisning (iXBRL → Bolagsverket).
 *
 * Three steps below the year-end ÅR editors:
 *   1. Granska: the generated iXBRL rendered in an iframe (the XHTML *is*
 *      the filed presentation) + pre-flight validation results + download
 *      for technical inspection and support diagnostics.
 *   2. Skicka in: only when the bolagsverket extension responds: avtalstext
 *      acceptance → kontrollera-utfall → upload till eget utrymme → kvittens
 *      with "signera hos Bolagsverket"-link. The fastställelseintyg is signed
 *      with e-legitimation at Bolagsverket, never here.
 *   3. Status: submission history driven by webhooks + polling fallback.
 *
 * Year-end surface: copy stays Swedish in both locales (see i18n rules).
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { formatDate } from '@/lib/utils'
import {
  ExternalLink,
  FileDown,
  Loader2,
  RefreshCcw,
  SearchCheck,
  Send,
  ShieldCheck,
} from 'lucide-react'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { CONNECTED_FILING_PUBLIC_RELEASED } from '@/lib/bokslut/arsredovisning/capabilities'
import type { AnnualReportVersionSummary } from '@/lib/bokslut/arsredovisning/compliance-types'

/** Inlämningen till Bolagsverket väntar på avtal + organisationscertifikat
 *  (M0). Tills dess visas hela digital inlämning-sektionen blurrad med en
 *  "Kommer snart"-skylt: endast PDF-nedladdningen på ÅR-sidan är användbar.
 *  Flippa till false när integrationen är godkänd. Importeras också av
 *  ÅR-sidan som blurrar sina Bolagsverket-delar med samma flagga. */
export const INLAMNING_COMING_SOON = !CONNECTED_FILING_PUBLIC_RELEASED

interface PreflightIssue {
  code: string
  severity: 'error' | 'warn'
  message: string
}

interface ValidateResponse {
  ok: boolean
  issues: PreflightIssue[]
  error_count: number
  warning_count: number
  generated_bytes: number
  entry_point: string
}

interface KontrolleraUtfall {
  kod: string
  text: string
  typ: string
}

interface SubmissionRow {
  id: string
  status: string
  environment: string
  kontrollsumma: string | null
  sha256_checksumma: string | null
  bolagsverket_url: string | null
  undertecknare_namn: string | null
  kontrollera_utfall: KontrolleraUtfall[] | null
  error_message: string | null
  uploaded_at: string | null
  registered_at: string | null
  created_at: string
  annual_report_version_id: string | null
  archive_status: 'pending' | 'stored' | 'failed'
}

interface RegistryInformation {
  namn: string
  status: Array<{ kod?: string; text?: string }>
  rakenskapsperioder: Array<{
    from: string
    tom: string
    kravPaRevisionsberattelse: 'ja' | 'nej' | 'uppgift_saknas'
    revisorsplikt: 'ja' | 'nej' | 'uppgift_saknas'
  }>
}

interface RegistryCaseStatus {
  typ: string
  arendenummer: string | null
  rakenskapsperiod: { from: string; tom: string } | null
}

type SubmitOutcome =
  | { outcome: 'avtal_required'; avtalstext: string; avtalstextAndrad: string }
  | { outcome: 'preflight_failed'; issues: PreflightIssue[] }
  | { outcome: 'kontrollera_stopped'; submissionId: string; utfall: KontrolleraUtfall[] }
  | { outcome: 'uploaded'; submissionId: string; url: string; utfall: KontrolleraUtfall[] }
  | { outcome: 'state_unknown'; submissionId: string; url: string | null; message: string }

/**
 * Normalize a Swedish personnummer to the 12-digit ÅÅÅÅMMDDNNNN form the
 * Bolagsverket token API requires. 10-digit input gets its century inferred:
 * a 2-digit year greater than the current year's last two digits → 19xx,
 * otherwise 20xx; the '+' separator (person 100+ years) shifts one more
 * century back. Returns null when the input is neither 10 nor 12 digits.
 */
function normalizePnr(raw: string): string | null {
  const trimmed = raw.trim()
  const digits = trimmed.replace(/\D/g, '')
  if (digits.length === 12) return digits
  if (digits.length !== 10) return null
  const now = new Date()
  const currentCentury = Math.floor(now.getFullYear() / 100)
  const currentYy = now.getFullYear() % 100
  const yy = Number(digits.slice(0, 2))
  let century = yy > currentYy ? currentCentury - 1 : currentCentury
  if (trimmed.includes('+')) century -= 1
  return `${century}${digits}`
}

const STATUS_BADGES: Record<string, { label: string; variant: 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline' }> = {
  draft: { label: 'Utkast', variant: 'outline' },
  kontrollerad: { label: 'Kontrollerad', variant: 'secondary' },
  sending: { label: 'Skickar: avvakta', variant: 'warning' },
  uploaded: { label: 'Uppladdad: väntar på signering', variant: 'warning' },
  unknown: { label: 'Okänd extern status: skicka inte igen', variant: 'destructive' },
  inkommen: { label: 'Inkommen till Bolagsverket', variant: 'secondary' },
  forelagd: { label: 'Föreläggande: åtgärd krävs', variant: 'destructive' },
  komplettering: { label: 'Komplettering inlämnad', variant: 'secondary' },
  registrerad: { label: 'Registrerad', variant: 'success' },
  avslutad: { label: 'Avslutad utan registrering', variant: 'destructive' },
  error: { label: 'Fel', variant: 'destructive' },
}

export function DigitalInlamning({ periodId }: { periodId: string }) {
  const { toast } = useToast()
  const tStudio = useTranslations('annualReportStudio')
  const ixbrlUrl = `/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/ixbrl`

  const [showPreview, setShowPreview] = useState(false)
  const [validating, setValidating] = useState(false)
  const [validation, setValidation] = useState<ValidateResponse | null>(null)

  // Extension availability: probe the status route; 404 = not enabled.
  const [extensionActive, setExtensionActive] = useState<boolean | null>(null)
  const [filingEnabled, setFilingEnabled] = useState(false)
  const [environment, setEnvironment] = useState<string>('test')

  // Submission form
  const [avsandarePnr, setAvsandarePnr] = useState('')
  const [pnr, setPnr] = useState('')
  const [fornamn, setFornamn] = useState('')
  const [efternamn, setEfternamn] = useState('')
  const [roll, setRoll] = useState('Styrelseledamot')
  const [epost, setEpost] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [avtal, setAvtal] = useState<{ text: string; andrad: string; accepted: boolean } | null>(null)
  const [utfall, setUtfall] = useState<KontrolleraUtfall[] | null>(null)
  const [kvittens, setKvittens] = useState<{ url: string } | null>(null)

  const [versions, setVersions] = useState<AnnualReportVersionSummary[]>([])
  const [selectedVersionId, setSelectedVersionId] = useState('')
  const [registryInformation, setRegistryInformation] = useState<RegistryInformation | null>(null)
  const [registryCase, setRegistryCase] = useState<RegistryCaseStatus | null>(null)

  const versionQuery = selectedVersionId
    ? `version=${encodeURIComponent(selectedVersionId)}`
    : ''
  const previewUrl = versionQuery ? `${ixbrlUrl}?${versionQuery}` : ixbrlUrl
  const downloadUrl = `${ixbrlUrl}?download=1${versionQuery ? `&${versionQuery}` : ''}`

  const [submissions, setSubmissions] = useState<SubmissionRow[]>([])
  const [loadingSubmissions, setLoadingSubmissions] = useState(false)
  const [submissionsError, setSubmissionsError] = useState<string | null>(null)
  const [pollingEvents, setPollingEvents] = useState(false)

  useEffect(() => {
    const signer = versions.find((version) => version.id === selectedVersionId)
      ?.certificate_signer
    if (!signer) return
    setFornamn(signer.first_name)
    setEfternamn(signer.last_name)
    setRoll(signer.role)
  }, [selectedVersionId, versions])

  const loadSubmissions = useCallback(async () => {
    setLoadingSubmissions(true)
    try {
      const res = await fetch(
        `/api/extensions/ext/bolagsverket/submissions?fiscal_period_id=${periodId}`,
      )
      if (res.ok) {
        const body = await res.json()
        setSubmissions((body.data ?? []) as SubmissionRow[])
        setSubmissionsError(null)
      } else {
        setSubmissionsError('Kunde inte hämta inlämningshistoriken: försök igen.')
      }
    } catch {
      // Non-blocking: the call sites fire-and-forget (`void loadSubmissions()`),
      // so a network failure must surface here instead of as an unhandled
      // rejection.
      setSubmissionsError('Kunde inte hämta inlämningshistoriken: försök igen.')
    } finally {
      setLoadingSubmissions(false)
    }
  }, [periodId])

  const loadVersions = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/versions`,
      )
      if (!res.ok) return
      const body = await res.json()
      const rows = (body.data ?? []) as AnnualReportVersionSummary[]
      setVersions(rows)
      const latestSigned = rows.find(
        (version) => version.status === 'signed' && version.digital_filing_eligible,
      )
      if (latestSigned) setSelectedVersionId((current) => current || latestSigned.id)
    } catch {
      // The version list is also visible in the studio. Submission stays
      // disabled here until a signed version can be selected.
    }
  }, [periodId])

  useEffect(() => {
    let cancelled = false
    fetch('/api/extensions/ext/bolagsverket/status')
      .then(async (res) => {
        if (cancelled) return
        if (!res.ok) {
          setExtensionActive(false)
          return
        }
        const body = await res.json()
        setExtensionActive(true)
        setFilingEnabled(body.data?.filing_enabled === true)
        setEnvironment(body.data?.environment ?? 'test')
        void loadSubmissions()
        void Promise.all([
          fetch('/api/extensions/ext/bolagsverket/grunduppgifter'),
          fetch('/api/extensions/ext/bolagsverket/arendestatus'),
        ])
          .then(async ([informationResponse, caseResponse]) => {
            if (informationResponse.ok) {
              const informationBody = await informationResponse.json()
              if (!cancelled) setRegistryInformation(informationBody.data as RegistryInformation)
            }
            if (caseResponse.ok) {
              const caseBody = await caseResponse.json()
              if (!cancelled) setRegistryCase(caseBody.data as RegistryCaseStatus)
            }
          })
          .catch(() => undefined)
      })
      .catch(() => {
        if (!cancelled) setExtensionActive(false)
      })
    void loadVersions()
    return () => {
      cancelled = true
    }
  }, [loadSubmissions, loadVersions])

  const handleValidate = async () => {
    setValidating(true)
    try {
      const res = await fetch(
        `${ixbrlUrl}/validate${versionQuery ? `?${versionQuery}` : ''}`,
      )
      const body = await res.json()
      if (body?.error) {
        toast({ title: 'Kunde inte validera', description: getUserErrorMessage(body.error), variant: 'destructive' })
        return
      }
      setValidation(body.data as ValidateResponse)
    } catch {
      toast({ title: 'Kunde inte validera', variant: 'destructive' })
    } finally {
      setValidating(false)
    }
  }

  const handleSubmit = async (opts: { ignoreWarnings?: boolean } = {}) => {
    // The Bolagsverket token API needs 12 digits (ÅÅÅÅMMDDNNNN); 10-digit
    // input is normalized client-side with a century pivot.
    const normalizedAvsandare = normalizePnr(avsandarePnr)
    const normalizedPnr = normalizePnr(pnr)
    if (!normalizedAvsandare || !normalizedPnr) {
      toast({ title: 'Ange personnummer med 10 eller 12 siffror', variant: 'destructive' })
      return
    }
    if (!fornamn.trim() || !efternamn.trim() || !epost.trim()) {
      toast({ title: 'Fyll i undertecknarens namn och e-post', variant: 'destructive' })
      return
    }
    if (!selectedVersionId) {
      toast({ title: 'Lås och underteckna en version före inlämning', variant: 'destructive' })
      return
    }
    setSubmitting(true)
    setUtfall(null)
    try {
      const res = await fetch('/api/extensions/ext/bolagsverket/submissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fiscal_period_id: periodId,
          annual_report_version_id: selectedVersionId,
          avsandare_pnr: normalizedAvsandare,
          undertecknare: {
            pnr: normalizedPnr,
            fornamn: fornamn.trim(),
            efternamn: efternamn.trim(),
            roll,
            epost: epost.trim(),
          },
          ...(avtal?.accepted ? { accepted_avtalstext_andrad: avtal.andrad } : {}),
          ...(opts.ignoreWarnings ? { ignore_warnings: true } : {}),
        }),
      })
      const body = await res.json()
      if (body?.error) {
        toast({ title: 'Inlämningen misslyckades', description: getUserErrorMessage(body.error), variant: 'destructive' })
        return
      }
      const result = body.data as SubmitOutcome
      if (result.outcome === 'avtal_required') {
        setAvtal({ text: result.avtalstext, andrad: result.avtalstextAndrad, accepted: false })
        return
      }
      if (result.outcome === 'preflight_failed') {
        setValidation({
          ok: false,
          issues: result.issues,
          error_count: result.issues.filter((issue) => issue.severity === 'error').length,
          warning_count: result.issues.filter((issue) => issue.severity === 'warn').length,
          generated_bytes: 0,
          entry_point: '',
        })
        toast({
          title: 'Årsredovisningen är inte komplett',
          description: 'Åtgärda punkterna under Granska & validera och försök igen.',
          variant: 'destructive',
        })
        return
      }
      if (result.outcome === 'kontrollera_stopped') {
        setUtfall(result.utfall)
        void loadSubmissions()
        return
      }
      if (result.outcome === 'state_unknown') {
        setKvittens(result.url ? { url: result.url } : null)
        void loadSubmissions()
        toast({
          title: 'Okänd status hos Bolagsverket',
          description: result.message,
          variant: 'destructive',
        })
        return
      }
      setKvittens({ url: result.url })
      setUtfall(result.utfall.length > 0 ? result.utfall : null)
      setAvtal(null)
      void loadSubmissions()
      toast({ title: 'Uppladdad till Bolagsverkets eget utrymme' })
    } catch {
      toast({ title: 'Inlämningen misslyckades', variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }

  const handlePollEvents = async () => {
    setPollingEvents(true)
    try {
      const res = await fetch('/api/extensions/ext/bolagsverket/poll-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const body = await res.json()
      if (body?.error) {
        toast({ title: 'Kunde inte hämta händelser', description: getUserErrorMessage(body.error), variant: 'destructive' })
        return
      }
      void loadSubmissions()
      toast({ title: 'Status uppdaterad från Bolagsverket' })
    } catch {
      toast({ title: 'Kunde inte hämta händelser', variant: 'destructive' })
    } finally {
      setPollingEvents(false)
    }
  }

  const blockingErrors = validation !== null && validation.error_count > 0
  const utfallHasErrors = (utfall ?? []).some((item) => item.typ?.toLowerCase() === 'error')

  return (
    <div className="relative">
      <div
        inert={INLAMNING_COMING_SOON}
        aria-hidden={INLAMNING_COMING_SOON}
        className={
          INLAMNING_COMING_SOON
            ? 'pointer-events-none select-none blur-[3px] opacity-60 space-y-8'
            : 'space-y-8'
        }
      >
      {/* Steg: Granska & validera */}
      <section>
        <div className="mb-1 flex items-center gap-2 px-1">
          <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">Digital inlämning: granska &amp; validera (iXBRL)</h3>
          <div className="h-px flex-1 bg-border/60" />
        </div>
        <p className="px-1 text-sm text-muted-foreground">
          Bolagsverket tar emot årsredovisningen som iXBRL (XHTML). Dokumentet nedan är
          exakt det som lämnas in: granska det som den slutliga presentationen.
        </p>
        <div className="space-y-4 px-1 pt-4 text-sm">
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" onClick={() => setShowPreview((value) => !value)}>
              {showPreview ? 'Dölj förhandsgranskning' : 'Förhandsgranska iXBRL'}
            </Button>
            <Button variant="outline" asChild>
              <a href={downloadUrl}>
                <FileDown className="mr-2 h-4 w-4" /> Ladda ner tekniskt iXBRL-underlag
              </a>
            </Button>
            <Button onClick={() => void handleValidate()} disabled={validating}>
              {validating ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <SearchCheck className="mr-2 h-4 w-4" />
              )}
              Validera
            </Button>
          </div>

          {showPreview && (
            <iframe
              src={previewUrl}
              title="Förhandsgranskning av årsredovisning (iXBRL)"
              className="w-full h-[640px] rounded-lg border border-border bg-white"
            />
          )}

          {validation && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                {validation.ok ? (
                  <Badge variant="success">Klar för inlämning</Badge>
                ) : (
                  <Badge variant="destructive">{validation.error_count} fel</Badge>
                )}
                {validation.warning_count > 0 && (
                  <Badge variant="warning">{validation.warning_count} varningar</Badge>
                )}
              </div>
              {validation.issues.length > 0 && (
                <ul className="space-y-1.5">
                  {validation.issues.map((issue, index) => (
                    <li key={`${issue.code}-${index}`} className="flex gap-2 items-start">
                      <Badge
                        variant={issue.severity === 'error' ? 'destructive' : 'warning'}
                        className="mt-0.5 shrink-0"
                      >
                        {issue.code}
                      </Badge>
                      <span className="text-muted-foreground">{issue.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Steg: Skicka in */}
      <section>
        <div className="mb-1 flex items-center gap-2 px-1">
          <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">Skicka in till Bolagsverket</h3>
          <div className="h-px flex-1 bg-border/60" />
        </div>
        <p className="px-1 text-sm text-muted-foreground">
          Årsredovisningen laddas upp till företagets eget utrymme hos Bolagsverket.
          Undertecknaren får ett e-postmeddelande och signerar fastställelseintyget med
          e-legitimation hos Bolagsverket: först då är årsredovisningen inlämnad.
        </p>
        <div className="space-y-4 px-1 pt-4 text-sm">
          {extensionActive === null && (
            <p className="text-muted-foreground">
              <Loader2 className="inline h-4 w-4 animate-spin mr-2" />
              Kontrollerar anslutningen till Bolagsverket …
            </p>
          )}

          {extensionActive === false && (
            <div className="space-y-3">
              <p className="text-muted-foreground">
                Bolagsverket-integrationen är inte aktiverad i den här installationen.
                Digital inlämning kräver en ansluten programvara. Använd PDF-flödet för
                pappersinlämning per post, eller aktivera integrationen efter avtal,
                organisationscertifikat och godkänt acceptanstest.
              </p>
              <Button variant="outline" asChild>
                <a
                  href="https://bolagsverket.se/foretag/aktiebolag/arsredovisningforaktiebolag.759.html"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="mr-2 h-4 w-4" /> Lämna in hos Bolagsverket
                </a>
              </Button>
            </div>
          )}

          {extensionActive === true && !filingEnabled && (
            <p className="text-muted-foreground">
              Anslutningen finns installerad men säkerhetsgrinden för inlämning är stängd.
              Den öppnas först efter genomförd acceptanstest och produktionsgodkännande.
            </p>
          )}

          {extensionActive === true && filingEnabled && (
            <>
              {environment !== 'prod' && (
                <Badge variant="warning">
                  {environment === 'test' ? 'Testmiljö (statiskt testdata)' : 'Acceptansmiljö'}
                </Badge>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="di-version">Undertecknad årsredovisningsversion</Label>
                <Select
                  value={selectedVersionId}
                  onValueChange={(versionId) => {
                    setSelectedVersionId(versionId)
                    const signer = versions.find((version) => version.id === versionId)
                      ?.certificate_signer
                    if (signer) {
                      setFornamn(signer.first_name)
                      setEfternamn(signer.last_name)
                      setRoll(signer.role)
                    }
                  }}
                >
                  <SelectTrigger id="di-version">
                    <SelectValue placeholder="Välj undertecknad version" />
                  </SelectTrigger>
                  <SelectContent>
                    {versions
                      .filter(
                        (version) =>
                          version.status === 'signed' && version.digital_filing_eligible,
                      )
                      .map((version) => (
                        <SelectItem key={version.id} value={version.id}>
                          Version {version.version_number}: skapad {formatDate(version.created_at)}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                {versions.every(
                  (version) =>
                    version.status !== 'signed' || !version.digital_filing_eligible,
                ) && (
                  <p className="text-xs text-muted-foreground">
                    {tStudio('no_digital_version')}
                  </p>
                )}
                {selectedVersionId && (
                  <p className="text-xs text-muted-foreground">
                    Namn och roll för fastställelseintyget kommer från den låsta versionen och
                    måste vara oförändrade vid inlämning.
                  </p>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="di-avsandare-pnr">Ditt personnummer (avsändare)</Label>
                  <Input
                    id="di-avsandare-pnr"
                   
                    inputMode="numeric"
                    placeholder="ÅÅÅÅMMDDNNNN eller ÅÅMMDD-NNNN"
                    value={avsandarePnr}
                    onChange={(event) => setAvsandarePnr(event.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="di-pnr">Undertecknarens personnummer</Label>
                  <Input
                    id="di-pnr"
                   
                    inputMode="numeric"
                    placeholder="ÅÅÅÅMMDDNNNN eller ÅÅMMDD-NNNN"
                    value={pnr}
                    onChange={(event) => setPnr(event.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="di-fornamn">Undertecknarens förnamn</Label>
                  <Input
                    id="di-fornamn"
                   
                    value={fornamn}
                    onChange={(event) => setFornamn(event.target.value)}
                    readOnly={Boolean(selectedVersionId)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="di-efternamn">Undertecknarens efternamn</Label>
                  <Input
                    id="di-efternamn"
                   
                    value={efternamn}
                    onChange={(event) => setEfternamn(event.target.value)}
                    readOnly={Boolean(selectedVersionId)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="di-roll">Roll</Label>
                  <Select
                    value={roll}
                    onValueChange={setRoll}
                    disabled={Boolean(selectedVersionId)}
                  >
                    <SelectTrigger id="di-roll">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Styrelseledamot">Styrelseledamot</SelectItem>
                      <SelectItem value="Styrelseordförande">Styrelseordförande</SelectItem>
                      <SelectItem value="Verkställande direktör">Verkställande direktör</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="di-epost">Undertecknarens e-post</Label>
                  <Input
                    id="di-epost"
                   
                    type="email"
                    placeholder="namn@foretag.se"
                    value={epost}
                    onChange={(event) => setEpost(event.target.value)}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Personnumren skickas till Bolagsverket för att skapa eget utrymme och bjuda
                in undertecknaren. De sparas inte i Accounted och skrivs inte till loggar.
              </p>

              {registryInformation && (
                <div className="border-t border-border/60 pt-3 text-xs">
                  <p className="font-medium">Grunduppgifter från Bolagsverket</p>
                  <p className="mt-1 text-muted-foreground">
                    {registryInformation.namn}
                    {registryInformation.status[0]?.text
                      ? `: ${registryInformation.status[0].text}`
                      : ''}
                  </p>
                  {registryInformation.rakenskapsperioder[0] && (
                    <p className="mt-1 text-muted-foreground">
                      Senaste period: {registryInformation.rakenskapsperioder[0].from} till{' '}
                      {registryInformation.rakenskapsperioder[0].tom}. Krav på
                      revisionsberättelse:{' '}
                      {registryInformation.rakenskapsperioder[0].kravPaRevisionsberattelse}.
                    </p>
                  )}
                  {registryCase && (
                    <p className="mt-1 text-muted-foreground">
                      Senaste ärendestatus: {registryCase.typ}
                      {registryCase.arendenummer ? `, ärende ${registryCase.arendenummer}` : ''}.
                    </p>
                  )}
                </div>
              )}

              {avtal && (
                <div className="space-y-3 border-y border-border/60 py-4">
                  <p className="font-medium">Villkor för eget utrymme hos Bolagsverket</p>
                  <p className="text-muted-foreground whitespace-pre-wrap text-xs max-h-48 overflow-y-auto">
                    {avtal.text}
                  </p>
                  <label className="flex cursor-pointer items-start gap-3 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={avtal.accepted}
                      onChange={(event) =>
                        setAvtal({ ...avtal, accepted: event.target.checked })
                      }
                    />
                    <span>
                      Jag har tagit del av villkoren och är behörig att företräda företaget.
                    </span>
                  </label>
                </div>
              )}

              {utfall && utfall.length > 0 && (
                <div className="space-y-2">
                  <p className="font-medium">Bolagsverkets kontroll hittade följande:</p>
                  <ul className="space-y-1.5">
                    {utfall.map((item, index) => (
                      <li key={`${item.kod}-${index}`} className="flex gap-2 items-start">
                        <Badge
                          variant={item.typ?.toLowerCase() === 'error' ? 'destructive' : 'warning'}
                          className="mt-0.5 shrink-0"
                        >
                          {item.kod}
                        </Badge>
                        <span className="text-muted-foreground">{item.text}</span>
                      </li>
                    ))}
                  </ul>
                  {!utfallHasErrors && (
                    <p className="text-xs text-muted-foreground">
                      Varningarna hindrar inte inlämning, men minskar risken för
                      föreläggande om de åtgärdas.
                    </p>
                  )}
                </div>
              )}

              <div className="flex flex-wrap gap-3">
                <Button
                 
                  onClick={() => void handleSubmit()}
                  disabled={
                    submitting ||
                    blockingErrors ||
                    !selectedVersionId ||
                    (avtal !== null && !avtal.accepted)
                  }
                >
                  {submitting ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="mr-2 h-4 w-4" />
                  )}
                  {avtal ? 'Godkänn villkoren och skicka in' : 'Kontrollera och skicka in'}
                </Button>
                {utfall && utfall.length > 0 && !utfallHasErrors && (
                  <Button
                   
                    variant="outline"
                    onClick={() => void handleSubmit({ ignoreWarnings: true })}
                    disabled={submitting}
                  >
                    Skicka in trots varningar
                  </Button>
                )}
              </div>

              {kvittens && (
                <div className="space-y-2 border-t border-border/60 pt-4">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-success" />
                    <p className="font-medium">Uppladdad till eget utrymme</p>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    Undertecknaren har fått e-post från Bolagsverket och signerar
                    fastställelseintyget där. Ärendet startar först efter signering.
                  </p>
                  <Button variant="outline" size="sm" asChild>
                    <a href={kvittens.url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="mr-2 h-4 w-4" /> Signera hos Bolagsverket
                    </a>
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* Steg: Status */}
      {extensionActive === true && (
        <section>
          <div className="mb-1 flex items-center gap-2 px-1">
            <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">Inlämningsstatus</h3>
            <div className="h-px flex-1 bg-border/60" />
          </div>
          <p className="px-1 text-sm text-muted-foreground">
            Status uppdateras automatiskt via händelseaviseringar från Bolagsverket.
          </p>
          <div className="space-y-4 px-1 pt-4 text-sm">
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                disabled={pollingEvents}
                onClick={() => void handlePollEvents()}
              >
                {pollingEvents ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCcw className="mr-2 h-4 w-4" />
                )}
                {pollingEvents ? 'Uppdaterar …' : 'Uppdatera status'}
              </Button>
            </div>
            {submissionsError && <p className="text-xs text-destructive">{submissionsError}</p>}
            {loadingSubmissions && submissions.length === 0 && (
              <p className="text-muted-foreground">
                <Loader2 className="inline h-4 w-4 animate-spin mr-2" /> Hämtar …
              </p>
            )}
            {!loadingSubmissions && submissions.length === 0 && !submissionsError && (
              <p className="text-muted-foreground italic">Inga inlämningar ännu.</p>
            )}
            {submissions.map((submission) => {
              const badge = STATUS_BADGES[submission.status] ?? {
                label: submission.status,
                variant: 'outline' as const,
              }
              const envLabel =
                submission.environment === 'prod'
                  ? ''
                  : submission.environment === 'test'
                    ? 'Testmiljö'
                    : submission.environment === 'acceptans'
                      ? 'Acceptansmiljö'
                      : submission.environment.charAt(0).toUpperCase() +
                        submission.environment.slice(1)
              return (
                <div
                  key={submission.id}
                  className="flex flex-col gap-3 border-b border-border pb-3 last:border-b-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="space-y-1">
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {envLabel ? `${envLabel} · ` : ''}
                      {formatDate(submission.created_at)}
                      {submission.undertecknare_namn ? ` · ${submission.undertecknare_namn}` : ''}
                    </p>
                    {submission.status === 'forelagd' && (
                      <p className="text-xs text-destructive">
                        Bolagsverket har skickat ett föreläggande: läs brevet, åtgärda
                        bristerna och lämna in en komplettering (ny inlämning ovan).
                      </p>
                    )}
                    {submission.error_message && (
                      <p className="text-xs text-destructive">{submission.error_message}</p>
                    )}
                  </div>
                  {submission.bolagsverket_url && submission.status === 'uploaded' && (
                    <Button variant="outline" size="sm" asChild>
                      <a href={submission.bolagsverket_url} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="mr-1 h-3.5 w-3.5" /> Signera
                      </a>
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}
      </div>
      {INLAMNING_COMING_SOON && (
        <div className="absolute inset-0 z-10 flex items-center justify-center">
          <div className="rounded-lg border border-border bg-background px-8 py-6 text-center">
            <p className="font-display text-2xl">Kommer snart</p>
            <p className="mt-2 max-w-xs text-sm text-muted-foreground">
              Digital inlämning till Bolagsverket öppnar så snart integrationen
              är godkänd. Tills dess: ladda ner PDF-utkastet ovan.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
