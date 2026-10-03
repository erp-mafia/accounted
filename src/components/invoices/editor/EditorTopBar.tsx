'use client'

import { useState, type KeyboardEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Check, ChevronDown, ChevronRight, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HelpPopover } from '@/components/ui/help-popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { InvoiceDocumentType } from '@/types'

export interface TopBarMenuEntry {
  key: string
  label: string
  /** The menu's check mark: the channel the primary uses. */
  selected?: boolean
  disabled?: boolean
  /** Why it is disabled, under the label. */
  reason?: string | null
  onSelect: () => void
}

export interface TopBarPrimary {
  label: string
  onClick: () => void
  disabled: boolean
  loading: boolean
  /** Tooltip, e.g. why a viewer cannot send. */
  title?: string
  /** Viewers see a lock on the face. */
  locked?: boolean
}

interface EditorTopBarProps {
  breadcrumb: { label: string; href: string }
  title: string
  /** The enabled document types; null = the title is plain text (no switch). */
  documentTypes: Array<{ value: InvoiceDocumentType; label: string }> | null
  documentType: InvoiceDocumentType
  onDocumentTypeChange: (value: InvoiceDocumentType) => void
  help: ReactNode
  meta: string
  paneSwitch: ReactNode | null
  primary: TopBarPrimary
  menu: { channels: TopBarMenuEntry[]; actions: TopBarMenuEntry[] } | null
}

/**
 * The editor's 48 px top bar (the panel's .page-header): breadcrumb back to
 * the list, the title as the document-type switch ("Ny faktura" lists only
 * the enabled types), the "?" help, one meta line, and the split primary
 * whose caret menu holds the other channels and the save-only actions.
 * Alt+ArrowDown on the primary opens the menu.
 */
export function EditorTopBar({
  breadcrumb,
  title,
  documentTypes,
  documentType,
  onDocumentTypeChange,
  help,
  meta,
  paneSwitch,
  primary,
  menu,
}: EditorTopBarProps) {
  const t = useTranslations('invoice_editor_shell')
  const [menuOpen, setMenuOpen] = useState(false)

  function handlePrimaryKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (menu && event.altKey && event.key === 'ArrowDown') {
      event.preventDefault()
      setMenuOpen(true)
    }
  }

  return (
    // margin 0: .page-header pulls itself over a padded container's top
    // padding; this editor is full-bleed, so there is nothing to pull over.
    <header className="page-header flex flex-wrap" style={{ margin: 0 }}>
      <nav aria-label={t('breadcrumb_aria')} className="flex min-w-0 items-center gap-1 text-[13px]">
        <Link
          href={breadcrumb.href}
          className="whitespace-nowrap text-muted-foreground transition-colors duration-150 hover:text-foreground"
        >
          {breadcrumb.label}
        </Link>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h1 className="page-header-title min-w-0">
          {documentTypes ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t('document_type_aria', { title })}
                  className="inline-flex h-8 items-center gap-1 rounded-full px-2 transition-colors duration-150 hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {title}
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[200px]">
                <DropdownMenuRadioGroup
                  value={documentType}
                  onValueChange={(value) => onDocumentTypeChange(value as InvoiceDocumentType)}
                >
                  {documentTypes.map((option) => (
                    <DropdownMenuRadioItem key={option.value} value={option.value}>
                      {option.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <span className="px-2">{title}</span>
          )}
        </h1>
      </nav>
      <HelpPopover>{help}</HelpPopover>
      {meta && (
        // flex-1 from a zero basis: a long meta ("Utkast · får nummer 004 när
        // den skickas") truncates with an ellipsis instead of wrapping the
        // 48px bar onto a second row; the title keeps it readable.
        <p
          className="page-header-meta hidden min-w-0 flex-1 basis-0 text-muted-foreground sm:block"
          title={meta}
          data-ph-mask=""
        >
          {meta}
        </p>
      )}
      <div className="ml-auto flex items-center gap-2">
        {paneSwitch}
        <div className="inline-flex items-stretch">
          <Button
            size="sm"
            className={menu ? 'rounded-r-none' : undefined}
            onClick={primary.onClick}
            onKeyDown={handlePrimaryKeyDown}
            disabled={primary.disabled}
            loading={primary.loading}
            title={primary.title}
            aria-keyshortcuts="Meta+Enter Control+Enter"
          >
            {primary.locked && <Lock className="mr-2 h-3.5 w-3.5" aria-hidden="true" />}
            {primary.label}
          </Button>
          {menu && (
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  className="rounded-l-none border-l border-primary-foreground/20 px-2"
                  aria-label={t('more_actions_aria')}
                  disabled={primary.disabled}
                >
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[260px]">
                {menu.channels.map((entry) => (
                  <MenuEntry key={entry.key} entry={entry} />
                ))}
                {menu.channels.length > 0 && menu.actions.length > 0 && <DropdownMenuSeparator />}
                {menu.actions.map((entry) => (
                  <MenuEntry key={entry.key} entry={entry} />
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </header>
  )
}

function MenuEntry({ entry }: { entry: TopBarMenuEntry }) {
  return (
    <DropdownMenuItem disabled={entry.disabled} onSelect={entry.onSelect} className="items-start py-2">
      <span className="flex h-5 w-4 shrink-0 items-center" aria-hidden="true">
        {entry.selected && <Check className="h-3.5 w-3.5" strokeWidth={2.5} />}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-[13px] leading-5">{entry.label}</span>
        {entry.reason && <span className="text-[11px] leading-4 text-muted-foreground">{entry.reason}</span>}
      </span>
    </DropdownMenuItem>
  )
}
