"use client"

import * as React from "react"
import * as CheckboxPrimitive from "@radix-ui/react-checkbox"
import { CheckIcon } from '@/components/icons'
import { cn } from "@/lib/utils"

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      // Stil v3: a 16px box on the control surface with a hairline ring at
      // rest (strong enough for 3:1 against the panel), filled ink when
      // checked; the check is drawn 1.8px.
      "peer h-4 w-4 shrink-0 rounded-sm bg-control shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.45)] transition-[background-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-40 data-[state=checked]:bg-primary/88 data-[state=checked]:text-primary-foreground data-[state=checked]:shadow-none data-[state=indeterminate]:bg-primary/88 data-[state=indeterminate]:text-primary-foreground data-[state=indeterminate]:shadow-none",
      className
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator
      className={cn("flex items-center justify-center text-current")}
    >
      <CheckIcon className="h-3 w-3" strokeWidth={1.8} />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
))
Checkbox.displayName = CheckboxPrimitive.Root.displayName

export { Checkbox }
