import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

// Stil v3 (founder decision 2026-10-29, "no cards inside the panel"): the
// full-bleed page panel is already the card, so a Card on it is a flat
// section: no border, no fill, no inset, its content on the page's 24px
// gutter, sections apart by the page's spacing. Only a single object (a
// file, a bank row to choose, a plan to pick) gets a surface: variant
// "object", the raised control with the hairline lift. Floating layers
// (dialogs, drawers, menus) are not Cards at all.
const cardVariants = cva("text-card-foreground", {
  variants: {
    variant: {
      section: "",
      object: "rounded-lg bg-control p-4 shadow-raised",
    },
  },
  defaultVariants: {
    variant: "section",
  },
})

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, variant, ...props }, ref) => (
    <div ref={ref} className={cn(cardVariants({ variant }), className)} {...props} />
  )
)
Card.displayName = "Card"

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col gap-0.5 pb-3", className)}
    {...props}
  />
))
CardHeader.displayName = "CardHeader"

const CardTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  // data-ph-unmask: card titles are static i18n chrome in session replays;
  // a title carrying user data adds data-ph-mask at the call site.
  <h3
    ref={ref}
    data-ph-unmask=""
    className={cn(
      "text-[15px] font-medium leading-[22px] text-strong",
      className
    )}
    {...props}
  />
))
CardTitle.displayName = "CardTitle"

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    data-ph-unmask=""
    className={cn("text-[12px] leading-4 text-muted-foreground", className)}
    {...props}
  />
))
CardDescription.displayName = "CardDescription"

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn(className)} {...props} />
))
CardContent.displayName = "CardContent"

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center gap-2 pt-4", className)}
    {...props}
  />
))
CardFooter.displayName = "CardFooter"

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent, cardVariants }
