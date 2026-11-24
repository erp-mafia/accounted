import type { ReactNode } from 'react'
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
import { cn } from '@/lib/utils'
import type { ConnectionKind } from '@/lib/settings/mcp-connections'
import type { PictureSourceKey } from '@/lib/agent-context/agent-picture'

/**
 * The marks on the agent picture's cards. Every mark sits in a 32px tile
 * with an 8px radius: a logo the app ships (public/logos) on a white tile
 * with a hairline, contained at 22px; an icon on the wash tile. A card that
 * is not connected (`off`) has its mark greyed.
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

const TILE = 'grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-lg'
/** The hairline round a white logo tile, in the strong line's ink. */
const LOGO_HAIRLINE = { boxShadow: 'inset 0 0 0 0.5px hsl(var(--line-strong))' } as const
const ICON_CLASS = 'h-4 w-4 text-foreground'

/** A logo on its white tile. */
export function LogoTile({ src, off = false }: { src: string; off?: boolean }) {
  return (
    <span className={cn(TILE, 'bg-white', off && 'opacity-60')} style={LOGO_HAIRLINE}>
      {/* A small brand mark from public/logos: the image optimizer adds nothing for it. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" width={22} height={22} className={cn('h-5.5 w-5.5 object-contain', off && 'grayscale')} />
    </span>
  )
}

/** An icon on the wash tile; `bare` for a mark that is a tile of its own. */
function IconTile({ children, off = false, bare = false }: { children: ReactNode; off?: boolean; bare?: boolean }) {
  return <span className={cn(TILE, !bare && 'bg-secondary', off && 'opacity-60 grayscale')}>{children}</span>
}

export function SourceMark({ sourceKey, logo, off = false }: { sourceKey: PictureSourceKey; logo: string | null; off?: boolean }) {
  const src = logo ?? SOURCE_LOGO[sourceKey]
  if (src) return <LogoTile src={src} off={off} />
  switch (sourceKey) {
    case 'whatsapp':
      // The mark is its own green tile.
      return (
        <IconTile off={off} bare>
          <WhatsAppMark size={32} />
        </IconTile>
      )
    case 'gmail':
      return (
        <span className={cn(TILE, 'bg-white', off && 'opacity-60 grayscale')} style={LOGO_HAIRLINE}>
          <GoogleMark className="h-4 w-4" />
        </span>
      )
    case 'inbox':
      return (
        <IconTile off={off}>
          <EnvelopeIcon className={ICON_CLASS} aria-hidden="true" />
        </IconTile>
      )
    case 'pos':
      return (
        <IconTile off={off}>
          <BuildingStorefrontIcon className={ICON_CLASS} aria-hidden="true" />
        </IconTile>
      )
    default:
      return (
        <IconTile off={off}>
          <BuildingLibraryIcon className={ICON_CLASS} aria-hidden="true" />
        </IconTile>
      )
  }
}

export function AgentMark({ kind, off = false }: { kind: ConnectionKind; off?: boolean }) {
  const src = CLIENT_LOGO[kind]
  if (src) return <LogoTile src={src} off={off} />
  return (
    <IconTile off={off}>
      {kind === 'key' ? (
        <KeyIcon className={ICON_CLASS} aria-hidden="true" />
      ) : kind === 'local' ? (
        <CommandLineIcon className={ICON_CLASS} aria-hidden="true" />
      ) : (
        <CpuChipIcon className={ICON_CLASS} aria-hidden="true" />
      )}
    </IconTile>
  )
}
