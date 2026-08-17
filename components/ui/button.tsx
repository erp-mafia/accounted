import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

// Buttons are pills (radius 99px): a deliberate app-wide divergence from the
// shadcn 8px default, locked in the UI-migration conventions. Change it here,
// never per call site.
const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-full font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50",
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
      size: {
        default: "px-4 py-[7px] text-[13px]",
        sm: "h-9 px-4 text-xs",
        lg: "h-11 px-8 text-base",
        icon: "h-10 w-10",
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
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
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
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
