import { cn } from "@/lib/utils"

/**
 * A loading placeholder shaped like the content it stands in for (Stil v3):
 * a 4px-radius bar with a slow shimmer of the warm wash, still under reduced
 * motion. Render skeleton rows in the real columns at the real row heights
 * (44px lists, 36px ledgers) inside a LateReveal, so a fast load never
 * flashes them.
 */
function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("skeleton-shimmer rounded-sm", className)}
      {...props}
    />
  )
}

/**
 * Holds its children invisible for the first 300ms, then fades them in: a
 * load that finishes in time never shows a skeleton at all.
 */
function LateReveal({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div aria-busy="true" className={cn("animate-late", className)} {...props} />
}

export { Skeleton, LateReveal }
