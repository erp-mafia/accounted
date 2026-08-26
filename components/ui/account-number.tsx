'use client'

import { getAccountDescription, type AccountType } from '@/lib/bookkeeping/account-descriptions'
import { useBasReference } from '@/lib/bookkeeping/use-bas-reference'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/info-tooltip'
import { cn } from '@/lib/utils'

const TYPE_COLORS: Record<AccountType, string> = {
  asset: 'bg-success',
  liability: 'bg-warning',
  equity: 'bg-primary',
  revenue: 'bg-muted-foreground',
  expense: 'bg-destructive',
  untaxed_reserves: 'bg-warning',
}

const TYPE_LABELS: Record<AccountType, string> = {
  asset: 'Tillgång',
  liability: 'Skuld',
  equity: 'Eget kapital',
  revenue: 'Intäkt',
  expense: 'Kostnad',
  untaxed_reserves: 'Obeskattade reserver',
}

interface AccountNumberProps {
  number: string
  name?: string
  showName?: boolean
  size?: 'sm' | 'default'
  className?: string
}

export function AccountNumber({
  number,
  name,
  showName,
  size = 'default',
  className,
}: AccountNumberProps) {
  // Loads the BAS chart chunk after mount and re-renders once names and
  // descriptions for non-hardcoded accounts are available.
  useBasReference()
  const desc = getAccountDescription(number)
  // The company's own account name wins over the BAS reference name: a chart
  // row is user-editable data and must never be visually overridden by our
  // hardcoded copy. The tooltip still shows the BAS name as reference.
  const displayName = name || desc?.name

  const numberElement = (
    <span
      className={cn(
        'font-mono',
        size === 'sm' ? 'text-xs' : 'text-sm',
        className,
      )}
    >
      {number}
    </span>
  )

  if (!desc) {
    return (
      <>
        {numberElement}
        {showName && displayName && (
          <span className="ml-1">{displayName}</span>
        )}
      </>
    )
  }

  return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              'inline-flex items-center gap-1 cursor-help',
              'decoration-dotted underline underline-offset-4 decoration-muted-foreground/40',
            )}
          >
            <span
              className={cn(
                'font-mono',
                size === 'sm' ? 'text-xs' : 'text-sm',
                className,
              )}
            >
              {number}
            </span>
            {showName && displayName && (
              <span className={size === 'sm' ? 'text-xs' : 'text-sm'}>
                {displayName}
              </span>
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs p-3">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className={cn('h-2 w-2 rounded-full shrink-0', TYPE_COLORS[desc.type])} />
              <span className="text-xs text-muted-foreground">
                {desc.classLabel} &middot; {TYPE_LABELS[desc.type]}
              </span>
            </div>
            <div className="font-medium">
              <span className="font-mono mr-1.5">{number}</span>
              {desc.name}
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {desc.explanation}
            </p>
          </div>
        </TooltipContent>
      </Tooltip>
  )
}
