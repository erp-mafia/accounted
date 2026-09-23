import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

// Chips are pills (concept .chip): 99px radius, 11.5px, quiet padding.
const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-[3px] text-[11.5px] font-medium leading-none transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary/10 text-primary",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground",
        destructive:
          "border-transparent bg-destructive/10 text-destructive",
        outline:
          "border-border text-foreground bg-transparent",
        success:
          "border-transparent bg-success/10 text-success",
        // No amber fill: status colors are data, not chrome (convention 12).
        // The exception reads through the ochre text on a hairline chip.
        warning:
          "border-border bg-transparent text-attn",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  // data-ph-unmask: status chips are static i18n chrome in session replays;
  // a badge carrying user data adds data-ph-mask at the call site.
  return (
    <div data-ph-unmask="" className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
