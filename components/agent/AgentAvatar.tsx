'use client'

import { MessageCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getAvatarUrl } from './avatars'

interface Props {
  avatarId: string | null | undefined
  size?: 'xs' | 'sm' | 'md' | 'lg'
  className?: string
  alt?: string
}

// Renders the agent's avatar: either the chosen dicebear SVG from the
// AVATAR_OPTIONS registry, or a fallback MessageCircle glyph on a dark circle
// when no avatar is set yet (free tier / older profiles).
//
// `next/image` is intentionally NOT used: avatars are tiny remote SVGs from
// the dicebear CDN, and adding the domain to next.config just to render a
// 28px image is overkill. Browser caches the SVG forever via the seed-keyed
// URL.
export default function AgentAvatar({ avatarId, size = 'sm', className, alt }: Props) {
  const url = getAvatarUrl(avatarId)
  const dim = SIZES[size]
  const altText = alt ?? 'Avatar'

  if (!url) {
    return (
      <span
        className={cn(
          'inline-flex items-center justify-center rounded-full bg-foreground text-background shrink-0',
          dim.box,
          className,
        )}
        aria-label={altText}
      >
        <MessageCircle className={dim.icon} />
      </span>
    )
  }

  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src={url}
      alt={altText}
      className={cn(
        'rounded-full shrink-0 bg-secondary object-cover',
        dim.box,
        className,
      )}
    />
  )
}

const SIZES = {
  xs: { box: 'h-5 w-5', icon: 'h-2.5 w-2.5' },
  sm: { box: 'h-8 w-8', icon: 'h-3.5 w-3.5' },
  md: { box: 'h-10 w-10', icon: 'h-4 w-4' },
  lg: { box: 'h-14 w-14', icon: 'h-5 w-5' },
}
