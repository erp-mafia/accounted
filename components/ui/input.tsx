import * as React from "react"
import { cn } from "@/lib/utils"

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, onWheel, ...props }, ref) => {
    // Prevent the mouse wheel from silently mutating a focused number input
    // (e.g. scrolling the page over a salary field turning 20000 into 19998).
    // Blurring drops focus so the wheel scrolls the page instead of the value.
    const handleWheel = React.useCallback(
      (e: React.WheelEvent<HTMLInputElement>) => {
        if (type === 'number') {
          e.currentTarget.blur()
        }
        onWheel?.(e)
      },
      [type, onWheel]
    )

    return (
      <input
        type={type}
        className={cn(
          "flex h-10 w-full rounded-lg border border-input bg-card px-4 py-2 text-sm transition-colors duration-150 file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        onWheel={handleWheel}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
