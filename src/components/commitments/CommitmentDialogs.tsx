'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { SlideOver, SlideOverBody, SlideOverContent, SlideOverFooter, SlideOverHeader } from '@/components/ui/slide-over'
import { SettingsSelect } from '@/components/settings/SettingsRows'
import { useToast } from '@/components/ui/use-toast'
import { parseAmountInput, parseDecimalInput } from '@/lib/money'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import {
  AGREEMENT_KINDS,
  AGREEMENT_PERIODS,
  GROUP_RELATIONS,
  PLEDGED_SECURITY_KINDS,
  SECURITY_KINDS,
  type AgreementView,
  type GroupLinkView,
  type SecurityView,
} from '@/lib/commitments/types'

type Form = Record<string, string>

const str = (v: string | number | null | undefined): string => (v == null ? '' : String(v))
const orNull = (v: string): string | null => (v.trim() ? v.trim() : null)

/** The request a dialog sends, and the failure it shows. */
async function send(url: string, method: 'POST' | 'PATCH', body: Record<string, unknown>): Promise<{ ok: true } | { ok: false; body: unknown }> {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (res.ok) return { ok: true }
  return { ok: false, body: await res.json().catch(() => ({})) }
}

function useSubmit(onDone: (created: boolean) => Promise<void> | void) {
  const t = useTranslations('bolaget_commitments')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [saving, setSaving] = useState(false)
  const submit = async (url: string, method: 'POST' | 'PATCH', body: Record<string, unknown> | null) => {
    if (!body) {
      toast({ title: t('invalid_numbers'), variant: 'destructive' })
      return
    }
    setSaving(true)
    try {
      const out = await send(url, method, body)
      if (!out.ok) {
        toast({ title: t('save_failed'), description: getErrorMessage(out.body, { locale, fallback: t('save_failed') }), variant: 'destructive' })
        return
      }
      await onDone(method === 'POST')
    } finally {
      setSaving(false)
    }
  }
  return { saving, submit }
}

function Field({ id, label, children, wide = false, optional = false }: { id: string; label: string; children: React.ReactNode; wide?: boolean; optional?: boolean }) {
  return (
    <div className={wide ? 'space-y-1 sm:col-span-2' : 'space-y-1'}>
      <Label htmlFor={id} optional={optional}>
        {label}
      </Label>
      {children}
    </div>
  )
}

// ── Agreement ──────────────────────────────────────────────────────

function agreementForm(a: AgreementView | null): Form {
  return {
    kind: a?.kind ?? 'rental',
    title: a?.title ?? '',
    counterparty_name: a?.counterparty_name ?? '',
    starts_on: a?.starts_on ?? '',
    ends_on: a?.ends_on ?? '',
    notice_months: str(a?.notice_months),
    renewal_terms: a?.renewal_terms ?? '',
    amount: str(a?.amount),
    period: a?.period ?? '',
    first_due_on: a?.first_due_on ?? '',
    principal: str(a?.principal),
    interest_rate: str(a?.interest_rate),
    notes: a?.notes ?? '',
  }
}

/** The body the agreement routes take, or null when a number does not parse. */
export function agreementBody(form: Form): Record<string, unknown> | null {
  const number = (v: string, parse: (s: string) => number | null) => (v.trim() === '' ? null : parse(v))
  const amount = number(form.amount, parseAmountInput)
  const principal = number(form.principal, parseAmountInput)
  const rate = number(form.interest_rate, parseDecimalInput)
  const notice = form.notice_months.trim() === '' ? null : Number.parseInt(form.notice_months, 10)
  if ((form.amount.trim() && amount === null) || (form.principal.trim() && principal === null) || (form.interest_rate.trim() && rate === null)) return null
  if (notice !== null && !Number.isInteger(notice)) return null
  const loan = form.kind === 'loan'
  return {
    kind: form.kind,
    title: form.title.trim(),
    counterparty_name: orNull(form.counterparty_name),
    starts_on: orNull(form.starts_on),
    ends_on: orNull(form.ends_on),
    notice_months: notice,
    renewal_terms: orNull(form.renewal_terms),
    amount,
    period: amount === null ? null : orNull(form.period),
    first_due_on: amount === null ? null : orNull(form.first_due_on),
    principal: loan ? principal : null,
    interest_rate: loan ? rate : null,
    notes: orNull(form.notes),
  }
}

export function AgreementDialog({
  agreement,
  onClose,
  onSaved,
  onEnd,
}: {
  agreement: AgreementView | null
  onClose: () => void
  onSaved: (created: boolean) => Promise<void>
  onEnd: (agreement: AgreementView) => void
}) {
  const t = useTranslations('bolaget_commitments')
  const [form, setForm] = useState<Form>(() => agreementForm(agreement))
  const { saving, submit } = useSubmit(onSaved)
  const field = (key: string) => ({
    id: `agreement-${key}`,
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [key]: e.target.value })),
  })
  const save = () =>
    submit(agreement ? `/api/commitments/agreements/${agreement.agreement_id}` : '/api/commitments/agreements', agreement ? 'PATCH' : 'POST', agreementBody(form))

  return (
    <SlideOver open onOpenChange={(open) => !open && onClose()}>
      <SlideOverContent aria-describedby={undefined}>
        <SlideOverHeader title={agreement ? t('agreement_edit') : t('agreement_add')} />
        <SlideOverBody>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="agreement-kind" label={t('field_kind')}>
            <SettingsSelect {...field('kind')}>
              {AGREEMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`kind.${k}`)}
                </option>
              ))}
            </SettingsSelect>
          </Field>
          <Field id="agreement-title" label={t('field_title')}>
            <Input {...field('title')} maxLength={200} placeholder={t('field_title_placeholder')} />
          </Field>
          <Field id="agreement-counterparty_name" label={t('field_counterparty')} optional wide>
            <Input {...field('counterparty_name')} maxLength={200} />
          </Field>
          <Field id="agreement-starts_on" label={t('field_starts_on')} optional>
            <Input {...field('starts_on')} type="date" className="tabular-nums" />
          </Field>
          <Field id="agreement-ends_on" label={t('field_ends_on')} optional>
            <Input {...field('ends_on')} type="date" className="tabular-nums" />
          </Field>
          <Field id="agreement-notice_months" label={t('field_notice_months')} optional>
            <Input {...field('notice_months')} inputMode="numeric" className="tabular-nums" />
          </Field>
          <Field id="agreement-renewal_terms" label={t('field_renewal_terms')} optional>
            <Input {...field('renewal_terms')} maxLength={500} placeholder={t('field_renewal_terms_placeholder')} />
          </Field>
          <Field id="agreement-amount" label={t('field_amount')} optional>
            <Input {...field('amount')} inputMode="decimal" className="tabular-nums" />
          </Field>
          <Field id="agreement-period" label={t('field_period')}>
            <SettingsSelect {...field('period')}>
              <option value="">{t('period_none')}</option>
              {AGREEMENT_PERIODS.map((p) => (
                <option key={p} value={p}>
                  {t(`period.${p}`)}
                </option>
              ))}
            </SettingsSelect>
          </Field>
          <Field id="agreement-first_due_on" label={t('field_first_due_on')} optional>
            <Input {...field('first_due_on')} type="date" className="tabular-nums" />
          </Field>
          {form.kind === 'loan' && (
            <>
              <Field id="agreement-principal" label={t('field_principal')}>
                <Input {...field('principal')} inputMode="decimal" className="tabular-nums" />
              </Field>
              <Field id="agreement-interest_rate" label={t('field_interest_rate')}>
                <Input {...field('interest_rate')} inputMode="decimal" className="tabular-nums" />
              </Field>
            </>
          )}
          <Field id="agreement-notes" label={t('field_notes')} optional wide>
            <Textarea {...field('notes')} maxLength={4000} rows={3} />
          </Field>
          <p className="text-xs text-muted-foreground sm:col-span-2">{t('agreement_schedule_hint')}</p>
        </div>
        </SlideOverBody>
        <SlideOverFooter className="justify-between">
          {agreement && agreement.status === 'active' ? (
            <Button variant="ghost" onClick={() => onEnd(agreement)} disabled={saving}>
              {t('agreement_end')}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              {t('cancel')}
            </Button>
            <Button onClick={save} loading={saving} disabled={!form.title.trim()}>
              {agreement ? t('save') : t('agreement_create')}
            </Button>
          </div>
        </SlideOverFooter>
      </SlideOverContent>
    </SlideOver>
  )
}

export function EndAgreementDialog({
  agreement,
  today,
  onClose,
  onEnded,
}: {
  agreement: AgreementView
  today: string
  onClose: () => void
  onEnded: () => Promise<void>
}) {
  const t = useTranslations('bolaget_commitments')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [endedOn, setEndedOn] = useState(today)
  const confirm = async () => {
    const out = await send(`/api/commitments/agreements/${agreement.agreement_id}/end`, 'POST', endedOn ? { ended_on: endedOn } : {})
    if (!out.ok) {
      toast({ title: t('save_failed'), description: getErrorMessage(out.body, { locale, fallback: t('save_failed') }), variant: 'destructive' })
      return
    }
    await onEnded()
  }
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('end_title', { title: agreement.title })}
      description={t('end_description')}
      confirmLabel={t('agreement_end')}
      onConfirm={confirm}
      confirmDisabled={!endedOn}
    >
      <div className="space-y-1">
        <Label htmlFor="agreement-ended_on">{t('field_ended_on')}</Label>
        <Input id="agreement-ended_on" type="date" value={endedOn} onChange={(e) => setEndedOn(e.target.value)} className="tabular-nums" />
      </div>
    </ConfirmDialog>
  )
}

// ── Ställda säkerheter and eventualförpliktelser ───────────────────

function securityForm(s: SecurityView | null): Form {
  return {
    kind: s?.kind ?? 'foretagsinteckning',
    description: s?.description ?? '',
    amount: str(s?.amount),
    in_favour_of_name: s?.in_favour_of_name ?? '',
    for_group_company: s?.for_group_company ? 'true' : 'false',
    agreement_id: s?.agreement_id ?? '',
    valid_from: s?.valid_from ?? '',
    valid_to: s?.valid_to ?? '',
    notes: s?.notes ?? '',
  }
}

export function securityBody(form: Form): Record<string, unknown> | null {
  const amount = parseAmountInput(form.amount)
  if (amount === null || amount < 0) return null
  return {
    kind: form.kind,
    description: form.description.trim(),
    amount,
    in_favour_of_name: orNull(form.in_favour_of_name),
    for_group_company: form.for_group_company === 'true',
    agreement_id: orNull(form.agreement_id),
    valid_from: orNull(form.valid_from),
    valid_to: orNull(form.valid_to),
    notes: orNull(form.notes),
  }
}

export function SecurityDialog({
  security,
  loans,
  onClose,
  onSaved,
}: {
  security: SecurityView | null
  loans: AgreementView[]
  onClose: () => void
  onSaved: (created: boolean) => Promise<void>
}) {
  const t = useTranslations('bolaget_commitments')
  const [form, setForm] = useState<Form>(() => securityForm(security))
  const { saving, submit } = useSubmit(onSaved)
  const field = (key: string) => ({
    id: `security-${key}`,
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [key]: e.target.value })),
  })
  const pledged = SECURITY_KINDS.filter((k) => PLEDGED_SECURITY_KINDS.includes(k))
  const contingent = SECURITY_KINDS.filter((k) => !PLEDGED_SECURITY_KINDS.includes(k))
  const save = () =>
    submit(security ? `/api/commitments/securities/${security.security_id}` : '/api/commitments/securities', security ? 'PATCH' : 'POST', securityBody(form))

  return (
    <SlideOver open onOpenChange={(open) => !open && onClose()}>
      <SlideOverContent aria-describedby={undefined}>
        <SlideOverHeader title={security ? t('security_edit') : t('security_add')} />
        <SlideOverBody>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="security-kind" label={t('field_security_kind')}>
            <SettingsSelect {...field('kind')}>
              <optgroup label={t('security_group_pledged')}>
                {pledged.map((k) => (
                  <option key={k} value={k}>
                    {t(`security_kind.${k}`)}
                  </option>
                ))}
              </optgroup>
              <optgroup label={t('security_group_contingent')}>
                {contingent.map((k) => (
                  <option key={k} value={k}>
                    {t(`security_kind.${k}`)}
                  </option>
                ))}
              </optgroup>
            </SettingsSelect>
          </Field>
          <Field id="security-amount" label={t('field_security_amount')}>
            <Input {...field('amount')} inputMode="decimal" className="tabular-nums" />
          </Field>
          <Field id="security-description" label={t('field_description')} wide>
            <Input {...field('description')} maxLength={300} placeholder={t('field_description_placeholder')} />
          </Field>
          <Field id="security-in_favour_of_name" label={t('field_in_favour_of')} optional>
            <Input {...field('in_favour_of_name')} maxLength={200} />
          </Field>
          <Field id="security-for_group_company" label={t('field_for_group_company')}>
            <SettingsSelect {...field('for_group_company')}>
              <option value="false">{t('no')}</option>
              <option value="true">{t('yes')}</option>
            </SettingsSelect>
          </Field>
          <Field id="security-agreement_id" label={t('field_loan')}>
            <SettingsSelect {...field('agreement_id')}>
              <option value="">{t('loan_none')}</option>
              {loans.map((l) => (
                <option key={l.agreement_id} value={l.agreement_id}>
                  {l.title}
                </option>
              ))}
            </SettingsSelect>
          </Field>
          <span className="hidden sm:block" />
          <Field id="security-valid_from" label={t('field_valid_from')} optional>
            <Input {...field('valid_from')} type="date" className="tabular-nums" />
          </Field>
          <Field id="security-valid_to" label={t('field_valid_to')} optional>
            <Input {...field('valid_to')} type="date" className="tabular-nums" />
          </Field>
          <Field id="security-notes" label={t('field_notes')} optional wide>
            <Textarea {...field('notes')} maxLength={4000} rows={3} />
          </Field>
          <p className="text-xs text-muted-foreground sm:col-span-2">{t('security_hint')}</p>
        </div>
        </SlideOverBody>
        <SlideOverFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t('cancel')}
          </Button>
          <Button onClick={save} loading={saving} disabled={!form.description.trim() || !form.amount.trim()}>
            {security ? t('save') : t('security_create')}
          </Button>
        </SlideOverFooter>
      </SlideOverContent>
    </SlideOver>
  )
}

// ── Group structure ────────────────────────────────────────────────

function groupForm(g: GroupLinkView | null): Form {
  return {
    relation: g?.relation ?? 'parent',
    counterparty_name: g?.counterparty_name ?? '',
    counterparty_org_number: g?.counterparty_org_number ?? '',
    counterparty_registered_office: g?.counterparty_registered_office ?? '',
    ownership_percent: str(g?.ownership_percent),
    voting_percent: str(g?.voting_percent),
    valid_from: g?.valid_from ?? '',
    valid_to: g?.valid_to ?? '',
    bas_account: g?.bas_account ?? '',
    notes: g?.notes ?? '',
  }
}

export function groupLinkBody(form: Form): Record<string, unknown> | null {
  const percent = (v: string) => (v.trim() === '' ? null : parseDecimalInput(v))
  const ownership = percent(form.ownership_percent)
  const votes = percent(form.voting_percent)
  if ((form.ownership_percent.trim() && ownership === null) || (form.voting_percent.trim() && votes === null)) return null
  return {
    relation: form.relation,
    counterparty_name: form.counterparty_name.trim(),
    counterparty_org_number: orNull(form.counterparty_org_number),
    counterparty_registered_office: orNull(form.counterparty_registered_office),
    ownership_percent: ownership,
    voting_percent: votes,
    valid_from: orNull(form.valid_from),
    valid_to: orNull(form.valid_to),
    bas_account: orNull(form.bas_account),
    notes: orNull(form.notes),
  }
}

export function GroupLinkDialog({
  link,
  onClose,
  onSaved,
}: {
  link: GroupLinkView | null
  onClose: () => void
  onSaved: (created: boolean) => Promise<void>
}) {
  const t = useTranslations('bolaget_commitments')
  const [form, setForm] = useState<Form>(() => groupForm(link))
  const { saving, submit } = useSubmit(onSaved)
  const field = (key: string) => ({
    id: `group-${key}`,
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [key]: e.target.value })),
  })
  const save = () =>
    submit(link ? `/api/commitments/group-links/${link.group_link_id}` : '/api/commitments/group-links', link ? 'PATCH' : 'POST', groupLinkBody(form))

  return (
    <SlideOver open onOpenChange={(open) => !open && onClose()}>
      <SlideOverContent aria-describedby={undefined}>
        <SlideOverHeader title={link ? t('group_edit') : t('group_add')} />
        <SlideOverBody>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="group-relation" label={t('field_relation')}>
            <SettingsSelect {...field('relation')}>
              {GROUP_RELATIONS.map((r) => (
                <option key={r} value={r}>
                  {t(`relation.${r}`)}
                </option>
              ))}
            </SettingsSelect>
          </Field>
          <Field id="group-counterparty_name" label={t('field_company_name')}>
            <Input {...field('counterparty_name')} maxLength={200} />
          </Field>
          <Field id="group-counterparty_org_number" label={t('field_org_number')} optional>
            <Input {...field('counterparty_org_number')} maxLength={40} className="tabular-nums" />
          </Field>
          <Field id="group-counterparty_registered_office" label={t('field_registered_office')} optional>
            <Input {...field('counterparty_registered_office')} maxLength={120} />
          </Field>
          <Field id="group-ownership_percent" label={t('field_ownership')} optional>
            <Input {...field('ownership_percent')} inputMode="decimal" className="tabular-nums" />
          </Field>
          <Field id="group-voting_percent" label={t('field_votes')} optional>
            <Input {...field('voting_percent')} inputMode="decimal" className="tabular-nums" />
          </Field>
          <Field id="group-valid_from" label={t('field_valid_from')} optional>
            <Input {...field('valid_from')} type="date" className="tabular-nums" />
          </Field>
          <Field id="group-valid_to" label={t('field_valid_to')} optional>
            <Input {...field('valid_to')} type="date" className="tabular-nums" />
          </Field>
          <Field id="group-bas_account" label={t('field_bas_account')} optional>
            <Input {...field('bas_account')} inputMode="numeric" maxLength={4} className="font-mono" placeholder={t('field_bas_account_placeholder')} />
          </Field>
          <span className="hidden sm:block" />
          <Field id="group-notes" label={t('field_notes')} optional wide>
            <Textarea {...field('notes')} maxLength={4000} rows={3} />
          </Field>
          <p className="text-xs text-muted-foreground sm:col-span-2">{t('group_hint')}</p>
        </div>
        </SlideOverBody>
        <SlideOverFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t('cancel')}
          </Button>
          <Button onClick={save} loading={saving} disabled={!form.counterparty_name.trim()}>
            {link ? t('save') : t('group_create')}
          </Button>
        </SlideOverFooter>
      </SlideOverContent>
    </SlideOver>
  )
}
