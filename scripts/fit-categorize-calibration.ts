/**
 * Fit and report the auto-booking confidence calibration (RIP-4 step 4).
 *
 * READ-ONLY. Reads categorize_calibration_samples, prints the reliability
 * diagram + expected calibration error, fits an isotonic calibrator, and shows
 * what the auto-book / suggest / review bands would look like on the calibrated
 * probability. Run this once real outcomes have accumulated (>= a few hundred);
 * it changes nothing on its own.
 *
 *   npx tsx scripts/fit-categorize-calibration.ts
 *
 * Note: .env.local points at production; this only SELECTs, so it is safe, but
 * it is still the prod corpus you are reading.
 *
 * Consent: samples are only written for, and only read from, companies with
 * company_settings.data_analysis_opt_in = true (#1346). The write side is
 * gated in POST /api/agent/categorize/outcome; the read side filters again
 * here so a company that opted out after contributing drops out of the fit.
 */
import { createClient } from '@supabase/supabase-js'
import {
  reliabilityByBucket,
  expectedCalibrationError,
  fitIsotonic,
  calibrate,
  bandFor,
  type Sample,
} from '@/lib/agent/categorize/calibration'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}
const supabase = createClient(url, key)

async function main() {
  // Consent gate (#1346): only companies that opted in to data analysis.
  const { data: optedIn, error: optedInError } = await supabase
    .from('company_settings')
    .select('company_id')
    .eq('data_analysis_opt_in', true)
  if (optedInError) throw optedInError
  const optedInIds = (optedIn ?? []).map((r) => r.company_id as string)
  if (optedInIds.length === 0) {
    console.log('\nNo company has opted in to data analysis (company_settings.data_analysis_opt_in). Nothing to fit.')
    return
  }

  const rows: { confidence: number; was_correct: boolean }[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('categorize_calibration_samples')
      .select('confidence, was_correct')
      .in('company_id', optedInIds)
      .order('created_at', { ascending: false })
      .range(from, from + PAGE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    rows.push(...(data as { confidence: number; was_correct: boolean }[]))
    if (data.length < PAGE) break
  }

  const samples: Sample[] = rows.map((r) => ({ confidence: Number(r.confidence), correct: r.was_correct }))
  console.log(`\nSamples: ${samples.length}`)
  if (samples.length === 0) {
    console.log('No calibration samples yet. Let people book AI proposals first.')
    return
  }

  const overall = samples.filter((s) => s.correct).length / samples.length
  console.log(`Overall accuracy (proposal booked unedited): ${(overall * 100).toFixed(1)}%`)
  console.log(`Expected calibration error (ECE): ${expectedCalibrationError(samples).toFixed(4)}\n`)

  console.log('Reliability diagram (raw confidence bucket → empirical accuracy):')
  for (const b of reliabilityByBucket(samples)) {
    if (b.n === 0) continue
    const bar = '#'.repeat(Math.round(b.accuracy * 20))
    console.log(
      `  ${b.lo.toFixed(1)}-${b.hi.toFixed(1)}  n=${String(b.n).padStart(5)}  ` +
        `conf=${b.meanConfidence.toFixed(2)}  acc=${b.accuracy.toFixed(2)}  ${bar}`,
    )
  }

  const cal = fitIsotonic(samples)
  if (!cal) {
    console.log(`\nNot enough data to fit a calibrator yet (need >= 200). Bands stay uncalibrated (no auto-book).`)
    return
  }

  console.log(`\nFitted isotonic calibrator on ${cal.fittedOn} samples.`)
  console.log('Raw → calibrated (and the band for a small, routine amount):')
  for (const raw of [0.3, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99]) {
    const p = calibrate(raw, cal)
    const band = bandFor(raw, cal, { amount: 499 })
    console.log(`  ${raw.toFixed(2)} → ${p.toFixed(2)}   ${band}`)
  }
  console.log(
    `\nNext: store this calibrator (or its thresholds) where bandFor reads it, ` +
      `then enable auto-book for the top band once the empirical accuracy there is acceptable.`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
