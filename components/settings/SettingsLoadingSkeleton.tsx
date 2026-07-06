import { Skeleton } from '@/components/ui/skeleton'

/**
 * Placeholder shown while a settings section's data loads. Mirrors the real shape
 * of the section forms: an uppercase section heading followed by stacked
 * label/field rows, with a hairline divider between blocks: so the swap to live
 * content doesn't jump from a mismatched layout.
 */
export function SettingsLoadingSkeleton() {
  return (
    <div className="space-y-8 animate-in fade-in duration-300" aria-busy="true">
      {[0, 1].map((block) => (
        <div
          key={block}
          className={block === 0 ? 'space-y-4' : 'space-y-4 border-t border-border pt-8'}
        >
          <Skeleton className="h-3.5 w-32" />
          {[0, 1, 2].map((row) => (
            <div key={row} className="space-y-2">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-10 w-full max-w-md" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
