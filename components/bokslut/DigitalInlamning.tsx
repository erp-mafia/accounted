'use client'

/**
 * Digital inlämning av årsredovisning (iXBRL → Bolagsverket).
 *
 * Three steps below the year-end ÅR editors:
 *   1. Granska — the generated iXBRL rendered in an iframe (the XHTML *is*
 *      the filed presentation) + pre-flight validation results + download
 *      for manual filing (the self-hosted/no-extension path).
 *   2. Skicka in — only when the bolagsverket extension responds: avtalstext
 *      acceptance → kontrollera-utfall → upload till eget utrymme → kvittens
 *      with "signera hos Bolagsverket"-link. The fastställelseintyg is signed
 *      with e-legitimation at Bolagsverket, never here.
 *   3. Status — submission history driven by webhooks + polling fallback.
 *
 * Year-end surface: copy stays Swedish in both locales (see i18n rules).
 */

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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

/** Inlämningen till Bolagsverket väntar på avtal + organisationscertifikat
 *  (M0). Tills dess visas hela digital inlämning-sektionen blurrad med en
 *  "Kommer snart"-skylt — endast PDF-nedladdningen på ÅR-sidan är användbar.
 *  Flippa till false när integrationen är godkänd. Importeras också av
 *  ÅR-sidan som blurrar sina Bolagsverket-delar med samma flagga. */
export const INLAMNING_COMING_SOON = true

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
  idnummer: string | null
  kontrollsumma: string | null
  sha256_checksumma: string | null
  bolagsverket_url: string | null
  undertecknare_namn: string | null
  kontrollera_utfall: KontrolleraUtfall[] | null
  error_message: string | null
  uploaded_at: string | null
  registered_at: string | null
  created_at: string
}

type SubmitOutcome =
  | { outcome: 'avtal_required'; avtalstext: string; avtalstextAndrad: string }
  | { outcome: 'preflight_failed'; issues: PreflightIssue[] }
  | { outcome: 'kontrollera_stopped'; submissionId: string; utfall: KontrolleraUtfall[] }
  | { outcome: 'uploaded'; submissionId: string; idnummer: string; url: string; utfall: KontrolleraUtfall[] }

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
  uploaded: { label: 'Uppladdad — väntar på signering', variant: 'warning' },
  inkommen: { label: 'Inkommen till Bolagsverket', variant: 'secondary' },
  forelagd: { label: 'Föreläggande — åtgärd krävs', variant: 'destructive' },
  komplettering: { label: 'Komplettering inlämnad', variant: 'secondary' },
  registrerad: { label: 'Registrerad', variant: 'success' },
  avslutad: { label: 'Avslutad utan registrering', variant: 'destructive' },
  error: { label: 'Fel', variant: 'destructive' },
}

export function DigitalInlamning({ periodId }: { periodId: string }) {
  const { toast } = useToast()
  const ixbrlUrl = `/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/ixbrl`

  const [showPreview, setShowPreview] = useState(false)
  const [validating, setValidating] = useState(false)
  const [validation, setValidation] = useState<ValidateResponse | null>(null)

  // Extension availability: probe the status route; 404 = not enabled.
  const [extensionActive, setExtensionActive] = useState<boolean | null>(null)
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
  const [kvittens, setKvittens] = useState<{ idnummer: string; url: string } | null>(null)

  // Proposed dividend (utdelning) for the resultatdisposition. There is no
  // persisted dividend proposal in the year-end flow yet, so the value is
  // entered here and forwarded to the preview, the download and the
  // submission so all three render the same disposition.
  const [utdelning, setUtdelning] = useState('')
  const parsedUtdelning = Math.round(Number(utdelning.replace(/\s/g, '').replace(',', '.')))
  const utdelningValue = Number.isFinite(parsedUtdelning) && parsedUtdelning > 0 ? parsedUtdelning : 0
  const previewUrl = utdelningValue > 0 ? `${ixbrlUrl}?utdelning=${utdelningValue}` : ixbrlUrl
  const downloadUrl =
    utdelningValue > 0 ? `${ixbrlUrl}?download=1&utdelning=${utdelningValue}` : `${ixbrlUrl}?download=1`

  const [submissions, setSubmissions] = useState<SubmissionRow[]>([])
  const [loadingSubmissions, setLoadingSubmissions] = useState(false)
  const [submissionsError, setSubmissionsError] = useState<string | null>(null)

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
        setSubmissionsError('Kunde inte hämta inlämningshistoriken — försök igen.')
      }
    } catch {
      // Non-blocking: the call sites fire-and-forget (`void loadSubmissions()`),
      // so a network failure must surface here instead of as an unhandled
      // rejection.
      setSubmissionsError('Kunde inte hämta inlämningshistoriken — försök igen.')
    } finally {
      setLoadingSubmissions(false)
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
        setEnvironment(body.data?.environment ?? 'test')
        void loadSubmissions()
      })
      .catch(() => {
        if (!cancelled) setExtensionActive(false)
      })
    return () => {
      cancelled = true
    }
  }, [loadSubmissions])

  const handleValidate = async () => {
    setValidating(true)
    try {
      const res = await fetch(
        `${ixbrlUrl}/validate${utdelningValue > 0 ? `?utdelning=${utdelningValue}` : ''}`,
      )
      const body = await res.json()
      if (body?.error) {
        toast({ title: 'Kunde inte validera', description: body.error.message, variant: 'destructive' })
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
    setSubmitting(true)
    setUtfall(null)
    try {
      const res = await fetch('/api/extensions/ext/bolagsverket/submissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fiscal_period_id: periodId,
          avsandare_pnr: normalizedAvsandare,
          undertecknare: {
            pnr: normalizedPnr,
            fornamn: fornamn.trim(),
            efternamn: efternamn.trim(),
            roll,
            epost: epost.trim(),
          },
          ...(utdelningValue > 0 ? { utdelning: utdelningValue } : {}),
          ...(avtal?.accepted ? { accepted_avtalstext_andrad: avtal.andrad } : {}),
          ...(opts.ignoreWarnings ? { ignore_warnings: true } : {}),
        }),
      })
      const body = await res.json()
      if (body?.error) {
        toast({ title: 'Inlämningen misslyckades', description: body.error.message, variant: 'destructive' })
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
      setKvittens({ idnummer: result.idnummer, url: result.url })
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
    try {
      const res = await fetch('/api/extensions/ext/bolagsverket/poll-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const body = await res.json()
      if (body?.error) {
        toast({ title: 'Kunde inte hämta händelser', description: body.error.message, variant: 'destructive' })
        return
      }
      void loadSubmissions()
      toast({ title: 'Status uppdaterad från Bolagsverket' })
    } catch {
      toast({ title: 'Kunde inte hämta händelser', variant: 'destructive' })
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
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Digital inlämning — granska &amp; validera (iXBRL)</CardTitle>
          <p className="text-sm text-muted-foreground">
            Bolagsverket tar emot årsredovisningen som iXBRL (XHTML). Dokumentet nedan är
            exakt det som lämnas in — granska det som den slutliga presentationen.
          </p>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="space-y-1.5 max-w-xs">
            <Label htmlFor="di-utdelning">Föreslagen utdelning (kr)</Label>
            <Input
              id="di-utdelning"
              inputMode="numeric"
              placeholder="0"
              value={utdelning}
              onChange={(event) => setUtdelning(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Ingår i resultatdispositionen i dokumentet — 0 betyder att allt
              balanseras i ny räkning. Beloppet följer med förhandsgranskning,
              nedladdning och inlämning.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" onClick={() => setShowPreview((value) => !value)}>
              {showPreview ? 'Dölj förhandsgranskning' : 'Förhandsgranska iXBRL'}
            </Button>
            <Button variant="outline" asChild>
              <a href={downloadUrl}>
                <FileDown className="mr-2 h-4 w-4" /> Ladda ner iXBRL (.xhtml)
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
        </CardContent>
      </Card>

      {/* Steg: Skicka in */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Skicka in till Bolagsverket</CardTitle>
          <p className="text-sm text-muted-foreground">
            Årsredovisningen laddas upp till företagets eget utrymme hos Bolagsverket.
            Undertecknaren får ett e-postmeddelande och signerar fastställelseintyget med
            e-legitimation hos Bolagsverket — först då är årsredovisningen inlämnad.
          </p>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
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
                Ladda ner iXBRL-filen ovan och lämna in den manuellt via Bolagsverkets
                e-tjänst, eller aktivera integrationen (kräver avtal med Bolagsverket och
                organisationscertifikat).
              </p>
              <Button variant="outline" asChild>
                <a
                  href="https://www.bolagsverket.se/foretag/aktiebolag/arsredovisning/lamna-in-arsredovisning"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="mr-2 h-4 w-4" /> Lämna in hos Bolagsverket
                </a>
              </Button>
            </div>
          )}

          {extensionActive === true && (
            <>
              {environment !== 'prod' && (
                <Badge variant="warning">
                  {environment === 'test' ? 'Testmiljö (statiskt testdata)' : 'Acceptansmiljö'}
                </Badge>
              )}

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
                  <Input id="di-fornamn" value={fornamn} onChange={(event) => setFornamn(event.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="di-efternamn">Undertecknarens efternamn</Label>
                  <Input id="di-efternamn" value={efternamn} onChange={(event) => setEfternamn(event.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="di-roll">Roll</Label>
                  <select
                    id="di-roll"
                    className="border border-border rounded-md h-9 text-sm px-2 bg-background w-full"
                    value={roll}
                    onChange={(event) => setRoll(event.target.value)}
                  >
                    <option>Styrelseledamot</option>
                    <option>Styrelseordförande</option>
                    <option>Verkställande direktör</option>
                  </select>
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
                in undertecknaren. De sparas inte i Accounted — endast en teknisk
                referens (hash) lagras.
              </p>

              {avtal && (
                <div className="rounded-lg border border-border p-4 space-y-3">
                  <p className="font-medium">Villkor för eget utrymme hos Bolagsverket</p>
                  <p className="text-muted-foreground whitespace-pre-wrap text-xs max-h-48 overflow-y-auto">
                    {avtal.text}
                  </p>
                  <label className="flex items-start gap-2 text-sm">
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
                  disabled={submitting || blockingErrors || (avtal !== null && !avtal.accepted)}
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
                <div className="rounded-lg border border-border p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4" />
                    <p className="font-medium">Uppladdad till eget utrymme</p>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    Dokument-id: <span className="tabular-nums">{kvittens.idnummer}</span>.
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
        </CardContent>
      </Card>

      {/* Steg: Status */}
      {extensionActive === true && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Inlämningsstatus</CardTitle>
            <p className="text-sm text-muted-foreground">
              Status uppdateras automatiskt via händelseaviseringar från Bolagsverket.
            </p>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={() => void handlePollEvents()}>
                <RefreshCcw className="mr-2 h-4 w-4" /> Uppdatera status
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
                  className="flex items-start justify-between gap-4 border-b border-border last:border-b-0 pb-3 last:pb-0"
                >
                  <div className="space-y-1">
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {envLabel ? `${envLabel} · ` : ''}
                      {formatDate(submission.created_at)}
                      {submission.idnummer ? ` · id ${submission.idnummer}` : ''}
                      {submission.undertecknare_namn ? ` · ${submission.undertecknare_namn}` : ''}
                    </p>
                    {submission.status === 'forelagd' && (
                      <p className="text-xs text-destructive">
                        Bolagsverket har skickat ett föreläggande — läs brevet, åtgärda
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
          </CardContent>
        </Card>
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
