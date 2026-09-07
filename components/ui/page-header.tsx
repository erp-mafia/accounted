import * as React from 'react'

interface PageHeaderProps {
  /**
   * Usually a static i18n string. The header is data-ph-unmask chrome in
   * session replays, so a title or description that carries user data must
   * wrap that part in a data-ph-mask element (hence ReactNode).
   */
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  /**
   * Page help content, rendered as a small "?" popover right after the H1
   * (UI-migration convention 7). Pass a <HelpPopover>...</HelpPopover>.
   */
  help?: React.ReactNode
}

export function PageHeader({ title, description, action, help }: PageHeaderProps) {
  // The page-header* class hooks carry no styling of their own: they let
  // shell v2 ([data-shell="v2"] in globals.css) turn this header into the
  // panel's top bar without any page changing its markup.
  return (
    <div className="page-header flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-8">
      <div className="page-header-lead">
        <div className="flex items-center gap-2">
          {/* Locked at exactly 24px/32px (UI-migration convention 2).
              data-ph-unmask: page titles are static i18n chrome in session
              replays; a page whose title carries user data must wrap it in
              data-ph-mask at the call site. */}
          <h1 data-ph-unmask="" className="page-header-title font-display text-2xl leading-8 tracking-tight">{title}</h1>
          {help}
        </div>
        {description && (
          <p data-ph-unmask="" className="page-header-desc text-muted-foreground mt-1 text-balance">{description}</p>
        )}
      </div>
      {action && <div className="page-header-action w-full sm:w-auto [&>*]:w-full [&>*]:sm:w-auto">{action}</div>}
    </div>
  )
}
