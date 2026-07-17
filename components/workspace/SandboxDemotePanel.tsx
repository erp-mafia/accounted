'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { AlertTriangle, Loader2, FlaskConical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'

interface Props {
  onDone: () => void
  defaultLimit?: number
}

export function SandboxDemotePanel({ onDone, defaultLimit = 50 }: Props) {
  const t = useTranslations('pending')
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const limit = defaultLimit

  async function runDemote() {
    setLoading(true)
    try {
      const res = await fetch('/api/workspace/demote-sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast({
          title: 'Kunde inte flytta',
          description: getErrorMessage(json, { statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      const demoted = Number(json?.data?.demoted ?? 0)
      toast({
        title: demoted > 0 ? `Flyttade ${demoted} verifikat till utkast` : 'Inga verifikat att flytta',
        description:
          demoted > 0
            ? 'De syns nu under Verifikationsutkast. Fastställ när du är redo.'
            : 'Inga postade verifikat i öppen period som är sista i serien.',
      })
      setOpen(false)
      onDone()
    } catch (err) {
      toast({
        title: 'Kunde inte flytta',
        description: getErrorMessage(err),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <div className="rounded-xl border border-amber-300/60 bg-amber-50/50 dark:bg-amber-950/20 p-4 space-y-3">
        <div className="flex items-start gap-3">
          <FlaskConical className="h-5 w-5 text-amber-700 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="space-y-1 min-w-0">
            <p className="text-sm font-medium">{t('sandbox_demote_title')}</p>
            <p className="text-sm text-muted-foreground">{t('sandbox_demote_body')}</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          {t('sandbox_demote_button', { count: limit })}
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('sandbox_demote_title')}</DialogTitle>
            <DialogDescription>{t('sandbox_demote_confirm', { count: limit })}</DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-2 rounded-lg bg-warning/10 border border-warning/30 p-3">
            <AlertTriangle className="h-4 w-4 text-warning-foreground mt-0.5 shrink-0" />
            <p className="text-sm text-warning-foreground">{t('sandbox_demote_body')}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>
              Avbryt
            </Button>
            <Button onClick={runDemote} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              {t('sandbox_demote_button', { count: limit })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
