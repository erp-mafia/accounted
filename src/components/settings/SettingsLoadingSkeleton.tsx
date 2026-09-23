import { Skeleton } from '@/components/ui/skeleton'

/**
 * Placeholder shown while a settings section's data loads. Mirrors the real
 * shape of the section forms (see CompanyInfoForm and SettingsFormWrapper):
 * an uppercase section heading, a two-column grid of label/field pairs,
 * full-width rows, and a right-aligned save button, so the swap to live
 * content doesn't jump from a mismatched layout.
 */
export function SettingsLoadingSkeleton() {
  return (
    <div className="space-y-8" aria-busy="true">
      <div className="space-y-4">
        <Skeleton className="h-4 w-40" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {[0, 1].map((cell) => (
            <div key={cell} className="space-y-2">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
        </div>
        <div className="space-y-2">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-10 w-full" />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {[0, 1].map((cell) => (
            <div key={cell} className="space-y-2">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
        </div>
        <div className="mt-8 flex justify-end">
          <Skeleton className="h-10 w-24" />
        </div>
      </div>
      <div className="space-y-4 border-t border-border pt-8">
        <Skeleton className="h-4 w-32" />
        <div className="space-y-2">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-10 w-full" />
        </div>
      </div>
    </div>
  )
}
