"use client"

import * as React from "react"
import * as LabelPrimitive from "@radix-ui/react-label"
import { cva, type VariantProps } from "class-variance-authority"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"

const labelVariants = cva(
  // Stil v3: a field label is 12px/500 in sentence case above its field.
  "text-[12px] font-medium leading-4 text-foreground/80 peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
)

/** The quiet "valfritt" after an optional field's label (V7 creation forms:
 *  required is the default and is not marked; no asterisks). */
function OptionalMark() {
  const t = useTranslations("common")
  return <span className="ml-1.5 font-normal text-muted-foreground">{t("optional")}</span>
}

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> &
    VariantProps<typeof labelVariants> & {
      /** Marks the field as optional: a quiet "valfritt" after the label. */
      optional?: boolean
    }
>(({ className, optional, children, ...props }, ref) => (
  // data-ph-unmask: form field labels are static i18n chrome, readable under
  // the deny-by-default replay masking (see lib/analytics/replay-masking.ts).
  // A call site whose label text is user data must add data-ph-mask, which
  // wins over this default.
  <LabelPrimitive.Root
    ref={ref}
    data-ph-unmask=""
    className={cn(labelVariants(), className)}
    {...props}
  >
    {children}
    {optional && <OptionalMark />}
  </LabelPrimitive.Root>
))
Label.displayName = LabelPrimitive.Root.displayName

export { Label }
