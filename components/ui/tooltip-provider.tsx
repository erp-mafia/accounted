'use client'

import * as TooltipPrimitive from '@radix-ui/react-tooltip'

/**
 * The single app-wide tooltip provider, mounted once in the root layout.
 *
 * `skipDelayDuration` is provider-scoped: it is the grace window during which
 * a second tooltip opens instantly because one is already open. Mounting a
 * provider per tooltip instance (which is what AccountNumber, InfoTooltip,
 * BankSyncStatusChip and KassaflodesanalysClient each used to do) means every
 * instance sits in its own scope and the grace window can never fire, so
 * scanning a huvudbok re-pays the full open delay on every single account
 * number. One provider makes the second and later tooltips instant.
 */
export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={200} skipDelayDuration={300}>
      {children}
    </TooltipPrimitive.Provider>
  )
}
