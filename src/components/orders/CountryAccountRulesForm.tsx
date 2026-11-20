'use client'

import { useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { ArrowPathIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { useViewerLock } from '@/components/ui/viewer-lock'
import {
  SettingsGroup,
  SettingsInput,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
  SettingsSelect,
} from '@/components/settings/SettingsRows'
import { panelRequest } from '@/lib/browser/panel-request'
import { ACCOUNT_NUMBER_RE } from '@/lib/invariants/account-number'
import { parseDecimalInput } from '@/lib/money'
import { getCountryName, getCountryOptions } from '@/lib/vat/country-codes'
import {
  COUNTRY_SCOPE_EU,
  COUNTRY_SCOPE_NON_EU,
  COUNTRY_SWEDEN,
  NO_OSS_PRESET_RULES,
  OSS_PRESET_RULES,
  SWEDISH_RULE_RATES,
  alternativeAccountFor,
  isEuRuleCountry,
  presetAccountsFor,
  ruleCoversVat,
  sameCountryRules,
  sameVatRate,
} from '@/lib/webshop-orders/country-routing'
import type { CountryRuleProblem } from '@/lib/webshop-orders/country-rule-checks'
import type { WebshopCountryAccountRule, WebshopPlatform, WebshopStoreSettings } from '@/types'

interface CountryAccountRulesFormProps {
  platform: WebshopPlatform
  storeScope: string
}

/**
 * One editable row; account fields are strings while the user types. A
 * 'swedish' row's revenue is optional: empty books the default Swedish sales
 * account for the rate.
 */
type DraftRule =
  | { country: string; vat_rate: number | null; mode: 'accounts'; revenue: string; vat: string }
  | { country: string; vat_rate: number | null; mode: 'swedish'; revenue: string }

function toDraft(rule: WebshopCountryAccountRule): DraftRule {
  return rule.mode === 'swedish'
    ? { country: rule.country, vat_rate: rule.vat_rate, mode: 'swedish', revenue: rule.revenue_account ?? '' }
    : {
        country: rule.country,
        vat_rate: rule.vat_rate,
        mode: 'accounts',
        revenue: rule.revenue_account,
        vat: rule.vat_account ?? '',
      }
}

function toRule(draft: DraftRule): WebshopCountryAccountRule {
  return draft.mode === 'swedish'
    ? {
        country: draft.country,
        vat_rate: draft.vat_rate,
        mode: 'swedish',
        ...(draft.revenue ? { revenue_account: draft.revenue } : {}),
      }
    : {
        country: draft.country,
        vat_rate: draft.vat_rate,
        mode: 'accounts',
        revenue_account: draft.revenue,
        vat_account: draft.vat || null,
      }
}

type RateChoice = 'any' | 'zero' | 'other'

/**
 * Whether a row may book with Swedish VAT ('swedish'): an EU destination at a
 * Swedish rate or every rate. Such a row offers the choice between its own
 * accounts (OSS and the like) and Swedish VAT, so a seller below the
 * distance-selling threshold reaches Svensk moms on a row that exists
 * (crm#1449), not only through the preset on an empty form. A Sverige row
 * has no choice: it is always Svensk moms.
 */
function offersSwedishMode(rule: DraftRule): boolean {
  if (rule.country === COUNTRY_SWEDEN) return false
  if (rule.mode === 'swedish') return true
  if (!isEuRuleCountry(rule.country) || !ruleCoversVat(rule)) return false
  return rule.vat_rate === null || SWEDISH_RULE_RATES.some((rate) => sameVatRate(rate, rule.vat_rate as number))
}

/**
 * Where the stored rules stand. Only 'ready' renders rules, presets or save:
 * a failed read (401, 500, an MFA step-up, offline) is not "no rules", and an
 * empty form offered on top of it would let a save replace the real ones.
 */
type LoadState = 'loading' | 'failed' | 'ready'

/**
 * Accounts per destination country for a Shopify store (country_account_rules).
 * An order books each VAT bucket on these accounts, in the single dialog's
 * prefill, in bulk booking and in the MCP suggestion; an order to a country
 * outside Sweden without a row is skipped by bulk booking, and one to Sweden
 * without a row books on the default Swedish accounts. Fönster
 * language: flat hairline rows, save appears only when dirty, every
 * explanation behind the group's "?".
 */
export function CountryAccountRulesForm({ platform, storeScope }: CountryAccountRulesFormProps) {
  const t = useTranslations('webshop_orders')
  const { canWrite, lockedTitle } = useViewerLock()
  const tCommon = useTranslations('common')
  const locale = useLocale() === 'en' ? 'en' : 'sv'
  const { toast } = useToast()
  const [saved, setSaved] = useState<WebshopCountryAccountRule[]>([])
  const [draft, setDraft] = useState<DraftRule[]>([])
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [saving, setSaving] = useState(false)
  const [problems, setProblems] = useState<CountryRuleProblem[]>([])
  const [newCountry, setNewCountry] = useState(COUNTRY_SCOPE_EU)
  const [newRateChoice, setNewRateChoice] = useState<RateChoice>('any')
  const [newRateValue, setNewRateValue] = useState('')

  useEffect(() => {
    let cancelled = false
    void panelRequest<{ data?: WebshopStoreSettings[] }>({
      url: `/api/webshop-orders/settings?platform=${platform}&store_scope=${encodeURIComponent(storeScope)}`,
      method: 'GET',
    }).then((result) => {
      if (cancelled) return
      const rows = result.ok ? result.data?.data : undefined
      if (!Array.isArray(rows)) {
        setLoadState('failed')
        return
      }
      const stored = rows[0]?.country_account_rules ?? []
      setSaved(stored)
      setDraft(stored.map(toDraft))
      setLoadState('ready')
    })
    return () => {
      cancelled = true
    }
  }, [platform, storeScope, loadAttempt])

  const retryLoad = () => {
    setLoadState('loading')
    setLoadAttempt((n) => n + 1)
  }

  const rules = useMemo(() => draft.map(toRule), [draft])
  const dirty = !sameCountryRules(rules, saved)

  const countryLabel = (country: string) =>
    country === COUNTRY_SCOPE_EU
      ? t('country_rules_scope_eu')
      : country === COUNTRY_SCOPE_NON_EU
        ? t('country_rules_scope_non_eu')
        : getCountryName(country, locale)
  const rateLabel = (rate: number | null) =>
    rate === null
      ? t('country_rules_rate_any')
      : t('country_rules_rate_value', { rate: rate.toLocaleString(locale === 'en' ? 'en-GB' : 'sv-SE') })

  const countryOptions = useMemo(
    () => getCountryOptions(locale).filter((option) => option.code !== COUNTRY_SWEDEN),
    [locale],
  )

  const newRate: number | null | undefined =
    newRateChoice === 'any'
      ? null
      : newRateChoice === 'zero'
        ? 0
        : (() => {
            const parsed = parseDecimalInput(newRateValue)
            return parsed !== null && parsed > 0 && parsed < 100 ? parsed : undefined
          })()
  const newIsDuplicate =
    newRate !== undefined &&
    draft.some(
      (rule) =>
        rule.country === newCountry &&
        (rule.vat_rate === null || newRate === null
          ? rule.vat_rate === newRate
          : sameVatRate(rule.vat_rate, newRate)),
    )
  // Sverige at 0 %: Svensk moms with no sales account to choose, a row that
  // changes nothing.
  const newIsEmptySweden = newCountry === COUNTRY_SWEDEN && newRate === 0

  const editDraft = (next: DraftRule[]) => {
    setDraft(next)
    setProblems([])
  }

  const addRule = () => {
    if (newRate === undefined || newIsDuplicate || newIsEmptySweden) return
    if (newCountry === COUNTRY_SWEDEN) {
      editDraft([...draft, { country: newCountry, vat_rate: newRate, mode: 'swedish', revenue: '' }])
      return
    }
    const preset = presetAccountsFor(newCountry, newRate)
    editDraft([
      ...draft,
      {
        country: newCountry,
        vat_rate: newRate,
        mode: 'accounts',
        revenue: preset.revenue ?? '',
        vat: preset.vat ?? '',
      },
    ])
  }

  const setAccount = (index: number, field: 'revenue' | 'vat', value: string) => {
    editDraft(
      draft.map((rule, i) => {
        if (i !== index) return rule
        if (rule.mode === 'accounts') return { ...rule, [field]: value }
        return field === 'revenue' ? { ...rule, revenue: value } : rule
      }),
    )
  }

  // Switching a row keeps an account the user typed: a ruta 05 account on an
  // EU row is exactly what Svensk moms books on. The preset OSS account is
  // not carried over, and back to own accounts the row starts from the preset.
  const setMode = (index: number, mode: DraftRule['mode']) => {
    editDraft(
      draft.map((rule, i) => {
        if (i !== index || rule.mode === mode) return rule
        const preset = presetAccountsFor(rule.country, rule.vat_rate)
        if (mode === 'swedish') {
          const revenue = rule.revenue !== preset.revenue ? rule.revenue : ''
          return { country: rule.country, vat_rate: rule.vat_rate, mode, revenue }
        }
        return {
          country: rule.country,
          vat_rate: rule.vat_rate,
          mode,
          revenue: preset.revenue ?? '',
          vat: preset.vat ?? '',
        }
      }),
    )
  }

  const removeRule = (index: number) => editDraft(draft.filter((_, i) => i !== index))

  const invalid = draft.some((rule) =>
    rule.mode === 'swedish'
      ? rule.revenue !== '' && !ACCOUNT_NUMBER_RE.test(rule.revenue)
      : !ACCOUNT_NUMBER_RE.test(rule.revenue) ||
        (rule.vat !== '' && !ACCOUNT_NUMBER_RE.test(rule.vat)) ||
        (rule.vat === '' && ruleCoversVat(rule)),
  )

  async function save() {
    setSaving(true)
    try {
      const res = await fetch('/api/webshop-orders/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, store_scope: storeScope, country_account_rules: rules }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { code?: string; details?: { problems?: CountryRuleProblem[] } }
        } | null
        if (body?.error?.code === 'WEBSHOP_COUNTRY_RULES_INVALID' && body.error.details?.problems) {
          setProblems(body.error.details.problems)
          toast({ title: t('country_rules_save_invalid'), variant: 'destructive' })
          return
        }
        throw new Error(`save failed: ${res.status}`)
      }
      const json = (await res.json()) as { data: WebshopStoreSettings }
      const stored = json.data.country_account_rules ?? []
      setSaved(stored)
      setDraft(stored.map(toDraft))
      setProblems([])
      toast({ title: t('country_rules_saved') })
    } catch {
      toast({ title: t('country_rules_save_failed'), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const problemText = (problem: CountryRuleProblem) => {
    // A problem's index is the row's place in the rules the last save sent,
    // which is the draft until it is edited (an edit clears the problems).
    const rule = draft[problem.index]
    const alternative =
      rule && (problem.field === 'revenue_account' || problem.field === 'vat_account')
        ? alternativeAccountFor(rule, problem.field, problem.account)
        : null
    return t(`country_rules_problem_${problem.code}`, {
      account: problem.account ?? '',
      box: problem.box ?? '',
      alternative: alternative ?? 'none',
    })
  }

  if (loadState === 'loading') return null

  // Same shape as the feed panel's failed status read: the sentence and a
  // retry, nothing else. No presets, rows or save until a read succeeds.
  if (loadState === 'failed') {
    return (
      <SettingsGroup label={t('country_rules_title')}>
        <div className="flex items-center justify-between gap-4 px-1 py-3" role="alert">
          <p className="text-sm text-destructive">{t('country_rules_load_failed')}</p>
          <Button variant="outline" onClick={retryLoad}>
            <ArrowPathIcon className="h-4 w-4" />
            {tCommon('retry')}
          </Button>
        </div>
      </SettingsGroup>
    )
  }

  return (
    <SettingsGroup label={t('country_rules_title')} help={t('country_rules_help')}>
      {draft.length === 0 && (
        <SettingsRow label={t('country_rules_preset_label')}>
          <SettingsRowEnd>
            <Button
              variant="outline"
              onClick={() => editDraft(OSS_PRESET_RULES.map(toDraft))}
            >
              {t('country_rules_preset_oss')}
            </Button>
            <Button
              variant="outline"
              onClick={() => editDraft(NO_OSS_PRESET_RULES.map(toDraft))}
            >
              {t('country_rules_preset_no_oss')}
            </Button>
          </SettingsRowEnd>
        </SettingsRow>
      )}

      {draft.map((rule, index) => {
        const label = `${countryLabel(rule.country)} · ${rateLabel(rule.vat_rate)}`
        const rowProblems = problems.filter((p) => p.index === index)
        return (
          <div key={`${rule.country}-${rule.vat_rate ?? 'any'}`}>
            <SettingsRow label={label} borderless={rowProblems.length > 0}>
              {offersSwedishMode(rule) && (
                <SettingsSelect
                  value={rule.mode}
                  onChange={(e) => setMode(index, e.target.value as DraftRule['mode'])}
                  aria-label={t('country_rules_mode_aria', { country: label })}
                  wrapperClassName="min-w-28 flex-1"
                >
                  <option value="swedish">{t('country_rules_mode_swedish')}</option>
                  <option value="accounts">{t('country_rules_mode_accounts')}</option>
                </SettingsSelect>
              )}
              {rule.mode === 'swedish' ? (
                ruleCoversVat(rule) && (
                  <SettingsInput
                    value={rule.revenue}
                    onChange={(e) => setAccount(index, 'revenue', e.target.value.trim())}
                    inputMode="numeric"
                    maxLength={4}
                    placeholder={t('country_rules_swedish_revenue_placeholder')}
                    className="max-w-24 flex-none text-right tabular-nums"
                    aria-label={t('country_rules_swedish_revenue_aria', { country: label })}
                    aria-invalid={rule.revenue !== '' && !ACCOUNT_NUMBER_RE.test(rule.revenue)}
                  />
                )
              ) : (
                <>
                  <SettingsInput
                    value={rule.revenue}
                    onChange={(e) => setAccount(index, 'revenue', e.target.value.trim())}
                    inputMode="numeric"
                    maxLength={4}
                    placeholder={t('country_rules_revenue_placeholder')}
                    className="max-w-24 flex-none text-right tabular-nums"
                    aria-label={t('country_rules_revenue_aria', { country: label })}
                    aria-invalid={!ACCOUNT_NUMBER_RE.test(rule.revenue)}
                  />
                  <SettingsInput
                    value={rule.vat}
                    onChange={(e) => setAccount(index, 'vat', e.target.value.trim())}
                    inputMode="numeric"
                    maxLength={4}
                    placeholder={
                      ruleCoversVat(rule)
                        ? t('country_rules_vat_placeholder')
                        : t('country_rules_no_vat')
                    }
                    className="max-w-24 flex-none text-right tabular-nums"
                    aria-label={t('country_rules_vat_aria', { country: label })}
                    aria-invalid={
                      rule.vat === '' ? ruleCoversVat(rule) : !ACCOUNT_NUMBER_RE.test(rule.vat)
                    }
                  />
                </>
              )}
              <SettingsRowEnd>
                <Button
                  variant="ghost"
                  onClick={() => removeRule(index)}
                  aria-label={t('country_rules_remove_aria', { country: label })}
                >
                  {t('country_rules_remove')}
                </Button>
              </SettingsRowEnd>
            </SettingsRow>
            {rowProblems.length > 0 && (
              <ul className="space-y-0.5 border-b-hairline pb-3" role="alert">
                {rowProblems.map((problem) => (
                  <li key={`${problem.field}-${problem.code}`} className="text-xs text-destructive">
                    {problemText(problem)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      })}

      <SettingsRow label={t('country_rules_add_label')}>
        <SettingsSelect
          value={newCountry}
          onChange={(e) => setNewCountry(e.target.value)}
          aria-label={t('country_rules_add_country_aria')}
          wrapperClassName="min-w-0 flex-1"
        >
          <option value={COUNTRY_SCOPE_EU}>{t('country_rules_scope_eu')}</option>
          <option value={COUNTRY_SCOPE_NON_EU}>{t('country_rules_scope_non_eu')}</option>
          {/* Up top, not in its alphabetical place: the most common row. */}
          <option value={COUNTRY_SWEDEN}>{countryLabel(COUNTRY_SWEDEN)}</option>
          {countryOptions.map((option) => (
            <option key={option.code} value={option.code}>
              {locale === 'en' ? option.nameEn : option.name}
            </option>
          ))}
        </SettingsSelect>
        <SettingsSelect
          value={newRateChoice}
          onChange={(e) => setNewRateChoice(e.target.value as RateChoice)}
          aria-label={t('country_rules_add_rate_aria')}
          wrapperClassName="min-w-0 flex-1"
        >
          <option value="any">{t('country_rules_add_rate_any')}</option>
          <option value="zero">{t('country_rules_add_rate_zero')}</option>
          <option value="other">{t('country_rules_add_rate_other')}</option>
        </SettingsSelect>
        {newRateChoice === 'other' && (
          <SettingsInput
            value={newRateValue}
            onChange={(e) => setNewRateValue(e.target.value)}
            inputMode="decimal"
            maxLength={5}
            placeholder="19"
            className="max-w-20 flex-none text-right tabular-nums"
            aria-label={t('country_rules_add_rate_input_aria')}
          />
        )}
        <SettingsRowEnd>
          <Button
            variant="outline"
            onClick={addRule}
            disabled={newRate === undefined || newIsDuplicate || newIsEmptySweden}
          >
            {t('country_rules_add')}
          </Button>
        </SettingsRowEnd>
      </SettingsRow>

      <div className="flex items-center justify-between gap-4 px-1 pt-3">
        <SettingsRowNote>{t('country_rules_note')}</SettingsRowNote>
        {dirty && (
          <Button onClick={save} disabled={!canWrite || saving || invalid} title={lockedTitle}>
            {saving ? t('country_rules_saving') : t('country_rules_save')}
          </Button>
        )}
      </div>
    </SettingsGroup>
  )
}
