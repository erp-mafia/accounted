import { Puzzle } from 'lucide-react'

interface EmptyExtensionStateProps {
  title?: string
  description?: string
  icon?: React.ReactNode
}

export default function EmptyExtensionState({
  title = 'Ingen data ännu',
  description = 'Data kommer att visas här när det finns tillgängligt.',
  icon,
}: EmptyExtensionStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {icon ?? <Puzzle className="h-12 w-12 text-muted-foreground/40 mb-4" />}
      <h3 className="text-lg text-foreground">{title}</h3>
      <p className="text-sm text-muted-foreground mt-1 max-w-md">{description}</p>
    </div>
  )
}
