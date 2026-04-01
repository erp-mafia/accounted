export function SettingsLoadingSkeleton() {
  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      {[1, 2].map(i => (
        <div key={i} className="space-y-4">
          <div className="h-3.5 bg-muted rounded w-24 animate-pulse" />
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="h-3.5 bg-muted rounded w-20 animate-pulse" />
              <div className="h-10 bg-muted rounded animate-pulse" />
            </div>
            <div className="space-y-2">
              <div className="h-3.5 bg-muted rounded w-28 animate-pulse" />
              <div className="h-10 bg-muted rounded animate-pulse" />
            </div>
          </div>
          <div className="space-y-2">
            <div className="h-3.5 bg-muted rounded w-16 animate-pulse" />
            <div className="h-10 bg-muted rounded animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  )
}
