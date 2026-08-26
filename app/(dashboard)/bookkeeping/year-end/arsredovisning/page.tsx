'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/ui/page-header'
import { ArrowLeft, FileDown, Plus, ExternalLink, Loader2, Save, CheckCircle2, Trash2 } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { formatCurrency } from '@/lib/utils'
import { FyPicker } from '@/components/common/FyPicker'
import { DigitalInlamning, INLAMNING_COMING_SOON } from '@/components/bokslut/DigitalInlamning'
import { AnnualReportStudio } from '@/components/bokslut/AnnualReportStudio'
import type { ArsredovisningData } from '@/lib/bokslut/arsredovisning/types'
import type { SignatureRequest } from '@/lib/bokslut/arsredovisning/signature-service'
import type { AnnualReportVersionSummary } from '@/lib/bokslut/arsredovisning/compliance-types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

const SIGNATURE_EVIDENCE_REFERENCE_PATTERN =
  /^(archive|document|receipt):[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/

export default function ArsredovisningPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const periodId = searchParams.get('period')
  const { toast } = useToast()
  const tStudio = useTranslations('annualReportStudio')

  const [data, setData] = useState<ArsredovisningData | null>(null)
  const [signatures, setSignatures] = useState<SignatureRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Editable narrative fields: persisted to arsredovisning_narratives so
  // the PDF always reflects the latest saved version and a refresh / new
  // user picks up the same content.
  const [description, setDescription] = useState('')
  const [importantEvents, setImportantEvents] = useState('')
  const [resultatdisposition, setResultatdisposition] = useState('')
  const [proposedDividend, setProposedDividend] = useState('')
  const [savedDescription, setSavedDescription] = useState('')
  const [savedImportantEvents, setSavedImportantEvents] = useState('')
  const [savedResultatdisposition, setSavedResultatdisposition] = useState('')
  const [savedProposedDividend, setSavedProposedDividend] = useState('')
  const [agmDate, setAgmDate] = useState('')
  const [savedAgmDate, setSavedAgmDate] = useState('')
  const [agmDispositionOutcome, setAgmDispositionOutcome] = useState<
    '' | 'proposal_approved' | 'alternative_decision'
  >('')
  const [savedAgmDispositionOutcome, setSavedAgmDispositionOutcome] = useState('')
  const [agmDispositionDecision, setAgmDispositionDecision] = useState('')
  const [savedAgmDispositionDecision, setSavedAgmDispositionDecision] = useState('')
  // Disclosure fields per ÅRL 5:13-15 § + BFNAR koncernförhållanden.
  // Persisted via the same POST endpoint as the förvaltningsberättelse text.
  const [longTermDebt, setLongTermDebt] = useState('')
  const [savedLongTermDebt, setSavedLongTermDebt] = useState('')
  const [securitiesPledged, setSecuritiesPledged] = useState('')
  const [savedSecuritiesPledged, setSavedSecuritiesPledged] = useState('')
  const [contingentLiabilities, setContingentLiabilities] = useState('')
  const [savedContingentLiabilities, setSavedContingentLiabilities] = useState('')
  const [parentName, setParentName] = useState('')
  const [savedParentName, setSavedParentName] = useState('')
  const [parentOrgNr, setParentOrgNr] = useState('')
  const [savedParentOrgNr, setSavedParentOrgNr] = useState('')
  const [parentCity, setParentCity] = useState('')
  const [savedParentCity, setSavedParentCity] = useState('')
  const [longTermDebtConfirmed, setLongTermDebtConfirmed] = useState(false)
  const [savedLongTermDebtConfirmed, setSavedLongTermDebtConfirmed] = useState(false)
  const [securitiesPledgedConfirmed, setSecuritiesPledgedConfirmed] = useState(false)
  const [savedSecuritiesPledgedConfirmed, setSavedSecuritiesPledgedConfirmed] = useState(false)
  const [contingentLiabilitiesConfirmed, setContingentLiabilitiesConfirmed] = useState(false)
  const [savedContingentLiabilitiesConfirmed, setSavedContingentLiabilitiesConfirmed] = useState(false)
  const [parentCompanyConfirmed, setParentCompanyConfirmed] = useState(false)
  const [savedParentCompanyConfirmed, setSavedParentCompanyConfirmed] = useState(false)
  const [savingNarrative, setSavingNarrative] = useState(false)
  const [narrativeRevision, setNarrativeRevision] = useState<string | null>(null)

  // Add-signer form
  const [signerName, setSignerName] = useState('')
  const [signerRole, setSignerRole] = useState('Styrelseledamot')
  const [versions, setVersions] = useState<AnnualReportVersionSummary[]>([])
  const [blockingCount, setBlockingCount] = useState<number | null>(null)
  const [selectedSignatureVersionId, setSelectedSignatureVersionId] = useState('')
  const [signingMethod, setSigningMethod] = useState<
    'paper_original' | 'advanced_e_signature' | 'bankid'
  >('paper_original')
  const [signatureEvidence, setSignatureEvidence] = useState('')
  const [signatureDate, setSignatureDate] = useState(() => new Date().toISOString().slice(0, 10))

  const handleVersionsChanged = useCallback((nextVersions: AnnualReportVersionSummary[]) => {
    setVersions(nextVersions)
    setSelectedSignatureVersionId((current) => {
      if (nextVersions.some((version) => version.id === current && version.status === 'ready_for_signature')) {
        return current
      }
      return nextVersions.find((version) => version.status === 'ready_for_signature')?.id ?? ''
    })
  }, [])

  useEffect(() => {
    if (!periodId) return
    let cancelled = false
    Promise.all([
      fetch(`/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning`).then((r) => r.json()),
      fetch(`/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/signatures`).then((r) =>
        r.json(),
      ),
    ])
      .then(([arBody, sigBody]) => {
        if (cancelled) return
        if (arBody?.error) {
          setError(getUserErrorMessage(arBody.error) ?? 'Kunde inte hämta årsredovisning')
          return
        }
        const d = arBody.data as ArsredovisningData
        setData(d)
        // buildArsredovisningData merges persisted narrative + boilerplate,
        // so the values here are whatever the user will see in the PDF
        // unless they edit. Track both "current draft" and "last saved" so
        // we can disable Spara when there's nothing pending.
        setDescription(d.forvaltningsberattelse.description)
        setImportantEvents(d.forvaltningsberattelse.important_events)
        setResultatdisposition(d.forvaltningsberattelse.resultatdisposition)
        const dividend = String(d.forvaltningsberattelse.proposed_dividend || '')
        setProposedDividend(dividend)
        setAgmDate(d.forvaltningsberattelse.agm_date ?? '')
        setSavedDescription(d.forvaltningsberattelse.description)
        setSavedImportantEvents(d.forvaltningsberattelse.important_events)
        setSavedResultatdisposition(d.forvaltningsberattelse.resultatdisposition)
        setSavedProposedDividend(dividend)
        setSavedAgmDate(d.forvaltningsberattelse.agm_date ?? '')
        setAgmDispositionOutcome(d.forvaltningsberattelse.agm_disposition_outcome ?? '')
        setSavedAgmDispositionOutcome(d.forvaltningsberattelse.agm_disposition_outcome ?? '')
        setAgmDispositionDecision(d.forvaltningsberattelse.agm_disposition_decision ?? '')
        setSavedAgmDispositionDecision(d.forvaltningsberattelse.agm_disposition_decision ?? '')
        const ltd = d.disclosures.long_term_debt_over_five_years
        const ltdStr = ltd != null ? String(ltd) : ''
        setLongTermDebt(ltdStr)
        setSavedLongTermDebt(ltdStr)
        setSecuritiesPledged(d.disclosures.securities_pledged ?? '')
        setSavedSecuritiesPledged(d.disclosures.securities_pledged ?? '')
        setContingentLiabilities(d.disclosures.contingent_liabilities ?? '')
        setSavedContingentLiabilities(d.disclosures.contingent_liabilities ?? '')
        setParentName(d.disclosures.parent_company_name ?? '')
        setSavedParentName(d.disclosures.parent_company_name ?? '')
        setParentOrgNr(d.disclosures.parent_company_org_number ?? '')
        setSavedParentOrgNr(d.disclosures.parent_company_org_number ?? '')
        setParentCity(d.disclosures.parent_company_city ?? '')
        setSavedParentCity(d.disclosures.parent_company_city ?? '')
        setLongTermDebtConfirmed(d.disclosures.confirmations.long_term_debt_over_five_years)
        setSavedLongTermDebtConfirmed(d.disclosures.confirmations.long_term_debt_over_five_years)
        setSecuritiesPledgedConfirmed(d.disclosures.confirmations.securities_pledged)
        setSavedSecuritiesPledgedConfirmed(d.disclosures.confirmations.securities_pledged)
        setContingentLiabilitiesConfirmed(d.disclosures.confirmations.contingent_liabilities)
        setSavedContingentLiabilitiesConfirmed(d.disclosures.confirmations.contingent_liabilities)
        setParentCompanyConfirmed(d.disclosures.confirmations.parent_company)
        setSavedParentCompanyConfirmed(d.disclosures.confirmations.parent_company)
        setSignatures((sigBody.data ?? []) as SignatureRequest[])
      })
      .catch(() => {
        if (!cancelled) setError('Kunde inte hämta årsredovisning')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [periodId])

  const hasUnsavedNarrative =
    description !== savedDescription ||
    importantEvents !== savedImportantEvents ||
    resultatdisposition !== savedResultatdisposition ||
    proposedDividend !== savedProposedDividend ||
    agmDate !== savedAgmDate ||
    agmDispositionOutcome !== savedAgmDispositionOutcome ||
    agmDispositionDecision !== savedAgmDispositionDecision ||
    longTermDebt !== savedLongTermDebt ||
    securitiesPledged !== savedSecuritiesPledged ||
    contingentLiabilities !== savedContingentLiabilities ||
    parentName !== savedParentName ||
    parentOrgNr !== savedParentOrgNr ||
    parentCity !== savedParentCity ||
    longTermDebtConfirmed !== savedLongTermDebtConfirmed ||
    securitiesPledgedConfirmed !== savedSecuritiesPledgedConfirmed ||
    contingentLiabilitiesConfirmed !== savedContingentLiabilitiesConfirmed ||
    parentCompanyConfirmed !== savedParentCompanyConfirmed

  const handleSaveNarrative = useCallback(async () => {
    if (!periodId) return
    // Parse the long-term debt input; empty string and zero both clear the
    // override (the note then falls back to the "Inga." default). Reject
    // non-numeric input with a toast so the API doesn't return a 400.
    let longTermDebtParsed: number | null = null
    if (longTermDebt.trim()) {
      const parsed = Number(longTermDebt.replace(',', '.'))
      if (!Number.isFinite(parsed) || parsed < 0) {
        toast({
          title: 'Ogiltigt belopp',
          description:
            'Långfristiga skulder förfallande efter mer än fem år måste vara ett positivt tal (eller lämnas tomt).',
          variant: 'destructive',
        })
        return
      }
      longTermDebtParsed = parsed
    }
    let proposedDividendParsed = 0
    if (proposedDividend.trim()) {
      const parsed = Number(proposedDividend.replace(/\s/g, '').replace(',', '.'))
      if (!Number.isFinite(parsed) || parsed < 0) {
        toast({
          title: 'Ogiltigt belopp',
          description: 'Föreslagen utdelning måste vara noll eller ett positivt belopp.',
          variant: 'destructive',
        })
        return
      }
      proposedDividendParsed = Math.round(parsed * 100) / 100
    }
    setSavingNarrative(true)
    try {
      const res = await fetch(
        `/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/narrative`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            description,
            important_events: importantEvents,
            resultatdisposition,
            proposed_dividend: proposedDividendParsed,
            agm_date: agmDate || null,
            agm_disposition_outcome: agmDispositionOutcome || null,
            agm_disposition_decision:
              agmDispositionOutcome === 'alternative_decision'
                ? agmDispositionDecision.trim() || null
                : null,
            long_term_debt_over_five_years: longTermDebtParsed,
            securities_pledged: securitiesPledged.trim() || null,
            contingent_liabilities: contingentLiabilities.trim() || null,
            parent_company_name: parentName.trim() || null,
            parent_company_org_number: parentOrgNr.trim() || null,
            parent_company_city: parentCity.trim() || null,
            long_term_debt_over_five_years_confirmed: longTermDebtConfirmed,
            securities_pledged_confirmed: securitiesPledgedConfirmed,
            contingent_liabilities_confirmed: contingentLiabilitiesConfirmed,
            parent_company_confirmed: parentCompanyConfirmed,
          }),
        },
      )
      const body = await res.json()
      if (!res.ok) {
        toast({
          title: 'Kunde inte spara texten',
          description: getUserErrorMessage(body?.error) ?? '',
          variant: 'destructive',
        })
        return
      }
      setSavedDescription(description)
      setSavedImportantEvents(importantEvents)
      setSavedResultatdisposition(resultatdisposition)
      setSavedProposedDividend(proposedDividend)
      setSavedAgmDate(agmDate)
      setSavedAgmDispositionOutcome(agmDispositionOutcome)
      setSavedAgmDispositionDecision(agmDispositionDecision)
      setSavedLongTermDebt(longTermDebt)
      setSavedSecuritiesPledged(securitiesPledged)
      setSavedContingentLiabilities(contingentLiabilities)
      setSavedParentName(parentName)
      setSavedParentOrgNr(parentOrgNr)
      setSavedParentCity(parentCity)
      setSavedLongTermDebtConfirmed(longTermDebtConfirmed)
      setSavedSecuritiesPledgedConfirmed(securitiesPledgedConfirmed)
      setSavedContingentLiabilitiesConfirmed(contingentLiabilitiesConfirmed)
      setSavedParentCompanyConfirmed(parentCompanyConfirmed)
      setNarrativeRevision(
        typeof body.data?.updated_at === 'string' ? body.data.updated_at : null,
      )
    } catch (err) {
      toast({
        title: 'Kunde inte spara texten',
        description: err instanceof Error ? getUserErrorMessage(err) : 'Okänt fel',
        variant: 'destructive',
      })
    } finally {
      setSavingNarrative(false)
    }
  }, [
    periodId,
    description,
    importantEvents,
    resultatdisposition,
    proposedDividend,
    agmDate,
    agmDispositionOutcome,
    agmDispositionDecision,
    longTermDebt,
    securitiesPledged,
    contingentLiabilities,
    parentName,
    parentOrgNr,
    parentCity,
    longTermDebtConfirmed,
    securitiesPledgedConfirmed,
    contingentLiabilitiesConfirmed,
    parentCompanyConfirmed,
    toast,
  ])

  const handleMarkSigned = useCallback(
    async (signatureId: string) => {
      if (!periodId) return
      if (
        !selectedSignatureVersionId ||
        !SIGNATURE_EVIDENCE_REFERENCE_PATTERN.test(signatureEvidence.trim()) ||
        !signatureDate
      ) {
        toast({
          title: 'Underskriftsbevis saknas',
          description:
            'Välj en låst version och ange datum samt en strukturerad referens, till exempel archive:AR-2026-001.',
          variant: 'destructive',
        })
        return
      }
      try {
        const res = await fetch(
          `/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/signatures/${signatureId}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              status: 'signed',
              annual_report_version_id: selectedSignatureVersionId,
              signing_method: signingMethod,
              evidence_reference: signatureEvidence.trim(),
              signed_at: new Date(`${signatureDate}T12:00:00`).toISOString(),
            }),
          },
        )
        const body = await res.json()
        if (!res.ok) {
          toast({
            title: 'Kunde inte markera som signerad',
            description: getUserErrorMessage(body?.error) ?? '',
            variant: 'destructive',
          })
          return
        }
        setSignatures((prev) =>
          prev.map((s) => (s.id === signatureId ? (body.data as SignatureRequest) : s)),
        )
        const versionsResponse = await fetch(
          `/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/versions`,
        )
        if (versionsResponse.ok) {
          const versionsBody = await versionsResponse.json()
          handleVersionsChanged((versionsBody.data ?? []) as AnnualReportVersionSummary[])
        }
        toast({ title: 'Underskrift registrerad' })
      } catch (err) {
        toast({
          title: 'Kunde inte markera som signerad',
          description: err instanceof Error ? getUserErrorMessage(err) : 'Okänt fel',
          variant: 'destructive',
        })
      }
    },
    [
      handleVersionsChanged,
      periodId,
      selectedSignatureVersionId,
      signatureDate,
      signatureEvidence,
      signingMethod,
      toast,
    ],
  )

  const handleAddSigner = useCallback(async () => {
    if (!periodId || !signerName.trim()) return
    try {
      const res = await fetch(
        `/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/signatures`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: signerRole, signer_name: signerName.trim() }),
        },
      )
      const body = await res.json()
      if (!res.ok) {
        toast({
          title: 'Kunde inte lägga till undertecknare',
          description: getUserErrorMessage(body?.error) ?? '',
          variant: 'destructive',
        })
        return
      }
      setSignatures((prev) => [...prev, body.data as SignatureRequest])
      setSignerName('')
      toast({ title: 'Undertecknare tillagd', description: `${signerRole}: ${signerName}` })
    } catch (err) {
      toast({
        title: 'Kunde inte lägga till undertecknare',
        description: err instanceof Error ? getUserErrorMessage(err) : 'Okänt fel',
        variant: 'destructive',
      })
    }
  }, [periodId, signerName, signerRole, toast])

  const handleRemoveSigner = useCallback(
    async (signatureId: string) => {
      if (!periodId) return
      try {
        const response = await fetch(
          `/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/signatures/${signatureId}`,
          { method: 'DELETE' },
        )
        if (!response.ok) {
          const body = await response.json()
          throw new Error(getUserErrorMessage(body?.error))
        }
        setSignatures((current) => current.filter((signature) => signature.id !== signatureId))
        toast({ title: tStudio('signer_removed') })
      } catch (err) {
        toast({
          title: tStudio('signer_remove_error'),
          description: err instanceof Error ? getUserErrorMessage(err) : undefined,
          variant: 'destructive',
        })
      }
    },
    [periodId, tStudio, toast],
  )

  if (!periodId) {
    return (
      <div className="space-y-8">
        <PageHeader
          title="Årsredovisning"
          description="Förhandsgranska och ladda ner årsredovisningen för valt räkenskapsår."
        />
        <div className="max-w-xl px-1">
            <h3 className="font-sans text-sm font-medium">Välj räkenskapsår</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Välj det räkenskapsår du vill se årsredovisningen för. Du kan
              förhandsgranska och ladda ner PDF-utkastet utan att stänga året: det
              fullständiga bokslutet görs sedan via{' '}
              <Link href="/bookkeeping/year-end" className="text-foreground underline underline-offset-4 decoration-muted-foreground/40 hover:decoration-foreground">
                Bokslut
              </Link>
              .
            </p>
          <div className="mt-4">
            <FyPicker
              value={null}
              onChange={(id) => {
                if (id) router.replace(`/bookkeeping/year-end/arsredovisning?period=${id}`)
              }}
              includeAllOption={false}
              hideFuturePeriods
            />
          </div>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="space-y-8">
        <PageHeader title="Årsredovisning" />
        <div className="space-y-3">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="space-y-8">
        <PageHeader title="Årsredovisning" />
        <p className="py-4 text-sm text-destructive">{error ?? 'Kunde inte hämta data'}</p>
      </div>
    )
  }

  // PDF route reads persisted narrative from the new arsredovisning_narratives
  // table. The save button below writes overrides; the URL stays clean.
  const pdfUrl = `/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/pdf`

  // Only versions locked via "Lås version för underskrift" can be signed. An
  // empty "Låst version" select with no explanation was a dead end for a real
  // user (2026-08-20): say what is missing and where the button lives.
  const lockedVersions = versions.filter((version) => version.status === 'ready_for_signature')
  const draftVersionCount = versions.filter((version) => version.status === 'draft').length
  const noLockedVersionHint = (() => {
    if (lockedVersions.length > 0) return null
    const draftNote = draftVersionCount > 0 ? 'Versionsutkast kan inte signeras. ' : ''
    if (blockingCount === null) {
      return `${draftNote}Lås en version under Fullständighetskontroll så dyker den upp här.`
    }
    if (blockingCount > 0) {
      const what = blockingCount === 1 ? 'det blockerande felet' : `de ${blockingCount} blockerande felen`
      const done = blockingCount === 1 ? 'åtgärdat' : 'åtgärdade'
      return `${draftNote}Knappen Lås version för underskrift är grå tills ${what} under Fullständighetskontroll är ${done}.`
    }
    return `${draftNote}Klicka på Lås version för underskrift under Fullständighetskontroll så dyker versionen upp här.`
  })()
  const pendingSignatureCount = signatures.filter(
    (sig) => sig.status !== 'signed' && sig.status !== 'declined',
  ).length
  const signReadinessHint = !selectedSignatureVersionId
    ? 'Välj en låst version ovan, sedan går det att markera underskrifter.'
    : !SIGNATURE_EVIDENCE_REFERENCE_PATTERN.test(signatureEvidence.trim())
      ? 'Ange en bevisreferens (t.ex. archive:AR-2026-001) så aktiveras Markera som signerad.'
      : !signatureDate
        ? 'Ange underskriftsdatum så aktiveras Markera som signerad.'
        : null

  return (
    <div className="space-y-8">
      <PageHeader
        title={`Årsredovisning ${data.fiscal_period.name}`}
        description={
          <span data-ph-mask="">
            {data.company.org_number
              ? `${data.company.name} · ${data.company.org_number}`
              : data.company.name}
          </span>
        }
        action={
          <Button variant="outline" asChild>
            <Link href={`/bookkeeping/year-end?period=${periodId}`}>
              <ArrowLeft className="mr-2 h-4 w-4" /> Tillbaka till bokslut
            </Link>
          </Button>
        }
      />

      {data.accounting_framework === 'k3' && (
        <div className="px-1 text-sm">
          <p className="font-medium">Årsredovisning enligt K3 (BFNAR 2012:1)</p>
          {/* Enumerate only what buildK3Noter and buildArsredovisningData
              actually emit. The uppskjuten skatt-noten needs a 2240/8940
              balance (which the engine no longer creates: K3 29.37 gross in
              juridisk person), the anläggningsnoter need assets in the
              register, and the kassaflödesanalys is dropped with a warning
              when it cannot be generated. Promising any of them
              unconditionally is false in the normal case. */}
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {data.kassaflodesanalys
              ? 'Dokumentet följer K3-mallen: kassaflödesanalys, förändring av eget kapital som egen räkning och noter enligt K3.'
              : 'Dokumentet följer K3-mallen: förändring av eget kapital som egen räkning och noter enligt K3. Kassaflödesanalysen kunde inte beräknas för perioden: se varningarna längre ner.'}{' '}
            Vilka noter som kommer med styrs av bokföringen: noten Uppskjutna skatter tas
            med först när konto 2240 eller 8940 har ett saldo, och anläggningsnoterna när
            det finns tillgångar i anläggningsregistret.
          </p>
        </div>
      )}

      <AnnualReportStudio
        periodId={periodId}
        periodStart={data.fiscal_period.period_start}
        periodEnd={data.fiscal_period.period_end}
        framework={data.accounting_framework}
        hasUnsavedNarrative={hasUnsavedNarrative}
        narrativeRevision={narrativeRevision}
        onVersionsChanged={handleVersionsChanged}
        onBlockingCountChanged={setBlockingCount}
      />

      <section>
        <div className="mb-1 flex items-center gap-2 px-1">
          <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">Förvaltningsberättelse: narrativ</h3>
          <div className="h-px flex-1 bg-border/60" />
        </div>
          <p className="px-1 text-xs leading-5 text-muted-foreground">
            Texten nedan visas i PDF:en. Klicka på <strong>Spara texten</strong> nedan
            för att behålla ändringarna mellan sessioner.
          </p>
        <div className="space-y-4 px-1 pt-4">
          <div className="space-y-2">
            <Label htmlFor="ar-description">Verksamhetsbeskrivning</Label>
            <Textarea
              id="ar-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ar-events">Väsentliga händelser</Label>
            <Textarea
              id="ar-events"
              value={importantEvents}
              onChange={(e) => setImportantEvents(e.target.value)}
              rows={4}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ar-rd">Resultatdisposition</Label>
            <Textarea
              id="ar-rd"
              value={resultatdisposition}
              onChange={(e) => setResultatdisposition(e.target.value)}
              rows={3}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ar-dividend">Föreslagen utdelning (kr)</Label>
            <Input
              id="ar-dividend"
              inputMode="decimal"
              value={proposedDividend}
              onChange={(event) => setProposedDividend(event.target.value)}
              placeholder="0"
              className="max-w-[220px] tabular-nums"
            />
            <p className="text-xs text-muted-foreground">
              Beloppet används i resultatdispositionen i samma version av PDF och iXBRL.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ar-agm-date">Datum för årsstämma</Label>
            <Input
              id="ar-agm-date"
              type="date"
              value={agmDate}
              onChange={(e) => setAgmDate(e.target.value)}
              className="max-w-[220px]"
            />
            <p className="text-xs text-muted-foreground">
              Datum då årsstämman fastställde årsredovisningen: fyller i datumraden på
              fastställelseintyget i PDF:en (krävs för inlämning till Bolagsverket).
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ar-agm-outcome">Årsstämmans beslut om resultatdisposition</Label>
            <Select
              value={agmDispositionOutcome}
              onValueChange={(next) =>
                setAgmDispositionOutcome(
                  next as 'proposal_approved' | 'alternative_decision',
                )
              }
            >
              <SelectTrigger id="ar-agm-outcome" className="max-w-xl">
                <SelectValue placeholder="Välj efter genomförd årsstämma" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="proposal_approved">Styrelsens förslag godkändes</SelectItem>
                <SelectItem value="alternative_decision">Årsstämman fattade ett annat beslut</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {agmDispositionOutcome === 'alternative_decision' && (
            <div className="space-y-2">
              <Label htmlFor="ar-agm-decision">Årsstämmans beslut</Label>
              <Textarea
                id="ar-agm-decision"
                value={agmDispositionDecision}
                onChange={(event) => setAgmDispositionDecision(event.target.value)}
                rows={3}
              />
            </div>
          )}

          <div className="pt-4 border-t border-border space-y-4">
            <div>
              <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Lagstadgade upplysningar
              </h3>
              <p className="text-xs text-muted-foreground mt-1">
                Noter som krävs enligt ÅRL men inte kan härledas automatiskt. Tomma
                fält visas som &quot;Inga.&quot; i PDF:en.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ar-ltd">
                Långfristiga skulder förfallande efter mer än fem år (kr)
              </Label>
              <Input
                id="ar-ltd"
                type="text"
                inputMode="decimal"
                value={longTermDebt}
                onChange={(e) => setLongTermDebt(e.target.value)}
                placeholder="0"
                className="max-w-[220px] tabular-nums"
              />
              <p className="text-xs text-muted-foreground">
                ÅRL 5:13 §. Lämna tomt om inga skulder förfaller senare än fem år.
              </p>
              <label className="flex cursor-pointer items-center gap-3 text-sm">
                <Checkbox
                  id="ar-ltd-confirmed"
                  checked={longTermDebtConfirmed}
                  onCheckedChange={(checked) => setLongTermDebtConfirmed(Boolean(checked))}
                />
                Jag har kontrollerat uppgiften, även om beloppet är noll.
              </label>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ar-securities">Ställda säkerheter</Label>
              <Textarea
                id="ar-securities"
                value={securitiesPledged}
                onChange={(e) => setSecuritiesPledged(e.target.value)}
                rows={2}
                placeholder="t.ex. Företagsinteckning 500 000 kr som säkerhet för bankkredit."
              />
              <p className="text-xs text-muted-foreground">ÅRL 5:14 §.</p>
              <label className="flex cursor-pointer items-center gap-3 text-sm">
                <Checkbox
                  id="ar-securities-confirmed"
                  checked={securitiesPledgedConfirmed}
                  onCheckedChange={(checked) => setSecuritiesPledgedConfirmed(Boolean(checked))}
                />
                Jag har kontrollerat ställda säkerheter, även om svaret är inga.
              </label>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ar-contingent">Eventualförpliktelser</Label>
              <Textarea
                id="ar-contingent"
                value={contingentLiabilities}
                onChange={(e) => setContingentLiabilities(e.target.value)}
                rows={2}
                placeholder="t.ex. Borgensåtagande för dotterbolags krediter 200 000 kr."
              />
              <p className="text-xs text-muted-foreground">ÅRL 5:15 §.</p>
              <label className="flex cursor-pointer items-center gap-3 text-sm">
                <Checkbox
                  id="ar-contingent-confirmed"
                  checked={contingentLiabilitiesConfirmed}
                  onCheckedChange={(checked) => setContingentLiabilitiesConfirmed(Boolean(checked))}
                />
                Jag har kontrollerat eventualförpliktelser, även om svaret är inga.
              </label>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ar-parent-name">
                Moderföretag: namn (om koncerntillhörighet)
              </Label>
              <Input
                id="ar-parent-name"
                value={parentName}
                onChange={(e) => setParentName(e.target.value)}
                placeholder="t.ex. AB Koncernholding"
              />
              <p className="text-xs text-muted-foreground">
                BFNAR 2016:10 kap. 19 / BFNAR 2012:1 kap. 8. Lämna tomt om bolaget
                inte ingår i en koncern: noten utelämnas då.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="ar-parent-orgnr">Moderföretagets org.nr</Label>
                <Input
                  id="ar-parent-orgnr"
                  value={parentOrgNr}
                  onChange={(e) => setParentOrgNr(e.target.value)}
                  placeholder="556677-8899 eller CHE-123.456.789"
                />
                <p className="text-xs text-muted-foreground">
                  Svenskt org.nr NNNNNN-NNNN. Utländskt moderföretag: registreringsnumret som
                  det står i hemlandets register.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="ar-parent-city">Moderföretagets säte</Label>
                <Input
                  id="ar-parent-city"
                  value={parentCity}
                  onChange={(e) => setParentCity(e.target.value)}
                  placeholder="Stockholm eller Zug, Schweiz"
                />
              </div>
            </div>
            <label className="flex cursor-pointer items-center gap-3 text-sm">
              <Checkbox
                id="ar-parent-confirmed"
                checked={parentCompanyConfirmed}
                onCheckedChange={(checked) => setParentCompanyConfirmed(Boolean(checked))}
              />
              Jag har kontrollerat koncernförhållandet, även om bolaget saknar moderföretag.
            </label>
          </div>

          <div className="flex items-center justify-between pt-2">
            <div className="text-xs text-muted-foreground">
              {hasUnsavedNarrative ? (
                <span>Ändringar sparas inte automatiskt.</span>
              ) : narrativeRevision ? (
                <span className="inline-flex items-center gap-1 text-success">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Sparat
                </span>
              ) : (
                <span>Alla ändringar är sparade.</span>
              )}
            </div>
            <Button
              onClick={handleSaveNarrative}
              disabled={savingNarrative || !hasUnsavedNarrative}
            >
              {savingNarrative ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Sparar…
                </>
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" /> Spara texten
                </>
              )}
            </Button>
          </div>
        </div>
      </section>

      <section>
        <div className="mb-1 flex items-center gap-2 px-1">
          <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">Flerårsöversikt</h3>
          <div className="h-px flex-1 bg-border/60" />
        </div>
        <div className="px-1 pt-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>År</TableHead>
                <TableHead className="text-right">Nettoomsättning</TableHead>
                <TableHead className="text-right">Resultat efter fin.</TableHead>
                <TableHead className="text-right">Soliditet</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.forvaltningsberattelse.flerarsoversikt.map((row) => (
                <TableRow key={row.year}>
                  <TableCell>{row.year}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(row.net_revenue)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(row.result_after_financial)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.soliditet_pct === null
                      ? '-'
                      : `${row.soliditet_pct.toFixed(1)} %`}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section>
        <div className="mb-1 flex items-center gap-2 px-1">
          <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">Underskrifter</h3>
          <div className="h-px flex-1 bg-border/60" />
        </div>
          <p className="px-1 text-xs leading-5 text-muted-foreground">
            Lägg till varje styrelseledamot och eventuell VD. Lås först en version i
            arbetsflödet ovan. När originalet eller en extern e-signatur är klar registrerar
            du datum och bevisreferens mot exakt den version som skrevs under.
          </p>
        <div className="space-y-4 px-1 pt-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="signature-version">Låst version</Label>
              <Select
                value={selectedSignatureVersionId}
                onValueChange={setSelectedSignatureVersionId}
                disabled={lockedVersions.length === 0}
              >
                <SelectTrigger id="signature-version">
                  <SelectValue
                    placeholder={lockedVersions.length === 0 ? 'Ingen låst version ännu' : 'Välj version'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {lockedVersions.map((version) => (
                    <SelectItem key={version.id} value={version.id}>
                      Version {version.version_number}: {version.content_hash.slice(0, 12)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {noLockedVersionHint && (
                <p className="text-xs leading-5 text-muted-foreground">
                  {noLockedVersionHint}{' '}
                  <a
                    href="#ar-fullstandighetskontroll"
                    className="text-foreground underline underline-offset-4 decoration-muted-foreground/40 hover:decoration-foreground"
                  >
                    Gå till Fullständighetskontroll
                  </a>
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="signature-method">Underskriftsmetod</Label>
              <Select
                value={signingMethod}
                onValueChange={(next) =>
                  setSigningMethod(
                    next as 'paper_original' | 'advanced_e_signature' | 'bankid',
                  )
                }
              >
                <SelectTrigger id="signature-method">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="paper_original">Undertecknat original på papper</SelectItem>
                  <SelectItem value="advanced_e_signature">Avancerad e-signatur</SelectItem>
                  <SelectItem value="bankid">BankID via extern signeringstjänst</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="signature-date">Underskriftsdatum</Label>
              <Input
                id="signature-date"
                type="date"
               
                value={signatureDate}
                onChange={(event) => setSignatureDate(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="signature-evidence">Bevisreferens</Label>
              <Input
                id="signature-evidence"
               
                value={signatureEvidence}
                onChange={(event) => setSignatureEvidence(event.target.value)}
                placeholder="archive:AR-2026-001"
                maxLength={128}
                autoComplete="off"
              />
            </div>
            <p className="text-xs text-muted-foreground md:col-span-2">
              Accounted registrerar beviset men skapar inte själva underskriften. Spara
              originalet eller signeringskvittot enligt bolagets dokumenthantering.
            </p>
          </div>
          {signatures.length === 0 && (
            <p className="text-sm text-muted-foreground italic">
              Inga undertecknare tillagda än.
            </p>
          )}
          {pendingSignatureCount > 0 && signReadinessHint && (
            <p className="text-xs leading-5 text-muted-foreground">{signReadinessHint}</p>
          )}
          {signatures.map((sig) => (
            <div
              key={sig.id}
              className="flex flex-col gap-3 border-b border-border pb-3 last:border-b-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <p className="text-sm font-medium">{sig.signer_name}</p>
                <p className="text-xs text-muted-foreground">{sig.role}</p>
              </div>
              <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
                {sig.status === 'signed' ? (
                  <Badge variant="success">Signerad</Badge>
                ) : sig.status === 'declined' ? (
                  <Badge variant="destructive">Avböjd</Badge>
                ) : (
                  <>
                    <Badge variant="outline">Väntar på underskrift</Badge>
                    {sig.annual_report_version_id === null && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="min-w-11"
                        aria-label={tStudio('remove_signer')}
                        onClick={() => void handleRemoveSigner(sig.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                     
                      onClick={() => void handleMarkSigned(sig.id)}
                      disabled={
                        !selectedSignatureVersionId ||
                        !SIGNATURE_EVIDENCE_REFERENCE_PATTERN.test(signatureEvidence.trim()) ||
                        !signatureDate
                      }
                    >
                      Markera som signerad
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
          <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:flex-wrap sm:items-end">
            <div className="space-y-1">
              <Label htmlFor="signer-role" className="text-xs">
                Roll
              </Label>
              <Select value={signerRole} onValueChange={setSignerRole}>
                <SelectTrigger id="signer-role" className="sm:w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Styrelseledamot">Styrelseledamot</SelectItem>
                  <SelectItem value="Styrelseordförande">Styrelseordförande</SelectItem>
                  <SelectItem value="VD">VD</SelectItem>
                  <SelectItem value="Verkställande direktör">Verkställande direktör</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 flex-1 min-w-[200px]">
              <Label htmlFor="signer-name" className="text-xs">
                Namn
              </Label>
              <Input
                id="signer-name"
                value={signerName}
                onChange={(e) => setSignerName(e.target.value)}
                placeholder="t.ex. Anna Andersson"
               
              />
            </div>
            <Button className="w-full sm:w-auto" onClick={handleAddSigner} disabled={!signerName.trim()}>
              <Plus className="mr-1 h-4 w-4" /> Lägg till
            </Button>
          </div>
        </div>
      </section>

      <section>
        <div className="mb-1 flex items-center gap-2 px-1">
          <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">PDF för pappersinlämning</h3>
          <div className="h-px flex-1 bg-border/60" />
        </div>
        <div className="space-y-4 px-1 pt-2 text-sm">
          <p className="text-muted-foreground">
            Ladda ner PDF-utkastet och granska det. För pappersinlämning ska
            årsredovisningens original skrivas under av samtliga styrelseledamöter och
            eventuell VD. En bestyrkt kopia med fastställelseintyg skickas sedan per post
            till Bolagsverket. PDF-filen kan inte laddas upp som digital årsredovisning.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <Link href={pdfUrl} target="_blank" rel="noopener noreferrer">
                <FileDown className="mr-2 h-4 w-4" /> Ladda ner PDF (utkast)
              </Link>
            </Button>
            {/* Bolagsverket-delarna blurras tills integrationen är godkänd:
                rubriken, instruktionstexten och PDF-knappen förblir skarpa. */}
            <span
              inert={INLAMNING_COMING_SOON}
              aria-hidden={INLAMNING_COMING_SOON}
              className={
                INLAMNING_COMING_SOON
                  ? 'pointer-events-none select-none blur-[3px] opacity-60'
                  : undefined
              }
            >
              <Button variant="outline" asChild>
                <Link
                  href="https://bolagsverket.se/foretag/aktiebolag/arsredovisningforaktiebolag.759.html"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="mr-2 h-4 w-4" /> Bolagsverket om årsredovisning
                </Link>
              </Button>
            </span>
          </div>
          {/* The warning list stays SHARP even while direct submission is
              gated: the warnings describe problems in the user's own report
              (unmapped accounts, resultat vs 2099, AGM dates) and apply to
              the paper PDF just as much as to digital inlämning. Blurring
              them alongside the coming-soon Bolagsverket parts made the
              pre-submission checklist unreadable in the default config. */}
          {data.warnings.length > 0 && (
            <div className="space-y-1 border-t border-border/60 pt-3 text-xs">
              <p className="font-medium">Innan inlämning till Bolagsverket:</p>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                {data.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          <p
            inert={INLAMNING_COMING_SOON}
            aria-hidden={INLAMNING_COMING_SOON}
            className={
              INLAMNING_COMING_SOON
                ? 'pointer-events-none select-none blur-[3px] opacity-60 text-xs text-muted-foreground'
                : 'text-xs text-muted-foreground'
            }
          >
            <strong className="text-foreground">Digital inlämning är frivillig.</strong> Den görs som iXBRL genom en
            ansluten programvara. Accounteds direktinlämning förblir stängd tills avtal,
            certifikat och Bolagsverkets acceptanstest är klara. PDF-flödet ovan är den
            separata vägen för pappersinlämning.
          </p>
        </div>
      </section>

      {data.accounting_framework === 'k2' && periodId && (
        <DigitalInlamning periodId={periodId} />
      )}
    </div>
  )
}
