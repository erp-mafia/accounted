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
 * - Mismatch between output RC VAT (ruta 30-32) and the offsetting input
 *   VAT on 2645/2647. The 2614/2645 (or 2647) pair must net to zero in the
 *   buyer's input deduction, so a shortfall means one half of the pair was
 *   booked without the other. Compared against those two accounts when the
 *   caller supplies per-account totals, and against the ruta 48 aggregate
 *   otherwise.
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
    | 'SALES_OUTPUT_VAT_SHORTFALL'
  status: VatDeclarationCheckStatus
  /** Swedish user-facing message; safe to render directly in the UI. */
  message: string
  /** Optional rutor that the user should investigate. */
  rutor?: Array<keyof VatDeclarationRutor>
}

/**
 * Per-account debit/credit totals for the declared period, keyed by BAS account
 * number. Exactly the shape `fetchVatAccountTotals()` returns
 * (`VatAccountTotals.totals`) and `rutorFromTotals()` consumes, so a caller that
 * already has the totals passes them straight through without deriving anything
 * of its own.
 */
export type VatCheckAccountTotals = ReadonlyMap<string, { debit: number; credit: number }>

/**
 * The two BAS accounts that carry the deductible input half of an omvänd-
 * skattskyldighet purchase, per BAS 2026:
 *
 *   2645 Beräknad ingående moms på förvärv från utlandet (EU + non-EU)
 *   2647 Ingående moms, omvänd betalningsskyldighet i Sverige (ML 16 kap:
 *        byggtjänster, skrot, guld, mobiler/datorer över 100 000 kr)
 *
 * The other five accounts ACCOUNT_RUTA maps to ruta 48 are NOT reverse charge
 * and are deliberately excluded: 2641 (debiterad ingående moms, i.e. VAT
 * actually invoiced to us, which a reverse-charge invoice by definition never
 * carries; also where the import flow books its deductible import VAT), 2640
 * (the summary parent), 2642 (frivillig betalningsskyldighet), 2646 (uthyrning)
 * and 2649 (blandad verksamhet, the deductible portion of shared costs in
 * general). Counting 2649 as RC input would reintroduce exactly the aggregation
 * this check exists to remove.
 */
const RC_INPUT_ACCOUNTS = ['2645', '2647'] as const

/** Period debit balance (debit minus credit) of 2645 + 2647. */
function reverseChargeInputVat(accountTotals: VatCheckAccountTotals): number {
  let sum = 0
  for (const account of RC_INPUT_ACCOUNTS) {
    const t = accountTotals.get(account)
    if (t) sum += t.debit - t.credit
  }
  return Math.round(sum * 100) / 100
}

/**
 * Run all local checks against a calculated VatDeclarationRutor.
 *
 * `accountTotals` is optional and only sharpens `RC_INPUT_VAT_MISMATCH`: with it
 * the check compares the reverse-charge output against the reverse-charge INPUT
 * accounts, without it against the ruta 48 aggregate (see there). Every other
 * check reads the rutor alone.
 *
 * Returns an empty array when the declaration looks consistent. Order
 * within the returned array is stable so the UI can rely on it for
 * snapshot tests.
 */
export function runVatDeclarationChecks(
  rutor: VatDeclarationRutor,
  accountTotals?: VatCheckAccountTotals,
): VatDeclarationCheck[] {
  const findings: VatDeclarationCheck[] = []

  const rcOutput = rutor.ruta30 + rutor.ruta31 + rutor.ruta32
  const rcBasis =
    rutor.ruta20 + rutor.ruta21 + rutor.ruta22 + rutor.ruta23 + rutor.ruta24

  // Use a 0.5 SEK epsilon: values are rounded to öres in the calculator
  // and we don't want a 0.01 rounding scrap to trip a sanity check.
  const eps = 0.5

  // The basis the per-rate output boxes imply (basbelopp = fiktiv moms / sats).
  // The RC checks compare reported basis against this instead of testing mere
  // presence: a binary present/absent test clears as soon as ONE voucher in
  // the period carries a basis pair, silently passing a declaration where the
  // remaining vouchers still under-report rutor 20-24 (FK004).
  const expectedRcBasis =
    rutor.ruta30 / 0.25 + rutor.ruta31 / 0.12 + rutor.ruta32 / 0.06
  // Per-voucher öre rounding (basis derived as moms/sats vs the invoiced
  // amount) accumulates with voucher count; 0.5% with a 1 kr floor absorbs
  // that without hiding a genuinely missing voucher.
  const rcTolerance = Math.max(1, expectedRcBasis * 0.005)

  // FK004 mirror: output RC VAT exists, basis missing or too low.
  if (rcOutput > eps && rcBasis + rcTolerance < expectedRcBasis) {
    const shortfall = Math.round(expectedRcBasis - rcBasis)
    findings.push({
      code: 'RC_BASIS_MISSING',
      status: 'ERROR',
      message:
        'Den utgående momsen på inköp (ruta 30-32) motsvarar ett basbelopp ' +
        `på cirka ${Math.round(expectedRcBasis).toLocaleString('sv-SE')} kr, ` +
        'men ruta 20-24 innehåller bara ' +
        `${Math.round(rcBasis).toLocaleString('sv-SE')} kr: cirka ` +
        `${shortfall.toLocaleString('sv-SE')} kr saknas. Skatteverket kräver ` +
        'att båda sidor finns med (ML 13 kap; SKV felkod FK004). Kontrollera ' +
        'att leverantörsfakturor med omvänd skattskyldighet är bokförda med ' +
        'basbelopp på 44xx/45xx-konton.',
      rutor: ['ruta20', 'ruta21', 'ruta22', 'ruta23', 'ruta24', 'ruta30', 'ruta31', 'ruta32'],
    })
  }

  // Mirror: more basis than the output VAT accounts for, fiktiv moms missing
  // for some vouchers. Covers both the all-output-missing case and a partial
  // one; often a half-finished manual posting.
  if (rcBasis > eps && rcBasis > expectedRcBasis + rcTolerance) {
    findings.push({
      code: 'RC_OUTPUT_MISSING',
      status: 'ERROR',
      message:
        'Basbeloppet för omvänd skattskyldighet (ruta 20-24) är större än ' +
        'vad den utgående momsen (ruta 30-32) motsvarar. Vid omvänd ' +
        'skattskyldighet måste köparen redovisa både underlag och fiktiv ' +
        'moms (ML 13 kap). Kontrollera att fiktiv moms är bokförd på ' +
        '2614/2624/2634 för varje inköp.',
      rutor: ['ruta20', 'ruta21', 'ruta22', 'ruta23', 'ruta24', 'ruta30', 'ruta31', 'ruta32'],
    })
  }

  // The fiktiv-moms pair must net to zero in the buyer's input deduction when
  // the buyer has full avdragsrätt: the engine debits 2645 (or 2647) with
  // exactly the amount it credits to 2614/2624/2634 inside the same verifikat
  // (vat-entries.ts), so the two period sums match öre for öre and need no
  // percentage tolerance.
  //
  // Compared against the RC INPUT ACCOUNTS, not against ruta 48, whenever the
  // caller hands us the per-account totals. Ruta 48 aggregates 2640 + 2641 +
  // 2642 + 2645 + 2646 + 2647 + 2649, so ordinary debiterad ingående moms hides a
  // missing RC input entirely: 50 000 kr of utgående moms on ruta 30 with
  // nothing on 2645, alongside 60 000 kr of ordinary 2641, leaves ruta 48 above
  // rcOutput and the aggregate test silent while the company pays in 50 000 kr
  // it was entitled to deduct, recoverable only through omprövning.
  //
  // Without the totals we fall back to the weaker necessary condition
  // ruta 48 >= rutor 30-32. Still sound (ruta 48 contains the RC input, so a
  // total below rcOutput proves the RC input is short) but blind to any
  // shortfall smaller than the ordinary input VAT sitting in the same box.
  const rcInputVat = accountTotals ? reverseChargeInputVat(accountTotals) : null
  const rcInputFloor = rcInputVat ?? rutor.ruta48
  if (rcOutput > eps && rcInputFloor + eps < rcOutput) {
    const shortfall = Math.round(rcOutput - rcInputFloor)
    findings.push({
      code: 'RC_INPUT_VAT_MISMATCH',
      status: 'WARNING',
      message:
        rcInputVat === null
          ? 'Utgående moms på omvänd skattskyldighet (ruta 30-32) är högre än ' +
            'avdragsgill ingående moms (ruta 48). Vid full avdragsrätt ska ' +
            'beräknad ingående moms (2645/2647) nolla ut den fiktiva utgående ' +
            'momsen. Kontrollera att 2645/2647 är bokförd för varje 2614/2624/2634-rad.'
          : 'Utgående moms på omvänd skattskyldighet (ruta 30-32) är ' +
            `${Math.round(rcOutput).toLocaleString('sv-SE')} kr, men den beräknade ` +
            'ingående momsen på 2645/2647 är bara ' +
            `${Math.round(rcInputVat).toLocaleString('sv-SE')} kr: cirka ` +
            `${shortfall.toLocaleString('sv-SE')} kr saknas. Vid full avdragsrätt ` +
            'ska 2645 (förvärv från utlandet) eller 2647 (omvänd skattskyldighet ' +
            'i Sverige) nolla ut den fiktiva utgående momsen; annars betalar du ' +
            'in moms som du hade rätt att dra av. Kontrollera att en ingående rad ' +
            'finns för varje 2614/2624/2634-rad. Är avdragsrätten begränsad ' +
            '(blandad verksamhet, personbil, representation) är skillnaden ' +
            'korrekt och kan lämnas som den är.',
      rutor: ['ruta30', 'ruta31', 'ruta32', 'ruta48'],
    })
  }

  // SKV §4.1.1.4 rule 1: taxable sales base requires output VAT.
  // If user has booked revenue (3001-3003, uttag, VMB, frivillig uthyrning)
  // without any output VAT (2611-2638), the declaration will be rejected.
  // Common cause: revenue posted but VAT line forgotten, or revenue on a
  // zero-rated account that should have been ruta 35/36/39/40.
  //
  // DELIBERATELY BINARY, unlike the RC and import pairs. The proportional form
  // (rutor 05-08 vs ruta10/0.25 + ruta11/0.12 + ruta12/0.06) is NOT sound on
  // the sales side as a filing-blocking ERROR, because ACCOUNT_RUTA's two
  // halves are not a closed set:
  //   - rutor 07 (VMB) and 08 (frivillig uthyrning) have NO source accounts at
  //     all, while their output VAT (2616/2626/2636, 2613/2623/2633) does feed
  //     rutor 10-12, so the implied base permanently exceeds the reported one;
  //   - ruta 05 recognises only 3001/3002/3003, but an invoice line may carry
  //     any revenue_account override (3590, 3910, ...) while its moms still
  //     lands on 2611/2621/2631;
  //   - periodiserade invoice lines credit the 29xx interim account with the
  //     full moms untouched on 2611 (invoice-entries.ts), then credit 3001 with
  //     no moms in each dissolution month, so both directions drift by design.
  // Any of those would turn a proportional check into a permanent filing-
  // blocking ERROR (isFilingBlocked) on a correct declaration. Making rutor 07
  // and 08 mappable and reconciling the revenue_account override is the
  // prerequisite; see the report accompanying this change.
  //
  // ONE direction is proportionally checkable without blocking: see
  // SALES_OUTPUT_VAT_SHORTFALL below.
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
        'matchas med ett försäljningsunderlag. Kontrollera att momspliktiga ' +
        'intäktskonton är bokförda för varje momsrad. Om ett försäljningskonto ' +
        'saknas i ruta 05, kontrollera att kontots "Standard moms" är rätt ' +
        'inställd i kontoplanen.',
      rutor: ['ruta05', 'ruta06', 'ruta07', 'ruta08', 'ruta10', 'ruta11', 'ruta12'],
    })
  }

  // Proportional tightening of the sales pair, WARNING tier only. The binary
  // ERROR above clears as soon as ANY output VAT exists, so at a 400 000 kr
  // sales base 2 000 kr of missing utgående moms still rendered a green
  // "Inga fel hittades" banner: undeclared moms and skattetillägg exposure
  // under SFL 49 kap 4 §.
  //
  // Only THIS direction (reported base implies more output VAT than rutor
  // 10-12 carry) is proportionally checkable: every unmapped drift source
  // listed above (VMB, frivillig uthyrning, revenue_account overrides,
  // periodisering in the invoice month) inflates the OUTPUT side and can only
  // suppress this finding, never trigger it. The one legitimate trigger is
  // periodiserade invoice lines dissolving (3001 credited with the moms
  // already declared in the invoice month), which is why this is a WARNING
  // that names that cause and never blocks filing (isFilingBlocked reads
  // ERROR only), following the RC_INPUT_VAT_MISMATCH precedent.
  //
  // The base comparison is exact per rate (basbelopp = moms/sats summed over
  // 25/12/6), so legitimate mixed-rate declarations net to zero drift; the
  // shared max(1 kr, 0.5%) tolerance absorbs per-voucher öre rounding.
  const expectedSalesBase =
    rutor.ruta10 / 0.25 + rutor.ruta11 / 0.12 + rutor.ruta12 / 0.06
  const salesTolerance = Math.max(1, expectedSalesBase * 0.005)
  if (taxableSalesOutput > eps && taxableSalesBase > expectedSalesBase + salesTolerance) {
    const shortfall = Math.round(taxableSalesBase - expectedSalesBase)
    findings.push({
      code: 'SALES_OUTPUT_VAT_SHORTFALL',
      status: 'WARNING',
      message:
        'Den momspliktiga försäljningen (ruta 05-08) är ' +
        `${Math.round(taxableSalesBase).toLocaleString('sv-SE')} kr, men den ` +
        'utgående momsen (ruta 10-12) motsvarar bara ett underlag på cirka ' +
        `${Math.round(expectedSalesBase).toLocaleString('sv-SE')} kr: cirka ` +
        `${shortfall.toLocaleString('sv-SE')} kr av försäljningen saknar ` +
        'utgående moms. Kontrollera att momsrader (2611/2621/2631) är ' +
        'bokförda för varje intäktsrad, eller flytta momsfri försäljning till ' +
        'rätt ruta (35/36/39/40). Använder du periodisering av fakturarader ' +
        'är skillnaden korrekt (momsen redovisas i fakturamånaden, intäkten ' +
        'löpande) och varningen kan lämnas utan åtgärd.',
      rutor: ['ruta05', 'ruta06', 'ruta07', 'ruta08', 'ruta10', 'ruta11', 'ruta12'],
    })
  }

  // SKV §4.1.1.4 rules 5 and 6: import base and import output VAT require each
  // other. Compared PROPORTIONALLY, not by presence, for the same reason the
  // RC pair above is: a binary test clears as soon as ONE import voucher
  // carries both halves, so a period where the rest still miss their utgående
  // importmoms passes silently and the difference is undeclared moms.
  //
  // The implied base is exact here. ruta 50 is fed only by 4545/4546/4547
  // ("Import av råvaror och material, 25/12/6 % moms") and ruta 60/61/62 only
  // by 2615/2625/2635 (import 25/12/6%): a closed one-to-one set at exactly
  // those three rates, so basbelopp = importmoms / sats with no other account
  // able to land in either side. VAT-free imports use 4540, which is not
  // mapped to any ruta.
  const importOutput = rutor.ruta60 + rutor.ruta61 + rutor.ruta62
  const expectedImportBase =
    rutor.ruta60 / 0.25 + rutor.ruta61 / 0.12 + rutor.ruta62 / 0.06
  // Same convention as the RC pair: per-voucher öre rounding (basis derived as
  // moms/sats vs the declared tullvärde) accumulates with voucher count, so
  // 0.5% with a 1 kr floor absorbs it without hiding a missing voucher.
  const importTolerance = Math.max(1, expectedImportBase * 0.005)

  // Rule 5: import base larger than the output importmoms accounts for, i.e.
  // some imports were booked on 4545/4546/4547 without their 26x5 moms.
  if (rutor.ruta50 > eps && rutor.ruta50 > expectedImportBase + importTolerance) {
    const shortfall = Math.round(rutor.ruta50 - expectedImportBase)
    findings.push({
      code: 'IMPORT_BASE_WITHOUT_OUTPUT',
      status: 'ERROR',
      message:
        `Importunderlaget (ruta 50) är ${Math.round(rutor.ruta50).toLocaleString('sv-SE')} kr, ` +
        'men den utgående importmomsen (ruta 60-62) motsvarar bara ett ' +
        `underlag på cirka ${Math.round(expectedImportBase).toLocaleString('sv-SE')} kr: ` +
        `cirka ${shortfall.toLocaleString('sv-SE')} kr av underlaget saknar ` +
        'utgående moms. Skatteverket kräver båda. Kontrollera att importmoms ' +
        'är bokförd på 2615/2625/2635 för varje import.',
      rutor: ['ruta50', 'ruta60', 'ruta61', 'ruta62'],
    })
  }

  // Rule 6: output importmoms larger than the reported base, i.e. the
  // tullvärdesunderlag is missing or too low. This was the canary that the
  // Phase 1b ruta50 wiring fixed.
  if (importOutput > eps && rutor.ruta50 + importTolerance < expectedImportBase) {
    const shortfall = Math.round(expectedImportBase - rutor.ruta50)
    findings.push({
      code: 'IMPORT_OUTPUT_WITHOUT_BASE',
      status: 'ERROR',
      message:
        'Den utgående importmomsen (ruta 60-62) motsvarar ett ' +
        `beskattningsunderlag på cirka ${Math.round(expectedImportBase).toLocaleString('sv-SE')} kr, ` +
        `men ruta 50 innehåller bara ${Math.round(rutor.ruta50).toLocaleString('sv-SE')} kr: ` +
        `cirka ${shortfall.toLocaleString('sv-SE')} kr saknas. Skatteverket ` +
        'kräver att importmoms kombineras med tullvärdesunderlag på ' +
        '4545/4546/4547.',
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
