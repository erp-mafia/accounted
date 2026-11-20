import * as React from "react"
import { cn } from "@/lib/utils"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * DataList: unified list surface, flat on the panel with hairline rows
 * (Stil v3: no box inside the panel). It bleeds 16px past the gutter
 * (LIST_BLEED_CLASS) so row text sits on the 24px gutter while the hover
 * tint and hairlines reach past it. Replaces the per-row Card pattern
 * across Granskning, Transactions and similar list pages.
 */
const DataList = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "-mx-2 text-card-foreground [&>*]:border-b-hairline",
      className
    )}
    {...props}
  />
))
DataList.displayName = "DataList"

const DataListHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "flex min-h-8 flex-wrap items-center gap-3 px-2 py-1.5 text-xs font-medium text-muted-foreground",
      className
    )}
    {...props}
  />
))
DataListHeader.displayName = "DataListHeader"

interface DataListRowProps extends React.HTMLAttributes<HTMLDivElement> {
  leading?: React.ReactNode
  trailing?: React.ReactNode
  selected?: boolean
  expanded?: boolean
  expandedContent?: React.ReactNode
  rowClassName?: string
}

const DataListRow = React.forwardRef<HTMLDivElement, DataListRowProps>(
  (
    {
      className,
      leading,
      trailing,
      selected,
      expanded,
      expandedContent,
      rowClassName,
      onClick,
      children,
      ...props
    },
    ref
  ) => {
    const isInteractive = Boolean(onClick)
    return (
      <div
        ref={ref}
        className={cn(
          "transition-colors",
          selected ? "bg-secondary/60" : "hover:bg-secondary/35",
          className
        )}
        {...props}
      >
        <div
          className={cn(
            "flex min-h-11 items-start gap-3 px-2 py-3",
            isInteractive && "cursor-pointer",
            rowClassName
          )}
          onClick={onClick}
        >
          {leading != null && (
            <div className="flex shrink-0 items-center pt-0.5">{leading}</div>
          )}
          <div className="min-w-0 flex-1">{children}</div>
          {trailing != null && (
            <div className="flex shrink-0 items-center gap-3">{trailing}</div>
          )}
        </div>
        {expandedContent != null && (
          <div
            className={cn(
              "grid transition-[grid-template-rows] duration-300 motion-reduce:transition-none",
              expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
            )}
          >
            <div className="overflow-hidden">
              <div className="border-t-hairline px-2 py-3">
                {expandedContent}
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }
)
DataListRow.displayName = "DataListRow"

const DataListPrimary = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn("truncate text-[13px] font-medium leading-5 text-strong", className)}
    {...props}
  />
))
DataListPrimary.displayName = "DataListPrimary"

const DataListMeta = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground",
      className
    )}
    {...props}
  />
))
DataListMeta.displayName = "DataListMeta"

const DataListMetaSeparator = () => (
  <span className="text-muted-foreground" aria-hidden>
    ·
  </span>
)
DataListMetaSeparator.displayName = "DataListMetaSeparator"

interface DataListEmptyProps {
  icon?: React.ReactNode
  /** Chrome in session replays (data-ph-unmask): wrap any user data (e.g. a
      search term) in a data-ph-mask element. */
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
}

const DataListEmpty = ({
  icon,
  title,
  description,
  action,
  className,
}: DataListEmptyProps) => (
  // data-ph-unmask: list empty states are static i18n chrome in session replays.
  <div
    data-ph-unmask=""
    className={cn(
      "flex flex-col items-center px-2 pb-2 pt-10 text-center",
      className
    )}
  >
    {icon != null && (
      <div className="mb-2 text-muted-foreground [&_svg]:h-5 [&_svg]:w-5">
        {icon}
      </div>
    )}
    <p className="text-[15px] font-medium leading-[22px] text-strong">{title}</p>
    {description != null && (
      <p className="mt-1 max-w-[560px] text-balance text-sm text-muted-foreground">{description}</p>
    )}
    {action != null && <div className="mt-3">{action}</div>}
  </div>
)
DataListEmpty.displayName = "DataListEmpty"

/**
 * The list's own rows as skeletons while it loads, the silhouette
 * ListPageSkeleton paints for a route: a centred spinner made the list jump
 * from one dot to a full table when the rows arrived.
 */
const DataListLoading = ({ className, rows = 4 }: { className?: string; rows?: number }) => (
  <div className={className} aria-busy="true" aria-live="polite">
    {Array.from({ length: rows }, (_, i) => (
      <div key={i} className="flex items-center justify-between gap-4 border-b-hairline py-3.5 last:border-b-0">
        <Skeleton className="h-4 w-48" />
        <div className="flex items-center gap-6">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-16" />
        </div>
      </div>
    ))}
  </div>
)
DataListLoading.displayName = "DataListLoading"

export {
  DataList,
  DataListHeader,
  DataListRow,
  DataListPrimary,
  DataListMeta,
  DataListMetaSeparator,
  DataListEmpty,
  DataListLoading,
}
