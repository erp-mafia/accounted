'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AlertTriangle, ArrowLeft, Loader2, MoreVertical, Trash2, Undo2 } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import { periodLabelOf, type RunDetail } from './types'

const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline'> = {
  draft: 'secondary',
  review: 'warning',
  approved: 'default',
  paid: 'success',
  booked: 'success',
  corrected: 'outline',
}

interface RunHeaderProps {
  run: RunDetail
  canWrite: boolean
  actionLoading: string | null
  employeeCount: number
  onDelete: () => void
  onCorrect: () => void
}

export function RunHeader({ run, canWrite, actionLoading, employeeCount, onDelete, onCorrect }: RunHeaderProps) {
  const t = useTranslations('salary_run')
  const tSalary = useTranslations('salary')
  const [correctOpen, setCorrectOpen] = useState(false)
  const periodLabel = periodLabelOf(run)

  const statusKey = `status_${run.status}`
  const showMenu = canWrite && (run.status === 'draft' || run.status === 'booked')

  return (
    <div className="flex items-start gap-2">
      <Button variant="ghost" size="icon" asChild className="h-8 w-8 -ml-2 shrink-0">
        <Link href="/salary" aria-label={t('back_to_salary')}>
          <ArrowLeft className="h-4 w-4" />
        </Link>
      </Button>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="font-display text-2xl tracking-tight truncate">
            {t('title', { period: periodLabel })}
          </h1>
          <Badge variant={STATUS_VARIANTS[run.status] || 'secondary'} className="shrink-0">
            {tSalary(statusKey)}
          </Badge>
        </div>
        {/* Inline property row — Linear-style dot-separated metadata. */}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>
            {t('payment_date_label')} {formatDate(run.payment_date)}
          </span>
          <span aria-hidden>·</span>
          <span>{t('header_employees', { count: employeeCount })}</span>
          {run.is_correction && run.corrects_run_id && (
            <>
              <span aria-hidden>·</span>
              <Badge variant="secondary">{t('correction_badge')}</Badge>
              <Link
                href={`/salary/runs/${run.corrects_run_id}`}
                className="underline underline-offset-2 hover:text-foreground"
              >
                {t('corrects_link', { period: periodLabel })}
              </Link>
            </>
          )}
          {run.status === 'corrected' && run.corrected_by_run_id && (
            <>
              <span aria-hidden>·</span>
              <Link
                href={`/salary/runs/${run.corrected_by_run_id}`}
                className="underline underline-offset-2 hover:text-foreground"
              >
                {t('corrected_by_link')}
              </Link>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {showMenu && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={t('more_actions')}>
                {actionLoading === 'delete' || actionLoading === 'correct' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <MoreVertical className="h-4 w-4" />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {run.status === 'draft' && (
                <DropdownMenuItem
                  onClick={onDelete}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t('action_delete_draft')}
                </DropdownMenuItem>
              )}
              {run.status === 'booked' && (
                <DropdownMenuItem onClick={() => setCorrectOpen(true)}>
                  <Undo2 className="mr-2 h-4 w-4" />
                  {t('action_correct')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Correction confirm — storno per BFL 5 kap. 5 §, nothing is deleted. */}
      <Dialog open={correctOpen} onOpenChange={setCorrectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('correct_dialog_title')}</DialogTitle>
            <DialogDescription className="space-y-3 pt-2 text-left">
              <span className="block">{t('correct_dialog_body', { period: periodLabel })}</span>
              {run.agi_generated_at && (
                <span className="flex items-start gap-2 rounded-md border border-border p-3 text-xs">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>{t('correct_dialog_agi_warning')}</span>
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCorrectOpen(false)}>
              {t('correct_dialog_cancel')}
            </Button>
            <Button
              onClick={() => {
                setCorrectOpen(false)
                onCorrect()
              }}
            >
              {t('correct_dialog_confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
