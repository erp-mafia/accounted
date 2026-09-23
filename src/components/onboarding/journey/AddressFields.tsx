'use client'

import { useRef, useState, type ReactNode } from 'react'

/**
 * Three-part address entry (street / postal code / city) with Enter
 * chaining field to field and submitting from the last one. Skippable:
 * the address is optional in onboarding, exactly like the wizard.
 */
interface AddressFieldsProps {
  initial?: { street: string; postalCode: string; city: string }
  onChange?: (value: { street: string; postalCode: string; city: string }) => void
  placeholders: { street: string; postalCode: string; city: string }
  enterHint: ReactNode
  skipLabel: string
  onSubmit: (v: { addressLine1?: string; postalCode?: string; city?: string }) => void
}

export default function AddressFields({ initial, onChange, placeholders, enterHint, skipLabel, onSubmit }: AddressFieldsProps) {
  const [street, setStreet] = useState(initial?.street ?? '')
  const [zip, setZip] = useState(initial?.postalCode ?? '')
  const [city, setCity] = useState(initial?.city ?? '')
  const zipRef = useRef<HTMLInputElement | null>(null)
  const cityRef = useRef<HTMLInputElement | null>(null)

  function submit() {
    onSubmit({
      addressLine1: street.trim() || undefined,
      postalCode: zip.trim() || undefined,
      city: city.trim() || undefined,
    })
  }

  // A fragment, not a wrapper div: the action row below has to stay a direct
  // child of the step for the sticky rule in journey.css to reach it (#2642).
  return (
    <>
      <div className="jny-addr">
        <div className="jny-biginput">
          <input
            value={street}
            placeholder={placeholders.street}
            aria-label={placeholders.street}
            autoComplete="off"
            autoFocus
            onChange={(e) => { setStreet(e.target.value); onChange?.({ street: e.target.value, postalCode: zip, city }) }}
            onKeyDown={(e) => e.key === 'Enter' && zipRef.current?.focus()}
          />
        </div>
        <div className="jny-addr-row">
          <div className="jny-biginput jny-addr-zip">
            <input
              ref={zipRef}
              value={zip}
              placeholder={placeholders.postalCode}
              aria-label={placeholders.postalCode}
              inputMode="numeric"
              autoComplete="off"
              onChange={(e) => { setZip(e.target.value); onChange?.({ street, postalCode: e.target.value, city }) }}
              onKeyDown={(e) => e.key === 'Enter' && cityRef.current?.focus()}
            />
          </div>
          <div className="jny-biginput jny-addr-city">
            <input
              ref={cityRef}
              value={city}
              placeholder={placeholders.city}
              aria-label={placeholders.city}
              autoComplete="off"
              onChange={(e) => { setCity(e.target.value); onChange?.({ street, postalCode: zip, city: e.target.value }) }}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </div>
        </div>
      </div>
      <p className="jny-enterhint">{enterHint}</p>
      <div className="jny-qactions">
        <button type="button" className="jny-btn-quiet" onClick={() => onSubmit({})}>
          {skipLabel}
        </button>
      </div>
    </>
  )
}
