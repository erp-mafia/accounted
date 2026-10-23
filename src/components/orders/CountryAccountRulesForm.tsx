'use client'

import { useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import {
  SettingsGroup,
  SettingsInput,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
  SettingsSelect,
} from '@/components/settings/SettingsRows'
import { ACCOUNT_NUMBER_RE } from '@/lib/invariants/account-number'
import { parseDecimalInput } from '@/lib/money'
import { getCountryName, getCountryOptions } from '@/lib/vat/country-codes'
import {
  COUNTRY_SCOPE_EU,
  COUNTRY_SCOPE_NON_EU,
  EXPORT_REVENUE_ACCOUNT,
  NO_OSS_PRESET_RULES,
  OSS_PRESET_RULES,
  OSS_REVENUE_ACCOUNT,
  OSS_VAT_ACCOUNT,
  isEuRuleCountry,
  ruleCoversVat,
  sameVatRate,
} from '@/lib/webshop-orders/country-routing'
import type { CountryRuleProblem } from '@/lib/webshop-orders/country-rule-checks'
import type { WebshopCountryAccountRule, WebshopPlatform, WebshopStoreSettings } from '@/types'

interface CountryAccountRulesFormProps {
  platform: WebshopPlatform
  storeScope: string
}

/** One editable row; account fields are strings while the user types. */
type DraftRule =
  | { country: string; vat_rate: number | null; mode: 'accounts'; revenue: string; vat: string }
  | { country: string; vat_rate: number | null; mode: 'swedish' }

function toDraft(rule: WebshopCountryAccountRule): DraftRule {
  return rule.mode === 'swedish'
    ? { country: rule.country, vat_rate: rule.vat_rate, mode: 'swedish' }
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
    ? { country: draft.country, vat_rate: draft.vat_rate, mode: 'swedish' }
    : {
        country: draft.country,
        vat_rate: draft.vat_rate,
        mode: 'accounts',
        revenue_account: draft.revenue,
        vat_account: draft.vat || null,
      }
}

/**
 * The accounts a new row starts from: the OSS pair for an EU destination
 * with VAT, export (3105) outside the EU. Norway's VOEC VAT account has no
 * default (the company picks it), and a 0 % EU sale is left blank: it is a
 * different treatment (EU B2B) the user must name.
 */
function prefillFor(country: string, rate: number | null): { revenue: string; vat: string } {
  const withVat = ruleCoversVat({ vat_rate: rate })
  if (isEuRuleCountry(country)) {
    return withVat ? { revenue: OSS_REVENUE_ACCOUNT, vat: OSS_VAT_ACCOUNT } : { revenue: '', vat: '' }
  }
  return { revenue: EXPORT_REVENUE_ACCOUNT, vat: '' }
}

type RateChoice = 'any' | 'zero' | 'other'

/**
 * Accounts per destination country for a Shopify store (country_account_rules).
 * An order shipped outside Sweden books each VAT bucket on these accounts, in
 * the single dialog's prefill, in bulk booking and in the MCP suggestion; an
 * order to a country without a row is skipped by bulk booking. Fönster
 * language: flat hairline rows, save appears only when dirty, every
 * explanation behind the group's "?".
 */
export function CountryAccountRulesForm({ platform, storeScope }: CountryAccountRulesFormProps) {
  const t = useTranslations('webshop_orders')
  const locale = useLocale() === 'en' ? 'en' : 'sv'
  const { toast } = useToast()
  const [saved, setSaved] = useState<WebshopCountryAccountRule[]>([])
  const [draft, setDraft] = useState<DraftRule[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [problems, setProblems] = useState<CountryRuleProblem[]>([])
  const [newCountry, setNewCountry] = useState(COUNTRY_SCOPE_EU)
  const [newRateChoice, setNewRateChoice] = useState<RateChoice>('any')
  const [newRateValue, setNewRateValue] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch(
      `/api/webshop-orders/settings?platform=${platform}&store_scope=${encodeURIComponent(storeScope)}`,
    )
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((json: { data: WebshopStoreSettings[] }) => {
        if (cancelled) return
        const rules = json.data[0]?.country_account_rules ?? []
        setSaved(rules)
        setDraft(rules.map(toDraft))
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [platform, storeScope])

  const rules = useMemo(() => draft.map(toRule), [draft])
  const dirty = JSON.stringify(rules) !== JSON.stringify(saved)

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
    () => getCountryOptions(locale).filter((option) => option.code !== 'SE'),
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

  const editDraft = (next: DraftRule[]) => {
    setDraft(next)
    setProblems([])
  }

  const addRule = () => {
    if (newRate === undefined || newIsDuplicate) return
    const { revenue, vat } = prefillFor(newCountry, newRate)
    editDraft([...draft, { country: newCountry, vat_rate: newRate, mode: 'accounts', revenue, vat }])
  }

  const setAccount = (index: number, field: 'revenue' | 'vat', value: string) => {
    editDraft(
      draft.map((rule, i) => (i === index && rule.mode === 'accounts' ? { ...rule, [field]: value } : rule)),
    )
  }

  const removeRule = (index: number) => editDraft(draft.filter((_, i) => i !== index))

  const invalid = draft.some(
    (rule) =>
      rule.mode === 'accounts' &&
      (!ACCOUNT_NUMBER_RE.test(rule.revenue) ||
        (rule.vat !== '' && !ACCOUNT_NUMBER_RE.test(rule.vat)) ||
        (rule.vat === '' && ruleCoversVat(rule))),
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

  const problemText = (problem: CountryRuleProblem) =>
    t(`country_rules_problem_${problem.code}`, {
      account: problem.account ?? '',
      box: problem.box ?? '',
    })

  if (loading) return null

  return (
    <SettingsGroup label={t('country_rules_title')} help={t('country_rules_help')}>
      {draft.length === 0 && (
        <SettingsRow label={t('country_rules_preset_label')}>
          <SettingsRowEnd>
            <Button
              size="sm"
              variant="outline"
              onClick={() => editDraft(OSS_PRESET_RULES.map(toDraft))}
            >
              {t('country_rules_preset_oss')}
            </Button>
            <Button
              size="sm"
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
              {rule.mode === 'swedish' ? (
                <SettingsRowNote>{t('country_rules_swedish')}</SettingsRowNote>
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
                  size="sm"
                  variant="ghost"
                  onClick={() => removeRule(index)}
                  aria-label={t('country_rules_remove_aria', { country: label })}
                >
                  {t('country_rules_remove')}
                </Button>
              </SettingsRowEnd>
            </SettingsRow>
            {rowProblems.length > 0 && (
              <ul className="space-y-0.5 border-b border-border pb-3" role="alert">
                {rowProblems.map((problem) => (
                  <li key={`${problem.field}-${problem.code}`} className="text-[12.5px] text-destructive">
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
            size="sm"
            variant="outline"
            onClick={addRule}
            disabled={newRate === undefined || newIsDuplicate}
          >
            {t('country_rules_add')}
          </Button>
        </SettingsRowEnd>
      </SettingsRow>

      <div className="flex items-center justify-between gap-4 px-1 pt-3">
        <SettingsRowNote>{t('country_rules_note')}</SettingsRowNote>
        {dirty && (
          <Button size="sm" onClick={save} disabled={saving || invalid}>
            {saving ? t('country_rules_saving') : t('country_rules_save')}
          </Button>
        )}
      </div>
    </SettingsGroup>
  )
}
