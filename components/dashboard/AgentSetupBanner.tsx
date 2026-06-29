import Link from 'next/link'
import { MessageCircle, ArrowRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

interface Props {
  companyName: string
}

// Renders above the dashboard when the active company has no verified
// agent_profile yet. Mounted from the dashboard server component which
// already does the existence check, so this component itself doesn't fetch.
//
// Single CTA, no dismiss — building the agent is part of onboarding and
// once verified it disappears on its own.
export default function AgentSetupBanner({ companyName }: Props) {
  return (
    <Link
      href="/onboarding/agent"
      className="group block rounded-lg border border-border bg-card hover:bg-secondary/60 transition-colors duration-150 mb-8"
    >
      <div className="flex items-center gap-4 p-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-foreground text-background shrink-0">
          <MessageCircle className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-display text-lg tracking-tight">Bygg din bokföringsassistent</p>
            <Badge variant="secondary" className="uppercase tracking-wider">Beta</Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Skräddarsy en hjälp som kan ditt företag — laddas på under en halv minut för {companyName}.
          </p>
        </div>
        <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
      </div>
    </Link>
  )
}
