import { Skeleton } from '@/components/ui/skeleton'

/**
 * The editor's loading state in its own shape (top bar, 560 px form column,
 * preview pane on the frame tone), so the page does not jump when the editor
 * mounts. Same container-query split as InvoiceEditorShell.
 */
export function InvoiceEditorShellSkeleton() {
  return (
    <div className="@container flex min-h-dvh flex-col md:h-full md:min-h-0" aria-busy="true" aria-live="polite">
      <div className="flex min-h-12 items-center gap-2 border-b border-border px-4 md:px-6">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="ml-auto h-8 w-36 rounded-full" />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 space-y-4 px-4 pt-6 md:px-6 @min-[900px]:w-[560px] @min-[900px]:flex-none @min-[900px]:border-r @min-[900px]:border-border">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-10 w-2/3 rounded-lg" />
          <Skeleton className="h-40 w-full rounded-lg" />
        </div>
        <div className="hidden min-w-0 flex-1 bg-frame p-6 @min-[900px]:block">
          <Skeleton className="h-full w-full rounded-lg" />
        </div>
      </div>
    </div>
  )
}
