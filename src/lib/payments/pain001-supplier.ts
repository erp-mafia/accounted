/**
 * pain.001 (ISO 20022) payment file generator for supplier payments
 * (leverantorsbetalningar).
 *
 * Dialect: Swedish DOMESTIC giro credit transfers per the Swedish Common
 * Interpretation of ISO 20022 payment messages (Svenska Bankforeningen,
 * "Common Payment Types in Sweden", Appendix 1), cross-checked against
 * Nordea Corporate Access Payables pain.001 examples v2.6 (2026-06-22) and
 * validated against Swedbank Validex (eken.validex.net, Swedbank MIG 1.0,
 * run 2026-08-10). Target banks: Swedbank, SEB, Handelsbanken, Nordea
 * (pain.001.001.03 uploaded in the corporate portal).
 *
 * Wire-format constraints this file encodes (do not "improve" without a
 * bank implementation guide in hand):
 *
 *  - No SvcLvl element: SvcLvl SEPA means a SEPA credit transfer (EUR-only);
 *    the domestic default (NURG) applies when SvcLvl is omitted. No CtgyPurp:
 *    SALA/PENS mark salary rails; supplier giro payments are plain transfers.
 *  - Bankgiro payees are addressed through Bankgirot: CdtrAgt ClrSysMmbId
 *    SESBA member 9900, CdtrAcct/Id/Othr with the bare BG digits and
 *    SchmeNm/Prtry BGNR. Plusgiro payees route SESBA member 9960 with
 *    SchmeNm/Cd BBAN. Bank-account payees use the clearing number as the
 *    SESBA member and the account as BBAN in the form the debtor's bank
 *    reads (creditor-account.ts: without the clearing for most banks, with
 *    it for Danske Bank and Nordea), through the same encoder and
 *    resolveDomesticBankAccount as the salary file, so the files can never
 *    route an account differently.
 *  - Swedbank MIG (Validex PFH_pain_001_001_03_219): a BGNR creditor demands
 *    a BGNR debtor. When the company has a bankgiro, bankgiro-payee payments
 *    are grouped into their own PmtInf debited from the company bankgiro
 *    (DbtrAcct Othr/BGNR); other payees are debited from the IBAN.
 *  - That rule is Swedbank MIG 1.0's, not a property of the payee: which
 *    debit account a bankgiro payment takes is decided by the DEBTOR'S bank.
 *    Danske Bank and Nordea take it from the account only, so there every
 *    payee is debited from the IBAN (IBAN_DEBIT_FOR_BANKGIRO_PAYEES below,
 *    keyed on the DbtrAgt BIC). Swedbank itself now gets the ISO 2.0 form
 *    below. No other bank's guide has been applied yet: every other bank
 *    keeps this MIG 1.0 form.
 *  - Creditor postal address ALWAYS (Validex round 3, rule PFH_237 fires on
 *    the BGNR path too, overriding what rule 020's phrasing suggested), and
 *    a present PstlAdr must carry TwnNm (rule PFH_222, enforced now): the
 *    supplier's town when known, plus Ctry SE (v1 is domestic-only). A payee
 *    without a town yields a Ctry-only address that Swedbank rejects, so the
 *    preview warns when the supplier register lacks a city. The debtor
 *    address rides along the same way from company settings.
 *  - InitgPty and Dbtr always carry OrgId (Validex PFH_002: InitgPty
 *    other/Id must be stated); the batch service refuses to create a batch
 *    for a company without an organisationsnummer.
 *  - A Luhn-valid OCR reference rides RmtInf/Strd with the amount repeated
 *    as RfrdDocAmt/RmtdAmt (Validex PFH_217) and CdtrRefInf type SCOR,
 *    exactly one per transaction. Anything else is an unstructured
 *    RmtInf/Ustrd message (the giro "meddelande" field).
 *  - Free text is restricted to the MIG character set (Validex PFH_214):
 *    Swedish letters survive, other accented letters transliterate (e for
 *    e-acute, u for u-umlaut), anything else becomes '?'. Identifiers and
 *    references are ASCII digits by construction.
 *  - MsgId, PmtInfId, InstrId and EndToEndId are Max35Text.
 *  - ReqdExctnDt sits on PmtInf, so payments are grouped into one PmtInf per
 *    distinct (payment date, debtor account form).
 *  - Determinism: CreDtTm comes from the caller (the batch row's created_at),
 *    never from the clock, so re-generating a stored batch is byte-identical
 *    for the same generator version and bank-side duplicate detection (keyed
 *    on MsgId) stays meaningful.
 *
 * Swedbank ISO 2.0 (debtor.swedbank set). Swedbank's internet bank validates
 * an uploaded file against its MIG 2.0 (pain.001.001.03 version 2.0.0,
 * 2026-03-09, published as preliminary; Appendix v2.1.0), which refused the
 * form above ("Aktivt id för fullmaktshavare saknas", crm#1117). A Swedbank
 * debtor with both Swedbank ids gets that guide's form instead:
 *
 *  - InitgPty/Id/OrgId/Othr/Id is the SignerID and Dbtr/Id/OrgId/Othr/Id the
 *    Corporate Pay agreement id, both with SchmeNm/Cd BANK; the org number
 *    appears nowhere.
 *  - PmtTpInf SvcLvl NURG + CtgyPurp SUPP: the appendix makes that pair a
 *    supplier payment; without CtgyPurp it is an account transfer.
 *  - Every payee is debited from the IBAN: MIG 2.0 takes IBAN or BBAN as the
 *    debtor account and has no BGNR form, so MIG 1.0's rule 219 is gone.
 *  - Dbtr/PstlAdr always (Ctry SE, TwnNm when known); DbtrAgt is BIC
 *    SWEDSESS, the one value MIG 2.0 allows, plus PstlAdr/Ctry SE.
 *  - Swedbank's 2.0 service pays to bank accounts only today, so the batch
 *    and tax-account callers never hand this form a bankgiro or plusgiro
 *    payee (swedbankIso2PaysPayee, crm#1156). The alias form below is the
 *    one MIG 2.0 describes, kept for when Swedbank offers it.
 *  - Plusgiro payees use SchmeNm/Prtry PGNR. An account whose clearing
 *    starts with 8 is MmbId 8CCCC and a 15-digit BBAN (lib/payments/swedbank).
 *  - An OCR rides Strd only to a bankgiro or plusgiro payee, and without
 *    RfrdDocAmt (MIG 2.0: only with extended remittance; RmtdAmt only with
 *    CINV; one reference is at most 140 characters). To a bank account an
 *    OCR is the Ustrd message: Swedbank takes only RF references there.
 *  - Free text drops the apostrophe, which MIG 2.0's character set lacks.
 *
 * A Swedbank debtor without the ids (a batch created before 2026-10-11)
 * renders in the MIG 1.0 form, byte for byte, so a stored file never changes.
 *
 * Nordea (lib/payments/nordea.ts, crm#1530). InitgPty/Id/OrgId/Othr/Id is
 * the Signer ID with SchmeNm/Cd CUST (debtor.nordeaSignerId), which Nordea's
 * upload checks against the file agreement. With the CCM agreement id
 * (debtor.nordeaAgreementId) the file takes the form of Nordea's Corporate
 * Access Payables guide and its Sweden examples:
 *
 *  - Dbtr/Id/OrgId/Othr/Id is the agreement id with SchmeNm/Cd BANK
 *    ("mandatory"): Nordea matches the file to the agreement by it, and
 *    rejected the org number after upload.
 *  - Dbtr/PstlAdr always, Ctry SE ("Debtor Name, Country and Identification
 *    are required"), TwnNm when known.
 *  - PmtTpInf SvcLvl NURG + CtgyPurp SUPP, as the examples write them.
 *
 * A Nordea batch made before the agreement id was stored renders as it was
 * first downloaded. Which ids InitgPty and Dbtr carry is decided for every
 * bank in lib/payments/initiating-party.ts.
 *
 * Per BFL: the generated file is rakenskapsinformation (underlag) for the
 * payments it initiates. Subject to 7-year retention.
 */

import { escapeXml } from '@/lib/xml/escape'
import { formatPainAmount, max35, painControlSum, suffixId } from './pain001-format'
import { creditorAccountForm, domesticCreditorAccount, type CreditorAccountForm } from './creditor-account'
import { sanitizeMigText } from './mig-text'
import { debtorPartyId, initiatingPartyId } from './initiating-party'
import { SWEDBANK_BIC, type SwedbankFileIds } from './swedbank'
import type { PaymentReference, SupplierPayee } from './supplier-payee'

export interface SupplierPain001Debtor {
  name: string
  orgNumber: string
  iban: string
  /** DbtrAgt BIC. Also names the bank whose debit account rule applies. */
  bic: string
  /**
   * Company bankgiro (digits); enables the BGNR-to-BGNR debit Swedbank MIG
   * 1.0 wants. Never debited at a bank in IBAN_DEBIT_FOR_BANKGIRO_PAYEES
   * (Danske Bank, Nordea), nor in a Swedbank ISO 2.0 file.
   */
  bankgiro?: string | null
  /** Company town; emitted as Dbtr/PstlAdr/TwnNm when present. */
  city?: string | null
  /**
   * Swedbank SignerID and Corporate Pay agreement id: present only for a
   * Swedbank debtor that has both, and then the file takes Swedbank's ISO
   * 2.0 form (see the header). Absent on batches created before 2026-10-11,
   * which render in their original form.
   */
  swedbank?: SwedbankFileIds | null
  /**
   * Nordea's Signer ID: present only for a Nordea debtor, written as the
   * InitgPty id. Absent on batches created before crm#1530, which render in
   * their original form.
   */
  nordeaSignerId?: string | null
  /**
   * Nordea's CCM agreement id: present only for a Nordea debtor, written as
   * the Dbtr id, and the file then takes Nordea's form (see the header).
   * Absent on batches created before it was stored, which render in their
   * original form.
   */
  nordeaAgreementId?: string | null
}

export interface SupplierPain001Payment {
  payee: SupplierPayee
  payeeName: string
  /** Supplier town; Cdtr/PstlAdr/TwnNm on IBAN-debited payments when known. */
  payeeCity?: string | null
  amount: number
  /** YYYY-MM-DD requested execution date. */
  paymentDate: string
  reference: PaymentReference
}

export interface SupplierPain001Options {
  /** Stored batch msg_id; reused verbatim on regeneration. */
  messageId: string
  /** Batch created_at (ISO timestamp): becomes CreDtTm, NOT the clock. */
  createdAt: string
}

/** The receiver-side giro message field is 25 positions; keep Ustrd within it. */
const USTRD_MAX = 25

/**
 * Debtor banks, by 8-character BIC, that take a payment to a bankgiro number
 * from the bank account (IBAN) only, never from the company bankgiro.
 *
 * DABASESX, Danske Bank: "Danske Bank Message Implementation Guide (CGI-MP),
 * Supported payment types and examples" for pain.001.001.03, version 5.3
 * (2026-08-18). A bankgiro as debtor account (Othr/BGNR) is offered for
 * Swedish salary and Swedish account transfer only; all four "Swedish
 * Bankgiro payment" samples and all four "Swedish account transfer with
 * Bankgiro Alias" samples debit DbtrAcct/Id/IBAN with DbtrAgt BIC DABASESX.
 * A bankgiro payment debited from the company bankgiro is refused there: the
 * debit account is invalid (support ticket 137).
 *
 * NDEASESS, Nordea: "Corporate Access Payables, Appendix Sweden" (2026-10-08),
 * section 2.3.4, Structure of BBAN account numbers at debit level in
 * payments: "Bankgiro number is not to be used as a debtors account." Section
 * 2.3.1 offers IBAN or BBAN as the debtor account for Sweden, nothing else.
 *
 * Every bank not listed keeps the bankgiro debit, except Swedbank in its ISO
 * 2.0 form, which debits the IBAN for every payee (see the header). List a
 * bank only with its own implementation guide in hand.
 */
const IBAN_DEBIT_FOR_BANKGIRO_PAYEES: ReadonlySet<string> = new Set(['DABASESX', 'NDEASESS'])

/**
 * Whether the debtor's bank debits the IBAN for a bankgiro payee. The BIC is
 * read as its bank part: whitespace removed, upper case, first 8 characters,
 * so 'dabasesx', ' DABASESX ' and 'DABASESXXXX' all name the same bank.
 */
function debitsIbanForBankgiroPayees(bic: string): boolean {
  return IBAN_DEBIT_FOR_BANKGIRO_PAYEES.has(bic.replace(/\s/g, '').toUpperCase().slice(0, 8))
}

export function generateSupplierPain001(
  debtor: SupplierPain001Debtor,
  payments: SupplierPain001Payment[],
  options: SupplierPain001Options,
): string {
  if (payments.length === 0) {
    throw new Error('Betalfilen måste innehålla minst en betalning')
  }

  const creDtTm = new Date(options.createdAt).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const msgId = max35(options.messageId)
  const orgDigits = debtor.orgNumber.replace(/\D/g, '')
  if (!orgDigits) {
    // Validex PFH_002: InitgPty other/Id must be stated. The batch service
    // guarantees this; a missing org number here is a programming error.
    throw new Error('Organisationsnummer saknas för betalfilens avsändare')
  }
  // Swedbank's ISO 2.0 form, chosen by the presence of both Swedbank ids.
  const swedbank = debtor.swedbank ?? null
  // Nordea's form, chosen by the presence of the CCM agreement id.
  const nordea = !swedbank && Boolean(debtor.nordeaAgreementId)
  const text = (value: string) => sanitizeMigText(value, swedbank ? { apostrophe: false } : {})
  // The company bankgiro is a debit account only where the debtor's bank takes
  // one for a bankgiro payment; at Danske Bank and Nordea, and in a Swedbank
  // ISO 2.0 file (MIG 2.0 DbtrAcct: IBAN or BBAN only), it is left out of
  // the file.
  const debtorBankgiro = swedbank || debitsIbanForBankgiroPayees(debtor.bic)
    ? ''
    : (debtor.bankgiro ?? '').replace(/\D/g, '')
  const debtorName = text(debtor.name)
  // How a bank-account payee is written: the debtor bank's form, as it reads the file.
  const accountForm = creditorAccountForm(debtor.bic, swedbank)
  // Sum the per-transaction amounts exactly as they are rendered (rounded to
  // ore): CtrlSum must equal the sum of the InstdAmt values or banks reject
  // the file, and summing raw floats then rounding once can differ by an ore.
  const totalAmount = sumRendered(payments)

  // One PmtInf per distinct (execution date, debtor account form): a BGNR
  // creditor must debit the company bankgiro (Swedbank MIG 1.0 rule 219),
  // everything else debits the IBAN, and ReqdExctnDt is PmtInf-level. Original
  // order is preserved within a group so the file reads like the batch it
  // came from.
  const byGroup = new Map<string, SupplierPain001Payment[]>()
  for (const payment of payments) {
    const bgnrDebit = debtorBankgiro !== '' && payment.payee.type === 'bankgiro'
    const key = `${payment.paymentDate}|${bgnrDebit ? 'bgnr' : 'acct'}`
    const group = byGroup.get(key)
    if (group) group.push(payment)
    else byGroup.set(key, [payment])
  }
  const groupKeys = [...byGroup.keys()].sort()

  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"')
  lines.push('  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">')
  lines.push('  <CstmrCdtTrfInitn>')

  lines.push('    <GrpHdr>')
  lines.push(`      <MsgId>${escapeXml(msgId)}</MsgId>`)
  lines.push(`      <CreDtTm>${creDtTm}</CreDtTm>`)
  lines.push(`      <NbOfTxs>${payments.length}</NbOfTxs>`)
  lines.push(`      <CtrlSum>${formatPainAmount(totalAmount)}</CtrlSum>`)
  lines.push('      <InitgPty>')
  lines.push(`        <Nm>${escapeXml(debtorName)}</Nm>`)
  lines.push('        <Id>')
  lines.push('          <OrgId>')
  // The sender as the debtor's bank knows it (initiating-party.ts): the
  // SignerID at Swedbank (BANK), the Signer ID at Nordea (CUST), the org
  // number elsewhere. An org number there is what both banks refused.
  const initiator = initiatingPartyId(debtor) ?? { id: orgDigits, scheme: null }
  if (initiator.scheme) {
    pushSchemedId(lines, initiator.id, initiator.scheme)
  } else {
    lines.push(`            <Othr><Id>${escapeXml(initiator.id)}</Id></Othr>`)
  }
  lines.push('          </OrgId>')
  lines.push('        </Id>')
  lines.push('      </InitgPty>')
  lines.push('    </GrpHdr>')

  let txCounter = 0
  for (let g = 0; g < groupKeys.length; g++) {
    const key = groupKeys[g]
    const [date, form] = key.split('|')
    const group = byGroup.get(key) as SupplierPain001Payment[]
    const groupTotal = sumRendered(group)
    const bgnrDebit = form === 'bgnr'

    lines.push('    <PmtInf>')
    lines.push(`      <PmtInfId>${escapeXml(suffixId(msgId, `-P${g + 1}`))}</PmtInfId>`)
    lines.push('      <PmtMtd>TRF</PmtMtd>')
    lines.push('      <BtchBookg>true</BtchBookg>')
    lines.push(`      <NbOfTxs>${group.length}</NbOfTxs>`)
    lines.push(`      <CtrlSum>${formatPainAmount(groupTotal)}</CtrlSum>`)
    if (swedbank || nordea) {
      // Swedbank's Appendix, Supplier Payments: "requested using the
      // CategoryPurpose code of SUPP (Supplier Payment) and ServiceLevel code
      // NURG"; Nordea's Sweden examples write the same pair. XSD order:
      // PmtTpInf after CtrlSum, SvcLvl before CtgyPurp.
      lines.push('      <PmtTpInf>')
      lines.push('        <SvcLvl><Cd>NURG</Cd></SvcLvl>')
      lines.push('        <CtgyPurp><Cd>SUPP</Cd></CtgyPurp>')
      lines.push('      </PmtTpInf>')
    }
    lines.push(`      <ReqdExctnDt>${date}</ReqdExctnDt>`)
    lines.push('      <Dbtr>')
    lines.push(`        <Nm>${escapeXml(debtorName)}</Nm>`)
    // XSD order in PostalAddress6: TwnNm before Ctry; PstlAdr before Id. MIG
    // 2.0 marks Dbtr/PstlAdr and its Ctry required, and Nordea's guide the
    // debtor's country, so Swedbank and Nordea always get one.
    if (swedbank || nordea || debtor.city?.trim()) {
      lines.push('        <PstlAdr>')
      if (debtor.city?.trim()) {
        lines.push(`          <TwnNm>${escapeXml(text(debtor.city.trim()))}</TwnNm>`)
      }
      lines.push('          <Ctry>SE</Ctry>')
      lines.push('        </PstlAdr>')
    }
    lines.push('        <Id>')
    lines.push('          <OrgId>')
    // The debtor as its bank knows it (initiating-party.ts): Swedbank's
    // Corporate Pay agreement id and Nordea's CCM agreement id (both BANK),
    // the org number elsewhere.
    const debtorId = debtorPartyId(debtor) ?? { id: orgDigits, scheme: null }
    if (debtorId.scheme) {
      pushSchemedId(lines, debtorId.id, debtorId.scheme)
    } else {
      lines.push(`            <Othr><Id>${escapeXml(debtorId.id)}</Id></Othr>`)
    }
    lines.push('          </OrgId>')
    lines.push('        </Id>')
    lines.push('      </Dbtr>')
    lines.push('      <DbtrAcct>')
    lines.push('        <Id>')
    if (bgnrDebit) {
      lines.push('          <Othr>')
      lines.push(`            <Id>${escapeXml(debtorBankgiro)}</Id>`)
      lines.push('            <SchmeNm><Prtry>BGNR</Prtry></SchmeNm>')
      lines.push('          </Othr>')
    } else {
      lines.push(`          <IBAN>${escapeXml(debtor.iban)}</IBAN>`)
    }
    lines.push('        </Id>')
    lines.push('        <Ccy>SEK</Ccy>')
    lines.push('      </DbtrAcct>')
    lines.push('      <DbtrAgt>')
    lines.push('        <FinInstnId>')
    if (swedbank) {
      // MIG 2.0 DbtrAgt BIC: SWEDSESS is the one value allowed (a stored
      // 'swedsessxxx' would not match), and PstlAdr/Ctry is required.
      lines.push(`          <BIC>${SWEDBANK_BIC}</BIC>`)
      lines.push('          <PstlAdr><Ctry>SE</Ctry></PstlAdr>')
    } else {
      lines.push(`          <BIC>${escapeXml(debtor.bic)}</BIC>`)
    }
    lines.push('        </FinInstnId>')
    lines.push('      </DbtrAgt>')

    for (const payment of group) {
      txCounter += 1
      const txId = suffixId(msgId, `-TX${String(txCounter).padStart(4, '0')}`)

      lines.push('      <CdtTrfTxInf>')
      lines.push('        <PmtId>')
      lines.push(`          <InstrId>${escapeXml(txId)}</InstrId>`)
      lines.push(`          <EndToEndId>${escapeXml(txId)}</EndToEndId>`)
      lines.push('        </PmtId>')
      lines.push('        <Amt>')
      lines.push(`          <InstdAmt Ccy="SEK">${formatPainAmount(payment.amount)}</InstdAmt>`)
      lines.push('        </Amt>')
      pushCreditor(lines, payment, accountForm, text)
      pushRemittance(lines, payment, swedbank !== null, text)
      lines.push('      </CdtTrfTxInf>')
    }

    lines.push('    </PmtInf>')
  }

  lines.push('  </CstmrCdtTrfInitn>')
  lines.push('</Document>')

  return lines.join('\n')
}

/** A bank-assigned party id: Othr/Id with SchmeNm/Cd, BANK at Swedbank (MIG 2.0), CUST at Nordea. */
function pushSchemedId(lines: string[], id: string, scheme: 'BANK' | 'CUST'): void {
  lines.push('            <Othr>')
  lines.push(`              <Id>${escapeXml(id)}</Id>`)
  lines.push(`              <SchmeNm><Cd>${scheme}</Cd></SchmeNm>`)
  lines.push('            </Othr>')
}

/** XSD order within CdtTrfTxInf: CdtrAgt before Cdtr before CdtrAcct. */
function pushCreditor(
  lines: string[],
  payment: SupplierPain001Payment,
  accountForm: CreditorAccountForm,
  text: (value: string) => string,
): void {
  const { payee } = payment
  const swedbankIso2 = accountForm === 'swedbank_iso2'

  let memberId: string
  let accountId: string
  let scheme: string
  switch (payee.type) {
    case 'bankgiro':
      memberId = '9900'
      accountId = payee.bankgiro
      scheme = '<SchmeNm><Prtry>BGNR</Prtry></SchmeNm>'
      break
    case 'plusgiro':
      memberId = '9960'
      accountId = payee.plusgiro
      // MIG 2.0 Appendix, Payee account identification: an alias payee takes
      // the proprietary code, PGNR for a plusgiro; MIG 1.0 wanted Cd BBAN.
      scheme = swedbankIso2
        ? '<SchmeNm><Prtry>PGNR</Prtry></SchmeNm>'
        : '<SchmeNm><Cd>BBAN</Cd></SchmeNm>'
      break
    case 'bank_account': {
      // The same encoder as the salary file (creditor-account.ts).
      const routing = domesticCreditorAccount(payment.payeeName, payee.clearing, payee.account, accountForm)
      memberId = routing.memberId
      accountId = routing.accountId
      scheme = '<SchmeNm><Cd>BBAN</Cd></SchmeNm>'
      break
    }
  }

  lines.push('        <CdtrAgt>')
  lines.push('          <FinInstnId>')
  lines.push('            <ClrSysMmbId>')
  lines.push('              <ClrSysId><Cd>SESBA</Cd></ClrSysId>')
  lines.push(`              <MmbId>${memberId}</MmbId>`)
  lines.push('            </ClrSysMmbId>')
  lines.push('          </FinInstnId>')
  lines.push('        </CdtrAgt>')
  lines.push('        <Cdtr>')
  lines.push(`          <Nm>${escapeXml(text(payment.payeeName))}</Nm>`)
  // Always (Validex round 3, rule 237 fires on every path): the supplier's
  // town when known and country SE (v1 scope). XSD order: TwnNm before Ctry.
  lines.push('          <PstlAdr>')
  if (payment.payeeCity?.trim()) {
    lines.push(`            <TwnNm>${escapeXml(text(payment.payeeCity.trim()))}</TwnNm>`)
  }
  lines.push('            <Ctry>SE</Ctry>')
  lines.push('          </PstlAdr>')
  lines.push('        </Cdtr>')
  lines.push('        <CdtrAcct>')
  lines.push('          <Id>')
  lines.push('            <Othr>')
  lines.push(`              <Id>${escapeXml(accountId)}</Id>`)
  lines.push(`              ${scheme}`)
  lines.push('            </Othr>')
  lines.push('          </Id>')
  lines.push('        </CdtrAcct>')
}

function pushRemittance(
  lines: string[],
  payment: SupplierPain001Payment,
  swedbankIso2: boolean,
  text: (value: string) => string,
): void {
  const { reference, amount } = payment
  // MIG 2.0 Appendix: an OCR "can only be used with an Alias creditor account
  // identifier"; a bank account takes RF references only and rejects an
  // incorrect one, so to an account Swedbank gets the OCR as the message.
  const structured =
    reference.type === 'ocr' && !(swedbankIso2 && payment.payee.type === 'bank_account')
  lines.push('        <RmtInf>')
  if (structured) {
    lines.push('          <Strd>')
    if (!swedbankIso2) {
      // Validex PFH_217: RfrdDocAmt must be stated when Strd is provided. The
      // remitted amount equals the instructed amount for a full-line payment.
      // Not in Swedbank ISO 2.0: RfrdDocAmt only with extended remittance,
      // RmtdAmt only for CINV, and one reference is at most 140 characters.
      lines.push('            <RfrdDocAmt>')
      lines.push(`              <RmtdAmt Ccy="SEK">${formatPainAmount(amount)}</RmtdAmt>`)
      lines.push('            </RfrdDocAmt>')
    }
    lines.push('            <CdtrRefInf>')
    lines.push('              <Tp>')
    lines.push('                <CdOrPrtry><Cd>SCOR</Cd></CdOrPrtry>')
    lines.push('              </Tp>')
    lines.push(`              <Ref>${escapeXml(reference.value)}</Ref>`)
    lines.push('            </CdtrRefInf>')
    lines.push('          </Strd>')
  } else {
    lines.push(`          <Ustrd>${escapeXml(text(reference.value).slice(0, USTRD_MAX))}</Ustrd>`)
  }
  lines.push('        </RmtInf>')
}

// ============================================================
// Helpers (deliberately duplicated from the salary generator: that dialect is
// production-hardened and stays untouched; see DECISIONS.md 2026-08-10)
// ============================================================

/** Control sums add the amounts AS RENDERED (painControlSum). */
function sumRendered(payments: readonly SupplierPain001Payment[]): number {
  return painControlSum(payments.map((p) => p.amount))
}
