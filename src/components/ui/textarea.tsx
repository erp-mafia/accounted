import * as React from "react"
import { cn } from "@/lib/utils"
import { FIELD_CLASS } from "./field-classes"

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          FIELD_CLASS,
          "flex min-h-[100px] resize-none px-2.5 py-2 leading-5",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Textarea.displayName = "Textarea"

export { Textarea }
