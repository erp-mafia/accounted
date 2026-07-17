'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { AlertTriangle, BookOpen, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { formatCurrency, formatDate } from '@/lib/utils'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { WorkspaceItem } from '@/lib/workspace/types'

interface Props {
  drafts: WorkspaceItem[]
  onPosted: () => void
}

export function WorkspaceDraftsSection({ drafts, onPosted }: Props) {
  const t = useTranslations('pending')
  const { toast } = useToast()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [postingId, setPostingId] = useState<string | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkLoading, setBulkLoading] = useState(false)

  async function postOne(id: string) {
    setPostingId(id)
    try {
      const res = await fetch(`/api/bookkeeping/journal-entries/${id}/commit`, {
        method: 'POST',
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast({
          title: 'Kunde inte fastställa',
          description: getErrorMessage(json, { context: 'journal_entry', statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      toast({ title: 'Fastställd i huvudboken' })
      onPosted()
    } catch (err) {
      toast({
        title: 'Kunde inte fastställa',
        description: getErrorMessage(err, { context: 'journal_entry' }),
        variant: 'destructive',
      })
    } finally {
      setPostingId(null)
    }
  }

  async function postSelected() {
    setBulkLoading(true)
    const ids = [...selected]
    let ok = 0
    let fail = 0
    for (const id of ids) {
      try {
        const res = await fetch(`/api/bookkeeping/journal-entries/${id}/commit`, {
          method: 'POST',
        })
        if (res.ok) ok += 1
        else fail += 1
      } catch {
        fail += 1
      }
    }
    setBulkLoading(false)
    setBulkOpen(false)
    setSelected(new Set())
    toast({
      title: `Fastställde ${ok}${fail ? `, ${fail} misslyckades` : ''}`,
    })
    onPosted()
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (drafts.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-6 text-center space-y-1">
        <p className="text-sm font-medium">{t('empty_drafts_title')}</p>
        <p className="text-sm text-muted-foreground">{t('empty_drafts_description')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium tracking-tight">{t('section_drafts')}</h2>
        {selected.size > 0 ? (
          <Button size="sm" onClick={() => setBulkOpen(true)} disabled={bulkLoading}>
            {t('faststall_selected', { count: selected.size })}
          </Button>
        ) : null}
      </div>
      <ul className="divide-y rounded-xl border bg-card">
        {drafts.map((d) => (
          <li key={d.id} className="flex items-center gap-3 px-4 py-3">
            <Checkbox
              checked={selected.has(d.id)}
              onCheckedChange={() => toggle(d.id)}
              aria-label={t('select_operation_aria')}
            />
            <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {d.href ? (
                  <Link href={d.href} className="text-sm font-medium truncate hover:underline">
                    {d.title}
                  </Link>
                ) : (
                  <span className="text-sm font-medium truncate">{d.title}</span>
                )}
                {d.stale ? (
                  <Badge variant="outline" className="text-amber-700 border-amber-300">
                    <AlertTriangle className="h-3 w-3 mr-1" />
                    30+
                  </Badge>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                {d.businessDate ? formatDate(d.businessDate) : formatDate(d.createdAt)}
                {d.amountOre != null ? ` · ${formatCurrency(d.amountOre / 100)}` : ''}
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              disabled={postingId === d.id}
              onClick={() => postOne(d.id)}
            >
              {postingId === d.id ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                t('faststall')
              )}
            </Button>
          </li>
        ))}
      </ul>

      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('faststall_selected', { count: selected.size })}</DialogTitle>
            <DialogDescription>
              Valda utkast fastställs i huvudboken med verifikationsnummer. Därefter krävs storno
              för rättelse.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkOpen(false)} disabled={bulkLoading}>
              Avbryt
            </Button>
            <Button onClick={postSelected} disabled={bulkLoading}>
              {bulkLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              {t('faststall')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
