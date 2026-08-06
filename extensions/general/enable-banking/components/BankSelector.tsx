'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Landmark, Loader2, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export interface Bank {
  name: string
  country: string
  logo?: string
  bic?: string
}

const POPULAR_SWEDISH_BANKS = [
  'Swedbank',
  'SEB',
  'Nordea',
  'Handelsbanken',
  'Danske Bank',
]

interface BankSelectorProps {
  onConnect: (bank: Bank) => void
  onPsuTypeDetected?: (psuType: 'personal' | 'business') => void
  isConnecting?: boolean
  connectingBankName?: string | null
  className?: string
}

/**
 * Eyebrow above a list section: same micro-label and same px-1 inset as the
 * SettingsGroup eyebrow, so the two sit on one left edge.
 */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="px-1 pb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  )
}

/**
 * 32px leading mark for a row. Real bank logos are drawn for a white
 * background, so they sit on a white chip (same treatment as LogoMark in
 * components/onboarding/NewUserChecklist.tsx); the no-logo fallback uses the
 * neutral surface instead, which keeps the icon readable in dark mode.
 * While connecting, the mark is replaced by a bare spinner: quiet inline
 * state, no tint, no box.
 */
function BankMark({ bank, connecting }: { bank: Bank; connecting: boolean }) {
  if (connecting) {
    return (
      <span className="flex h-8 w-8 shrink-0 items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
      </span>
    )
  }

  if (bank.logo) {
    return (
      <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-white">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={bank.logo} alt="" className="h-6 w-6 object-contain" />
      </span>
    )
  }

  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-secondary">
      <Landmark className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
    </span>
  )
}

function BankRow({ bank, isConnecting, connectingBankName, onConnect }: {
  bank: Bank
  isConnecting: boolean
  connectingBankName: string | null
  onConnect: (bank: Bank) => void
}) {
  const connecting = isConnecting && connectingBankName === bank.name

  return (
    <button
      type="button"
      disabled={isConnecting}
      onClick={() => onConnect(bank)}
      className={cn(
        // 32px mark + py-2 keeps the row at 48px: comfortably past the 44px
        // touch target without turning back into a card.
        'flex w-full items-center gap-3 px-1 py-2 text-left transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        !isConnecting && 'hover:bg-secondary/60',
        isConnecting && 'cursor-not-allowed',
        isConnecting && !connecting && 'opacity-50',
      )}
    >
      <BankMark bank={bank} connecting={connecting} />
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-sm',
          connecting ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        {bank.name}
      </span>
      {/* No per-row "Ansluter..." text: the spinner mark carries the row's
          share of the state, the wording lives once in the line below the
          list. */}
      {!connecting && (
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
    </button>
  )
}

export function BankSelector({
  onConnect,
  onPsuTypeDetected,
  isConnecting = false,
  connectingBankName = null,
  className,
}: BankSelectorProps) {
  const [banks, setBanks] = useState<Bank[]>([])
  const [isSandbox, setIsSandbox] = useState(true)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    async function fetchBanks() {
      try {
        const res = await fetch('/api/extensions/ext/enable-banking/banks')
        if (!res.ok) {
          // A non-OK response (500, or the 403 capability gate) has no `banks`
          // array; without this guard it falls through to the "no banks
          // available" empty state, which misreads as a successful-but-empty
          // load rather than a failure.
          setError('Kunde inte ladda banker')
          return
        }
        const data = await res.json()
        if (data.banks) {
          setBanks(data.banks as Bank[])
        }
        if (data.sandbox !== undefined) {
          setIsSandbox(data.sandbox)
        }
        if (data.psu_type && onPsuTypeDetected) {
          onPsuTypeDetected(data.psu_type)
        }
      } catch {
        setError('Kunde inte ladda banker')
      } finally {
        setIsLoading(false)
      }
    }
    fetchBanks()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- onPsuTypeDetected is a stable setter, only run on mount
  }, [onPsuTypeDetected])

  const filteredBanks = banks.filter((bank) =>
    bank.name.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const showPopular = !isSandbox && !searchQuery
  const popularBanks = showPopular
    ? filteredBanks.filter((bank) => POPULAR_SWEDISH_BANKS.includes(bank.name))
    : []
  const otherBanks = showPopular
    ? filteredBanks.filter((bank) => !POPULAR_SWEDISH_BANKS.includes(bank.name))
    : filteredBanks

  return (
    <div className={cn('space-y-4', className)}>
      {/* Search input */}
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          ref={searchRef}
          type="text"
          placeholder="Sök efter din bank..."
          aria-label="Sök efter din bank"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Loading state. The spinner is decorative, so the state needs a text
          equivalent: without it a screen-reader user gets silence between
          submitting and the list appearing. */}
      {isLoading && (
        <div role="status" className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
          <span className="sr-only">Laddar banker...</span>
        </div>
      )}

      {/* Error state: one quiet line, not a tinted panel. role="alert" so the
          failure is announced rather than only redrawn. */}
      {error && (
        <p role="alert" className="px-1 text-[12.5px] leading-relaxed text-destructive">{error}</p>
      )}

      {/* Bank list */}
      {!isLoading && !error && (
        <>
          {filteredBanks.length === 0 ? (
            <div className="px-1 py-8 text-center">
              <p className="text-sm text-muted-foreground">
                {searchQuery
                  ? `Inga banker matchar "${searchQuery}"`
                  : 'Inga banker tillgängliga'}
              </p>
              {searchQuery && (
                <p className="mt-1 text-xs text-muted-foreground/70">
                  Försök med ett annat sökord
                </p>
              )}
            </div>
          ) : (
            // -mx-1 cancels the px-1 the settings panel wraps this in, so the
            // hairlines and the hover band run the full width of the settings
            // content, level with the SettingsRow hairlines above; the rows'
            // own px-1 then puts the bank mark on the same left edge as the
            // settings labels.
            // max-h-96 is exactly eight 48px rows: a scroll box with a reason.
            <div className="-mx-1 max-h-96 space-y-6 overflow-y-auto overscroll-contain">
              {popularBanks.length > 0 && (
                <section>
                  <SectionLabel>Populära banker</SectionLabel>
                  <div className="divide-y divide-border border-t border-border">
                    {popularBanks.map((bank) => (
                      <BankRow key={bank.name} bank={bank} isConnecting={isConnecting} connectingBankName={connectingBankName} onConnect={onConnect} />
                    ))}
                  </div>
                </section>
              )}
              {otherBanks.length > 0 && (
                <section>
                  {popularBanks.length > 0 && <SectionLabel>Alla banker</SectionLabel>}
                  <div className="divide-y divide-border border-t border-border">
                    {otherBanks.map((bank) => (
                      <BankRow key={bank.name} bank={bank} isConnecting={isConnecting} connectingBankName={connectingBankName} onConnect={onConnect} />
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </>
      )}

      {/* The single worded home of the connecting state: one muted line rather
          than a tinted bordered panel, and it names the bank so the state is
          still readable when the chosen row has scrolled out of view. */}
      {isConnecting && connectingBankName && (
        <p role="status" className="flex items-center gap-2 px-1 text-[12.5px] leading-relaxed text-muted-foreground">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
          Ansluter till {connectingBankName}...
        </p>
      )}
    </div>
  )
}
