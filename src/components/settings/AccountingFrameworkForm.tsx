'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import {
  SettingsRow,
  SettingsRowNote,
  SettingsSelect,
  SettingsTextarea,
} from '@/components/settings/SettingsRows'
import type { AccountingFramework } from '@/types'
import { isReliableFrameworkSource, type FiscalYearFramework } from '@/lib/company/accounting-framework'
import { getErrorMessage } from '@/lib/errors/get-error-message'

interface AccountingFrameworkFormProps {
  /** The company default (the framework a new year starts from). */
  current: AccountingFramework
  /** Bubble up after a successful save so parent state can refresh. */
  onSaved?: (next: AccountingFramework) => void
}

interface FrameworkList {
  years: FiscalYearFramework[]
  current_fiscal_period_id: string | null
  company_framework: AccountingFramework
}

function dayBefore(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

/**
 * K2/K3 selector rows for AB. Lives in the Grunder group on the bookkeeping
 * settings page. Renders nothing for non-AB entities: the parent gates this
 * component by entity_type.
 *
 * The framework is chosen per räkenskapsår (BFNAR 2012:4,
 * lib/company/accounting-framework.ts): the first row picks the year (the one
 * running today by default), the second its framework. A closed or locked
 * year keeps its framework. With no fiscal year yet (onboarding) only the
 * framework row shows, and it sets the default the first year starts from.
 *
 * UX rules (regulatory area: kept in Swedish):
 *   - Default is K2 (matches the column default and BFNAR 2016:10 baseline).
 *   - Switching in either direction fires a confirmation dialog. K2 → K3
 *     names what the system then does (K3-mallen for the årsredovisning,
 *     komponentuppdelning in the asset register) and the one obligation the
 *     choice itself carries: komponentavskrivning is mandatory under K3 where
 *     component useful lives differ materially (punkt 17.4).
 *     Kassaflödesanalys is NOT a consequence of K3: it follows from being a
 *     större företag, so the copy says the product includes one, it does not
 *     blame the regelverk.
 *     K3 → K2 warns about what the system does NOT do: uppskjuten skatt
 *     (2240/8940) balances and komponentavskrivningar are not unwound
 *     automatically, and the K3 årsredovisning content stops applying. A
 *     switch is judged against the previous årsredovisning: when Accounted
 *     holds no reliable record of its framework (a company default is not
 *     one) the dialog first asks which framework it was prepared under. When
 *     that was K3 the dialog also asks what BFNAR 2012:4 asks: the reasons
 *     (printed in a note), whether the company applied K2 before, and then
 *     that the reasons are särskilda skäl.
 *   - The save is its own request (PATCH /api/company/current): separate
 *     from /api/settings because the framework is not a company_settings
 *     column.
 */
export function AccountingFrameworkForm({ current, onSaved }: AccountingFrameworkFormProps) {
  const t = useTranslations('accounting_framework')
  const { toast } = useToast()
  const [list, setList] = useState<FrameworkList | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [yearId, setYearId] = useState<string | null>(null)
  const [defaultFramework, setDefaultFramework] = useState<AccountingFramework>(current)
  const [pending, setPending] = useState<AccountingFramework | null>(null)
  const [saving, setSaving] = useState(false)
  const [reason, setReason] = useState('')
  const [previouslyK2, setPreviouslyK2] = useState(false)
  const [specialReasons, setSpecialReasons] = useState(false)
  const [statedPrevious, setStatedPrevious] = useState<'' | AccountingFramework | 'none'>('')

  async function load() {
    try {
      const res = await fetch('/api/company/accounting-framework', { cache: 'no-store' })
      if (!res.ok) throw new Error(String(res.status))
      const body = (await res.json()) as { data: FrameworkList }
      setList(body.data)
      setDefaultFramework(body.data.company_framework)
      setYearId((previous) => previous ?? body.data.current_fiscal_period_id)
      setLoadFailed(false)
    } catch {
      setLoadFailed(true)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const years = useMemo(() => list?.years ?? [], [list])
  const year = years.find((y) => y.id === yearId) ?? null
  const selected: AccountingFramework = year?.framework ?? defaultFramework
  const yearLocked = Boolean(year && (year.is_closed || year.locked_at))
  const previousYear = year ? years.find((y) => y.period_end === dayBefore(year.period_start)) ?? null : null
  // BFNAR 2012:4: a switch is between årsredovisningar, so leaving K3 for K2
  // is judged against the previous one's framework: the previous year's
  // record when it is reliable, else what the user states (a company
  // default is not evidence; set_fiscal_period_framework applies the same).
  const previousKnown = previousYear !== null && isReliableFrameworkSource(previousYear.source)
  const asksPrevious = pending === 'k2' && year !== null && year.framework === 'k3' && !previousKnown
  const previousBasis = previousKnown && previousYear ? previousYear.framework : statedPrevious || null
  const isK3ToK2 = pending === 'k2' && year !== null && previousBasis === 'k3'
  const earlierK2Known = year
    ? years.some(
        (y) =>
          y.period_start < year.period_start
          && y.framework === 'k2'
          && isReliableFrameworkSource(y.source),
      )
    : false
  const needsSpecialReasons = earlierK2Known || previouslyK2
  const confirmBlocked =
    (asksPrevious && statedPrevious === '')
    || (isK3ToK2 && (reason.trim().length === 0 || (needsSpecialReasons && !specialReasons)))

  function resetDialog() {
    setPending(null)
    setReason('')
    setPreviouslyK2(false)
    setSpecialReasons(false)
    setStatedPrevious('')
  }

  async function persist(next: AccountingFramework) {
    setSaving(true)
    try {
      const res = await fetch('/api/company/current', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accounting_framework: next,
          ...(year ? { fiscal_period_id: year.id } : {}),
          ...(asksPrevious && statedPrevious !== '' ? { previous_year_framework: statedPrevious } : {}),
          ...(isK3ToK2
            ? {
                framework_change_reason: reason.trim(),
                previously_applied_k2: earlierK2Known || previouslyK2,
                special_reasons_confirmed: needsSpecialReasons ? specialReasons : null,
              }
            : {}),
        }),
      })
      const body = await res.json()
      if (!res.ok) {
        toast({
          title: 'Kunde inte spara',
          description: getErrorMessage(body, { fallback: 'Försök igen.' }),
          variant: 'destructive',
        })
        return
      }
      const cascaded = (body?.data?.fiscal_year?.cascaded_period_ids ?? []) as string[]
      const yearName = year?.name ?? ''
      toast({
        title: 'Sparat',
        description: [
          year
            ? next === 'k3' ? t('saved_k3', { year: yearName }) : t('saved_k2', { year: yearName })
            : next === 'k3'
              ? 'Bolaget redovisar nu enligt K3 (BFNAR 2012:1).'
              : 'Bolaget redovisar nu enligt K2 (BFNAR 2016:10).',
          cascaded.length > 0 ? t('saved_cascade', { count: cascaded.length }) : null,
        ]
          .filter(Boolean)
          .join(' '),
      })
      const companyFramework = (body?.data?.accounting_framework ?? next) as AccountingFramework
      setDefaultFramework(companyFramework)
      onSaved?.(companyFramework)
      await load()
    } catch {
      toast({
        title: 'Kunde inte spara',
        description: 'Försök igen.',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
      resetDialog()
    }
  }

  function handleChange(next: string) {
    const value = next as AccountingFramework
    if (value === selected) return
    // Both directions are consequential: K2 → K3 adds obligations, K3 → K2
    // leaves K3-only balances behind. Confirm before persisting either way.
    setPending(value)
  }

  const frameworkLabel = (framework: AccountingFramework) => framework.toUpperCase()

  return (
    <>
      {years.length > 0 && (
        <SettingsRow label={t('year_label')} htmlFor="accounting_framework_year" help={t('year_help')}>
          <SettingsSelect
            id="accounting_framework_year"
            value={yearId ?? ''}
            onChange={(e) => setYearId(e.target.value)}
            onInput={(e) => e.stopPropagation()}
            disabled={saving}
          >
            {[...years].reverse().map((y) => (
              <option key={y.id} value={y.id}>
                {t('year_option', { year: y.name, framework: frameworkLabel(y.framework) })}
              </option>
            ))}
          </SettingsSelect>
        </SettingsRow>
      )}
      <SettingsRow
        label="Regelverk"
        htmlFor="accounting_framework"
        help={
          <>
            K2 är standard för mindre bolag och innebär förenklade regler. Större företag
            ska tillämpa K3 och upprätta kassaflödesanalys: dit räknas bland annat bolag
            som överskrider mer än ett av tre tröskelvärden (nettoomsättning &gt; 80 MSEK,
            tillgångar &gt; 40 MSEK, fler än 50 anställda) under vart och ett av de två
            senaste räkenskapsåren, och bolag med noterade värdepapper. För räkenskapsår
            som börjar efter 2025-12-31 är K2 dessutom stängt för bolag med utländsk
            filial, kryptotillgångar eller aktierelaterade ersättningar, och för bolag där
            byggnader ger minst 75 % av nettoomsättningen. Med K3
            valt bygger Accounted årsredovisningen enligt K3-mallen: kassaflödesanalys,
            förändring av eget kapital som egen räkning och utökade noter.
            Anläggningsregistret tar emot komponentuppdelning först med K3, som kräver
            komponentavskrivning när komponenterna har väsentligt olika nyttjandeperioder.
            Obeskattade reserver redovisas brutto i juridisk person enligt K3 punkt 29.37.
          </>
        }
      >
        <SettingsSelect
          id="accounting_framework"
          value={selected}
          onChange={(e) => handleChange(e.target.value)}
          // Saves via its own PATCH; the row sits inside the page's
          // SettingsFormWrapper form, so keep the wrapper's dirty tracking
          // (onInput on the form) from reacting to this select. No `name`
          // either, so the wrapper's FormData never picks it up.
          onInput={(e) => e.stopPropagation()}
          disabled={saving || yearLocked || (list === null && !loadFailed)}
        >
          <option value="k2">K2 (BFNAR 2016:10): mindre företag</option>
          <option value="k3">K3 (BFNAR 2012:1): större företag</option>
        </SettingsSelect>
        {saving && <SettingsRowNote>Sparar…</SettingsRowNote>}
        {!saving && list === null && !loadFailed && <SettingsRowNote>{t('loading')}</SettingsRowNote>}
        {!saving && loadFailed && <SettingsRowNote>{t('load_failed')}</SettingsRowNote>}
        {!saving && yearLocked && <SettingsRowNote>{t('year_locked_note')}</SettingsRowNote>}
      </SettingsRow>

      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) resetDialog()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pending === 'k2' ? 'Byta till K2?' : 'Byta till K3?'}</DialogTitle>
            <DialogDescription className="space-y-2 pt-2">
              {year && <span className="block">{t('applies_to', { year: year.name })}</span>}
              {pending === 'k2' ? (
                <>
                  <span className="block">
                    Bokförda saldon för uppskjuten skatt (konto 2240 / 8940) och gjorda
                    komponentavskrivningar återförs inte automatiskt: de måste hanteras
                    manuellt.
                  </span>
                  <span className="block">
                    Årsredovisningens K3-innehåll (kassaflödesanalys, K3-noter och
                    uppskjuten skatt) gäller inte längre. Fortsätt?
                  </span>
                </>
              ) : (
                <>
                  <span className="block">
                    Årsredovisningen byggs då enligt K3-mallen: kassaflödesanalys,
                    förändring av eget kapital som egen räkning och utökade noter.
                    Kassaflödesanalys är i sig ett krav för större företag, inte en följd
                    av regelverksvalet.
                  </span>
                  <span className="block">
                    Komponentavskrivning blir obligatorisk för tillgångar vars komponenter
                    har väsentligt olika nyttjandeperioder (K3 punkt 17.4).
                    Anläggningsregistret tar emot komponentuppdelning först när K3 är valt.
                  </span>
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {asksPrevious && (
            <div className="space-y-2">
              <label htmlFor="framework_previous_year" className="text-[13px]">
                {t('previous_year_label')}
              </label>
              <SettingsSelect
                id="framework_previous_year"
                value={statedPrevious}
                onChange={(e) => setStatedPrevious(e.target.value as '' | AccountingFramework | 'none')}
                onInput={(e) => e.stopPropagation()}
              >
                <option value="">{t('previous_year_choose')}</option>
                <option value="k3">{t('previous_year_k3')}</option>
                <option value="k2">{t('previous_year_k2')}</option>
                {previousYear === null && <option value="none">{t('previous_year_none')}</option>}
              </SettingsSelect>
              <p className="text-[12.5px] text-muted-foreground">{t('previous_year_help')}</p>
            </div>
          )}
          {isK3ToK2 && (
            <div className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="framework_change_reason" className="text-[13px]">
                  {t('reason_label')}
                </label>
                <SettingsTextarea
                  id="framework_change_reason"
                  value={reason}
                  maxLength={2000}
                  onChange={(e) => setReason(e.target.value)}
                  onInput={(e) => e.stopPropagation()}
                />
                <p className="text-[12.5px] text-muted-foreground">{t('reason_help')}</p>
              </div>
              {earlierK2Known ? (
                <p className="text-[12.5px] text-muted-foreground">{t('previously_k2_known')}</p>
              ) : (
                <label className="flex items-start gap-2 text-[13px]">
                  <Checkbox
                    checked={previouslyK2}
                    onCheckedChange={(checked) => setPreviouslyK2(checked === true)}
                    className="mt-0.5"
                  />
                  <span>{t('previously_k2_label')}</span>
                </label>
              )}
              {needsSpecialReasons && (
                <label className="flex items-start gap-2 text-[13px]">
                  <Checkbox
                    checked={specialReasons}
                    onCheckedChange={(checked) => setSpecialReasons(checked === true)}
                    className="mt-0.5"
                  />
                  <span>{t('special_reasons_label')}</span>
                </label>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={resetDialog} disabled={saving}>
              Avbryt
            </Button>
            <Button
              onClick={() => {
                if (!pending) return
                void persist(pending)
              }}
              loading={saving}
              disabled={confirmBlocked}
            >
              {saving ? (
                'Sparar…'
              ) : pending === 'k2' ? (
                'Byt till K2'
              ) : (
                'Byt till K3'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
