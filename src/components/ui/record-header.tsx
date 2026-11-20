import * as React from 'react'
import { LockClosedIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { PageHeaderBelow, PageHeaderParent } from '@/components/ui/page-header'
import { PageHeaderActions } from '@/components/ui/page-header-actions'

interface RecordHeaderProps {
  /** The list this record sits under, as the quiet link before the title. */
  parent: { label: string; href: string }
  title: React.ReactNode
  /** The title and the facts carry user data (a number, a description): data-ph-mask in session replays. */
  mask?: boolean
  /** The "?" popover, right after the title. */
  help?: React.ReactNode
  /** The record's status: a chip for a deviation, muted text otherwise. */
  status?: React.ReactNode
  /** The facts line (type, org number, dates), inline after the title. */
  facts?: React.ReactNode
  /** The bar's actions; a page with none for this user passes nothing. */
  actions?: React.ReactNode
}

/**
 * A record page's top bar (convention 2): the way back, the title, its
 * status and facts, the actions. From md up status and facts sit in the bar;
 * on a phone the bar has no room for them, so they are the first line under
 * it (PageHeaderBelow). Written once here, so no page renders them twice.
 */
export function RecordHeader({ parent, title, mask, help, status, facts, actions }: RecordHeaderProps) {
  const masked = mask ? '' : undefined
  return (
    <>
      <div className="page-header page-header-wrap flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="page-header-lead min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <PageHeaderParent label={parent.label} href={parent.href} />
            <h1 data-ph-mask={masked} className="page-header-title">{title}</h1>
            {help}
            <span className="hidden md:contents">{status}</span>
          </div>
          {facts ? (
            <p data-ph-mask={masked} data-below="" className="page-header-meta mt-1 text-sm text-muted-foreground">{facts}</p>
          ) : null}
        </div>
        {actions ? <PageHeaderActions className="page-header-action shrink-0">{actions}</PageHeaderActions> : null}
      </div>
      <PageHeaderBelow>
        {status}
        {facts ? <p data-ph-mask={masked}>{facts}</p> : null}
      </PageHeaderBelow>
    </>
  )
}

interface RecordActionProps {
  canWrite: boolean
  /** Why a viewer cannot press it; replaces `title` while locked. */
  lockedTitle: string
  title?: string
  /** Shown before the label; a viewer sees the lock in its place. */
  icon?: React.ReactNode
  destructive?: boolean
  loading?: boolean
  onClick: () => void
  children: React.ReactNode
}

/** A quiet action in a register record's top bar (Redigera, Ta bort): disabled with a lock for a viewer. */
export function RecordAction({ canWrite, lockedTitle, title, icon, destructive, loading, onClick, children }: RecordActionProps) {
  return (
    <Button
      variant="ghost"
      size="toolbar"
      onClick={onClick}
      className={cn('text-muted-foreground', destructive ? 'hover:text-destructive' : 'hover:text-foreground')}
      disabled={!canWrite}
      loading={loading}
      title={canWrite ? title : lockedTitle}
    >
      {!loading && (canWrite ? icon : <LockClosedIcon className="h-4 w-4" />)}
      {children}
    </Button>
  )
}
