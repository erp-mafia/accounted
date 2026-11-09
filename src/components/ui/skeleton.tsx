import { cn } from "@/lib/utils"

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse min-w-0 max-w-full rounded-sm bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
