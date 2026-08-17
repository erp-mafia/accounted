'use client'

import * as React from 'react'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface ToolbarSearchProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Overrides the wrapper (width/flex) classes, not the input itself. */
  containerClassName?: string
}

/**
 * Page-toolbar search field. A pill, like every other control that lives in a
 * toolbar row (buttons, context pickers, segmented controls), at the shared
 * h-8 toolbar height. Form fields inside dialogs and forms keep the regular
 * rounded-lg Input; this variant exists only for toolbars.
 */
export const ToolbarSearch = React.forwardRef<HTMLInputElement, ToolbarSearchProps>(
  ({ containerClassName, className, ...props }, ref) => (
    <div className={cn('relative min-w-[220px] max-w-xs flex-1', containerClassName)}>
      <Search
        className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        ref={ref}
        type="search"
        {...props}
        className={cn('h-8 rounded-full pl-10 pr-4 text-[13px]', className)}
      />
    </div>
  ),
)
ToolbarSearch.displayName = 'ToolbarSearch'
