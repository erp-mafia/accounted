/**
 * Loads the Recapt SDK globally.
 *
 * Renders a plain <script> tag (not next/script) so it lands in <head> and
 * runs as early as possible: that's what the SDK needs to capture full
 * session replays. The public key is sourced from NEXT_PUBLIC_RECAPT_PUBLIC_KEY
 * so hosted and self-hosted deployments can each supply their own key (or
 * disable Recapt entirely by leaving it unset).
 */
export function RecaptLoader() {
  const publicKey = process.env.NEXT_PUBLIC_RECAPT_PUBLIC_KEY
  if (!publicKey) return null

  return (
    <script
      src="https://cdn.recapt.app/browser/glimt.js"
      async
      data-public-key={publicKey}
      data-persist=""
      data-enable-user-comments=""
    />
  )
}
