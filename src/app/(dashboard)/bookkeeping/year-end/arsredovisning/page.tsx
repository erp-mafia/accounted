'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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
import { HelpPopover } from '@/components/ui/help-popover'
import { FileDown, Plus, ExternalLink, Save, CheckCircle2, Trash2, Upload } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { formatCurrency } from '@/lib/utils'
import { FyPicker } from '@/components/common/FyPicker'
import { DigitalInlamning, INLAMNING_COMING_SOON } from '@/components/bokslut/DigitalInlamning'
import { ArsredovisningBankIdSigning, useVersionSigningRequests } from '@/components/bokslut/ArsredovisningBankIdSigning'
import { useSigningAvailability } from '@/components/signing/use-signing-availability'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { deriveArsredovisningSigningTrack } from '@/lib/bokslut/arsredovisning/signing-track'
import {
  AnnualReportStudio,
  type AnnualReportComplianceSummary,
} from '@/components/bokslut/AnnualReportStudio'
import { StepRail } from '@/components/bokslut/StepRail'
import { StepSectionHeader, annualReportStepAnchor } from '@/components/bokslut/StepSectionHeader'
import {
  deriveAnnualReportWorkflow,
  isAgmRecorded,
  type AnnualReportStep,
  type AnnualReportStepKey,
} from '@/lib/bokslut/arsredovisning/workflow-steps'
import { useFiscalPeriods } from '@/lib/reference-data/hooks'
import type { ArsredovisningData } from '@/lib/bokslut/arsredovisning/types'
import type { SignatureRequest } from '@/lib/bokslut/arsredovisning/signature-service'
import type { AnnualReportVersionSummary } from '@/lib/bokslut/arsredovisning/compliance-types'
import {
  documentEvidenceReference,
  evidenceDocumentId,
  orderEvidenceCandidates,
} from '@/lib/bokslut/arsredovisning/signature-evidence'
import type { ArkivDocumentRow } from '@/app/api/arkiv/documents/route'
import { DOCUMENT_UPLOAD_ACCEPT } from '@/lib/documents/upload-types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { parseAmountInput } from '@/lib/money'
import { useBranding } from '@/lib/branding/brand-context'

const SIGNATURE_EVIDENCE_REFERENCE_PATTERN =
  /^(archive|document|receipt):[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/

/** An archive document as the signed-copy picker shows it. */
type EvidenceDocument = Pick<ArkivDocumentRow, 'document_id' | 'title' | 'document_date' | 'created_at' | 'doc_type'>

const TEXT_LINK_CLASS =
  'text-foreground underline underline-offset-4 decoration-muted-foreground/40 hover:decoration-foreground'

/** Note overrides as the server rendered them: overridden notes carry the
 *  generated text in generated_body and the user's text in body. */
function noteOverridesFromData(d: ArsredovisningData): Record<string, string> {
  const result: Record<string, string> = {}
  for (const note of d.noter) {
    if (note.key && note.generated_body !== undefined) result[note.key] = note.body
  }
  return result
}

function sameNoteOverrides(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

export default function ArsredovisningPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const periodId = searchParams.get('period')
  const { toast } = useToast()
  const tStudio = useTranslations('annualReportStudio')
  const tNotes = useTranslations('annualReportNotes')
  const tSteps = useTranslations('annualReportSteps')
  const tHelp = useTranslations('annualReportHelp')
  const tSign = useTranslations('annualReportSigning')
  const { appName } = useBranding()
  const { periods: fiscalPeriods, isLoading: periodsLoading } = useFiscalPeriods()

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
  // ÅRL 5:20 §: manual medelantal anställda. Empty = computed from Löner.
  const [medelantalOverride, setMedelantalOverride] = useState('')
  const [savedMedelantalOverride, setSavedMedelantalOverride] = useState('')
  // ÅRL 6 kap. 3 §: ekonomisk förening member disclosures.
  const [memberCountChange, setMemberCountChange] = useState('')
  const [savedMemberCountChange, setSavedMemberCountChange] = useState('')
  const [insatserRepayable, setInsatserRepayable] = useState('')
  const [savedInsatserRepayable, setSavedInsatserRepayable] = useState('')
  const [forlagsDividendRight, setForlagsDividendRight] = useState('')
  const [savedForlagsDividendRight, setSavedForlagsDividendRight] = useState('')
  const [forlagsRedeemable, setForlagsRedeemable] = useState('')
  const [savedForlagsRedeemable, setSavedForlagsRedeemable] = useState('')
  const [longTermDebtConfirmed, setLongTermDebtConfirmed] = useState(false)
  const [savedLongTermDebtConfirmed, setSavedLongTermDebtConfirmed] = useState(false)
  const [securitiesPledgedConfirmed, setSecuritiesPledgedConfirmed] = useState(false)
  const [savedSecuritiesPledgedConfirmed, setSavedSecuritiesPledgedConfirmed] = useState(false)
  const [contingentLiabilitiesConfirmed, setContingentLiabilitiesConfirmed] = useState(false)
  const [savedContingentLiabilitiesConfirmed, setSavedContingentLiabilitiesConfirmed] = useState(false)
  const [parentCompanyConfirmed, setParentCompanyConfirmed] = useState(false)
  const [savedParentCompanyConfirmed, setSavedParentCompanyConfirmed] = useState(false)
  // K3 note texts the user replaced (key -> text). A key absent from the
  // map keeps the generated text, which stays the default.
  const [noteOverrides, setNoteOverrides] = useState<Record<string, string>>({})
  const [savedNoteOverrides, setSavedNoteOverrides] = useState<Record<string, string>>({})
  // K3 kassaflödesanalys omission (ÅRL 2 kap. 1 §, 1 kap. 3 §). The server
  // decides whether the choice is honoured; the UI mirrors its verdict.
  const [omitCashFlow, setOmitCashFlow] = useState(false)
  const [savedOmitCashFlow, setSavedOmitCashFlow] = useState(false)
  const [cashFlowOmissionConfirmed, setCashFlowOmissionConfirmed] = useState(false)
  const [savedCashFlowOmissionConfirmed, setSavedCashFlowOmissionConfirmed] = useState(false)
  const [savingNarrative, setSavingNarrative] = useState(false)
  const [narrativeRevision, setNarrativeRevision] = useState<string | null>(null)

  // Add-signer form
  const [signerName, setSignerName] = useState('')
  const [signerRole, setSignerRole] = useState('Styrelseledamot')
  const [versions, setVersions] = useState<AnnualReportVersionSummary[]>([])
  const [selectedSignatureVersionId, setSelectedSignatureVersionId] = useState('')
  // Evidence recorded by hand: a paper original, or an e-signature made in
  // another service (Scrive with BankID and the like). 'bankid' is written
  // only by the board's BankID signing in the app (SIGNING_METHOD_RESERVED).
  const [signingMethod, setSigningMethod] = useState<'paper_original' | 'advanced_e_signature'>('paper_original')
  const [signatureEvidence, setSignatureEvidence] = useState('')
  const [signatureDate, setSignatureDate] = useState(() => todayIsoStockholm())
  // The signed copy is picked from (or uploaded into) the archive: the
  // evidence reference used to be typed by hand, and nobody could know an
  // archive id to type (PH 186). null until the list is loaded.
  const [evidenceDocuments, setEvidenceDocuments] = useState<EvidenceDocument[] | null>(null)
  const [uploadingEvidence, setUploadingEvidence] = useState(false)
  const evidenceFileInput = useRef<HTMLInputElement>(null)
  const hasLockedVersion = versions.some((version) => version.status === 'ready_for_signature')
  // The board's BankID signing (lib/bokslut/arsredovisning/bankid-signing.ts):
  // offered only where signing is open here, and one track per version.
  const signingAvailable = useSigningAvailability()
  const [signingReload, setSigningReload] = useState(0)
  const [manualOpen, setManualOpen] = useState(false)
  // A version the board signed with BankID is no longer a locked one: its
  // panel stays, to say what comes next.
  const bankIdSignedVersionId =
    !selectedSignatureVersionId &&
    signatures.length > 0 &&
    signatures.every((sig) => sig.status === 'signed') &&
    signatures.some((sig) => sig.signing_method === 'bankid')
      ? signatures[0]!.annual_report_version_id
      : null
  const signingVersionId = selectedSignatureVersionId || bankIdSignedVersionId || null
  const versionSigningRequests = useVersionSigningRequests(signingVersionId, signingReload)

  // The compliance check as the studio last loaded it (null while loading)
  // and a counter that makes the studio reload it after a signer change:
  // the roster trigger clears the roster confirmation server-side.
  const [complianceSummary, setComplianceSummary] = useState<AnnualReportComplianceSummary | null>(null)
  const [complianceRefresh, setComplianceRefresh] = useState(0)
  const refreshCompliance = useCallback(() => setComplianceRefresh((n) => n + 1), [])

  const handleVersionsChanged = useCallback((nextVersions: AnnualReportVersionSummary[]) => {
    setVersions(nextVersions)
    setSelectedSignatureVersionId((current) => {
      if (nextVersions.some((version) => version.id === current && version.status === 'ready_for_signature')) {
        return current
      }
      return nextVersions.find((version) => version.status === 'ready_for_signature')?.id ?? ''
    })
  }, [])

  // The archive is the company's, not the year's: load it once, when there is
  // a locked version to sign.
  useEffect(() => {
    if (!hasLockedVersion || evidenceDocuments !== null) return
    let cancelled = false
    fetch('/api/arkiv/documents?limit=100')
      .then((response) => (response.ok ? response.json() : { data: [] }))
      .then((body: { data?: EvidenceDocument[] }) => {
        if (!cancelled) setEvidenceDocuments(orderEvidenceCandidates(body.data ?? []))
      })
      .catch(() => {
        if (!cancelled) setEvidenceDocuments([])
      })
    return () => {
      cancelled = true
    }
  }, [hasLockedVersion, evidenceDocuments])

  useEffect(() => {
    if (!periodId) return
    let cancelled = false
    // A year switch from the header picker re-runs this effect: show the
    // skeleton instead of the previous year's numbers while the new one
    // loads, and drop a stale error so the picker stays reachable.
    setLoading(true)
    setError(null)
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
        const medel = d.disclosures.medelantal_anstallda_override
        const medelStr = medel != null ? String(medel) : ''
        setMedelantalOverride(medelStr)
        setSavedMedelantalOverride(medelStr)
        setMemberCountChange(d.disclosures.member_count_change ?? '')
        setSavedMemberCountChange(d.disclosures.member_count_change ?? '')
        const repayable = d.disclosures.insatser_repayable_next_year
        const repayableStr = repayable != null ? String(repayable) : ''
        setInsatserRepayable(repayableStr)
        setSavedInsatserRepayable(repayableStr)
        setForlagsDividendRight(d.disclosures.forlagsinsatser_dividend_right ?? '')
        setSavedForlagsDividendRight(d.disclosures.forlagsinsatser_dividend_right ?? '')
        const redeemable = d.disclosures.forlagsinsatser_redeemable_two_years
        const redeemableStr = redeemable != null ? String(redeemable) : ''
        setForlagsRedeemable(redeemableStr)
        setSavedForlagsRedeemable(redeemableStr)
        setLongTermDebtConfirmed(d.disclosures.confirmations.long_term_debt_over_five_years)
        setSavedLongTermDebtConfirmed(d.disclosures.confirmations.long_term_debt_over_five_years)
        setSecuritiesPledgedConfirmed(d.disclosures.confirmations.securities_pledged)
        setSavedSecuritiesPledgedConfirmed(d.disclosures.confirmations.securities_pledged)
        setContingentLiabilitiesConfirmed(d.disclosures.confirmations.contingent_liabilities)
        setSavedContingentLiabilitiesConfirmed(d.disclosures.confirmations.contingent_liabilities)
        setParentCompanyConfirmed(d.disclosures.confirmations.parent_company)
        setSavedParentCompanyConfirmed(d.disclosures.confirmations.parent_company)
        const overrides = noteOverridesFromData(d)
        setNoteOverrides(overrides)
        setSavedNoteOverrides(overrides)
        setOmitCashFlow(d.disclosures.omit_kassaflodesanalys ?? false)
        setSavedOmitCashFlow(d.disclosures.omit_kassaflodesanalys ?? false)
        setCashFlowOmissionConfirmed(d.disclosures.kassaflodesanalys_omission_confirmed ?? false)
        setSavedCashFlowOmissionConfirmed(
          d.disclosures.kassaflodesanalys_omission_confirmed ?? false,
        )
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

  // The AGM fields are step 7, everything else is step 3; both are saved by
  // the same narrative POST.
  const hasUnsavedAgm =
    agmDate !== savedAgmDate ||
    agmDispositionOutcome !== savedAgmDispositionOutcome ||
    agmDispositionDecision !== savedAgmDispositionDecision
  const hasUnsavedContent =
    description !== savedDescription ||
    importantEvents !== savedImportantEvents ||
    resultatdisposition !== savedResultatdisposition ||
    proposedDividend !== savedProposedDividend ||
    longTermDebt !== savedLongTermDebt ||
    securitiesPledged !== savedSecuritiesPledged ||
    contingentLiabilities !== savedContingentLiabilities ||
    parentName !== savedParentName ||
    parentOrgNr !== savedParentOrgNr ||
    parentCity !== savedParentCity ||
    medelantalOverride !== savedMedelantalOverride ||
    memberCountChange !== savedMemberCountChange ||
    insatserRepayable !== savedInsatserRepayable ||
    forlagsDividendRight !== savedForlagsDividendRight ||
    forlagsRedeemable !== savedForlagsRedeemable ||
    longTermDebtConfirmed !== savedLongTermDebtConfirmed ||
    securitiesPledgedConfirmed !== savedSecuritiesPledgedConfirmed ||
    contingentLiabilitiesConfirmed !== savedContingentLiabilitiesConfirmed ||
    parentCompanyConfirmed !== savedParentCompanyConfirmed ||
    !sameNoteOverrides(noteOverrides, savedNoteOverrides) ||
    omitCashFlow !== savedOmitCashFlow ||
    cashFlowOmissionConfirmed !== savedCashFlowOmissionConfirmed
  const hasUnsavedNarrative = hasUnsavedContent || hasUnsavedAgm

  const handleSaveNarrative = useCallback(async () => {
    if (!periodId) return
    // Parse the long-term debt input; empty string and zero both clear the
    // override (the note then falls back to the "Inga." default). Reject
    // non-numeric input with a toast so the API doesn't return a 400.
    let longTermDebtParsed: number | null = null
    if (longTermDebt.trim()) {
      const parsed = parseAmountInput(longTermDebt)
      if (parsed === null || parsed < 0) {
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
    // Medelantal anställda: empty clears the override (note falls back to
    // the FTE average from Löner); otherwise a whole number of employees.
    let medelantalParsed: number | null = null
    if (medelantalOverride.trim()) {
      const parsed = Number(medelantalOverride.trim())
      if (!Number.isInteger(parsed) || parsed < 0) {
        toast({
          title: 'Ogiltigt antal',
          description: 'Medelantal anställda måste vara ett heltal, noll eller större (eller lämnas tomt).',
          variant: 'destructive',
        })
        return
      }
      medelantalParsed = parsed
    }
    let proposedDividendParsed = 0
    if (proposedDividend.trim()) {
      const parsed = parseAmountInput(proposedDividend)
      if (parsed === null || parsed < 0) {
        toast({
          title: 'Ogiltigt belopp',
          description: 'Föreslagen utdelning måste vara noll eller ett positivt belopp.',
          variant: 'destructive',
        })
        return
      }
      proposedDividendParsed = parsed
    }
    // ÅRL 6 kap. 3 § amounts: empty means "inga"; otherwise a non-negative
    // amount in kronor.
    const parseMemberAmount = (raw: string, label: string): number | null | false => {
      if (!raw.trim()) return null
      const parsed = parseAmountInput(raw)
      if (parsed === null || parsed < 0) {
        toast({
          title: 'Ogiltigt belopp',
          description: `${label} måste vara noll eller ett positivt belopp (eller lämnas tomt).`,
          variant: 'destructive',
        })
        return false
      }
      return parsed
    }
    const insatserRepayableParsed = parseMemberAmount(
      insatserRepayable,
      'Insatser som ska återbetalas nästa räkenskapsår',
    )
    if (insatserRepayableParsed === false) return
    const forlagsRedeemableParsed = parseMemberAmount(
      forlagsRedeemable,
      'Förlagsinsatser som ska lösas in inom två år',
    )
    if (forlagsRedeemableParsed === false) return
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
            medelantal_anstallda_override: medelantalParsed,
            member_count_change: memberCountChange.trim() || null,
            insatser_repayable_next_year: insatserRepayableParsed,
            forlagsinsatser_dividend_right: forlagsDividendRight.trim() || null,
            forlagsinsatser_redeemable_two_years: forlagsRedeemableParsed,
            long_term_debt_over_five_years_confirmed: longTermDebtConfirmed,
            securities_pledged_confirmed: securitiesPledgedConfirmed,
            contingent_liabilities_confirmed: contingentLiabilitiesConfirmed,
            parent_company_confirmed: parentCompanyConfirmed,
            note_overrides: noteOverrides,
            omit_kassaflodesanalys: omitCashFlow,
            kassaflodesanalys_omission_confirmed: cashFlowOmissionConfirmed,
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
      setSavedMedelantalOverride(medelantalOverride)
      setSavedMemberCountChange(memberCountChange)
      setSavedInsatserRepayable(insatserRepayable)
      setSavedForlagsDividendRight(forlagsDividendRight)
      setSavedForlagsRedeemable(forlagsRedeemable)
      setSavedLongTermDebtConfirmed(longTermDebtConfirmed)
      setSavedSecuritiesPledgedConfirmed(securitiesPledgedConfirmed)
      setSavedContingentLiabilitiesConfirmed(contingentLiabilitiesConfirmed)
      setSavedParentCompanyConfirmed(parentCompanyConfirmed)
      setSavedNoteOverrides(noteOverrides)
      setSavedOmitCashFlow(omitCashFlow)
      setSavedCashFlowOmissionConfirmed(cashFlowOmissionConfirmed)
      // Whether the cash-flow choice is honoured, and the generated note
      // texts, are decided server-side: refresh the document data quietly
      // so the verdict and the K3 summary reflect what was just saved.
      fetch(`/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning`)
        .then((r) => r.json())
        .then((refreshed) => {
          if (refreshed?.data) setData(refreshed.data as ArsredovisningData)
        })
        .catch(() => undefined) // a refresh: the save stands, the next load shows it
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
    medelantalOverride,
    memberCountChange,
    insatserRepayable,
    forlagsDividendRight,
    forlagsRedeemable,
    longTermDebtConfirmed,
    securitiesPledgedConfirmed,
    contingentLiabilitiesConfirmed,
    parentCompanyConfirmed,
    noteOverrides,
    omitCashFlow,
    cashFlowOmissionConfirmed,
    toast,
  ])

  // Upload the signed copy into the archive (kept seven years, BFL 7 kap.)
  // and point the evidence at it.
  const handleUploadEvidence = useCallback(
    async (file: File) => {
      setUploadingEvidence(true)
      try {
        const form = new FormData()
        form.append('file', file)
        form.append('upload_source', 'file_upload')
        form.append('dedupe_by_content', 'true')
        const response = await fetch('/api/documents', { method: 'POST', body: form })
        const body = await response.json().catch(() => null)
        const documentId: string | undefined = body?.data?.id
        if (!response.ok || !documentId) {
          throw new Error(getUserErrorMessage(body?.error) ?? '')
        }
        const uploaded: EvidenceDocument = {
          document_id: documentId,
          title: file.name,
          document_date: null,
          created_at: new Date().toISOString(),
          doc_type: null,
        }
        setEvidenceDocuments((current) => [
          uploaded,
          ...(current ?? []).filter((document) => document.document_id !== documentId),
        ])
        setSignatureEvidence(documentEvidenceReference(documentId))
      } catch (err) {
        toast({
          title: tSteps('signature_document_upload_error'),
          description: err instanceof Error ? getUserErrorMessage(err) : undefined,
          variant: 'destructive',
        })
      } finally {
        setUploadingEvidence(false)
        if (evidenceFileInput.current) evidenceFileInput.current.value = ''
      }
    },
    [tSteps, toast],
  )

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
          description: tSteps('signature_evidence_hint'),
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
        // The last signature moves the version to signed: the studio
        // reloads the versions and hands them back via onVersionsChanged.
        refreshCompliance()
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
      periodId,
      refreshCompliance,
      selectedSignatureVersionId,
      signatureDate,
      signatureEvidence,
      signingMethod,
      tSteps,
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
      refreshCompliance()
      toast({ title: 'Undertecknare tillagd', description: `${signerRole}: ${signerName}` })
    } catch (err) {
      toast({
        title: 'Kunde inte lägga till undertecknare',
        description: err instanceof Error ? getUserErrorMessage(err) : 'Okänt fel',
        variant: 'destructive',
      })
    }
  }, [periodId, refreshCompliance, signerName, signerRole, toast])

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
        refreshCompliance()
        toast({ title: tStudio('signer_removed') })
      } catch (err) {
        toast({
          title: tStudio('signer_remove_error'),
          description: err instanceof Error ? getUserErrorMessage(err) : undefined,
          variant: 'destructive',
        })
      }
    },
    [periodId, refreshCompliance, tStudio, toast],
  )

  // A BankID request was sent, reminded or cancelled, or a signature landed:
  // the slots, the requests and the compliance check are read again.
  const reloadSigning = useCallback(() => {
    if (!periodId) return
    fetch(`/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/signatures`)
      .then((response) => response.json())
      .then((body: { data?: SignatureRequest[] }) => {
        if (Array.isArray(body?.data)) setSignatures(body.data)
      })
      .catch(() => undefined) // a refresh: the list reloads on the next visit
    setSigningReload((n) => n + 1)
    refreshCompliance()
  }, [periodId, refreshCompliance])

  // A deep link to a step (#ar-step-agm from the member signing page) lands
  // there once the page has rendered its sections.
  const scrolledToHash = useRef(false)
  useEffect(() => {
    if (loading || scrolledToHash.current) return
    const hash = typeof window === 'undefined' ? '' : window.location.hash.slice(1)
    if (!hash.startsWith('ar-step-')) return
    scrolledToHash.current = true
    document.getElementById(hash)?.scrollIntoView({ block: 'start' })
  }, [loading])

  // A rail step scrolls to its section; the bokslut lives on its own page.
  const goToStep = useCallback(
    (key: string) => {
      if (key === 'bokslut') {
        if (periodId) router.push(`/bookkeeping/year-end?period=${periodId}`)
        return
      }
      const section = document.getElementById(annualReportStepAnchor(key as AnnualReportStepKey))
      if (!section) return
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      section.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' })
    },
    [periodId, router],
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
  const blockingCount = complianceSummary
    ? complianceSummary.issues.filter((issue) => issue.severity === 'error').length
    : null
  const noLockedVersionHint = (() => {
    if (lockedVersions.length > 0) return null
    const draftNote = draftVersionCount > 0 ? 'Versionsutkast kan inte signeras. ' : ''
    if (blockingCount === null) {
      return `${draftNote}Lås en version under Granska och lås så dyker den upp här.`
    }
    if (blockingCount > 0) {
      const what = blockingCount === 1 ? 'det blockerande felet' : `de ${blockingCount} blockerande felen`
      const done = blockingCount === 1 ? 'åtgärdat' : 'åtgärdade'
      return `${draftNote}Knappen Lås version för underskrift är grå tills ${what} är ${done}.`
    }
    return `${draftNote}Klicka på Lås version för underskrift under Granska och lås så dyker versionen upp här.`
  })()
  const pendingSignatureCount = signatures.filter(
    (sig) => sig.status !== 'signed' && sig.status !== 'declined',
  ).length
  // The archive document the evidence points at, when it is one the picker lists.
  const pickedEvidenceDocumentId = (() => {
    const documentId = evidenceDocumentId(signatureEvidence)
    return documentId && evidenceDocuments?.some((document) => document.document_id === documentId)
      ? documentId
      : null
  })()
  const signingSlots = signingVersionId ? signatures.filter((sig) => sig.annual_report_version_id === signingVersionId) : []
  const signingTrack = deriveArsredovisningSigningTrack(signingSlots, versionSigningRequests ?? [])
  // One track per version: a BankID request open, or a BankID signature
  // made, closes recording by hand; while both ways are open and BankID is
  // available, recording by hand is the secondary way, folded away.
  const manualBlocked = signingTrack.kind === 'bankid'
  const manualFolded = signingAvailable && signingTrack.kind === 'none' && !manualOpen
  const signReadinessHint = !selectedSignatureVersionId
    ? 'Välj en låst version ovan, sedan går det att markera underskrifter.'
    : !SIGNATURE_EVIDENCE_REFERENCE_PATTERN.test(signatureEvidence.trim())
      ? tSteps('signature_evidence_hint')
      : !signatureDate
        ? 'Ange underskriftsdatum så aktiveras Markera som signerad.'
        : null

  // The steps, derived from what is stored (workflow-steps.ts). They wait
  // for the compliance check and the fiscal-year list so the rail never
  // shows a guess.
  const period = fiscalPeriods.find((candidate) => candidate.id === periodId)
  const workflow =
    complianceSummary && !periodsLoading
      ? deriveAnnualReportWorkflow({
          yearClosed: Boolean(period && (period.is_closed || period.closing_entry_id)),
          issues: complianceSummary.issues,
          signerRosterConfirmed: complianceSummary.signerRosterConfirmed,
          unsavedContent: hasUnsavedContent,
          unsavedAgm: hasUnsavedAgm,
          signers: signatures,
          versions,
          agmRecorded: isAgmRecorded({
            agm_date: savedAgmDate,
            agm_disposition_outcome: savedAgmDispositionOutcome,
            agm_disposition_decision: savedAgmDispositionDecision,
          }),
        })
      : null
  const primaryAction = workflow?.next?.action ?? null
  const stepSub = (step: AnnualReportStep): { sub: string | null; warn: boolean } => {
    const detail = step.detail
    switch (detail.kind) {
      case 'done':
        return { sub: tSteps('sub_done'), warn: false }
      case 'errors':
        return { sub: tSteps('sub_errors', { count: detail.count }), warn: true }
      case 'unsaved':
        return { sub: tSteps('sub_unsaved'), warn: true }
      case 'draft':
        return { sub: tSteps('sub_draft'), warn: false }
      case 'version':
        return { sub: tSteps('sub_version', { number: detail.number }), warn: false }
      case 'progress':
        return { sub: tSteps('sub_progress', { done: detail.done, total: detail.total }), warn: false }
      case 'k3_draft_only':
        return { sub: tSteps('sub_k3'), warn: true }
      default:
        return { sub: step.state === 'current' ? tSteps('sub_next') : null, warn: false }
    }
  }

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
        // The year switch has to live on the loaded view too: the no-period
        // branch above auto-jumps to the remembered scope (or the newest
        // year) before anyone sees its picker, so without this the only way
        // to another year's årsredovisning was to change the scope on some
        // other page and come back. The way back to the bokslut is the
        // rail's first step (Bokslut), not a second button up here.
        action={
          <FyPicker
            value={periodId}
            onChange={(id) => {
              if (id && id !== periodId) {
                router.replace(`/bookkeeping/year-end/arsredovisning?period=${id}`)
              }
            }}
            includeAllOption={false}
            hideFuturePeriods
          />
        }
      />

      {/* One numbered sequence for the whole page: what is done, what is
          next and what blocks (crm#1172). Each step scrolls to its section. */}
      {workflow ? (
        <div className="space-y-3">
          <StepRail
            compact
            ariaLabel={tSteps('rail_label')}
            steps={workflow.steps.map((step) => ({
              key: step.key,
              label: tSteps(`step_${step.key}`),
              state: step.state,
              ...stepSub(step),
            }))}
            onSelect={goToStep}
          />
          <p className="px-1 text-[13px] leading-5">
            {workflow.next ? (
              <>
                <span className="text-muted-foreground">{tSteps('next_label')}</span>{' '}
                {tSteps(`next_${workflow.next.action}`)}{' '}
                {workflow.next.action === 'close_year' ? (
                  <Link href={`/bookkeeping/year-end?period=${periodId}`} className={TEXT_LINK_CLASS}>
                    {tSteps('open_bokslut')}
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => goToStep(workflow.next?.step ?? 'scope')}
                    className={TEXT_LINK_CLASS}
                  >
                    {tSteps('go_to_step')}
                  </button>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">{tSteps('all_done')}</span>
            )}
          </p>
        </div>
      ) : (
        <div className="space-y-3 px-1" aria-hidden="true">
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      )}

      {/* Steps 2 to 5 render inside the studio, which owns the compliance
          check; steps 3 and 4 are this page's inputs, passed in so each
          step's fields, open points and confirm button sit together. */}
      <AnnualReportStudio
        periodId={periodId}
        periodStart={data.fiscal_period.period_start}
        periodEnd={data.fiscal_period.period_end}
        framework={data.accounting_framework}
        hasUnsavedNarrative={hasUnsavedNarrative}
        narrativeRevision={narrativeRevision}
        refreshKey={complianceRefresh}
        primaryAction={primaryAction}
        onVersionsChanged={handleVersionsChanged}
        onComplianceChanged={setComplianceSummary}
        contentHelp={
          <HelpPopover>
            <div className="space-y-2">
              <p>{tHelp('content_pdf')}</p>
              {data.accounting_framework === 'k3' && (
                <>
                  <p className="font-medium">{tHelp('k3_title')}</p>
                  {/* Enumerate only what buildK3Noter and buildArsredovisningData
                      actually emit. The uppskjuten skatt-noten needs a 2240/8940
                      balance (which the engine no longer creates: K3 29.37 gross in
                      juridisk person), the anläggningsnoter need assets in the
                      register, and the kassaflödesanalys is dropped with a warning
                      when it cannot be generated. Promising any of them
                      unconditionally is false in the normal case. */}
                  <p>
                    {data.kassaflodesanalys
                      ? tHelp('k3_template')
                      : data.kassaflodesanalys_omission?.omitted
                        ? tNotes('cashflow_omitted_notice')
                        : tHelp('k3_template_cashflow_failed')}{' '}
                    {tHelp('k3_notes_scope')}
                  </p>
                </>
              )}
            </div>
          </HelpPopover>
        }
        boardHelp={<HelpPopover>{tSteps('board_intro')}</HelpPopover>}
        contentSection={
          <>
            <div className="space-y-4 px-1 pt-2">
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
              <div className="pt-4 border-t border-border space-y-4">
                <div className="flex items-center gap-2">
                  <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Lagstadgade upplysningar
                  </h3>
                  <HelpPopover>
                    <div className="space-y-2">
                      <p>{tHelp('disclosures_intro')}</p>
                      <ul className="list-disc space-y-1 pl-4">
                        <li>{tHelp('ref_medelantal')}</li>
                        <li>{tHelp('ref_long_term_debt')}</li>
                        <li>{tHelp('ref_securities')}</li>
                        <li>{tHelp('ref_contingent')}</li>
                        <li>{tHelp('ref_parent')}</li>
                      </ul>
                      <p>{tHelp('parent_org_nr_format')}</p>
                    </div>
                  </HelpPopover>
                </div>
                {data?.company.entity_type === 'ekonomisk_forening' && (
                  <div className="space-y-4 pb-4 border-b border-border">
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-medium">{tHelp('members_title')}</h4>
                      <HelpPopover>
                        <div className="space-y-2">
                          <p>{tHelp('members_intro')}</p>
                          <p>{tHelp('members_refs')}</p>
                        </div>
                      </HelpPopover>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="ar-member-count">Väsentliga förändringar i medlemsantalet</Label>
                      <Textarea
                        id="ar-member-count"
                        value={memberCountChange}
                        onChange={(e) => setMemberCountChange(e.target.value)}
                        placeholder="T.ex. Antalet medlemmar ökade från 42 till 55 under året."
                        rows={2}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="ar-insatser-repayable">
                        Insatser som ska återbetalas under nästa räkenskapsår (kr)
                      </Label>
                      <Input
                        id="ar-insatser-repayable"
                        type="text"
                        inputMode="decimal"
                        value={insatserRepayable}
                        onChange={(e) => setInsatserRepayable(e.target.value)}
                        placeholder="0"
                        className="max-w-[220px] tabular-nums"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="ar-forlags-right">Rätt till utdelning som förlagsinsatser medför</Label>
                      <Textarea
                        id="ar-forlags-right"
                        value={forlagsDividendRight}
                        onChange={(e) => setForlagsDividendRight(e.target.value)}
                        placeholder="Lämna tomt om föreningen saknar förlagsinsatser."
                        rows={2}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="ar-forlags-redeemable">
                        Uppsagda förlagsinsatser som ska lösas in inom två räkenskapsår (kr)
                      </Label>
                      <Input
                        id="ar-forlags-redeemable"
                        type="text"
                        inputMode="decimal"
                        value={forlagsRedeemable}
                        onChange={(e) => setForlagsRedeemable(e.target.value)}
                        placeholder="0"
                        className="max-w-[220px] tabular-nums"
                      />
                    </div>
                  </div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="ar-medelantal">Medelantal anställda</Label>
                  <Input
                    id="ar-medelantal"
                    type="text"
                    inputMode="numeric"
                    value={medelantalOverride}
                    onChange={(e) => setMedelantalOverride(e.target.value)}
                    placeholder="Beräknas från Löner"
                    className="max-w-[220px] tabular-nums"
                  />
                  <p className="text-xs text-muted-foreground">{tHelp('medelantal_hint')}</p>
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
                  <p className="text-xs text-muted-foreground">{tHelp('long_term_debt_hint')}</p>
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
                  <p className="text-xs text-muted-foreground">{tHelp('parent_name_hint')}</p>
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

              {data.accounting_framework === 'k3' && (
                <div className="pt-4 border-t border-border space-y-4">
                  <div className="flex items-center gap-2">
                    <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      {tNotes('notes_title')}
                    </h3>
                    <HelpPopover>{tNotes('notes_description')}</HelpPopover>
                  </div>
                  {data.noter
                    .filter((note) => note.key)
                    .map((note) => {
                      const key = note.key as string
                      const generated = note.generated_body ?? note.body
                      const edited = key in noteOverrides
                      return (
                        <div key={key} className="space-y-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <Label htmlFor={`ar-note-${key}`}>
                              {tNotes('note_label', { number: note.number, title: note.title })}
                            </Label>
                            {edited && (
                              <div className="flex items-center gap-2">
                                <Badge variant="secondary">{tNotes('note_edited')}</Badge>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    setNoteOverrides((prev) => {
                                      const next = { ...prev }
                                      delete next[key]
                                      return next
                                    })
                                  }
                                >
                                  {tNotes('reset_note')}
                                </Button>
                              </div>
                            )}
                          </div>
                          <Textarea
                            id={`ar-note-${key}`}
                            value={noteOverrides[key] ?? generated}
                            onChange={(event) => {
                              const value = event.target.value
                              setNoteOverrides((prev) => {
                                const next = { ...prev }
                                if (value === generated || value.trim() === '') delete next[key]
                                else next[key] = value
                                return next
                              })
                            }}
                            rows={key === 'redovisningsprinciper' ? 10 : 3}
                            maxLength={8000}
                          />
                        </div>
                      )
                    })}
                </div>
              )}

              {data.accounting_framework === 'k3' && data.kassaflodesanalys_omission && (
                <div className="pt-4 border-t border-border space-y-3">
                  <div className="flex items-center gap-2">
                    <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      {tNotes('cashflow_title')}
                    </h3>
                    <HelpPopover>{tNotes('cashflow_rule')}</HelpPopover>
                  </div>
                  {data.kassaflodesanalys_omission.rule === 'forbidden' ? (
                    <>
                      <p className="text-sm">{tNotes('cashflow_forbidden')}</p>
                      {/* A choice saved before the company became a större
                          företag is not honoured; let the user clear it. */}
                      {savedOmitCashFlow && (
                        <label className="flex cursor-pointer items-center gap-3 text-sm">
                          <Checkbox
                            id="ar-omit-cashflow"
                            checked={omitCashFlow}
                            onCheckedChange={(checked) => setOmitCashFlow(Boolean(checked))}
                          />
                          {tNotes('cashflow_omit')}
                        </label>
                      )}
                    </>
                  ) : (
                    <>
                      <p className="text-xs text-muted-foreground">
                        {data.kassaflodesanalys_omission.rule === 'allowed'
                          ? tNotes('cashflow_allowed')
                          : tNotes('cashflow_needs_confirmation')}
                      </p>
                      <label className="flex cursor-pointer items-center gap-3 text-sm">
                        <Checkbox
                          id="ar-omit-cashflow"
                          checked={omitCashFlow}
                          onCheckedChange={(checked) => setOmitCashFlow(Boolean(checked))}
                        />
                        {tNotes('cashflow_omit')}
                      </label>
                      {data.kassaflodesanalys_omission.rule === 'requires_confirmation' && omitCashFlow && (
                        <label className="flex cursor-pointer items-center gap-3 text-sm">
                          <Checkbox
                            id="ar-omit-cashflow-confirmed"
                            checked={cashFlowOmissionConfirmed}
                            onCheckedChange={(checked) =>
                              setCashFlowOmissionConfirmed(Boolean(checked))
                            }
                          />
                          {tNotes('cashflow_confirm')}
                        </label>
                      )}
                    </>
                  )}
                </div>
              )}

              <div className="space-y-2 border-t border-border pt-4">
                <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Flerårsöversikt
                </h3>
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
                  variant={primaryAction === 'save_text' ? 'default' : 'outline'}
                  onClick={handleSaveNarrative}
                  disabled={!hasUnsavedNarrative}
                  loading={savingNarrative}
                >
                  {savingNarrative ? (
                    'Sparar…'
                  ) : (
                    <>
                      <Save className="mr-2 h-4 w-4" /> Spara texten
                    </>
                  )}
                </Button>
              </div>
            </div>
          </>
        }
        boardSection={
          <div className="space-y-4 px-1 pt-2">
            {signingAvailable && <p className="text-xs leading-5 text-muted-foreground">{tSign('board_name_rule')}</p>}
            {signatures.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">{tSteps('board_empty')}</p>
            ) : (
              signatures.map((sig) => (
                <div
                  key={sig.id}
                  className="flex items-center justify-between gap-3 border-b border-border pb-3 last:border-b-0 last:pb-0"
                >
                  <div>
                    <p className="text-sm font-medium">{sig.signer_name}</p>
                    <p className="text-xs text-muted-foreground">{sig.role}</p>
                  </div>
                  {sig.status === 'pending' && sig.annual_report_version_id === null && (
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
                </div>
              ))
            )}
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
              <Button
                variant={primaryAction === 'add_signer' ? 'default' : 'outline'}
                className="w-full sm:w-auto"
                onClick={handleAddSigner}
                disabled={!signerName.trim()}
              >
                <Plus className="mr-1 h-4 w-4" /> Lägg till
              </Button>
            </div>
          </div>
        }
      />

      <section id={annualReportStepAnchor('signatures')} className="scroll-mt-24">
        <StepSectionHeader
          step="signatures"
          title={tSteps('section_signatures')}
          help={
            <HelpPopover>
              <div className="space-y-2">
                <p>{tSteps('signatures_intro')}</p>
                <p>{tHelp('signatures_evidence', { appName })}</p>
              </div>
            </HelpPopover>
          }
        />
        <div className="space-y-4 px-1 pt-2">
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
                  <a href={`#${annualReportStepAnchor('lock')}`} className={TEXT_LINK_CLASS}>
                    Gå till Granska och lås
                  </a>
                </p>
              )}
            </div>
          </div>
          {signingVersionId && (signingAvailable || signingTrack.kind === 'bankid') && (
            <ArsredovisningBankIdSigning
              fiscalPeriodId={periodId}
              versionId={signingVersionId}
              slots={signingSlots}
              requests={versionSigningRequests}
              track={signingTrack}
              available={signingAvailable}
              onChanged={reloadSigning}
            />
          )}
          {manualBlocked ? (
            <p className="text-[13px] text-muted-foreground">{tSign('manual_blocked_bankid')}</p>
          ) : (
            <>
              {signingAvailable && signingTrack.kind === 'none' && (
                <div className="space-y-1">
                  <button type="button" className={QUIET_LINK_CLASS} aria-expanded={manualOpen} onClick={() => setManualOpen((open) => !open)}>
                    {manualOpen ? tSign('manual_hide') : tSign('manual_show')}
                  </button>
                  <p className="text-[12.5px] text-muted-foreground">{tSign('manual_when')}</p>
                </div>
              )}
              {!manualFolded && (
                <>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="signature-method">Underskriftsmetod</Label>
              <Select
                value={signingMethod}
                onValueChange={(next) => setSigningMethod(next as 'paper_original' | 'advanced_e_signature')}
              >
                <SelectTrigger id="signature-method">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="paper_original">{tSign('method_paper')}</SelectItem>
                  <SelectItem value="advanced_e_signature">{tSign('method_e_signature')}</SelectItem>
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
              <Label htmlFor="signature-document">{tSteps('signature_document_label')}</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Select
                  value={pickedEvidenceDocumentId ?? ''}
                  onValueChange={(documentId) => setSignatureEvidence(documentEvidenceReference(documentId))}
                  disabled={!evidenceDocuments || evidenceDocuments.length === 0}
                >
                  <SelectTrigger id="signature-document" className="min-w-0 flex-1">
                    <SelectValue
                      placeholder={
                        evidenceDocuments && evidenceDocuments.length === 0
                          ? tSteps('signature_document_empty')
                          : tSteps('signature_document_placeholder')
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {(evidenceDocuments ?? []).map((document) => (
                      <SelectItem key={document.document_id} value={document.document_id}>
                        {document.title} ({document.document_date ?? document.created_at.slice(0, 10)})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <input
                  ref={evidenceFileInput}
                  type="file"
                  accept={DOCUMENT_UPLOAD_ACCEPT}
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void handleUploadEvidence(file)
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => evidenceFileInput.current?.click()}
                  disabled={!hasLockedVersion}
                  loading={uploadingEvidence}
                >
                  {!uploadingEvidence && <Upload className="mr-2 h-4 w-4" />}
                  {uploadingEvidence
                    ? tSteps('signature_document_uploading')
                    : tSteps('signature_document_upload')}
                </Button>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">{tSteps('signature_document_help')}</p>
              <Label htmlFor="signature-evidence" className="text-xs text-muted-foreground">
                {tSteps('signature_reference_label')}
              </Label>
              {/* A picked document shows in the picker; this field is for a reference of one's own. */}
              <Input
                id="signature-evidence"
                value={pickedEvidenceDocumentId ? '' : signatureEvidence}
                onChange={(event) => setSignatureEvidence(event.target.value)}
                placeholder="archive:AR-2026-001"
                maxLength={128}
                autoComplete="off"
              />
            </div>
          </div>
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
                  <span className="text-xs text-muted-foreground">Signerad</span>
                ) : sig.status === 'declined' ? (
                  <Badge variant="destructive">Avböjd</Badge>
                ) : (
                  <>
                    <span className="text-xs text-muted-foreground">Väntar på underskrift</span>
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
                </>
              )}
            </>
          )}
        </div>
      </section>

      <section id={annualReportStepAnchor('agm')} className="scroll-mt-24">
        <StepSectionHeader
          step="agm"
          title={tSteps('section_agm')}
          help={<HelpPopover>{tSteps('agm_intro')}</HelpPopover>}
        />
        <div className="space-y-4 px-1 pt-2">
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

          <div className="flex justify-end pt-2">
            <Button
              variant={primaryAction === 'save_agm' ? 'default' : 'outline'}
              onClick={handleSaveNarrative}
              disabled={!hasUnsavedNarrative}
              loading={savingNarrative}
            >
              {!savingNarrative && <Save className="mr-2 h-4 w-4" />}
              {tSteps('save_agm')}
            </Button>
          </div>
        </div>
      </section>

      <section id={annualReportStepAnchor('filing')} className="scroll-mt-24">
        <StepSectionHeader step="filing" title={tSteps('section_filing')} />
        <div className="space-y-4 px-1 pt-2 text-sm">
          <p className="text-muted-foreground">
            Ladda ner PDF-utkastet och granska det. För pappersinlämning ska
            årsredovisningens original skrivas under av samtliga styrelseledamöter och
            eventuell VD. En bestyrkt kopia med fastställelseintyg skickas sedan per post
            till Bolagsverket. PDF-filen kan inte laddas upp som digital årsredovisning.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" asChild>
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
            <div className="space-y-1 border-t border-border pt-3 text-xs">
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
