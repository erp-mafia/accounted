'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { StandaloneFacts } from '@/components/standalone/StandalonePage'
import { StatusGlyph } from '@/components/ui/status-glyph'
import { CheckIcon } from '@/components/icons'
import { type FormationAnswers, boardMembers, deputies, founders, persons, primaryName, quotaValue } from '@/lib/formation/answers'
import { FORMATION_BOOKING_URL } from '@/lib/formation/constants'
import { type FormationIssue, type FormationStep, beneficialOwners } from '@/lib/formation/rules'

const kr = (n: number) => `${new Intl.NumberFormat('sv-SE').format(n)} kr`

function Section({ title, onEdit, editLabel, children }: { title: string; onEdit: () => void; editLabel: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-base font-medium text-strong">{title}</h2>
        <Button variant="link" onClick={onEdit} className="h-auto px-0">
          {editLabel}
        </Button>
      </div>
      {children}
    </section>
  )
}

export function FormationReview({
  answers: a,
  issues,
  onEdit,
  onShowPackage,
}: {
  answers: FormationAnswers
  issues: FormationIssue[]
  onEdit: (step: FormationStep) => void
  /** Saves what is typed, then opens the package. */
  onShowPackage: () => Promise<void>
}) {
  const t = useTranslations('formation.review')
  const roles = useTranslations('formation.board')
  const months = useTranslations('formation.months')
  const locale = useLocale()
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const errors = issues.filter((i) => i.severity === 'error')
  const owners = beneficialOwners(a)
  const people = persons(a).filter((p) => p.roles.length > 0)

  const showPackage = async () => {
    setOpening(true)
    setError(null)
    try {
      await onShowPackage()
    } catch (err) {
      setError(getErrorMessage(err, { locale: locale === 'en' ? 'en' : 'sv' }))
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="space-y-8" data-ph-mask="">
      <Section title={t('company')} onEdit={() => onEdit('company')} editLabel={t('edit')}>
        <StandaloneFacts
          rows={[
            { label: t('names'), value: a.names.filter(Boolean).join(', ') || '-' },
            { label: t('description'), value: a.description ? t('description_value', { text: a.description.trim() }) : '-' },
            { label: t('seat'), value: a.seat || '-' },
            { label: t('address'), value: [a.address.street, `${a.address.postalCode} ${a.address.city}`.trim()].filter(Boolean).join(', ') || '-' },
          ]}
        />
      </Section>

      <Section title={t('owners')} onEdit={() => onEdit('owners')} editLabel={t('edit')}>
        <StandaloneFacts
          rows={[
            { label: t('capital'), value: `${kr(a.capital.amount)}, ${new Intl.NumberFormat('sv-SE').format(a.capital.shares)} ${t('shares_unit')} (${kr(quotaValue(a))} / ${t('share_unit')})` },
            ...founders(a).map((f) => ({ key: f.id, label: f.name || '-', value: `${new Intl.NumberFormat('sv-SE').format(f.shares)} ${t('shares_unit')}` })),
            { label: t('beneficial_owners'), value: owners.length > 0 ? owners.map((o) => `${o.name} (${String(o.percent).replace('.', ',')} %)`).join(', ') : t('no_beneficial_owner') },
          ]}
        />
      </Section>

      <Section title={t('board')} onEdit={() => onEdit('board')} editLabel={t('edit')}>
        <StandaloneFacts
          rows={[
            ...people.map((p) => ({ key: p.id, label: p.name || '-', value: p.roles.map((r) => roles(`role_${r}`)).join(', ') })),
            { label: t('signatory'), value: roles(`signatory_${a.signatoryRule === 'board' ? 'board' : a.signatoryRule === 'board_or_each' ? 'each' : 'two'}`) },
            { label: t('auditor'), value: a.auditor.has ? a.auditor.name || '-' : roles('auditor_no') },
            { label: t('board_size'), value: t('board_size_value', { members: boardMembers(a).length, deputies: deputies(a).length }) },
          ]}
        />
      </Section>

      <Section title={t('details')} onEdit={() => onEdit('details')} editLabel={t('edit')}>
        <StandaloneFacts
          rows={[
            { label: t('fiscal_year'), value: a.fiscalYearStartMonth === 1 ? t('calendar_year') : t('fiscal_from_month', { month: months(String(a.fiscalYearStartMonth)) }) },
            { label: t('bank'), value: a.bank ? t(`bank_${a.bank}`) : '-' },
            { label: t('contact'), value: [a.contact.name, a.contact.email].filter(Boolean).join(', ') || '-' },
          ]}
        />
      </Section>

      {errors.length > 0 ? (
        <section className="space-y-2">
          <p className="flex items-center gap-2 text-sm text-foreground">
            <StatusGlyph tone="warning" />
            {t('errors', { count: errors.length })}
          </p>
          <ul className="space-y-1 pl-6 text-sm">
            {errors.map((i, n) => (
              <li key={n}>
                <button type="button" className="text-left text-foreground/80 underline decoration-foreground/25 underline-offset-[3px] hover:decoration-foreground/60" onClick={() => onEdit(i.step)}>
                  {t(`step_${i.step}`)}: <IssueText issue={i} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <section className="space-y-4 border-t-hairline pt-6">
          <div>
            <h2 className="text-base font-medium text-strong">{t('package_title', { name: primaryName(a) })}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{t('package_sub')}</p>
          </div>
          <ul className="space-y-1.5 text-sm">
            {(['answer_sheet', 'documents', 'bank', 'skatteverket', 'setup', 'skill', 'help'] as const).map((k) => (
              <li key={k} className="flex gap-2">
                <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                <span>{t(`includes_${k}`)}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{t('fees_note')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="lg" onClick={showPackage} loading={opening}>
              {t('show_documents')}
            </Button>
            <Button asChild variant="ghost">
              <a href={FORMATION_BOOKING_URL} target="_blank" rel="noreferrer">
                {t('book_call')}
              </a>
            </Button>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </section>
      )}
    </div>
  )
}

function IssueText({ issue }: { issue: FormationIssue }) {
  const ti = useTranslations('formation.issues')
  return <>{ti(issue.code, { ...issue.params, ...(issue.params && 'name' in issue.params && !issue.params.name ? { name: ti('unnamed') } : {}) })}</>
}
