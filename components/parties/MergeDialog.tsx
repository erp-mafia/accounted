'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { Register, RegisterRow } from '@/lib/parties/register'
import { formatOrgNumber } from '@/lib/utils'

export interface MergeCandidate {
  id: string
  displayName: string
  orgNumber: string | null
  status: string
}

/**
 * Merge with a visible survivor that can be swapped. Everything merged keeps
 * its rows; the survivor gains the aliases. Undo lives on the toast.
 */
export function MergeDialog({
  open,
  onOpenChange,
  subject,
  suggested,
  busy,
  onMerge,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  subject: MergeCandidate
  suggested: MergeCandidate[]
  busy: boolean
  onMerge: (survivorId: string, mergedIds: string[]) => Promise<void>
}) {
  const t = useTranslations('parties')
  const [picked, setPicked] = useState<Set<string>>(new Set(suggested.map((s) => s.id)))
  const [survivor, setSurvivor] = useState<string>(subject.id)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<MergeCandidate[]>([])

  useEffect(() => {
    if (!open) return
    setPicked(new Set(suggested.map((s) => s.id)))
    setSurvivor(subject.id)
    setQuery('')
    setFound([])
  }, [open, subject.id, suggested])

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setFound([])
      return
    }
    const ctrl = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/parties?view=all&q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        if (!res.ok) return
        const json = (await res.json()) as { data: Register }
        setFound(
          json.data.rows
            .filter((r: RegisterRow) => r.id !== subject.id)
            .slice(0, 8)
            .map((r: RegisterRow) => ({ id: r.id, displayName: r.displayName, orgNumber: r.orgNumber, status: r.status })),
        )
      } catch {
        // aborted or offline: the list simply does not update
      }
    }, 250)
    return () => {
      clearTimeout(timer)
      ctrl.abort()
    }
  }, [query, subject.id])

  const candidates = useMemo(() => {
    const seen = new Set<string>()
    const out: MergeCandidate[] = []
    for (const c of [...suggested, ...found]) {
      if (seen.has(c.id) || c.id === subject.id) continue
      seen.add(c.id)
      out.push(c)
    }
    return out
  }, [suggested, found, subject.id])

  const members = [subject, ...candidates.filter((c) => picked.has(c.id))]
  const mergedIds = members.filter((m) => m.id !== survivor).map((m) => m.id)

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
        if (survivor === id) setSurvivor(subject.id)
      } else next.add(id)
      return next
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('merge_dialog_title')}</DialogTitle>
          <DialogDescription>{t('merge_body')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <ul className="divide-y divide-border rounded-lg border border-border">
            {[subject, ...candidates].map((c) => {
              const isSubject = c.id === subject.id
              const included = isSubject || picked.has(c.id)
              return (
                <li key={c.id} className="flex items-center gap-3 px-4 py-3 text-[13px]">
                  <Checkbox
                    checked={included}
                    disabled={isSubject}
                    onCheckedChange={() => toggle(c.id)}
                    aria-label={c.displayName}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{c.displayName}</div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      {c.orgNumber ? formatOrgNumber(c.orgNumber) : ''}
                      {c.status === 'suggested' ? (c.orgNumber ? ' · ' : '') + t('view_suggested') : ''}
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="radio"
                      name="party-survivor"
                      className="h-4 w-4 accent-foreground"
                      checked={survivor === c.id}
                      disabled={!included}
                      onChange={() => setSurvivor(c.id)}
                    />
                    {survivor === c.id ? t('merge_kept') : t('merge_keep')}
                  </label>
                </li>
              )
            })}
          </ul>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('merge_search_placeholder')}
            aria-label={t('merge_search_placeholder')}
          />
          {candidates.length === 0 && query.trim().length >= 2 ? (
            <p className="text-xs text-muted-foreground">{t('merge_none')}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('deselect')}
          </Button>
          <Button type="button" onClick={() => void onMerge(survivor, mergedIds)} disabled={busy || mergedIds.length === 0}>
            {t('merge_confirm', { count: mergedIds.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
