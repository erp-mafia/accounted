'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AttnLine } from '@/components/ui/attn-line'
import { HelpPopover } from '@/components/ui/help-popover'
import { Skeleton } from '@/components/ui/skeleton'
import { BankMark } from '@/components/banks/BankMark'
import { useToast } from '@/components/ui/use-toast'
import { useBasReference } from '@/lib/bookkeeping/use-bas-reference'
import { getBasLoadedByNumber } from '@/lib/bookkeeping/bas-lazy'
import {
  CARD_LEDGER_ORDER,
  isCardLedgerAccount,
  suggestCardLedger,
  type CardLedgerUsage,
} from '@/lib/cash-accounts/card-ledger'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { useCashAccounts } from '@/lib/reference-data/hooks'
import { formatCurrency } from '@/lib/utils'
import { CARD_ISSUERS, CURRENCIES, type CardIssuer, type CashAccount } from '@/types'

/**
 * Lägg till företagskort (accounts_v2 > Lägg till konto > Företagskort): a
 * company card as a cash account of kind 'card'. The statement's purchases
 * book against the card's own liability account, one verifikat each, and the
 * monthly payment from the bank clears it (lib/cash-accounts/card-ledger.ts).
 *
 * The ledger is prefilled with the first card account no other account holds
 * and no verifikat uses (2890 only when unused); one ochre sentence says why
 * when 2890 was skipped, and offers it for a company whose 2890 already holds
 * this card's debt. No verifikat is created, so the dialog is the
 * confirmation. On success it goes straight to the import with the card
 * preselected.
 */

/** The issuers' display names are brand names, the same in both locales. */
const ISSUER_NAMES: Record<Exclude<CardIssuer, 'other'>, string> = {
  eurocard: 'Eurocard (AirPlus)',
  seb_kort: 'SEB Kort',
  amex: 'American Express',
  handelsbanken: 'Handelsbanken',
  first_card: 'Nordea First Card',
  danske: 'Danske Bank',
  swedbank: 'Swedbank',
  qred: 'Qred',
  mynt: 'Mynt',
  pleo: 'Pleo',
}

/** What the name field starts as: the issuer's short name. */
const ISSUER_SHORT: Record<Exclude<CardIssuer, 'other'>, string> = {
  eurocard: 'Eurocard',
  seb_kort: 'SEB Kort',
  amex: 'Amex',
  handelsbanken: 'Handelsbanken',
  first_card: 'First Card',
  danske: 'Danske Bank',
  swedbank: 'Swedbank',
  qred: 'Qred',
  mynt: 'Mynt',
  pleo: 'Pleo',
}

/** The bank whose mark stands for the issuer (BankMark), when it has one. */
const ISSUER_MARK: Partial<Record<CardIssuer, string>> = {
  seb_kort: 'SEB',
  handelsbanken: 'Handelsbanken',
  first_card: 'Nordea',
  danske: 'Danske Bank',
  swedbank: 'Swedbank',
}

/** The ledgers the picker offers: the four 289x accounts and the first kontokredit. */
const OFFERED_LEDGERS = CARD_LEDGER_ORDER.slice(0, 5)

interface LedgerState {
  /** Ledger to the name of the cash account that holds it. */
  taken: Map<string, string>
  usage: Record<string, CardLedgerUsage>
}

type LedgerUsage = LedgerState['usage']

interface AddCardAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the new card; the default goes on to the import. */
  onCreated?: (card: CashAccount) => void
  /** Preloaded ledger facts (the sandbox render); fetched when absent. */
  initialLedgerState?: LedgerState
}

function parseLast4(value: string): string[] | null {
  const parts = value.split(/[\s,;]+/).map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) return []
  return parts.every((part) => part.length === 4 && /^\d+$/.test(part)) ? [...new Set(parts)] : null
}

function todayInStockholm(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date())
}

/** What the company already books on each card ledger candidate, with the saldo of the used ones. */
async function loadLedgerUsage(): Promise<LedgerUsage> {
  const usageRes = await fetch('/api/bookkeeping/accounts/usage')
  if (!usageRes.ok) throw new Error('ledger usage unavailable')
  const usageRows = ((await usageRes.json()).data ?? []) as { account_number: string; usage_count: number }[]
  const usage: LedgerUsage = {}
  for (const row of usageRows) {
    if (isCardLedgerAccount(row.account_number)) usage[row.account_number] = { lines: Number(row.usage_count) || 0 }
  }
  // The saldo of each used candidate, for the sentence that explains the pick.
  const used = Object.keys(usage)
  if (used.length > 0) {
    const balancesRes = await fetch(
      `/api/bookkeeping/account-balances?accounts=${used.join(',')}&as_of=${todayInStockholm()}`,
    )
    if (balancesRes.ok) {
      const rows = ((await balancesRes.json()).data ?? []) as { account_number: string; balance: number }[]
      for (const row of rows) {
        if (usage[row.account_number]) usage[row.account_number].balance = Number(row.balance) || 0
      }
    }
  }
  return usage
}

export default function AddCardAccountDialog({
  open,
  onOpenChange,
  onCreated,
  initialLedgerState,
}: AddCardAccountDialogProps) {
  const t = useTranslations('card_accounts')
  const tCommon = useTranslations('common')
  const locale = useLocale()
  const router = useRouter()
  const { toast } = useToast()
  const basReady = useBasReference()

  const [issuer, setIssuer] = useState<CardIssuer | ''>('')
  const [name, setName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [last4, setLast4] = useState('')
  const [currency, setCurrency] = useState<string>('SEK')
  const [ledger, setLedger] = useState<string>('')
  const [voucherSeries, setVoucherSeries] = useState('')
  // Every ledger a cash account holds (any kind, enabled or not: the
  // (company, ledger) pair is unique), from the shared reference cache.
  const { cashAccounts, isLoading: cashAccountsLoading } = useCashAccounts()
  const [usage, setUsage] = useState<LedgerUsage | null>(initialLedgerState?.usage ?? null)
  const [loadFailed, setLoadFailed] = useState(false)
  const ledgerState = useMemo<LedgerState | null>(() => {
    if (initialLedgerState) return initialLedgerState
    if (!usage || cashAccountsLoading) return null
    return {
      taken: new Map(cashAccounts.map((account) => [account.ledger_account, account.name ?? account.ledger_account])),
      usage,
    }
  }, [initialLedgerState, usage, cashAccounts, cashAccountsLoading])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A used ledger the person confirmed holds this card's debt.
  const [confirmedLedger, setConfirmedLedger] = useState<string | null>(null)

  useEffect(() => {
    if (!open || initialLedgerState) return
    let cancelled = false
    loadLedgerUsage()
      .then((next) => { if (!cancelled) { setUsage(next); setLoadFailed(false) } })
      .catch(() => { if (!cancelled) setLoadFailed(true) })
    return () => { cancelled = true }
  }, [open, initialLedgerState])

  const suggestion = useMemo(
    () => (ledgerState ? suggestCardLedger({ taken: ledgerState.taken.keys(), usage: ledgerState.usage }) : null),
    [ledgerState],
  )

  // Prefill the ledger once the facts are in; the person may change it after.
  useEffect(() => {
    if (suggestion?.ledger && !ledger) setLedger(suggestion.ledger)
  }, [suggestion, ledger])

  const pickIssuer = (value: CardIssuer) => {
    setIssuer(value)
    if (!nameEdited) setName(value === 'other' ? '' : `${ISSUER_SHORT[value]} ${t('name_suffix')}`)
  }

  const offered = useMemo(() => {
    const list = [...OFFERED_LEDGERS]
    if (ledger && !list.includes(ledger)) list.push(ledger)
    return list
  }, [ledger])

  const ledgerName = (account: string) => (basReady ? getBasLoadedByNumber(account)?.account_name : undefined)
  const money = (amount: number) => formatCurrency(Math.abs(amount))

  const last4Parsed = parseLast4(last4)
  const selectedUsage = ledger ? ledgerState?.usage[ledger] : undefined
  const firstFreeUnused = ledgerState
    ? CARD_LEDGER_ORDER.find((account) => !ledgerState.taken.has(account) && !ledgerState.usage[account]?.lines)
    : undefined

  // One ochre sentence at most: why the suggestion skipped 2890, or why the
  // chosen ledger will not reconcile on its own.
  let attention: { text: string; action?: { label: string; onClick: () => void } } | null = null
  if (ledger && selectedUsage && selectedUsage.lines > 0 && ledger !== confirmedLedger) {
    const free = firstFreeUnused && firstFreeUnused !== ledger ? firstFreeUnused : null
    attention = free
      ? {
          text: selectedUsage.balance
            ? t('ledger_has_balance', { ledger, balance: money(selectedUsage.balance), free })
            : t('ledger_in_use', { ledger, free }),
          action: { label: t('use_ledger', { ledger: free }), onClick: () => setLedger(free) },
        }
      : { text: t('ledger_no_free', { ledger }) }
  } else if (suggestion?.skipped && ledger === suggestion.ledger && suggestion.skipped.ledger !== ledger) {
    const skipped = suggestion.skipped
    attention = {
      text: skipped.balance
        ? t('ledger_skipped_balance', { skipped: skipped.ledger, balance: money(skipped.balance), ledger })
        : t('ledger_skipped', { skipped: skipped.ledger, ledger }),
      // The company already keeps this card's debt there: take it, and do not
      // warn about the balance the person just said is the card's.
      action: {
        label: t('use_skipped', { ledger: skipped.ledger }),
        onClick: () => { setConfirmedLedger(skipped.ledger); setLedger(skipped.ledger) },
      },
    }
  }

  const canSubmit =
    !!issuer && name.trim().length > 0 && !!ledger && last4Parsed !== null &&
    (voucherSeries === '' || /^[A-Z]$/.test(voucherSeries)) && !submitting

  const reset = () => {
    setIssuer('')
    setName('')
    setNameEdited(false)
    setLast4('')
    setCurrency('SEK')
    setLedger('')
    setVoucherSeries('')
    setConfirmedLedger(null)
    setError(null)
    if (!initialLedgerState) setUsage(null)
  }

  const submit = async () => {
    if (!canSubmit || !issuer) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/cash-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'card',
          name: name.trim(),
          currency,
          card_issuer: issuer,
          ledger_account: ledger,
          ...(last4Parsed && last4Parsed.length > 0 ? { card_last4: last4Parsed } : {}),
          ...(voucherSeries ? { voucher_series: voucherSeries } : {}),
        }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        setError(getErrorMessage(body, { statusCode: res.status, locale: locale === 'en' ? 'en' : 'sv' }))
        return
      }
      const card = body.data as CashAccount
      // Every picker (the import's target, the transactions source) sees the
      // card at once, and the chart the ledger row it may have gained.
      void invalidateReferenceData(['ref:cash-accounts', 'ref:accounts'])
      toast({ title: t('created_toast', { name: card.name ?? name.trim() }) })
      reset()
      onOpenChange(false)
      if (onCreated) onCreated(card)
      else router.push(`/import?mode=bank&account=${card.id}`)
    } catch (err) {
      setError(getErrorMessage(err, { locale: locale === 'en' ? 'en' : 'sv' }))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next) }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="card-issuer">{t('issuer_label')}</Label>
            <Select value={issuer} onValueChange={(value) => pickIssuer(value as CardIssuer)}>
              <SelectTrigger id="card-issuer">
                <SelectValue placeholder={t('issuer_placeholder')} />
              </SelectTrigger>
              <SelectContent>
                {CARD_ISSUERS.map((value) => (
                  <SelectItem key={value} value={value}>
                    <span className="flex items-center gap-2">
                      {ISSUER_MARK[value] && <BankMark bankName={ISSUER_MARK[value]} size={18} />}
                      {value === 'other' ? t('issuer_other') : ISSUER_NAMES[value]}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
            <div className="min-w-0 space-y-2">
              <Label htmlFor="card-name">{t('name_label')}</Label>
              <Input
                id="card-name"
                value={name}
                maxLength={100}
                onChange={(e) => { setName(e.target.value); setNameEdited(true) }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="card-currency">{t('currency_label')}</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger id="card-currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((code) => (
                    <SelectItem key={code} value={code}>{code}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
            <div className="min-w-0 space-y-2">
              <Label htmlFor="card-last4">{t('last4_label')}</Label>
              <Input
                id="card-last4"
                value={last4}
                inputMode="numeric"
                className="tabular-nums"
                aria-invalid={last4Parsed === null}
                onChange={(e) => setLast4(e.target.value.replace(/[^\d,;\s]/g, ''))}
              />
              <div className="text-[12.5px] text-muted-foreground">
                {last4Parsed === null ? <span className="text-destructive">{t('last4_invalid')}</span> : t('last4_hint')}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="card-series">{t('voucher_series_label')}</Label>
              <Input
                id="card-series"
                value={voucherSeries}
                maxLength={1}
                placeholder={t('voucher_series_hint')}
                className="uppercase placeholder:normal-case"
                onChange={(e) => setVoucherSeries(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Label htmlFor="card-ledger">{t('ledger_label')}</Label>
              <HelpPopover>{t('ledger_help')}</HelpPopover>
            </div>
            {ledgerState ? (
              <Select value={ledger} onValueChange={setLedger}>
                <SelectTrigger id="card-ledger" className="tabular-nums">
                  <SelectValue placeholder={t('ledger_placeholder')} />
                </SelectTrigger>
                <SelectContent>
                  {offered.map((account) => {
                    const holder = ledgerState.taken.get(account)
                    const label = ledgerName(account)
                    return (
                      <SelectItem key={account} value={account} disabled={!!holder}>
                        <span className="tabular-nums">{account}</span>
                        {label && <span className="text-muted-foreground"> {label}</span>}
                        {holder && <span className="text-muted-foreground"> {t('ledger_taken', { name: holder })}</span>}
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            ) : loadFailed ? (
              <div className="text-[12.5px] text-destructive">{t('load_failed')}</div>
            ) : (
              <Skeleton className="h-9 w-full rounded-lg" />
            )}
            <div className="text-[12.5px] text-muted-foreground">{t('ledger_hint')}</div>
            {attention && <AttnLine action={attention.action}>{attention.text}</AttnLine>}
            {suggestion && suggestion.ledger === null && <AttnLine>{t('no_free_ledger')}</AttnLine>}
          </div>

          {error && <div className="text-[13px] text-destructive" role="alert">{error}</div>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {tCommon('cancel')}
          </Button>
          <Button onClick={submit} disabled={!canSubmit} loading={submitting}>
            {t('submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
