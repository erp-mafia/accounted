'use client'

import * as React from 'react'
import { MagnifyingGlassIcon } from '@/components/icons'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface ToolbarSearchProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Overrides the wrapper (width/flex) classes, not the input itself. */
  containerClassName?: string
}

/**
 * Page-toolbar search field (Stil v3): a 32px field on the raised control
 * surface, the same height as the toolbar buttons, pickers and segmented
 * controls beside it, with the magnifier inside and an optional key hint.
 * Fields inside dialogs and forms use the regular Input (also 32px).
 */
export { TOOLBAR_FIELD_CLASS } from './field-classes'

/**
 * The search field at the end of a list toolbar (V7 list toolbars: view
 * segments, then filters, then search and "more" on the right). One width on
 * every list (240px); on a phone it fills what is left of its row. Pass as
 * `containerClassName`; anything after it in the row follows it to the right.
 */
export const TOOLBAR_SEARCH_END_CLASS = 'min-w-40 max-w-none flex-1 sm:ml-auto sm:w-60 sm:flex-none'

export const ToolbarSearch = React.forwardRef<HTMLInputElement, ToolbarSearchProps>(
  ({ containerClassName, className, ...props }, ref) => (
    <div className={cn('relative min-w-[200px] max-w-xs flex-1', containerClassName)}>
      <MagnifyingGlassIcon
        className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        ref={ref}
        type="search"
        {...props}
        className={cn('h-8 rounded-md pl-8 pr-2.5', className)}
      />
    </div>
  ),
)
ToolbarSearch.displayName = 'ToolbarSearch'
