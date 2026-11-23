'use client'

import { useRef, useState, type ComponentProps } from 'react'
import Link from 'next/link'
import { VoucherPeek } from '@/components/bookkeeping/VoucherPeek'
import { opensPeek, voucherPageHref } from '@/lib/bookkeeping/voucher-peek'

type VoucherPeekLinkProps = Omit<ComponentProps<typeof Link>, 'href' | 'prefetch'> & {
  /** The verifikat (journal entry id) the link leads to. */
  entryId: string
}

/**
 * A link to a verifikat for a list: a plain click reads the verifikat in a
 * side panel over the list (VoucherPeek), so the list keeps its tab, filters
 * and scroll. It stays a real anchor to the verifikat page: cmd or ctrl
 * click, shift click, the middle button and "open in a new tab" open the
 * page as any link does (opensPeek decides). When the panel closes, focus
 * returns to the link.
 *
 * Use it in place of a Link to the verifikat page, with the entry id for the
 * href; the other props go to the anchor.
 */
export function VoucherPeekLink({ entryId, onClick, children, ...anchorProps }: VoucherPeekLinkProps) {
  // The panel mounts at the first open and stays, so it can play its closing motion.
  const [panel, setPanel] = useState<'unopened' | 'open' | 'closed'>('unopened')
  const opener = useRef<HTMLAnchorElement | null>(null)

  return (
    <>
      <Link
        href={voucherPageHref(entryId)}
        // A plain click opens the panel and any other click a new tab with a
        // router of its own, so a prefetch of the page here is never used.
        prefetch={false}
        aria-haspopup="dialog"
        {...anchorProps}
        onClick={(event) => {
          onClick?.(event)
          if (!opensPeek(event)) return
          event.preventDefault()
          opener.current = event.currentTarget
          setPanel('open')
        }}
      >
        {children}
      </Link>
      {panel !== 'unopened' && (
        <VoucherPeek
          entryId={entryId}
          open={panel === 'open'}
          onOpenChange={(open) => setPanel(open ? 'open' : 'closed')}
          onClosed={() => opener.current?.focus()}
        />
      )}
    </>
  )
}
