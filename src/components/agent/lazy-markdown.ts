'use client'

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'

// Markdown parser loads separately from the chat surface: react-markdown +
// remark-gfm pull in the whole unified/remark tree.
//
// It used to render `null` while the chunk loaded. That is invisible while a
// reply streams (nobody reads that fast) but very visible on RESUME: every
// assistant bubble in a hydrated conversation was an empty bordered card until
// the chunk landed, then all the text appeared at once and reflowed the thread.
// Two changes: the chunk is prefetched as soon as any chat surface mounts, and
// until it resolves the raw text renders in place of nothing, so a bubble is
// never blank.
export const MarkdownMessage = dynamic(() => import('./MarkdownMessage'), {
  ssr: false,
  loading: () => null,
})

// Module-scoped so the chunk is fetched once per page load and every later
// chat surface (sheet, /chat, a resumed conversation) renders markdown on its
// first frame instead of falling back to plain text again.
let markdownReady = false
let markdownPromise: Promise<unknown> | null = null

/** Start the markdown chunk before anything needs to render with it. */
function prefetchMarkdown(): Promise<unknown> {
  if (!markdownPromise) {
    markdownPromise = import('./MarkdownMessage')
      .then((mod) => {
        markdownReady = true
        return mod
      })
      .catch(() => {
        // A chunk can 404 after a deploy, or the network can blip. Clear the
        // cached promise so a later surface retries, instead of every bubble
        // for the rest of the session being stuck on the plain-text fallback,
        // and swallow the rejection so it is not an unhandled one.
        markdownPromise = null
        return null
      })
  }
  return markdownPromise
}

/** True once the markdown chunk is usable; triggers the fetch if it isn't. */
export function useMarkdownReady(): boolean {
  const [ready, setReady] = useState(markdownReady)
  useEffect(() => {
    if (ready) return
    let alive = true
    void prefetchMarkdown().then(() => {
      if (alive) setReady(true)
    })
    return () => {
      alive = false
    }
  }, [ready])
  return ready
}
