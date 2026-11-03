'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { CheckIcon } from '@/components/icons'
import { AttnLine } from '@/components/ui/attn-line'
import { Button } from '@/components/ui/button'
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
} from '@/components/settings/SettingsRows'
import { SettingsLoadError } from '@/components/settings/SettingsLoadError'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { parseAmountInput } from '@/lib/money'
import { cn, formatCurrency } from '@/lib/utils'

interface Candidate {
  user_id: string
  name: string | null
  email: string | null
  role: 'owner' | 'admin' | 'member' | 'viewer'
}

interface AttestSettingsData {
  policy: {
    enabled: boolean
    threshold_amount: number | null
    mode: 'any' | 'all'
    attesters: string[]
    preparer_may_attest: boolean
    two_step_from_sek: number | null
  }
  candidates: Candidate[]
  /** The attest limit in SEK per person; null or missing = no limit. */
  limits: Record<string, number | null>
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
}

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
  }
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.enabled === b.enabled &&
    a.threshold.trim() === b.threshold.trim() &&
    a.mode === b.mode &&
    a.preparer_may_attest === b.preparer_may_attest &&
    a.two_step.trim() === b.two_step.trim() &&
    [...a.attesters].sort().join(',') === [...b.attesters].sort().join(',') &&
    a.attesters.every((id) => (a.limits[id] ?? '').trim() === (b.limits[id] ?? '').trim())
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
    if (!draft || thresholdInvalid || twoStepInvalid || limitsInvalid) return
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
          'sticky bottom-0 flex items-center gap-4 bg-gradient-to-t from-background via-background/95 to-transparent px-1 transition-opacity duration-150',
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
