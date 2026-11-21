'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { StandaloneFacts, StandaloneHeading } from '@/components/standalone/StandalonePage'
import { Dialog, DialogConsequence, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ArrowDownTrayIcon, ArrowTopRightOnSquareIcon, CheckCircleIcon } from '@/components/icons'
import { cn } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { fetchCompanyLookup } from '@/lib/company-lookup/fetch-company-lookup'
import type { CompanyLookupResult } from '@/lib/company-lookup/types'
import { type FormationAnswers, founders, persons, primaryName } from '@/lib/formation/answers'
import { BOLAGSVERKET_FEES, FORMATION_BOOKING_URL, VERKSAMT_REGISTER_AB_URL } from '@/lib/formation/constants'
import { FORMATION_CATALOG } from '@/lib/formation/documents/catalog'
import { firstFiscalYear } from '@/lib/formation/fiscal-year'
import { type FormationStep, beneficialOwners, isValidOrgNumber } from '@/lib/formation/rules'
import type { FormationView } from '@/lib/formation/store'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { formationFetch } from './FormationFlow'

const kr = (n: number) => `${new Intl.NumberFormat('sv-SE').format(n)} kr`

function DocLink({ href, label }: { href: string; label: string }) {
  return (
    <Button asChild variant="row" className="gap-1.5">
      <a href={href} download>
        <ArrowDownTrayIcon className="h-4 w-4" />
        {label}
      </a>
    </Button>
  )
}

function StepItem({ n, title, done, children }: { n: number; title: string; done?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex gap-3 border-t-hairline pt-4">
      <span
        className={cn(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs font-medium tabular-nums',
          done ? 'bg-secondary text-success' : 'bg-secondary text-strong',
        )}
        aria-hidden="true"
      >
        {done ? <CheckCircleIcon className="h-4 w-4" /> : n}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <h2 className="text-sm font-medium text-strong">{title}</h2>
        {children}
      </div>
    </li>
  )
}

export function FormationPackage({
  formation,
  answers,
  ticEnabled,
  shareholderAgreement,
  onChange,
  onEdit,
  onStartNew,
}: {
  formation: FormationView
  answers: FormationAnswers
  ticEnabled: boolean
  shareholderAgreement: boolean
  onChange: (v: FormationView) => void
  onEdit: (step: FormationStep) => void
  /** Start one more formation (a holding company, a second company). */
  onStartNew: () => void
}) {
  const t = useTranslations('formation.package')
  const docsT = useTranslations('formation.documents')
  const locale = useLocale()
  const router = useRouter()
  const today = todayIsoStockholm()
  const base = `/api/formation/${formation.id}`
  const docs = FORMATION_CATALOG.filter((d) => d.available(answers) && (d.slug !== 'aktieagaravtal' || shareholderAgreement))
  const href = (slug: string, format: 'pdf' | 'docx') => `${base}/documents/${slug}?format=${format}`

  // Sent in
  const [deedDate, setDeedDate] = useState(formation.deedDate ?? today)
  const [marking, setMarking] = useState(false)
  const [markError, setMarkError] = useState<string | null>(null)
  const markSubmitted = async () => {
    setMarking(true)
    setMarkError(null)
    try {
      onChange(await formationFetch<FormationView>(`${base}/submitted`, { method: 'POST', body: JSON.stringify({ deed_date: deedDate }) }, locale))
    } catch (err) {
      setMarkError(getErrorMessage(err, { locale: locale === 'en' ? 'en' : 'sv' }))
    } finally {
      setMarking(false)
    }
  }

  // Registered
  const [orgNumber, setOrgNumber] = useState('')
  const [looking, setLooking] = useState(false)
  const [lookup, setLookup] = useState<CompanyLookupResult | null>(null)
  const [manual, setManual] = useState(false)
  const [registeredName, setRegisteredName] = useState(primaryName(answers))
  const [registrationDate, setRegistrationDate] = useState(today)
  const [lookupNote, setLookupNote] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [ownersConfirmed, setOwnersConfirmed] = useState(false)
  const [settingUp, setSettingUp] = useState(false)
  const [setupError, setSetupError] = useState<string | null>(null)

  const find = async () => {
    setLookupNote(null)
    if (!isValidOrgNumber(orgNumber)) {
      setLookupNote(t('org_invalid'))
      return
    }
    setLooking(true)
    const outcome = await fetchCompanyLookup(orgNumber, { ticEnabled })
    setLooking(false)
    if (outcome.status === 'found') {
      setLookup(outcome.result)
      setManual(false)
      setRegisteredName(outcome.result.companyName || primaryName(answers))
      if (outcome.result.registrationDate) setRegistrationDate(new Date(outcome.result.registrationDate).toISOString().slice(0, 10))
      setConfirmOpen(true)
    } else {
      // Not in the registry data yet, or the lookup is off: the founder types
      // the two facts from the registreringsbevis.
      setLookup(null)
      setManual(true)
      setLookupNote(outcome.status === 'not_found' ? t('org_not_found') : t('org_lookup_off'))
    }
  }

  const fy = useMemo(() => firstFiscalYear(registrationDate, answers.fiscalYearStartMonth, answers.extendFirstYear), [registrationDate, answers])
  const owners = beneficialOwners(answers)

  const setUp = async () => {
    setSettingUp(true)
    setSetupError(null)
    try {
      await formationFetch<{ company_id: string }>(
        `${base}/setup`,
        {
          method: 'POST',
          body: JSON.stringify({
            org_number: orgNumber,
            company_name: registeredName,
            registration_date: registrationDate,
            beneficial_owners_confirmed: ownersConfirmed,
            lookup,
          }),
        },
        locale,
      )
      router.push('/')
      router.refresh()
    } catch (err) {
      setSetupError(getErrorMessage(err, { locale: locale === 'en' ? 'en' : 'sv' }))
      setSettingUp(false)
    }
  }

  if (formation.status === 'set_up') {
    return (
      <div>
        <StandaloneHeading title={t('done_title')} sub={t('done_sub')} />
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Button asChild>
            <Link href="/">{t('open_accounted')}</Link>
          </Button>
          <Button variant="ghost" onClick={onStartNew}>
            {t('start_another')}
          </Button>
        </div>
      </div>
    )
  }

  const submitted = formation.status === 'submitted'

  return (
    <div>
      <StandaloneHeading title={t('title', { name: primaryName(answers) })} sub={t('sub')} />

      <ol className="mt-6 space-y-4">
        <StepItem n={1} title={t('bank_title')}>
          <p className="text-sm text-foreground/80">{t('bank_text', { amount: kr(answers.capital.amount) })}</p>
          <div className="flex flex-wrap gap-1">
            <DocLink href={href('bank', 'pdf')} label={docsT('bank')} />
          </div>
        </StepItem>

        <StepItem n={2} title={t('verksamt_title')}>
          <p className="text-sm text-foreground/80">{t('verksamt_text')}</p>
          <div className="flex flex-wrap gap-1">
            <DocLink href={href('verksamt', 'pdf')} label={docsT('verksamt')} />
            <Button asChild variant="row" className="gap-1.5">
              <a href={VERKSAMT_REGISTER_AB_URL} target="_blank" rel="noreferrer">
                <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                {t('open_verksamt')}
              </a>
            </Button>
          </div>
        </StepItem>

        <StepItem n={3} title={t('sign_title')} done={submitted}>
          <p className="text-sm text-foreground/80">
            {t('sign_text', { founders: founders(answers).length, fees: kr(BOLAGSVERKET_FEES.registration + BOLAGSVERKET_FEES.beneficialOwner) })}
          </p>
          {submitted ? (
            <p className="text-xs text-muted-foreground">{t('submitted_on', { date: formation.deedDate ?? '' })}</p>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <Label htmlFor="formation-deed-date">{t('deed_date_label')}</Label>
                <Input id="formation-deed-date" type="date" max={today} value={deedDate} onChange={(e) => setDeedDate(e.target.value)} className="mt-1.5 w-44" />
              </div>
              <Button variant="outline" onClick={markSubmitted} loading={marking}>
                {t('mark_submitted')}
              </Button>
              {markError && <p className="w-full text-xs text-destructive">{markError}</p>}
            </div>
          )}
        </StepItem>

        <StepItem n={4} title={t('registered_title')}>
          <p className="text-sm text-foreground/80">{t('registered_text')}</p>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <Label htmlFor="formation-org-number">{t('org_label')}</Label>
              <Input
                id="formation-org-number"
                inputMode="numeric"
                placeholder="559XXX-XXXX"
                value={orgNumber}
                onChange={(e) => setOrgNumber(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void find()
                }}
                className="mt-1.5 w-44"
                maxLength={13}
              />
            </div>
            <Button onClick={find} loading={looking}>
              {t('find')}
            </Button>
          </div>
          {lookupNote && <p className="text-xs text-muted-foreground">{lookupNote}</p>}
          {manual && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="formation-registered-name">{t('registered_name_label')}</Label>
                <Input id="formation-registered-name" value={registeredName} onChange={(e) => setRegisteredName(e.target.value)} className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="formation-registration-date">{t('registration_date_label')}</Label>
                <Input id="formation-registration-date" type="date" max={today} value={registrationDate} onChange={(e) => setRegistrationDate(e.target.value)} className="mt-1.5" />
              </div>
              <div className="sm:col-span-2">
                <Button onClick={() => setConfirmOpen(true)} disabled={!isValidOrgNumber(orgNumber) || !registeredName.trim()}>
                  {t('continue_setup')}
                </Button>
              </div>
            </div>
          )}
        </StepItem>
      </ol>

      <section className="mt-8">
        <h2 className="text-base font-medium text-strong">{t('documents_title')}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('documents_sub')}</p>
        <ul className="mt-3 border-t-hairline">
          {docs.map((d) => (
            <li key={d.slug} className="flex min-h-11 items-center justify-between gap-3 border-b-hairline py-1">
              <span className="min-w-0 truncate text-sm text-foreground">{docsT(d.slug)}</span>
              <span className="flex shrink-0 gap-1">
                {d.formats.map((f) => (
                  <DocLink key={f} href={href(d.slug, f)} label={f === 'pdf' ? 'PDF' : 'Word'} />
                ))}
              </span>
            </li>
          ))}
          <li className="flex min-h-11 items-center justify-between gap-3 border-b-hairline py-1">
            <span className="min-w-0">
              <span className="block truncate text-sm text-foreground">{docsT('skill')}</span>
              <span className="block truncate text-xs text-muted-foreground">{docsT('skill_hint')}</span>
            </span>
            <DocLink href={`${base}/skill`} label="ZIP" />
          </li>
        </ul>
      </section>

      <div className="mt-8 flex flex-wrap items-center gap-2 border-t-hairline pt-4">
        <Button variant="ghost" onClick={() => onEdit('company')}>
          {t('edit_answers')}
        </Button>
        <Button asChild variant="ghost">
          <a href={FORMATION_BOOKING_URL} target="_blank" rel="noreferrer">
            {t('book_call')}
          </a>
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={(open) => !settingUp && setConfirmOpen(open)}>
        <DialogContent size="form">
          <DialogHeader>
            <DialogTitle>{t('confirm_title', { name: registeredName })}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm" data-ph-mask="">
            <StandaloneFacts
              rows={[
                { label: t('confirm_org'), value: orgNumber },
                { label: t('confirm_registered'), value: registrationDate },
                { label: t('confirm_fiscal'), value: `${fy.start} - ${fy.end}` },
                { label: t('confirm_aktiebok'), value: founders(answers).map((f) => `${f.name} ${new Intl.NumberFormat('sv-SE').format(f.shares)}`).join(', ') },
                { label: t('confirm_board'), value: persons(answers).filter((p) => p.roles.length > 0).map((p) => p.name).join(', ') },
                { label: t('confirm_voucher'), value: t('confirm_voucher_value', { amount: kr(answers.capital.amount) }) },
                { label: t('confirm_documents'), value: t('confirm_documents_value') },
              ]}
            />
            <label className="flex items-start gap-2.5">
              <Checkbox className="mt-0.5" checked={ownersConfirmed} onCheckedChange={(v) => setOwnersConfirmed(v === true)} />
              <span className="text-foreground">
                {owners.length > 0
                  ? t('confirm_owners', { names: owners.map((o) => o.name).join(', ') })
                  : t('confirm_no_owner')}
              </span>
            </label>
            {setupError && <p className="text-xs text-destructive">{setupError}</p>}
          </div>
          <DialogFooter>
            <DialogConsequence>{t('confirm_consequence')}</DialogConsequence>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={settingUp}>
              {t('cancel')}
            </Button>
            <Button onClick={setUp} loading={settingUp} disabled={!ownersConfirmed}>
              {t('set_up')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
