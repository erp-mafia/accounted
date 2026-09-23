'use client'

/**
 * Internal demo route for the journey onboarding primitives (PR B).
 * Auth-free via the /sandbox middleware exemption; view logged out.
 *
 * A gallery, not the product flow: it exercises JourneyOrb (all states,
 * travel, monogram morph), JourneyTrack (answers, jump-back), Question +
 * ChipRow (fly-to-orb ghost), YearBand, JourneyDatePicker and
 * AddressFields, with demo data only. NO TIC calls are made from this
 * page: the lookup budget is untouched. Swedish-only by design (internal
 * surface); the real flow (PR C) is fully i18n'd.
 */

import { useRef, useState } from 'react'
import JourneyOrb, { type OrbState } from '@/components/onboarding/journey/JourneyOrb'
import JourneyTrack from '@/components/onboarding/journey/JourneyTrack'
import Question from '@/components/onboarding/journey/Question'
import ChipRow from '@/components/onboarding/journey/ChipRow'
import YearBand from '@/components/onboarding/journey/YearBand'
import JourneyDatePicker from '@/components/onboarding/journey/JourneyDatePicker'
import AddressFields from '@/components/onboarding/journey/AddressFields'
import '@/components/onboarding/journey/journey.css'

const ORB_STATES: OrbState[] = ['listening', 'searching', 'thinking', 'working', 'shaping', 'check']
const STATION_FRACS = [0.07, 0.285, 0.5, 0.715, 0.93]

type Panel = 'chips' | 'band' | 'date' | 'address'

export default function JourneySandboxPage() {
  const bandRef = useRef<HTMLDivElement | null>(null)
  const [orbState, setOrbState] = useState<OrbState>('listening')
  const [active, setActive] = useState(1)
  const [morph, setMorph] = useState<string | null>(null)
  const [panel, setPanel] = useState<Panel>('chips')
  const [bandSpan, setBandSpan] = useState<[number, number] | null>([0, 11])
  const [bandLabel, setBandLabel] = useState('1 januari – 31 december')
  const [pickedDate, setPickedDate] = useState<string | null>(null)
  const [address, setAddress] = useState<string | null>(null)

  const answers: (string | null)[] = [
    'Nordvik Bygg & Konsult AB',
    active > 1 ? 'Kalenderår' : null,
    active > 2 ? 'Kvartalsvis' : null,
    active > 3 ? 'Faktureringsmetoden' : null,
    null,
  ]

  return (
    <div className="jny" style={{ background: 'hsl(var(--frame))' }}>
      <div className="jny-dawn" style={{ ['--jny-dawn' as string]: String(active / 4) }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '14px 26px', fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>
        <span>/sandbox/journey · primitivgalleri · inga TIC-anrop</span>
        <span>
          {ORB_STATES.map((s) => (
            <button
              key={s}
              type="button"
              className="jny-btn-quiet"
              style={{ marginLeft: 10, textDecoration: orbState === s ? 'underline' : undefined }}
              onClick={() => {
                setOrbState(s)
                if (s !== 'check') setMorph(null)
              }}
            >
              {s}
            </button>
          ))}
          <button
            type="button"
            className="jny-btn-quiet"
            style={{ marginLeft: 10 }}
            onClick={() => {
              setOrbState('check')
              setMorph('N')
            }}
          >
            monogram
          </button>
        </span>
      </div>

      <div className="jny-center">
        <div ref={bandRef} style={{ width: '100%' }}>
          <JourneyTrack
            stations={[
              { label: 'Företaget', answer: answers[0] },
              { label: 'Räkenskapsåret', answer: answers[1] },
              { label: 'Momsen', answer: answers[2] },
              { label: 'Bokföringen', answer: answers[3] },
              { label: 'Klart' },
            ]}
            active={active}
            onJump={(i) => setActive(i)}
            orbLabel={orbState}
          >
            <JourneyOrb state={orbState} targetX={STATION_FRACS[active]} morphChar={morph} />
          </JourneyTrack>
        </div>

        <div className="jny-facts">
          <div className="jny-factname">Nordvik Bygg &amp; Konsult AB</div>
          <div className="jny-factmeta">
            <span className="jny-f is-on">Aktiebolag</span>
            <span className="jny-f is-on"> · Malmö</span>
            <span className="jny-f is-on"> · F-skatt</span>
            <span className="jny-f is-on"> · Momsregistrerat</span>
          </div>
        </div>

        <div className="jny-qarea">
          {panel === 'chips' && (
            <Question
              title="Stämmer räkenskapsåret?"
              sub="Enligt Bolagsverket följer ni kalenderåret: 1 januari till 31 december."
              info="De flesta bolag följer kalenderåret. Brutet räkenskapsår slutar en annan månad än december och används mest i koncerner."
            >
              <ChipRow
                options={[
                  { key: 'yes', label: 'Ja, kalenderår' },
                  { key: 'other', label: 'Annat räkenskapsår' },
                  { key: 'first', label: 'Det är vårt första år' },
                ]}
                onPick={(k) => {
                  if (k === 'other') setPanel('band')
                  else if (k === 'first') setPanel('date')
                  else setActive((a) => Math.min(a + 1, 4))
                }}
                flyTargetRef={bandRef}
                flyTargetFrac={STATION_FRACS[active]}
              />
            </Question>
          )}

          {panel === 'band' && (
            <Question title="När slutar räkenskapsåret?" sub="Peka för att förhandsgranska.">
              <YearBand cells={24} year0={2026} span={bandSpan} label={bandLabel} note={bandSpan?.[0] === 0 ? 'Kalenderår, som de flesta.' : 'Brutet räkenskapsår.'} />
              <div className="jny-mchips">
                {['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'].map((n, i) => (
                  <button
                    key={n}
                    type="button"
                    className="jny-mchip"
                    onMouseEnter={() => {
                      const m = i + 1
                      if (m === 12) {
                        setBandSpan([0, 11])
                        setBandLabel('1 januari – 31 december')
                      } else {
                        setBandSpan([m, m + 11])
                        setBandLabel(`1 ${['januari','februari','mars','april','maj','juni','juli','augusti','september','oktober','november','december'][m]} – ${['januari','februari','mars','april','maj','juni','juli','augusti','september','oktober','november','december'][m - 1]}`)
                      }
                    }}
                    onClick={() => setPanel('address')}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </Question>
          )}

          {panel === 'date' && (
            <Question title="När startade bolaget?" sub="Registreringsdatumet hos Bolagsverket.">
              <JourneyDatePicker
                years={[2025, 2026]}
                onPick={(d) => {
                  setPickedDate(d)
                  setPanel('address')
                }}
              />
              {pickedDate ? <p className="jny-qsub" style={{ marginTop: 14 }}>Valt: {pickedDate}</p> : null}
            </Question>
          )}

          {panel === 'address' && (
            <Question title="Vad är bolagets adress?">
              <AddressFields
                placeholders={{ street: 'Gatuadress', postalCode: 'Postnummer', city: 'Ort' }}
                enterHint={
                  <>
                    Tryck <b>Enter</b> när du är klar
                  </>
                }
                skipLabel="Lägg till senare"
                onSubmit={(v) => {
                  setAddress(v.city ?? v.addressLine1 ?? '(hoppade över)')
                  setPanel('chips')
                }}
              />
              {address ? <p className="jny-qsub" style={{ marginTop: 14 }}>Sparat: {address}</p> : null}
            </Question>
          )}
        </div>

        <div className="jny-balance" aria-hidden="true" />
        <div className="jny-backrow">
          <button type="button" className="jny-btn-quiet" onClick={() => setPanel('chips')}>
            &lsaquo; Tillbaka till chipsen
          </button>
        </div>
      </div>
    </div>
  )
}
