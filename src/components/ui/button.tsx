import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

// Buttons are pills (radius 99px): a deliberate app-wide divergence from the
// shadcn 8px default, locked in the UI-migration conventions. Change it here,
// never per call site.
const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-full font-medium transition-colors duration-150 pointer-coarse:min-h-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        // active: mirrors hover: on every variant. Tailwind 4 gates hover:
        // behind (hover: hover), so on touch devices these are the only
        // pointer-down feedback a button gives.
        default:
          "bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/90",
        outline:
          "border border-input bg-transparent hover:bg-secondary active:bg-secondary",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/70 active:bg-secondary/70",
        ghost:
          "hover:bg-secondary hover:text-secondary-foreground active:bg-secondary active:text-secondary-foreground",
        link:
          "text-primary underline-offset-4 hover:underline active:underline",
        success:
          "bg-success text-success-foreground hover:bg-success/90 active:bg-success/90",
      },
      // One height per job (design.md, "Buttons"): sm is the shared h-8
      // toolbar height, so a button lines up with ToolbarSearch,
      // SegmentedControl and the context pickers beside it; lg is for auth
      // and touch-critical actions. Never override the height per call site.
      // Touch screens get a 40px minimum from pointer-coarse:min-h-10 above,
      // so no call site needs a min-h-11 patch.
      size: {
        default: "h-9 px-4 text-[13px]",
        sm: "h-8 px-3.5 text-xs",
        lg: "h-11 px-6 text-[13px]",
        icon: "h-10 w-10",
        "icon-sm": "h-8 w-8 pointer-coarse:min-w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  /** Shows the spinner and disables the button while an action runs. The
   *  button owns the spinner's size and spacing; call sites never render
   *  their own Loader2 inside a Button. */
  loading?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, disabled, children, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    // data-ph-unmask: button labels are static i18n chrome in session
    // replays. Combobox-style triggers render a selected VALUE (user data),
    // so they stay masked; a call site whose label carries user data adds
    // data-ph-mask, which wins over unmask on the same element.
    const phUnmask = props.role === "combobox" ? {} : { "data-ph-unmask": "" }
    return (
      <Comp
        {...phUnmask}
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {/* Slot needs exactly one child, so asChild buttons skip the spinner.
            An icon-only button has no label to space the spinner from. */}
        {loading && !asChild ? (
          <>
            <Loader2
              className={cn(
                "h-3.5 w-3.5 shrink-0 animate-spin",
                React.Children.toArray(children).length > 0 && "mr-2"
              )}
              aria-hidden="true"
            />
            {children}
          </>
        ) : (
          children
        )}
      </Comp>
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
