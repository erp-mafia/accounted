'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, Search, Trash2 } from 'lucide-react'

interface PruneCandidate {
  account_number: string
  account_name: string
  account_class: number
  plan_type: string | null
  is_active: boolean
  in_bas_reference: boolean
}

interface PruneAccountsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a successful prune so the parent can refetch the chart. */
  onPruned: () => void
}

/**
 * Bulk deletion of unused accounts. Fetches the server-computed deletable set
 * (dry run) and presents it in two groups — imported/custom accounts and
 * untouched accounts from the seeded base plan. Nothing is preselected:
 * deletion is opt-in per account or per group. Used accounts never appear
 * here; the server re-verifies every guard at execute time anyway.
 */
export function PruneAccountsDialog({ open, onOpenChange, onPruned }: PruneAccountsDialogProps) {
  const t = useTranslations('chart_of_accounts')
  const tCommon = useTranslations('common')
  const { toast } = useToast()

  const [loading, setLoading] = useState(false)
  const [candidates, setCandidates] = useState<PruneCandidate[]>([])
  const [usedCount, setUsedCount] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [isDeleting, setIsDeleting] = useState(false)

  // Grouping only: imported/manually added accounts (the typical cleanup
  // target) are listed separately from unused accounts in the seeded base
  // plan, so users see what came from an import at a glance.
  const isImportedOrCustom = useCallback(
    (c: PruneCandidate) => !c.in_bas_reference || c.plan_type === 'full_bas',
    [],
  )

  useEffect(() => {
    if (!open) return
    let cancelled = false
    async function load() {
      setLoading(true)
      setCandidates([])
      setSelected(new Set())
      setSearchQuery('')
      try {
        const res = await fetch('/api/bookkeeping/accounts/prune', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dry_run: true }),
        })
        if (!res.ok) throw new Error()
        const { data } = await res.json()
        if (cancelled) return
        const deletable: PruneCandidate[] = data?.deletable ?? []
        setCandidates(deletable)
        setUsedCount((data?.used ?? []).length)
        // Nothing starts selected — deletion is opt-in per account (or per
        // group via the header checkbox), never a preloaded default.
      } catch {
        if (!cancelled) {
          toast({ title: t('toast_prune_failed'), variant: 'destructive' })
          onOpenChange(false)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [open, onOpenChange, t, toast])

  // Charts bloated by an import easily reach hundreds of candidates — filter
  // by number or name, same semantics as the kontoplan page search. Selection
  // is keyed by account number, so it survives filter changes; the confirm
  // button always shows the true selected count.
  const filteredCandidates = useMemo(() => {
    if (!searchQuery) return candidates
    const q = searchQuery.toLowerCase()
    return candidates.filter(
      (c) => c.account_number.includes(q) || c.account_name.toLowerCase().includes(q),
    )
  }, [candidates, searchQuery])

  const customGroup = useMemo(
    () => filteredCandidates.filter(isImportedOrCustom),
    [filteredCandidates, isImportedOrCustom],
  )
  const seedGroup = useMemo(
    () => filteredCandidates.filter((c) => !isImportedOrCustom(c)),
    [filteredCandidates, isImportedOrCustom],
  )

  function toggleAccount(accountNumber: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(accountNumber)) {
        next.delete(accountNumber)
      } else {
        next.add(accountNumber)
      }
      return next
    })
  }

  function toggleGroup(group: PruneCandidate[], checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const c of group) {
        if (checked) {
          next.add(c.account_number)
        } else {
          next.delete(c.account_number)
        }
      }
      return next
    })
  }

  async function handlePrune() {
    if (selected.size === 0) return
    setIsDeleting(true)
    try {
      const res = await fetch('/api/bookkeeping/accounts/prune', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dry_run: false, account_numbers: [...selected] }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.error)
      const deleted: string[] = body?.data?.deleted ?? []
      const skipped: string[] = [
        ...(body?.data?.skipped ?? []),
        ...(body?.data?.not_found ?? []),
      ]
      toast({
        title: t('toast_pruned_title'),
        description:
          skipped.length > 0
            ? t('toast_pruned_with_skipped', { deleted: deleted.length, skipped: skipped.length })
            : t('toast_pruned_description', { deleted: deleted.length }),
      })
      onPruned()
      onOpenChange(false)
    } catch (err) {
      toast({
        title: err instanceof Error && err.message ? err.message : t('toast_prune_failed'),
        variant: 'destructive',
      })
    } finally {
      setIsDeleting(false)
    }
  }

  function renderGroup(group: PruneCandidate[], titleKey: 'prune_group_custom' | 'prune_group_seed', hintKey: 'prune_group_custom_hint' | 'prune_group_seed_hint') {
    if (group.length === 0) return null
    const allChecked = group.every((c) => selected.has(c.account_number))
    return (
      <div className="space-y-2">
        <div className="flex items-start gap-3">
          <Checkbox
            checked={allChecked}
            onCheckedChange={(checked) => toggleGroup(group, checked === true)}
            className="mt-1"
            aria-label={t(titleKey)}
          />
          <div>
            <p className="text-sm font-medium">
              {t(titleKey)}{' '}
              <span className="text-muted-foreground tabular-nums">({group.length})</span>
            </p>
            <p className="text-xs text-muted-foreground">{t(hintKey)}</p>
          </div>
        </div>
        <div className="w-full rounded-lg border border-border divide-y divide-border">
          {group.map((c) => (
            <label
              key={c.account_number}
              className="flex min-w-0 items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-secondary/60 transition-colors duration-150"
            >
              <Checkbox
                checked={selected.has(c.account_number)}
                onCheckedChange={() => toggleAccount(c.account_number)}
              />
              <span className="font-mono tabular-nums text-muted-foreground w-14 shrink-0">
                {c.account_number}
              </span>
              <span className="min-w-0 flex-1 truncate">{c.account_name}</span>
              {!c.is_active && (
                <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground shrink-0">
                  {t('prune_inactive_badge')}
                </span>
              )}
            </label>
          ))}
        </div>
      </div>
    )
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !isDeleting && onOpenChange(v)}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('prune_title')}</DialogTitle>
          <DialogDescription>{t('prune_description')}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
            {t('prune_loading')}
          </div>
        ) : candidates.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t('prune_empty')}</p>
        ) : (
          // min-w-0: DialogContent is a grid, and grid items default to
          // min-width auto — without this, the nowrap (truncate) account
          // names propagate their full width up and blow the dialog open
          // horizontally instead of truncating.
          <div className="min-w-0 space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t('search_placeholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <div className="space-y-4 max-h-[60vh] overflow-y-auto overflow-x-hidden pr-1">
              {filteredCandidates.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">{t('no_matches')}</p>
              ) : (
                <>
                  {renderGroup(customGroup, 'prune_group_custom', 'prune_group_custom_hint')}
                  {renderGroup(seedGroup, 'prune_group_seed', 'prune_group_seed_hint')}
                </>
              )}
              {usedCount > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('prune_used_note', { count: usedCount })}
                </p>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isDeleting}>
            {tCommon('cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={handlePrune}
            disabled={loading || isDeleting || selected.size === 0}
          >
            {isDeleting ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            )}
            {t('prune_confirm', { count: selected.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
