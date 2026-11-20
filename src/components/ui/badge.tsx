import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

// Stil v3 tags: 22px rectangles (6px radius), 12px/500, a tint of their
// tone, no border. Chips still mark exceptions only (convention 5): a normal
// state is muted text, and green is for numbers and the confirmation chip.
const badgeVariants = cva(
  "inline-flex h-5.5 items-center gap-1 whitespace-nowrap rounded-md px-1.75 text-[12px] font-medium leading-4 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-1",
  {
    variants: {
      variant: {
        // A neutral exception (Utkast, Krediterad).
        default: "bg-secondary/80 text-foreground/80",
        secondary: "bg-secondary/80 text-foreground/80",
        // Something not yet done (Ej skickad): a hairline, no fill.
        outline: "bg-transparent text-foreground/80 shadow-[inset_0_0_0_0.5px_hsl(var(--line-strong))]",
        // Needs attention (Förfallen, Delbetald): the amber tint, AA text.
        warning: "bg-warning/12 text-attn",
        // Wrong or reversed (Kredit, Avvisad).
        destructive: "bg-destructive/8 text-destructive",
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
