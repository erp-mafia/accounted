import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { SpinnerIcon } from '@/components/icons'
import { cn } from "@/lib/utils"

// Stil v3 (founder decisions 2026-10-29): buttons are 6px rectangles, never
// pills. A raised button is the control surface with the hairline lift
// (shadow-raised), the primary is translucent ink, and every button answers
// the pointer with the one press motion (scale .97 over 100ms). Change the
// look here, never per call site.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-[background-color,box-shadow,color,transform] duration-150 active:scale-[0.97] active:duration-100 motion-reduce:active:scale-100 pointer-coarse:min-h-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-40 aria-disabled:pointer-events-none aria-disabled:opacity-40",
  {
    variants: {
      variant: {
        // active: mirrors hover: on every variant. Tailwind 4 gates hover:
        // behind (hover: hover), so on touch devices these are the only
        // pointer-down feedback a button gives besides the press scale.
        default:
          "bg-primary/88 text-primary-foreground hover:bg-primary/80 active:bg-primary/80",
        outline:
          "bg-control text-strong shadow-raised hover:shadow-raised-hover active:shadow-raised-hover",
        ghost:
          "text-foreground/80 hover:bg-secondary/60 hover:text-foreground active:bg-secondary/60 active:text-foreground",
        destructive:
          "bg-destructive/8 text-destructive hover:bg-destructive/12 active:bg-destructive/12",
        link:
          "h-auto px-0 text-strong underline decoration-foreground/25 underline-offset-[3px] hover:decoration-foreground/60 active:scale-100",
        // Quiet row actions (Stil v3 polish P1): plain text at rest, the
        // raised surface (row) or the primary fill (row-primary) while the
        // row (a `group`) is hovered or the button has keyboard focus. A row
        // action that needs attention (Matcha Faktura 1043, Välj kategori)
        // stays outline so it stands out; touch shows the surface always.
        row:
          "text-foreground/80 group-hover:bg-control group-hover:text-strong group-hover:shadow-raised focus-visible:bg-control focus-visible:shadow-raised pointer-coarse:bg-control pointer-coarse:shadow-raised aria-expanded:bg-control aria-expanded:shadow-raised",
        "row-primary":
          "text-foreground/80 group-hover:bg-primary/88 group-hover:text-primary-foreground focus-visible:bg-primary/88 focus-visible:text-primary-foreground pointer-coarse:bg-primary/88 pointer-coarse:text-primary-foreground",
        // The confirmation chip (DoneChip) as a button: green only while it
        // confirms, before the row folds away.
        success:
          "bg-success/9 text-success hover:bg-success/12 active:bg-success/12",
      },
      // One height per job (design.md, "Buttons"), one text size for all:
      // default 28px in rows, lists and dialogs; toolbar 32px beside the
      // toolbar controls and in the top bar (check:guards
      // toolbar-button-size); lg 44px for auth and touch-critical actions.
      // Never override the height per call site. Touch screens get a 40px
      // minimum from pointer-coarse:min-h-10 above.
      size: {
        default: "h-7 px-2.5 text-[13px]",
        toolbar: "h-8 px-3 text-[13px]",
        lg: "h-11 px-5 text-[13px]",
        icon: "h-7 w-7 pointer-coarse:min-w-10",
        "icon-toolbar": "h-8 w-8 pointer-coarse:min-w-10",
      },
    },
    // A link is text in the line: the size's height and padding never apply
    // (compound classes land after the size's, so they win the merge).
    compoundVariants: [{ variant: "link", className: "h-auto px-0" }],
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
   *  their own SpinnerIcon inside a Button. */
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
            The spinner is always mounted and only hidden, so toggling
            `loading` never adds or removes a DOM node next to the label.
            Browser page translation (Chrome's Google Translate) replaces
            the label's text node with its own; when the toggle re-parented
            the label, React removed a text node that was no longer there
            and the page fell into the error boundary the moment a booking
            was refused and the row's Bokför button stopped loading
            (NotFoundError on removeChild, crm#1046). The button's gap
            spaces it from the label; a hidden spinner takes no gap. */}
        {asChild ? (
          children
        ) : (
          <>
            <SpinnerIcon
              className={cn("h-3.5 w-3.5 shrink-0 animate-spin", !loading && "hidden")}
              aria-hidden="true"
            />
            {children}
          </>
        )}
      </Comp>
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
