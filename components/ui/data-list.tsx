import * as React from "react"
import { cn } from "@/lib/utils"

/**
 * DataList — unified list surface (one bordered container, hairline rows).
 *
 * Replaces the per-row Card pattern across Granskning, Transactions, and
 * similar list pages. Visual contract is flat-with-hairlines per CLAUDE.md:
 * no shadows on the container, no state-tinted borders, secondary token for
 * selected/hover.
 */
const DataList = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "rounded-lg border border-border bg-card text-card-foreground overflow-hidden [&>*]:border-b [&>*]:border-border [&>*:last-child]:border-b-0",
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
      "flex flex-wrap items-center gap-3 border-b border-border bg-secondary/40 px-4 py-2",
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
          selected ? "bg-secondary/50" : "hover:bg-secondary/40",
          className
        )}
        {...props}
      >
        <div
          className={cn(
            "flex items-start gap-3 px-4 py-3",
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
              "grid transition-[grid-template-rows] duration-200 motion-reduce:transition-none",
              expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
            )}
          >
            <div className="overflow-hidden">
              <div className="border-t border-border bg-secondary/20 px-4 py-3">
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
    className={cn("truncate text-sm font-medium leading-snug", className)}
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
  <span className="text-muted-foreground/50" aria-hidden>
    ·
  </span>
)
DataListMetaSeparator.displayName = "DataListMetaSeparator"

interface DataListEmptyProps {
  icon?: React.ReactNode
  title: string
  description?: string
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
  <div
    className={cn(
      "flex flex-col items-center justify-center px-6 py-16 text-center",
      className
    )}
  >
    {icon != null && (
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {icon}
      </div>
    )}
    <p className="font-medium">{title}</p>
    {description != null && (
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
    )}
    {action != null && <div className="mt-4">{action}</div>}
  </div>
)
DataListEmpty.displayName = "DataListEmpty"

const DataListLoading = ({ className }: { className?: string }) => (
  <div
    className={cn(
      "flex items-center justify-center px-6 py-16 text-muted-foreground",
      className
    )}
  >
    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none" />
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
