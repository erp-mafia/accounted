import * as React from "react"
import { cn } from "@/lib/utils"

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>

/**
 * Native date-like inputs whose calendar a click anywhere on the field opens.
 * Chromium (Chrome, Edge, Brave, Opera) opens it only from the small icon at
 * the right edge; a click on the text selects the day, month or year segment
 * and nothing visible happens, so people click again. Nearly every input that
 * was rage-clicked in the app was one of these (invoice, due, payment,
 * employment and voucher dates). Firefox and Safari already open the picker on
 * a click; for them this is a no-op.
 */
const PICKER_TYPES = new Set(["date", "datetime-local", "month", "week"])

type PickerInput = Pick<HTMLInputElement, "type" | "disabled" | "readOnly"> & {
  showPicker?: () => void
}

export function openNativePicker(input: PickerInput): void {
  if (input.disabled || input.readOnly) return
  // `type` reads "text" where the browser has no native date input.
  if (!PICKER_TYPES.has(input.type)) return
  if (typeof input.showPicker !== "function") return
  try {
    input.showPicker()
  } catch {
    // Refused here (no user activation, a cross-origin frame): the browser's
    // own click behaviour stays, which is what the field did before.
  }
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, onWheel, onClick, ...props }, ref) => {
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

    const handleClick = React.useCallback(
      (e: React.MouseEvent<HTMLInputElement>) => {
        onClick?.(e)
        if (!e.defaultPrevented) openNativePicker(e.currentTarget)
      },
      [onClick]
    )

    return (
      <input
        type={type}
        className={cn(
          "flex h-10 w-full rounded-lg border border-input bg-card px-4 py-2 text-sm transition-colors duration-150 file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary/20 aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive aria-invalid:focus-visible:ring-destructive/20 disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        onWheel={handleWheel}
        onClick={handleClick}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
