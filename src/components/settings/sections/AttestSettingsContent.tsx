'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { CheckIcon, ChevronDownIcon, XMarkIcon } from '@/components/icons'
import { AttnLine } from '@/components/ui/attn-line'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import {
  SettingsGroup,
  SettingsInput,
  SettingsRow,
  SettingsRowNote,
  SettingsSectionHeader,
  SettingsSelect,
  SETTINGS_SELECT_TRIGGER_CLASS,
} from '@/components/settings/SettingsRows'
import { SettingsLoadError } from '@/components/settings/SettingsLoadError'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { byteOrder, sameIdSet } from '@/lib/supplier-invoices/attest-policy'
import { parseAmountInput } from '@/lib/money'
import { cn, formatCurrency, formatDate } from '@/lib/utils'

interface Candidate {
  user_id: string
  name: string | null
  email: string | null
  role: 'owner' | 'admin' | 'member' | 'viewer'
}

interface Substitute {
  id: string
  user_id: string
  substitute_user_id: string
  starts_on: string
  ends_on: string
  active: boolean
}

interface AttestSettingsData {
  policy: {
    enabled: boolean
    threshold_amount: number | null
    mode: 'any' | 'all'
    attesters: string[]
    preparer_may_attest: boolean
    two_step_from_sek: number | null
    /** Förattest for invoices without a project of their own; left out = none. */
    pre_attesters?: string[]
    /** Förattest per project code; left out = none. */
    project_attesters?: Record<string, string[]>
  }
  candidates: Candidate[]
  /** The attest limit in SEK per person; null or missing = no limit. */
  limits: Record<string, number | null>
  /** The company's projects (dimension 6). */
  projects: Array<{ code: string; name: string; is_active: boolean }>
  /** Substitutes that run now or later. */
  substitutes: Substitute[]
  /** The signed-in user. */
  user_id: string
  can_edit: boolean
  mail_enabled: boolean
  accounting_method: string | null
}

interface Draft {
  enabled: boolean
  threshold: string
  mode: 'any' | 'all'
  attesters: string[]
  preparer_may_attest: boolean
  /** Two attesters from this amount; empty = never. */
  two_step: string
  /** The typed limit per attester; empty = no limit. */
  limits: Record<string, string>
  /** Förattest of invoices without a project of their own. */
  pre_attesters: string[]
  /** Förattest per project, one row each. */
  projects: Array<{ project: string; attesters: string[] }>
}

const projectRowsOf = (routes: Record<string, string[]> | undefined) =>
  Object.entries(routes ?? {})
    .sort(([a], [b]) => byteOrder(a, b))
    .map(([project, attesters]) => ({ project, attesters }))

const amountText = (value: number | null | undefined) => (value === null || value === undefined ? '' : String(value))

function draftOf(data: AttestSettingsData): Draft {
  return {
    enabled: data.policy.enabled,
    threshold: amountText(data.policy.threshold_amount),
    mode: data.policy.mode,
    attesters: data.policy.attesters,
    preparer_may_attest: data.policy.preparer_may_attest,
    two_step: amountText(data.policy.two_step_from_sek),
    limits: Object.fromEntries(data.policy.attesters.map((id) => [id, amountText(data.limits?.[id])])),
    pre_attesters: data.policy.pre_attesters ?? [],
    projects: projectRowsOf(data.policy.project_attesters),
  }
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.enabled === b.enabled &&
    a.threshold.trim() === b.threshold.trim() &&
    a.mode === b.mode &&
    a.preparer_may_attest === b.preparer_may_attest &&
    a.two_step.trim() === b.two_step.trim() &&
    sameIdSet(a.attesters, b.attesters) &&
    a.attesters.every((id) => (a.limits[id] ?? '').trim() === (b.limits[id] ?? '').trim()) &&
    sameIdSet(a.pre_attesters, b.pre_attesters) &&
    a.projects.length === b.projects.length &&
    a.projects.every((row, i) => row.project === b.projects[i]?.project && sameIdSet(row.attesters, b.projects[i]?.attesters ?? []))
  )
}

/**
 * Pick people from the company's attest candidates: a field-shaped trigger
 * naming who is picked, a menu that ticks them on and off.
 */
function PeoplePicker({
  candidates,
  value,
  onChange,
  disabled,
  placeholder,
  label,
  nameOf,
}: {
  candidates: Candidate[]
  value: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
  placeholder: string
  label: string
  nameOf: (c: Candidate) => string
}) {
  const picked = candidates.filter((c) => value.includes(c.user_id))
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={label}
        className={cn(SETTINGS_SELECT_TRIGGER_CLASS, 'flex items-center text-left')}
      >
        <span className={cn('min-w-0 flex-1 truncate', picked.length === 0 && 'text-muted-foreground')} data-ph-mask="">
          {picked.length === 0 ? placeholder : picked.map(nameOf).join(', ')}
        </span>
        <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
        {candidates.map((c) => {
          const on = value.includes(c.user_id)
          return (
            <DropdownMenuItem
              key={c.user_id}
              onSelect={(event) => {
                // Stay open: several people are picked in one go.
                event.preventDefault()
                onChange(on ? value.filter((id) => id !== c.user_id) : [...value, c.user_id])
              }}
              className="pl-8"
              aria-checked={on}
              role="menuitemcheckbox"
            >
              <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
                {on ? <CheckIcon className="h-3.5 w-3.5 text-primary" /> : null}
              </span>
              <span data-ph-mask="">{nameOf(c)}</span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A typed amount ("1 250,50", "1250.5") to kronor; null for an empty field, NaN for anything else or a negative amount. */
function parseThreshold(value: string): number | null {
  if (value.trim() === '') return null
  const amount = parseAmountInput(value)
  return amount === null || amount < 0 ? Number.NaN : amount
}

/** A typed attest limit to kronor; null for an empty field (no limit), NaN for anything that is not an amount above 0. */
function parseLimit(value: string | undefined): number | null {
  if (!value || value.trim() === '') return null
  const amount = parseAmountInput(value)
  return amount === null || amount <= 0 ? Number.NaN : amount
}

/**
 * Bokföring → Attest: the company's attest policy for supplier invoices
 * (lib/supplier-invoices/attest-policy.ts). On or off, the amount from which
 * attest is required, the attesters, one or all of them, and whether the
 * person who registers an invoice may attest it too. Owners and admins edit;
 * everyone else reads. Below it, the signed-in user's own switch for the
 * attest mail. Kontantmetoden has no attest step, and the section says so.
 */
export function AttestSettingsContent() {
  const t = useTranslations('settings_attest')
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()

  const [data, setData] = useState<AttestSettingsData | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [mailSaving, setMailSaving] = useState(false)
  const [substitute, setSubstitute] = useState<{ user_id: string; substitute_user_id: string; starts_on: string; ends_on: string }>({
    user_id: '',
    substitute_user_id: '',
    starts_on: '',
    ends_on: '',
  })
  const [substituteBusy, setSubstituteBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoadFailed(false)
    try {
      const res = await fetch('/api/supplier-invoices/attest-policy')
      const body = await res.json().catch(() => null)
      if (!res.ok || !body?.data) {
        setLoadFailed(true)
        return
      }
      setData(body.data as AttestSettingsData)
      setDraft(draftOf(body.data as AttestSettingsData))
    } catch {
      setLoadFailed(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const dirty = useMemo(() => !!data && !!draft && !sameDraft(draft, draftOf(data)), [data, draft])
  const threshold = draft ? parseThreshold(draft.threshold) : null
  const thresholdInvalid = threshold !== null && Number.isNaN(threshold)
  const twoStep = draft ? parseThreshold(draft.two_step) : null
  const twoStepInvalid = twoStep !== null && Number.isNaN(twoStep)
  const limits = useMemo(
    () => new Map((draft?.attesters ?? []).map((id) => [id, parseLimit(draft?.limits[id])] as const)),
    [draft],
  )
  const limitsInvalid = [...limits.values()].some((limit) => limit !== null && Number.isNaN(limit))
  const twoStepNeedsTwo = !!draft && draft.enabled && twoStep !== null && !twoStepInvalid && draft.attesters.length < 2
  // Every project row names someone.
  const projectsIncomplete = !!draft && draft.projects.some((row) => row.attesters.length === 0)

  if (loadFailed) {
    return (
      <div>
        <SettingsSectionHeader title={tNav('attest')} intro={tIntro('attest')} />
        <SettingsLoadError onRetry={() => void load()} />
      </div>
    )
  }
  if (!data || !draft) {
    return (
      <div className="space-y-4">
        <SettingsSectionHeader title={tNav('attest')} intro={tIntro('attest')} />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    )
  }

  const cash = data.accounting_method === 'cash'
  const editable = data.can_edit && !cash
  const nameOf = (c: Candidate) => c.name ?? c.email ?? t('unnamed_member')

  async function save() {
    if (!draft || thresholdInvalid || twoStepInvalid || limitsInvalid || projectsIncomplete) return
    setSaving(true)
    setSaved(false)
    try {
      const res = await fetch('/api/supplier-invoices/attest-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: draft.enabled,
          threshold_amount: threshold,
          mode: draft.mode,
          attesters: draft.attesters,
          preparer_may_attest: draft.preparer_may_attest,
          two_step_from_sek: twoStep,
          limits: draft.attesters.map((id) => ({ user_id: id, max_amount_sek: limits.get(id) ?? null })),
          pre_attesters: draft.pre_attesters,
          project_attesters: draft.projects.map((row) => ({ project: row.project, attesters: row.attesters })),
        }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok || !body?.data) {
        toast({ title: t('save_failed_title'), description: getErrorMessage(body, { statusCode: res.status, locale }), variant: 'destructive' })
        return
      }
      setData(body.data as AttestSettingsData)
      setDraft(draftOf(body.data as AttestSettingsData))
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (error) {
      toast({ title: t('save_failed_title'), description: getErrorMessage(error, { locale }), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  async function toggleMail(enabled: boolean) {
    setMailSaving(true)
    try {
      const res = await fetch('/api/supplier-invoices/attest-policy/mail', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        toast({ title: t('save_failed_title'), description: getErrorMessage(body, { statusCode: res.status, locale }), variant: 'destructive' })
        return
      }
      setData((current) => (current ? { ...current, mail_enabled: enabled } : current))
    } catch (error) {
      toast({ title: t('save_failed_title'), description: getErrorMessage(error, { locale }), variant: 'destructive' })
    } finally {
      setMailSaving(false)
    }
  }

  /** Add or remove a substitute: saved at once, like the mail switch, and answered with the section as it now reads. */
  async function changeSubstitute(action: { add: typeof substitute } | { remove: string }) {
    setSubstituteBusy('add' in action ? 'add' : action.remove)
    try {
      const res =
        'add' in action
          ? await fetch('/api/supplier-invoices/attest-policy/substitutes', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(action.add),
            })
          : await fetch(`/api/supplier-invoices/attest-policy/substitutes/${encodeURIComponent(action.remove)}`, { method: 'DELETE' })
      const body = await res.json().catch(() => null)
      if (!res.ok || !body?.data) {
        toast({ title: t('substitute_failed_title'), description: getErrorMessage(body, { statusCode: res.status, locale }), variant: 'destructive' })
        return
      }
      setData(body.data as AttestSettingsData)
      if ('add' in action) setSubstitute((current) => ({ ...current, substitute_user_id: '', starts_on: '', ends_on: '' }))
    } catch (error) {
      toast({ title: t('substitute_failed_title'), description: getErrorMessage(error, { locale }), variant: 'destructive' })
    } finally {
      setSubstituteBusy(null)
    }
  }

  const setProjectAttesters = (project: string, attesters: string[]) =>
    setDraft((d) => (d ? { ...d, projects: d.projects.map((row) => (row.project === project ? { project, attesters } : row)) } : d))
  const addProjectRow = (project: string) =>
    setDraft((d) => (d && !d.projects.some((row) => row.project === project) ? { ...d, projects: [...d.projects, { project, attesters: [] }] } : d))
  const removeProjectRow = (project: string) => setDraft((d) => (d ? { ...d, projects: d.projects.filter((row) => row.project !== project) } : d))
  const projectLabel = (code: string) => {
    const name = data.projects.find((p) => p.code === code)?.name
    return name ? `${code} ${name}` : code
  }
  const addableProjects = data.projects.filter((p) => p.is_active && !draft.projects.some((row) => row.project === p.code))
  const candidateName = (id: string) => {
    const c = data.candidates.find((candidate) => candidate.user_id === id)
    return c ? nameOf(c) : t('unnamed_member')
  }
  // Anyone names their own substitute; owners and admins name one for anyone.
  const mayNameFor = data.can_edit ? data.candidates : data.candidates.filter((c) => c.user_id === data.user_id)
  const substituteFor = data.can_edit ? substitute.user_id : data.user_id
  const substitutePeriodInvalid = substitute.starts_on !== '' && substitute.ends_on !== '' && substitute.ends_on < substitute.starts_on
  const substituteReady =
    !cash &&
    substituteFor !== '' &&
    substitute.substitute_user_id !== '' &&
    substitute.substitute_user_id !== substituteFor &&
    substitute.starts_on !== '' &&
    substitute.ends_on !== '' &&
    !substitutePeriodInvalid
  const mayRemoveSubstitute = (row: Substitute) => data.can_edit || row.user_id === data.user_id

  const toggleAttester = (userId: string, on: boolean) =>
    setDraft((d) => (d ? { ...d, attesters: on ? [...new Set([...d.attesters, userId])] : d.attesters.filter((id) => id !== userId) } : d))
  const setLimit = (userId: string, value: string) => setDraft((d) => (d ? { ...d, limits: { ...d.limits, [userId]: value } } : d))

  // Every chosen attester has a limit: an invoice above the highest has nobody whose approval covers it.
  const finiteLimits = draft.attesters.map((id) => limits.get(id) ?? null)
  const highestLimit =
    !limitsInvalid && finiteLimits.length > 0 && finiteLimits.every((limit) => limit !== null)
      ? Math.max(...(finiteLimits as number[]))
      : null

  const barVisible = dirty || saving || saved

  return (
    <div>
      <SettingsSectionHeader title={tNav('attest')} intro={tIntro('attest')} />

      {cash && <AttnLine className="mt-4">{t('cash_method_note')}</AttnLine>}

      <SettingsGroup label={t('group_policy')}>
        <SettingsRow label={t('enabled_label')} help={t('enabled_help')}>
          <Switch
            checked={draft.enabled}
            onCheckedChange={(enabled) => setDraft((d) => (d ? { ...d, enabled } : d))}
            disabled={!editable}
            aria-label={t('enabled_label')}
          />
        </SettingsRow>
        <SettingsRow label={t('threshold_label')} htmlFor="attest-threshold" help={t('threshold_help')} align="baseline">
          <SettingsInput
            id="attest-threshold"
            inputMode="decimal"
            value={draft.threshold}
            placeholder={t('threshold_placeholder')}
            onChange={(e) => setDraft((d) => (d ? { ...d, threshold: e.target.value } : d))}
            disabled={!editable || !draft.enabled}
            aria-invalid={thresholdInvalid || undefined}
            className="tabular-nums"
          />
          {thresholdInvalid && <SettingsRowNote className="w-full text-destructive">{t('threshold_invalid')}</SettingsRowNote>}
        </SettingsRow>
        <SettingsRow label={t('mode_label')} help={t('mode_help')}>
          <SettingsSelect
            value={draft.mode}
            onChange={(e) => setDraft((d) => (d ? { ...d, mode: e.target.value === 'all' ? 'all' : 'any' } : d))}
            disabled={!editable || !draft.enabled}
            aria-label={t('mode_label')}
          >
            <option value="any">{t('mode_any')}</option>
            <option value="all">{t('mode_all')}</option>
          </SettingsSelect>
        </SettingsRow>
        <SettingsRow label={t('preparer_label')} help={t('preparer_help')}>
          <Switch
            checked={draft.preparer_may_attest}
            onCheckedChange={(preparer_may_attest) => setDraft((d) => (d ? { ...d, preparer_may_attest } : d))}
            disabled={!editable || !draft.enabled}
            aria-label={t('preparer_label')}
          />
        </SettingsRow>
        <SettingsRow label={t('two_step_label')} htmlFor="attest-two-step" help={t('two_step_help')} align="baseline">
          <SettingsInput
            id="attest-two-step"
            inputMode="decimal"
            value={draft.two_step}
            placeholder={t('two_step_placeholder')}
            onChange={(e) => setDraft((d) => (d ? { ...d, two_step: e.target.value } : d))}
            disabled={!editable || !draft.enabled}
            aria-invalid={twoStepInvalid || twoStepNeedsTwo || undefined}
            className="tabular-nums"
          />
          {twoStepInvalid && <SettingsRowNote className="w-full text-destructive">{t('threshold_invalid')}</SettingsRowNote>}
          {twoStepNeedsTwo && <SettingsRowNote className="w-full text-destructive">{t('two_step_needs_two')}</SettingsRowNote>}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label={t('group_attesters')} help={t('attesters_help')}>
        {data.candidates.length === 0 ? (
          <SettingsRow label={t('no_candidates')}>
            <span />
          </SettingsRow>
        ) : (
          data.candidates.map((c) => {
            const chosen = draft.attesters.includes(c.user_id)
            const limit = limits.get(c.user_id)
            const limitInvalid = limit !== null && limit !== undefined && Number.isNaN(limit)
            return (
              <SettingsRow
                key={c.user_id}
                align={chosen ? 'baseline' : 'center'}
                label={
                  <span className="min-w-0">
                    <span data-ph-mask="">{nameOf(c)}</span>
                    {c.role === 'viewer' ? <span className="ml-1.5 text-[12.5px] text-muted-foreground">{t('candidate_viewer')}</span> : null}
                    {c.name && c.email ? (
                      <span className="block truncate text-[12.5px] text-muted-foreground" data-ph-mask="">
                        {c.email}
                      </span>
                    ) : null}
                  </span>
                }
              >
                {chosen ? (
                  <SettingsInput
                    inputMode="decimal"
                    value={draft.limits[c.user_id] ?? ''}
                    placeholder={t('limit_placeholder')}
                    onChange={(e) => setLimit(c.user_id, e.target.value)}
                    disabled={!editable || !draft.enabled}
                    aria-label={t('limit_label', { name: nameOf(c) })}
                    aria-invalid={limitInvalid || undefined}
                    className="tabular-nums"
                  />
                ) : null}
                <Switch
                  checked={chosen}
                  onCheckedChange={(on) => toggleAttester(c.user_id, on)}
                  disabled={!editable || !draft.enabled}
                  aria-label={t('attester_toggle', { name: nameOf(c) })}
                />
                {limitInvalid && <SettingsRowNote className="w-full text-destructive">{t('limit_invalid')}</SettingsRowNote>}
              </SettingsRow>
            )
          })
        )}
        {!cash && draft.enabled && draft.attesters.length === 0 ? (
          <AttnLine className="mt-3">{t('no_attesters_note')}</AttnLine>
        ) : !cash && draft.enabled && highestLimit !== null ? (
          <AttnLine className="mt-3">{t('no_unlimited_note', { amount: formatCurrency(highestLimit) })}</AttnLine>
        ) : null}
      </SettingsGroup>

      <SettingsGroup label={t('group_pre_attest')} help={t('pre_attest_help')}>
        <SettingsRow label={t('pre_default_label')} help={t('pre_default_help')}>
          <PeoplePicker
            candidates={data.candidates}
            value={draft.pre_attesters}
            onChange={(pre_attesters) => setDraft((d) => (d ? { ...d, pre_attesters } : d))}
            disabled={!editable || !draft.enabled}
            placeholder={t('pre_none')}
            label={t('pre_default_label')}
            nameOf={nameOf}
          />
        </SettingsRow>
        {draft.projects.map((row) => (
          <SettingsRow key={row.project} label={<span data-ph-mask="">{projectLabel(row.project)}</span>}>
            <PeoplePicker
              candidates={data.candidates}
              value={row.attesters}
              onChange={(attesters) => setProjectAttesters(row.project, attesters)}
              disabled={!editable || !draft.enabled}
              placeholder={t('people_placeholder')}
              label={t('project_attesters_label', { project: projectLabel(row.project) })}
              nameOf={nameOf}
            />
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={() => removeProjectRow(row.project)}
              disabled={!editable || !draft.enabled}
              aria-label={t('project_remove', { project: projectLabel(row.project) })}
            >
              <XMarkIcon className="h-4 w-4" />
            </Button>
            {row.attesters.length === 0 && <SettingsRowNote className="w-full text-destructive">{t('project_incomplete')}</SettingsRowNote>}
          </SettingsRow>
        ))}
        <SettingsRow label={t('project_rows_label')} help={t('project_rows_help')}>
          {data.projects.length === 0 ? (
            <SettingsRowNote className="w-full">{t('projects_none_note')}</SettingsRowNote>
          ) : (
            <SettingsSelect
              value=""
              onChange={(e) => e.target.value && addProjectRow(e.target.value)}
              disabled={!editable || !draft.enabled || addableProjects.length === 0}
              aria-label={t('project_add')}
            >
              <option value="">{t('project_add')}</option>
              {addableProjects.map((p) => (
                <option key={p.code} value={p.code}>
                  {projectLabel(p.code)}
                </option>
              ))}
            </SettingsSelect>
          )}
        </SettingsRow>
      </SettingsGroup>

      {!cash && (
        <SettingsGroup label={t('group_substitutes')} help={t('substitutes_help')}>
          {data.substitutes.length === 0 ? (
            <SettingsRow label={t('substitute_none')}>
              <span />
            </SettingsRow>
          ) : (
            data.substitutes.map((row) => (
              <SettingsRow
                key={row.id}
                label={
                  <span data-ph-mask="">{t('substitute_row', { substitute: candidateName(row.substitute_user_id), user: candidateName(row.user_id) })}</span>
                }
              >
                <SettingsRowNote fill>
                  {t('substitute_period', { from: formatDate(row.starts_on), to: formatDate(row.ends_on) })}
                  {row.active ? ` · ${t('substitute_active')}` : null}
                </SettingsRowNote>
                {mayRemoveSubstitute(row) ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void changeSubstitute({ remove: row.id })}
                    loading={substituteBusy === row.id}
                    disabled={substituteBusy !== null}
                    aria-label={t('substitute_remove_label', { name: candidateName(row.substitute_user_id) })}
                  >
                    {t('substitute_remove')}
                  </Button>
                ) : null}
              </SettingsRow>
            ))
          )}
          <SettingsRow label={t('substitute_for_label')}>
            <SettingsSelect
              value={substituteFor}
              onChange={(e) => setSubstitute((current) => ({ ...current, user_id: e.target.value }))}
              disabled={!data.can_edit || substituteBusy !== null}
              aria-label={t('substitute_for_label')}
            >
              {data.can_edit ? <option value="">{t('substitute_pick')}</option> : null}
              {mayNameFor.map((c) => (
                <option key={c.user_id} value={c.user_id}>
                  {nameOf(c)}
                </option>
              ))}
            </SettingsSelect>
          </SettingsRow>
          <SettingsRow label={t('substitute_label')}>
            <SettingsSelect
              value={substitute.substitute_user_id}
              onChange={(e) => setSubstitute((current) => ({ ...current, substitute_user_id: e.target.value }))}
              disabled={substituteBusy !== null}
              aria-label={t('substitute_label')}
            >
              <option value="">{t('substitute_pick')}</option>
              {data.candidates
                .filter((c) => c.user_id !== substituteFor)
                .map((c) => (
                  <option key={c.user_id} value={c.user_id}>
                    {nameOf(c)}
                  </option>
                ))}
            </SettingsSelect>
          </SettingsRow>
          <SettingsRow label={t('substitute_period_label')} align="baseline">
            <SettingsInput
              type="date"
              value={substitute.starts_on}
              onChange={(e) => setSubstitute((current) => ({ ...current, starts_on: e.target.value }))}
              disabled={substituteBusy !== null}
              aria-label={t('substitute_from_label')}
              className="tabular-nums"
            />
            <SettingsInput
              type="date"
              value={substitute.ends_on}
              min={substitute.starts_on || undefined}
              onChange={(e) => setSubstitute((current) => ({ ...current, ends_on: e.target.value }))}
              disabled={substituteBusy !== null}
              aria-label={t('substitute_to_label')}
              aria-invalid={substitutePeriodInvalid || undefined}
              className="tabular-nums"
            />
            {substitutePeriodInvalid && <SettingsRowNote className="w-full text-destructive">{t('substitute_invalid_period')}</SettingsRowNote>}
          </SettingsRow>
          <SettingsRow label="" borderless>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="ml-auto"
              onClick={() => void changeSubstitute({ add: { ...substitute, user_id: substituteFor } })}
              loading={substituteBusy === 'add'}
              disabled={!substituteReady || substituteBusy !== null}
            >
              {t('substitute_add')}
            </Button>
          </SettingsRow>
        </SettingsGroup>
      )}

      {data.policy.enabled && !cash && (
        <SettingsGroup label={t('group_mail')}>
          <SettingsRow label={t('mail_label')} help={t('mail_help')}>
            <Switch
              checked={data.mail_enabled}
              onCheckedChange={(enabled) => void toggleMail(enabled)}
              disabled={mailSaving}
              aria-label={t('mail_label')}
            />
          </SettingsRow>
        </SettingsGroup>
      )}

      {!data.can_edit && !cash && <p className="mt-4 text-[12.5px] text-muted-foreground">{t('read_only_note')}</p>}

      {/* Sticky save bar, the Fönster convention: invisible until something changed. */}
      <div
        className={cn(
          'sticky bottom-[var(--bottom-nav-h)] flex items-center gap-4 bg-gradient-to-t from-background via-background/95 to-transparent px-1 transition-opacity duration-150',
          barVisible ? 'mt-2 pb-3 pt-6 opacity-100' : 'pointer-events-none h-0 overflow-hidden py-0 opacity-0',
        )}
        aria-hidden={!barVisible}
      >
        <Button
          type="button"
          size="sm"
          onClick={() => void save()}
          loading={saving}
          disabled={
            !editable ||
            thresholdInvalid ||
            twoStepInvalid ||
            limitsInvalid ||
            twoStepNeedsTwo ||
            projectsIncomplete ||
            (draft.enabled && draft.attesters.length === 0)
          }
          tabIndex={barVisible ? 0 : -1}
        >
          {t('save')}
        </Button>
        {saved ? (
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckIcon className="h-3.5 w-3.5" />
            {t('saved')}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">{t('unsaved')}</span>
        )}
      </div>
    </div>
  )
}
