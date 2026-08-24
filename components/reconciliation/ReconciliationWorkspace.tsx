'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Scale } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { EmptyState } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { Skeleton } from '@/components/ui/skeleton'
import type { ReconciliationAccount } from '@/lib/reconciliation/schemas'
import { ReconciliationRail } from './ReconciliationRail'
import { AccountOverview } from './AccountOverview'

/**
 * /reconciliation: one page for every account with an outside truth. The
 * rail on the left lists the accounts (bank accounts, the skattekonto) with
 * their status; the body shows the selected account's bridge and the rows
 * behind it. Selection lives in the URL (?account=) so a link lands on the
 * right account and a reload keeps it.
 */
export function ReconciliationWorkspace() {
  const t = useTranslations('reconciliation')
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [accounts, setAccounts] = useState<ReconciliationAccount[] | null>(null)
  const [loadError, setLoadError] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/reconciliation/accounts')
      setLoadError(false)
      if (!res.ok) {
        setLoadError(true)
        return
      }
      const json = await res.json()
      setAccounts((json.data?.accounts ?? []) as ReconciliationAccount[])
    } catch {
      setLoadError(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const requestedKey = searchParams.get('account')
  const selected = useMemo(() => {
    if (!accounts || accounts.length === 0) return null
    return (
      accounts.find((a) => a.account_key === requestedKey) ??
      accounts.find((a) => !a.superseded_by) ??
      accounts[0]
    )
  }, [accounts, requestedKey])

  const select = useCallback(
    (accountKey: string) => {
      const params = new URLSearchParams(searchParams.toString())
      params.set('account', accountKey)
      router.replace(`${pathname}?${params.toString()}`, { scroll: false })
    },
    [pathname, router, searchParams],
  )

  const header = (
    <PageHeader
      title={t('title')}
      help={
        <HelpPopover>
          <p>{t('help_text')}</p>
        </HelpPopover>
      }
    />
  )

  if (loadError) {
    return (
      <div className="space-y-6">
        {header}
        <AttnLine action={{ label: t('older_show'), onClick: () => void load() }}>{t('load_failed')}</AttnLine>
      </div>
    )
  }

  if (accounts === null) {
    return (
      <div className="space-y-6" aria-busy>
        {header}
        <div className="grid gap-8 lg:grid-cols-[220px_1fr]">
          <div className="space-y-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    )
  }

  if (accounts.length === 0) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState
          icon={Scale}
          title={t('empty_title')}
          description={t('empty_body')}
          actionLabel={t('empty_connect_bank')}
          actionHref="/settings/banking"
          secondaryActionLabel={t('empty_connect_skv')}
          secondaryActionHref="/settings/skatteverket"
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {header}
      <div className="grid gap-8 lg:grid-cols-[220px_1fr]">
        <ReconciliationRail accounts={accounts} selectedKey={selected?.account_key ?? null} onSelect={select} />
        <div className="min-w-0">
          {selected && <AccountOverview key={selected.account_key} account={selected} onChanged={() => void load()} />}
        </div>
      </div>
    </div>
  )
}
