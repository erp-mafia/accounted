import type { VatDeclarationRutor } from '@/types'

/**
 * Local pre-flight checks for the momsdeklaration, run BEFORE the SKV
 * /kontrollera or /utkast calls.
 *
 * Why we need this: Skatteverket's "validering" only confirms that the
 * payload is internally arithmetically consistent: it does NOT confirm
 * that the declaration reflects reality. A declaration of all zeros
 * validates fine; one with output VAT but no underlying purchases
 * validates fine too, until the gateway-level FK004 rule fires.
 *
 * The checks below catch the patterns we have seen in practice where
 * "Validera" returned OK but the declaration was wrong:
 *
 * - Reverse charge: ruta 30-32 populated but ruta 20-24 empty. Caused by
 *   supplier invoices flagged as reverse charge that booked the fiktiv
 *   moms (2614/2624/2634) without the parallel basis lines on 44xx/45xx.
 *   Fixed at the data layer by generateReverseChargeBasisLines, but we
 *   keep the check here as a safety net for legacy verifikat and direct
 *   journal entries that bypass the supplier invoice flow.
 *
 * - Reverse charge: ruta 20-24 populated but ruta 30-32 empty. The mirror
 *   case, basis booked but fiktiv moms missing. Less common but equally
 *   broken.
 *
 * - Mismatch between output RC VAT (ruta 30-32) and offsetting input VAT
 *   in ruta 48. The 2614/2645 (or 2647) pair must net to zero in the
 *   buyer's input deduction. A mismatch indicates one half of the pair
 *   was booked without the other.
 *
 * Output is consumed by the UI; ERROR findings should block "Skicka",
 * WARNING findings should surface but allow the user to proceed if they
 * understand the reason.
 */

export type VatDeclarationCheckStatus = 'ERROR' | 'WARNING'

export interface VatDeclarationCheck {
  /** Stable identifier so the UI can render specific guidance per rule. */
  code:
    | 'RC_BASIS_MISSING'
    | 'RC_OUTPUT_MISSING'
    | 'RC_INPUT_VAT_MISMATCH'
    | 'SUMMA_MOMS_DRIFT'
    | 'TAXABLE_SALES_WITHOUT_OUTPUT'
    | 'IMPORT_BASE_WITHOUT_OUTPUT'
    | 'IMPORT_OUTPUT_WITHOUT_BASE'
    | 'OUTPUT_VAT_WITHOUT_SALES_BASE'
  status: VatDeclarationCheckStatus
  /** Swedish user-facing message; safe to render directly in the UI. */
  message: string
  /** Optional rutor that the user should investigate. */
  rutor?: Array<keyof VatDeclarationRutor>
}

/**
 * Run all local checks against a calculated VatDeclarationRutor.
 *
 * Returns an empty array when the declaration looks consistent. Order
 * within the returned array is stable so the UI can rely on it for
 * snapshot tests.
 */
export function runVatDeclarationChecks(rutor: VatDeclarationRutor): VatDeclarationCheck[] {
  const findings: VatDeclarationCheck[] = []

  const rcOutput = rutor.ruta30 + rutor.ruta31 + rutor.ruta32
  const rcBasis =
    rutor.ruta20 + rutor.ruta21 + rutor.ruta22 + rutor.ruta23 + rutor.ruta24

  // Use a 0.5 SEK epsilon: values are rounded to öres in the calculator
  // and we don't want a 0.01 rounding scrap to trip a sanity check.
  const eps = 0.5

  // FK004 mirror: output RC VAT exists, basis missing.
  if (rcOutput > eps && rcBasis <= eps) {
    findings.push({
      code: 'RC_BASIS_MISSING',
      status: 'ERROR',
      message:
        'Du har redovisat utgående moms på inköp (ruta 30-32) men inget ' +
        'basbelopp för omvänd skattskyldighet (ruta 20-24). Skatteverket ' +
        'kräver att båda sidor finns med (ML 13 kap; SKV felkod FK004). ' +
        'Kontrollera att leverantörsfakturor med omvänd skattskyldighet ' +
        'är bokförda med basbelopp på 44xx/45xx-konton.',
      rutor: ['ruta20', 'ruta21', 'ruta22', 'ruta23', 'ruta24', 'ruta30', 'ruta31', 'ruta32'],
    })
  }

  // Mirror: basis present but no output VAT, equally broken, often a
  // half-finished manual posting.
  if (rcBasis > eps && rcOutput <= eps) {
    findings.push({
      code: 'RC_OUTPUT_MISSING',
      status: 'ERROR',
      message:
        'Du har redovisat basbelopp för omvänd skattskyldighet (ruta 20-24) ' +
        'men ingen utgående moms (ruta 30-32). Vid omvänd skattskyldighet ' +
        'måste köparen redovisa både underlag och fiktiv moms (ML 13 kap). ' +
        'Kontrollera att fiktiv moms är bokförd på 2614/2624/2634.',
      rutor: ['ruta20', 'ruta21', 'ruta22', 'ruta23', 'ruta24', 'ruta30', 'ruta31', 'ruta32'],
    })
  }

  // The fiktiv-moms-pair must net to zero in the buyer's input deduction.
  // We can't isolate the RC portion of ruta 48 without the breakdown, but
  // we can flag when ruta 48 is smaller than rcOutput: that means the
  // RC purchase didn't fully recover the calculated input VAT, which is
  // a strong signal that one half of the 2645/2614 pair is missing.
  if (rcOutput > eps && rutor.ruta48 + eps < rcOutput) {
    findings.push({
      code: 'RC_INPUT_VAT_MISMATCH',
      status: 'WARNING',
      message:
        'Utgående moms på omvänd skattskyldighet (ruta 30-32) är högre än ' +
        'avdragsgill ingående moms (ruta 48). Vid full avdragsrätt ska ' +
        'beräknad ingående moms (2645/2647) nolla ut den fiktiva utgående ' +
        'momsen. Kontrollera att 2645/2647 är bokförd för varje 2614/2624/2634-rad.',
      rutor: ['ruta30', 'ruta31', 'ruta32', 'ruta48'],
    })
  }

  // SKV §4.1.1.4 rule 1: taxable sales base requires output VAT.
  // If user has booked revenue (3001-3003, uttag, VMB, frivillig uthyrning)
  // without any output VAT (2611-2638), the declaration will be rejected.
  // Common cause: revenue posted but VAT line forgotten, or revenue on a
  // zero-rated account that should have been ruta 35/36/39/40.
  const taxableSalesBase = rutor.ruta05 + rutor.ruta06 + rutor.ruta07 + rutor.ruta08
  const taxableSalesOutput = rutor.ruta10 + rutor.ruta11 + rutor.ruta12
  if (taxableSalesBase > eps && taxableSalesOutput <= eps) {
    findings.push({
      code: 'TAXABLE_SALES_WITHOUT_OUTPUT',
      status: 'ERROR',
      message:
        'Du har redovisat momspliktig försäljning (ruta 05-08) men ingen ' +
        'utgående moms (ruta 10-12). Skatteverket kräver att momspliktig ' +
        'försäljning kombineras med utgående moms. Kontrollera att VAT-rader ' +
        'är bokförda på 2611/2621/2631, eller flytta intäkterna till rätt ' +
        'momsfri ruta (35/36/39/40) om de inte är momspliktiga.',
      rutor: ['ruta05', 'ruta06', 'ruta07', 'ruta08', 'ruta10', 'ruta11', 'ruta12'],
    })
  }

  // Mirror: output VAT without taxable sales base. Output VAT booked
  // standalone (e.g. manual correction without matching revenue posting)
  // would also fail SKV's contract.
  if (taxableSalesOutput > eps && taxableSalesBase <= eps) {
    findings.push({
      code: 'OUTPUT_VAT_WITHOUT_SALES_BASE',
      status: 'ERROR',
      message:
        'Du har redovisat utgående moms (ruta 10-12) men ingen momspliktig ' +
        'försäljning (ruta 05-08). Skatteverket kräver att utgående moms ' +
        'matchas med ett försäljningsunderlag. Kontrollera att intäktskonton ' +
        '(3001/3002/3003) är bokförda för varje VAT-rad.',
      rutor: ['ruta05', 'ruta06', 'ruta07', 'ruta08', 'ruta10', 'ruta11', 'ruta12'],
    })
  }

  // SKV §4.1.1.4 rule 5: import base requires import output VAT.
  const importOutput = rutor.ruta60 + rutor.ruta61 + rutor.ruta62
  if (rutor.ruta50 > eps && importOutput <= eps) {
    findings.push({
      code: 'IMPORT_BASE_WITHOUT_OUTPUT',
      status: 'ERROR',
      message:
        'Du har redovisat importunderlag (ruta 50) men ingen utgående ' +
        'importmoms (ruta 60-62). Skatteverket kräver båda. Kontrollera ' +
        'att importmoms är bokförd på 2615/2625/2635.',
      rutor: ['ruta50', 'ruta60', 'ruta61', 'ruta62'],
    })
  }

  // SKV §4.1.1.4 rule 6: import output VAT requires import base.
  // This was the canary that the Phase 1b ruta50 wiring fixed.
  if (importOutput > eps && rutor.ruta50 <= eps) {
    findings.push({
      code: 'IMPORT_OUTPUT_WITHOUT_BASE',
      status: 'ERROR',
      message:
        'Du har redovisat utgående importmoms (ruta 60-62) men inget ' +
        'importunderlag (ruta 50). Skatteverket kräver att importmoms ' +
        'kombineras med tullvärdesunderlag på 4545/4546/4547.',
      rutor: ['ruta50', 'ruta60', 'ruta61', 'ruta62'],
    })
  }

  // SummaMoms drift: sanity check that our local ruta49 matches what the
  // mapper will send. If this fires, the calculator and mapper disagree
  // and we'd hit SKV's FK009.
  const expectedRuta49 =
    rutor.ruta10 + rutor.ruta11 + rutor.ruta12 +
    rutor.ruta30 + rutor.ruta31 + rutor.ruta32 +
    rutor.ruta60 + rutor.ruta61 + rutor.ruta62 -
    rutor.ruta48
  if (Math.abs(expectedRuta49 - rutor.ruta49) > eps) {
    findings.push({
      code: 'SUMMA_MOMS_DRIFT',
      status: 'ERROR',
      message:
        'Beräknad ruta 49 (moms att betala) stämmer inte överens med summan ' +
        'av övriga rutor. Detta tyder på avrundningsfel i bokföringen. ' +
        'Kontrollera huvudboken för perioden innan inlämning.',
      rutor: ['ruta49'],
    })
  }

  return findings
}
