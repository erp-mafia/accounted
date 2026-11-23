'use client'

import { useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { HelpPopover } from '@/components/ui/help-popover'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { parseDecimalInput } from '@/lib/money'
import { EU_COUNTRIES } from '@/lib/vat/eu-countries'
import { OSS_ALL_EU_COUNTRIES, isOssVatRate } from '@/lib/vat/oss-accounts'
import type { OssAccount } from '@/lib/webshop-orders/oss-underlag'

/**
 * "Konton per land" in the OSS underlag: the country, and for a sales account
 * the VAT rate, each OSS account is for. A company that books OSS sales
 * without an order feed keeps one account per country and rate; setting that
 * here is what lets the underlag place those verifikat. An account that names
 * no country yet opens with what its name states, for the reader to check
 * and save.
 */

/** The Select's value for an account that names no country. */
const NO_COUNTRY = 'none'

interface Draft {
  country: string
  rate: string
}

function rateText(rate: number | null, locale: string): string {
  return rate === null ? '' : rate.toLocaleString(locale === 'en' ? 'en-US' : 'sv-SE', { maximumFractionDigits: 2, useGrouping: false })
}

/**
 * "19", "25,5" or "25.5" as a rate in percent; null when empty or not a
 * rate. Read as typed, never rounded: a third decimal is not a rate, and the
 * field says so instead of saving another one.
 */
function parseRate(text: string): number | null {
  const rate = parseDecimalInput(text)
  return isOssVatRate(rate) ? rate : null
}

function draftOf(account: OssAccount, locale: string): Draft {
  return {
    country: account.country ?? account.suggested_country ?? NO_COUNTRY,
    rate: rateText(account.vat_rate ?? account.suggested_vat_rate, locale),
  }
}

export function OssAccountsSection({ accounts, onSaved }: { accounts: OssAccount[]; onSaved: () => void }) {
  const t = useTranslations('oss_underlag')
  const locale = useLocale()
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(accounts.map((account) => [account.account_number, draftOf(account, locale)])),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const countries = useMemo(() => {
    const names = new Intl.DisplayNames([locale === 'en' ? 'en' : 'sv'], { type: 'region' })
    return EU_COUNTRIES.filter((country) => country.code !== 'SE')
      .map((country) => ({ code: country.code, name: names.of(country.code) ?? country.code }))
      .sort((a, b) => a.name.localeCompare(b.name, locale === 'en' ? 'en' : 'sv'))
  }, [locale])

  /** What each account would be saved as, and whether that differs from what it names now. */
  const rows = accounts.map((account) => {
    const draft = drafts[account.account_number]
    const country = draft.country === NO_COUNTRY ? null : draft.country
    const rate = account.kind === 'sales' && country !== null ? parseRate(draft.rate) : null
    const rateMissing = account.kind === 'sales' && country !== null && rate === null
    const changed = country !== account.country || rate !== account.vat_rate
    return { account, draft, country, rate, rateMissing, changed }
  })
  const changes = rows.filter((row) => row.changed)
  const canSave = changes.length > 0 && !changes.some((row) => row.rateMissing)

  const setDraft = (accountNumber: string, patch: Partial<Draft>) => {
    setError(null)
    setDrafts((current) => ({ ...current, [accountNumber]: { ...current[accountNumber], ...patch } }))
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/bookkeeping/accounts/oss-countries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accounts: changes.map((row) => ({
            account_number: row.account.account_number,
            country: row.country,
            ...(row.account.kind === 'sales' ? { vat_rate: row.rate } : {}),
          })),
        }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        setError(getErrorMessage(json, { statusCode: res.status, locale: locale as ErrorLocale }))
        return
      }
      onSaved()
    } catch {
      setError(t('accounts_save_failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">{t('heading_accounts')}</CardTitle>
          <HelpPopover>{t('accounts_help')}</HelpPopover>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('col_account')}</TableHead>
              <TableHead>{t('col_account_name')}</TableHead>
              <TableHead>{t('col_country')}</TableHead>
              <TableHead>{t('col_rate')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ account, draft, country, rateMissing }) => (
              <TableRow key={account.account_number}>
                <TableCell className="font-mono tabular-nums">{account.account_number}</TableCell>
                <TableCell className="max-w-64 truncate">{account.account_name}</TableCell>
                <TableCell>
                  <Select value={draft.country} onValueChange={(value) => setDraft(account.account_number, { country: value })}>
                    <SelectTrigger className="w-48" aria-label={t('country_label', { account: account.account_number })}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_COUNTRY}>{t('country_none')}</SelectItem>
                      {account.kind === 'vat' && <SelectItem value={OSS_ALL_EU_COUNTRIES}>{t('country_all_eu')}</SelectItem>}
                      {countries.map((option) => (
                        <SelectItem key={option.code} value={option.code}>
                          {option.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell>
                  {account.kind === 'sales' ? (
                    <div className="flex items-center gap-1.5">
                      <Input
                        className="w-20 text-right tabular-nums"
                        inputMode="decimal"
                        value={draft.rate}
                        disabled={country === null}
                        aria-invalid={rateMissing || undefined}
                        aria-label={t('rate_label', { account: account.account_number })}
                        onChange={(event) => setDraft(account.account_number, { rate: event.target.value })}
                      />
                      <span className="text-muted-foreground">%</span>
                    </div>
                  ) : (
                    <span className="text-muted-foreground">{t('rate_follows_sale')}</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {account.blocks_vouchers ? (
                    <Badge variant="warning">{t('account_missing')}</Badge>
                  ) : account.country === null ? (
                    <span className="text-xs text-muted-foreground">{t('account_suggested')}</span>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="flex items-center justify-end gap-3">
          {error && (
            <p role="alert" className="mr-auto min-w-0 text-[13px] text-destructive">
              {error}
            </p>
          )}
          <Button variant="outline" onClick={save} disabled={!canSave} loading={saving}>
            {t('accounts_save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
