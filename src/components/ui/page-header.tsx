import * as React from 'react'
import Link from 'next/link'
import { ChevronLeftIcon, ChevronRightIcon } from '@/components/icons'
import { PageHeaderActions } from '@/components/ui/page-header-actions'

interface PageHeaderProps {
  /**
   * Usually a static i18n string. The header is data-ph-unmask chrome in
   * session replays, so a title or description that carries user data must
   * wrap that part in a data-ph-mask element (hence ReactNode).
   */
  title: React.ReactNode
  description?: React.ReactNode
  /**
   * A facts line (counterparty, dates, a count) that stays in the top bar,
   * inline after the title, where a description is hidden. Same masking
   * contract as the title: wrap user data in a data-ph-mask element.
   */
  meta?: React.ReactNode
  action?: React.ReactNode
  /**
   * The page this one sits under, as a quiet link before the title
   * ("Rapporter › Balansräkning"), for pages reached from a list or index.
   */
  parent?: { label: string; href: string; onClick?: () => void }
  /**
   * Page help content, rendered as a small "?" popover right after the H1
   * (UI-migration convention 7). Pass a <HelpPopover>...</HelpPopover>.
   */
  help?: React.ReactNode
}

/**
 * The page this one sits under, as a quiet link and a chevron before the
 * title ("Fakturor > Faktura 1038"). PageHeader renders it from `parent`; a
 * detail page with a hand-rolled header (the page-header* class hooks) places
 * it right before its own h1.
 */
/** `onClick` is for a list and its record that share one route: the page clears its selection as the link is followed. */
export function PageHeaderParent({ label, href, onClick }: { label: string; href: string; onClick?: () => void }) {
  // On a phone the way back is a chevron (the label is its name), so the
  // title and the page's action share one row; from md up it is the label.
  return (
    <span className="flex shrink-0 items-center gap-1">
      <Link
        href={href}
        onClick={onClick}
        aria-label={label}
        className="-ml-2 inline-flex h-8 w-8 items-center justify-center whitespace-nowrap text-[13px] text-muted-foreground transition-colors duration-150 hover:text-foreground md:ml-0 md:inline md:h-auto md:w-auto"
      >
        <ChevronLeftIcon className="h-4 w-4 md:hidden" aria-hidden="true" />
        <span className="hidden md:inline">{label}</span>
      </Link>
      <ChevronRightIcon className="hidden h-3.5 w-3.5 text-muted-foreground md:block" aria-hidden="true" />
    </span>
  )
}

/**
 * A record page's first line under the top bar on a phone: what the bar
 * shows beside the title from md up (a status, the facts line) and has no
 * room for at 390px. Place it right after the header; the bar's own copy is
 * marked `data-below` (a facts line) or wrapped in `hidden md:contents` (a
 * status). Same masking contract as the title.
 */
export function PageHeaderBelow({ children }: { children: React.ReactNode }) {
  return (
    <div className="page-header-below !mt-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-5 text-muted-foreground md:hidden print:hidden">
      {children}
    </div>
  )
}

export function PageHeader({ title, description, meta, action, help, parent }: PageHeaderProps) {
  // The page-header* class hooks carry no styling of their own: the
  // .page-header rules in globals.css turn this header into the panel's top
  // bar, and pages that hand-roll a header reuse the same hooks.
  return (
    <>
    <div className="page-header flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-8">
      <div className="page-header-lead">
        <div className="flex items-center gap-2">
          {parent && <PageHeaderParent label={parent.label} href={parent.href} onClick={parent.onClick} />}
          {/* Sized for the top bar by .page-header-title in globals.css
              (UI-migration convention 2).
              data-ph-unmask: page titles are static i18n chrome in session
              replays; a page whose title carries user data must wrap it in
              data-ph-mask at the call site. */}
          <h1 data-ph-unmask="" className="page-header-title">{title}</h1>
          {help}
        </div>
        {meta ? (
          <p data-ph-unmask="" data-below="" className="page-header-meta text-muted-foreground">{meta}</p>
        ) : null}
        {description && (
          <p data-ph-unmask="" className="page-header-desc text-muted-foreground mt-1 text-balance">{description}</p>
        )}
      </div>
      {/* ml-auto: at the bar's end edge on a phone too, where the row is not spread. */}
      {action && (
        <PageHeaderActions className="page-header-action ml-auto w-full sm:w-auto [&>*]:w-full [&>*]:sm:w-auto">{action}</PageHeaderActions>
      )}
    </div>
    {/* On a phone the facts line is never cut beside the title: it is the
        page's first line under the bar. From md up it is in the bar. */}
    {meta ? (
      <PageHeaderBelow>
        <p data-ph-unmask="">{meta}</p>
      </PageHeaderBelow>
    ) : null}
    </>
  )
}
