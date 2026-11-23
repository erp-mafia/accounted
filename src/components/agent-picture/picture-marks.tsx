import {
  BuildingLibraryIcon,
  BuildingStorefrontIcon,
  CommandLineIcon,
  CpuChipIcon,
  EnvelopeIcon,
  KeyIcon,
} from '@/components/icons'
import { WhatsAppMark } from '@/components/extensions/general/WhatsAppMark'
import { GoogleMark } from '@/components/ui/provider-marks'
import { AI_CLIENTS } from '@/lib/onboarding/ai-clients'
import type { ConnectionKind } from '@/lib/settings/mcp-connections'
import type { PictureSourceKey } from '@/lib/agent-context/agent-picture'

/**
 * The marks on the agent picture's cards: the logo the app ships for a
 * source or a client where there is one (public/logos), otherwise an icon
 * on the app's tile.
 */

/** A source's logo file, where the app ships one. Banks bring their own (the loader picks it by the bank's name). */
const SOURCE_LOGO: Partial<Record<PictureSourceKey, string>> = {
  bolagsverket: '/logos/bolagsverket.jpg',
  kivra: '/logos/kivra.png',
  billo: '/logos/billo.png',
  stripe: '/logos/stripeicon.jpeg',
  shopify: '/logos/shopify.svg',
  woocommerce: '/logos/woocommerce.svg',
  zettle: '/logos/zettle.svg',
}

const CLIENT_LOGO: Partial<Record<ConnectionKind, string>> = {
  ...Object.fromEntries(AI_CLIENTS.map((client) => [client.id, client.logo])),
  copilot: '/logos/copilot.webp',
}

function Logo({ src }: { src: string }) {
  // A small brand mark from public/logos: the image optimizer adds nothing for it.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" className="h-full w-full bg-white object-contain p-1" />
}

const ICON_CLASS = 'h-4 w-4 text-foreground'

export function SourceMark({ sourceKey, logo }: { sourceKey: PictureSourceKey; logo: string | null }) {
  const src = logo ?? SOURCE_LOGO[sourceKey]
  if (src) return <Logo src={src} />
  switch (sourceKey) {
    case 'whatsapp':
      return <WhatsAppMark size={32} />
    case 'gmail':
      return <GoogleMark className="h-4 w-4" />
    case 'inbox':
      return <EnvelopeIcon className={ICON_CLASS} aria-hidden="true" />
    case 'pos':
      return <BuildingStorefrontIcon className={ICON_CLASS} aria-hidden="true" />
    default:
      return <BuildingLibraryIcon className={ICON_CLASS} aria-hidden="true" />
  }
}

export function AgentMark({ kind }: { kind: ConnectionKind }) {
  const src = CLIENT_LOGO[kind]
  if (src) return <Logo src={src} />
  if (kind === 'key') return <KeyIcon className={ICON_CLASS} aria-hidden="true" />
  if (kind === 'local') return <CommandLineIcon className={ICON_CLASS} aria-hidden="true" />
  return <CpuChipIcon className={ICON_CLASS} aria-hidden="true" />
}
