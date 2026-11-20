"use client"

import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"
import { cn } from "@/lib/utils"

const Tabs = TabsPrimitive.Root

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      // Stil v3: the same wash track and raised thumb as SegmentedControl.
      "inline-flex h-8 items-center justify-center gap-0.5 rounded-lg bg-secondary/80 p-0.5 text-muted-foreground max-w-full overflow-x-auto scrollbar-hide",
      className
    )}
    {...props}
  />
))
TabsList.displayName = TabsPrimitive.List.displayName

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  // data-ph-unmask: tab labels are static i18n chrome in session replays.
  <TabsPrimitive.Trigger
    ref={ref}
    data-ph-unmask=""
    className={cn(
      "inline-flex h-full items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 text-[13px] font-medium ring-offset-background transition-[background-color,box-shadow,color] duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-40 data-[state=active]:bg-control data-[state=active]:text-strong data-[state=active]:shadow-raised",
      className
    )}
    {...props}
  />
))
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-4 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2",
      // When a consumer passes `forceMount`, Radix keeps inactive panels in the
      // DOM (present is always true) but does NOT hide them itself: hide them
      // here. No-op for non-forceMount tabs, which unmount inactive content.
      "data-[state=inactive]:hidden",
      className
    )}
    {...props}
  />
))
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
