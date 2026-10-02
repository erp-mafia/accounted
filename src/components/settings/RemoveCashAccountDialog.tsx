'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'

interface RemovalPreview {
  transactions: number
  underlag: number
}

type RemovalState =
  | { kind: 'checking' }
  | { kind: 'ready'; preview: RemovalPreview }
  | { kind: 'refused'; message: string }

interface Props {
  /** The account to remove; null keeps the dialog closed. */
  account: { id: string; label: string } | null
  onClose: () => void
  /** After the account is gone: refresh whatever lists it. */
  onRemoved: () => unknown
}

/**
 * "Ta bort konto" (#3130): remove a bank account that never became
 * bookkeeping, with its unbooked transactions. The dialog first asks the
 * server's dry run, the same check the removal itself runs, so what it shows
 * is either the outcome ("Kontot och dess 162 obokförda transaktioner tas
 * bort") or the reason it cannot go, with the way out when there is one.
 * There is no second copy of the rule here.
 */
export function RemoveCashAccountDialog({ account, onClose, onRemoved }: Props) {
  if (!account) return null
  // Keyed by account: each opening starts from a fresh check.
  return <RemoveCashAccountBody key={account.id} account={account} onClose={onClose} onRemoved={onRemoved} />
}

function RemoveCashAccountBody({
  account,
  onClose,
  onRemoved,
}: {
  account: { id: string; label: string }
  onClose: () => void
  onRemoved: () => unknown
}) {
  const t = useTranslations('settings_voucher_series')
  const tCommon = useTranslations('common')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [state, setState] = useState<RemovalState>({ kind: 'checking' })
  const [pending, setPending] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/cash-accounts/${account.id}?dry_run=true`, { method: 'DELETE' })
      .then(async (res) => {
        const json = await res.json().catch(() => null)
        if (cancelled) return
        if (res.ok && json?.data) {
          setState({
            kind: 'ready',
            preview: { transactions: Number(json.data.transactions ?? 0), underlag: Number(json.data.underlag ?? 0) },
          })
        } else {
          setState({
            kind: 'refused',
            message: getErrorMessage(json, { context: 'settings', statusCode: res.status, locale }),
          })
        }
      })
      .catch((err) => {
        if (!cancelled) setState({ kind: 'refused', message: getErrorMessage(err, { context: 'settings', locale }) })
      })
    return () => {
      cancelled = true
    }
  }, [account.id, locale])

  const handleRemove = async () => {
    setPending(true)
    try {
      const res = await fetch(`/api/cash-accounts/${account.id}`, { method: 'DELETE' })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        // The account changed since the check (a row got booked, a bank
        // connection claimed it): say why instead of the old preview.
        setState({ kind: 'refused', message: getErrorMessage(json, { context: 'settings', statusCode: res.status, locale }) })
        return
      }
      await onRemoved()
      toast({
        title: t('remove_done_title'),
        description: t('remove_done_body', {
          account: account.label,
          count: Number(json?.data?.deleted_transactions ?? 0),
        }),
      })
      onClose()
    } catch (err) {
      toast({
        title: t('remove_failed'),
        description: getErrorMessage(err, { context: 'settings', locale }),
        variant: 'destructive',
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="sm:min-w-[460px] sm:max-w-md">
        <DialogHeader>
          {/* data-ph-mask: the title names the account (user data). */}
          <DialogTitle data-ph-mask="" className="font-display text-lg tracking-tight">
            {state.kind === 'refused'
              ? t('remove_refused_title', { account: account.label })
              : t('remove_confirm_title', { account: account.label })}
          </DialogTitle>
          {state.kind === 'checking' ? (
            <DialogDescription className="sr-only">{t('remove_checking')}</DialogDescription>
          ) : (
            <DialogDescription data-ph-mask="" className="text-[13px] leading-relaxed">
              {state.kind === 'refused' ? (
                state.message
              ) : (
                <>
                  {t('remove_confirm_body', { count: state.preview.transactions })}
                  {state.preview.underlag > 0 && <> {t('remove_confirm_underlag', { count: state.preview.underlag })}</>}
                </>
              )}
            </DialogDescription>
          )}
        </DialogHeader>
        {state.kind === 'checking' && (
          <div className="space-y-2" aria-busy>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        )}
        <DialogFooter className="gap-2 sm:gap-2">
          {state.kind === 'refused' ? (
            <Button variant="ghost" onClick={onClose}>
              {tCommon('close')}
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose} disabled={pending}>
                {tCommon('cancel')}
              </Button>
              <Button
                variant="destructive"
                onClick={() => void handleRemove()}
                loading={pending}
                disabled={state.kind !== 'ready'}
              >
                {t('remove_confirm_action')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
