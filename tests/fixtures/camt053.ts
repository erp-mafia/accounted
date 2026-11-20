/**
 * A pretty-printed camt.053.001.02 statement the way banks export it: <Refs>
 * (with EndToEndId) comes before <RmtInf>, so a bare <Ref> search lands on
 * <Refs> and its whitespace instead of the OCR inside <CdtrRefInf>.
 *
 * Entry 1: an incoming OCR payment. Entry 2: an outgoing payment whose
 * end-to-end id is the ISO placeholder NOTPROVIDED.
 */
export const CAMT053_PRETTY_WITH_REFS = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Acct>
        <Id>
          <IBAN>SE3550000000054910000003</IBAN>
        </Id>
        <Ccy>SEK</Ccy>
      </Acct>
      <Ntry>
        <NtryRef>NTRY-1</NtryRef>
        <Amt Ccy="SEK">12500.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt>
          <Dt>2025-03-10</Dt>
        </BookgDt>
        <ValDt>
          <Dt>2025-03-11</Dt>
        </ValDt>
        <AcctSvcrRef>ACSR-1</AcctSvcrRef>
        <BkTxCd>
          <Domn>
            <Cd>PMNT</Cd>
            <Fmly>
              <Cd>RCDT</Cd>
              <SubFmlyCd>DMCT</SubFmlyCd>
            </Fmly>
          </Domn>
        </BkTxCd>
        <NtryDtls>
          <TxDtls>
            <Refs>
              <AcctSvcrRef>ACSR-1</AcctSvcrRef>
              <EndToEndId>E2E-INCOMING-1</EndToEndId>
            </Refs>
            <RltdPties>
              <Dbtr>
                <Nm>Kund AB</Nm>
              </Dbtr>
              <DbtrAcct>
                <Id>
                  <IBAN>SE45 5000 0000 0583 9825 7466</IBAN>
                </Id>
              </DbtrAcct>
            </RltdPties>
            <RmtInf>
              <Strd>
                <CdtrRefInf>
                  <Tp>
                    <CdOrPrtry>
                      <Cd>SCOR</Cd>
                    </CdOrPrtry>
                  </Tp>
                  <Ref>1001000000017</Ref>
                </CdtrRefInf>
              </Strd>
            </RmtInf>
          </TxDtls>
        </NtryDtls>
        <AddtlNtryInf>Faktura 1001</AddtlNtryInf>
      </Ntry>
      <Ntry>
        <NtryRef>NTRY-2</NtryRef>
        <Amt Ccy="SEK">399.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt>
          <Dt>2025-03-12</Dt>
        </BookgDt>
        <ValDt>
          <Dt>2025-03-12</Dt>
        </ValDt>
        <AcctSvcrRef>ACSR-2</AcctSvcrRef>
        <NtryDtls>
          <TxDtls>
            <Refs>
              <EndToEndId>NOTPROVIDED</EndToEndId>
            </Refs>
            <RltdPties>
              <Cdtr>
                <Nm>Leverantör AB</Nm>
              </Cdtr>
            </RltdPties>
            <RmtInf>
              <Ustrd>Månadsavgift</Ustrd>
            </RmtInf>
          </TxDtls>
        </NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`

/**
 * A camt.053.001.08 file the way an XML serializer writes it (crm#1160):
 * UTF-8 BOM, every element under an `ns2:` prefix, two statements (a SEK and
 * a EUR account), <Sts> wrapped in <Cd>, ISODateTime booking dates and a date
 * with a zone offset. Built from the ISO 20022 message definition; every
 * name, reference and amount is invented.
 *
 * SEK statement: an OCR payment in, a Bankgirot deposit batch of three
 * payments booked as one entry, a pending entry, a card payment out.
 * EUR statement: one payment out.
 */
export const CAMT053_V08_PREFIXED_MULTI_STMT = `﻿<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ns2:Document xmlns:ns2="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <ns2:BkToCstmrStmt>
    <ns2:GrpHdr>
      <ns2:MsgId>MSG-0001</ns2:MsgId>
      <ns2:CreDtTm>2026-02-01T06:00:00+01:00</ns2:CreDtTm>
    </ns2:GrpHdr>
    <ns2:Stmt>
      <ns2:Id>STMT-SEK-2026-01</ns2:Id>
      <ns2:Acct>
        <ns2:Id><ns2:IBAN>SE0000000000000000000001</ns2:IBAN></ns2:Id>
        <ns2:Ccy>SEK</ns2:Ccy>
      </ns2:Acct>
      <ns2:Ntry>
        <ns2:Amt Ccy="SEK">1500.00</ns2:Amt>
        <ns2:CdtDbtInd>CRDT</ns2:CdtDbtInd>
        <ns2:Sts><ns2:Cd>BOOK</ns2:Cd></ns2:Sts>
        <ns2:BookgDt><ns2:DtTm>2026-01-02T00:00:00.000+01:00</ns2:DtTm></ns2:BookgDt>
        <ns2:ValDt><ns2:Dt>2026-01-02</ns2:Dt></ns2:ValDt>
        <ns2:AcctSvcrRef>ACSR-0001</ns2:AcctSvcrRef>
        <ns2:BkTxCd><ns2:Domn><ns2:Cd>PMNT</ns2:Cd><ns2:Fmly><ns2:Cd>RCDT</ns2:Cd><ns2:SubFmlyCd>DMCT</ns2:SubFmlyCd></ns2:Fmly></ns2:Domn></ns2:BkTxCd>
        <ns2:NtryDtls>
          <ns2:TxDtls>
            <ns2:Refs><ns2:EndToEndId>E2E-0001</ns2:EndToEndId></ns2:Refs>
            <ns2:Amt Ccy="SEK">1500.00</ns2:Amt>
            <ns2:CdtDbtInd>CRDT</ns2:CdtDbtInd>
            <ns2:RltdPties>
              <ns2:Dbtr><ns2:Pty><ns2:Nm>Kund &amp; Partner AB</ns2:Nm></ns2:Pty></ns2:Dbtr>
              <ns2:DbtrAcct><ns2:Id><ns2:IBAN>SE00 0000 0000 0000 0000 0002</ns2:IBAN></ns2:Id></ns2:DbtrAcct>
            </ns2:RltdPties>
            <ns2:RmtInf><ns2:Strd><ns2:CdtrRefInf><ns2:Ref>2001000000013</ns2:Ref></ns2:CdtrRefInf></ns2:Strd></ns2:RmtInf>
          </ns2:TxDtls>
        </ns2:NtryDtls>
        <ns2:AddtlNtryInf>Inbetalning faktura 2001</ns2:AddtlNtryInf>
      </ns2:Ntry>
      <ns2:Ntry>
        <ns2:Amt Ccy="SEK">3000.00</ns2:Amt>
        <ns2:CdtDbtInd>CRDT</ns2:CdtDbtInd>
        <ns2:Sts><ns2:Cd>BOOK</ns2:Cd></ns2:Sts>
        <ns2:BookgDt><ns2:Dt>2026-01-03</ns2:Dt></ns2:BookgDt>
        <ns2:ValDt><ns2:Dt>2026-01-03</ns2:Dt></ns2:ValDt>
        <ns2:AcctSvcrRef>ACSR-0002</ns2:AcctSvcrRef>
        <ns2:NtryDtls>
          <ns2:Btch><ns2:NbOfTxs>3</ns2:NbOfTxs></ns2:Btch>
          <ns2:TxDtls>
            <ns2:Amt Ccy="SEK">500.00</ns2:Amt>
            <ns2:RltdPties><ns2:Dbtr><ns2:Pty><ns2:Nm>Betalare Ett AB</ns2:Nm></ns2:Pty></ns2:Dbtr></ns2:RltdPties>
            <ns2:RmtInf><ns2:Strd><ns2:CdtrRefInf><ns2:Ref>3001000000011</ns2:Ref></ns2:CdtrRefInf></ns2:Strd></ns2:RmtInf>
          </ns2:TxDtls>
          <ns2:TxDtls>
            <ns2:Amt Ccy="SEK">1000.00</ns2:Amt>
            <ns2:RltdPties><ns2:Dbtr><ns2:Pty><ns2:Nm>Betalare Två AB</ns2:Nm></ns2:Pty></ns2:Dbtr></ns2:RltdPties>
            <ns2:RmtInf><ns2:Strd><ns2:CdtrRefInf><ns2:Ref>3002000000019</ns2:Ref></ns2:CdtrRefInf></ns2:Strd></ns2:RmtInf>
          </ns2:TxDtls>
          <ns2:TxDtls>
            <ns2:Amt Ccy="SEK">1500.00</ns2:Amt>
            <ns2:RltdPties><ns2:Dbtr><ns2:Pty><ns2:Nm>Betalare Tre AB</ns2:Nm></ns2:Pty></ns2:Dbtr></ns2:RltdPties>
            <ns2:RmtInf><ns2:Strd><ns2:CdtrRefInf><ns2:Ref>3003000000017</ns2:Ref></ns2:CdtrRefInf></ns2:Strd></ns2:RmtInf>
          </ns2:TxDtls>
        </ns2:NtryDtls>
      </ns2:Ntry>
      <ns2:Ntry>
        <ns2:Amt Ccy="SEK">75.00</ns2:Amt>
        <ns2:CdtDbtInd>DBIT</ns2:CdtDbtInd>
        <ns2:Sts><ns2:Cd>PDNG</ns2:Cd></ns2:Sts>
        <ns2:BookgDt><ns2:Dt>2026-01-31</ns2:Dt></ns2:BookgDt>
        <ns2:AcctSvcrRef>ACSR-0003</ns2:AcctSvcrRef>
        <ns2:AddtlNtryInf>Kortköp reserverat</ns2:AddtlNtryInf>
      </ns2:Ntry>
      <ns2:Ntry>
        <ns2:Amt Ccy="SEK">249.50</ns2:Amt>
        <ns2:CdtDbtInd>DBIT</ns2:CdtDbtInd>
        <ns2:Sts><ns2:Cd>BOOK</ns2:Cd></ns2:Sts>
        <ns2:BookgDt><ns2:Dt>2026-01-05+01:00</ns2:Dt></ns2:BookgDt>
        <ns2:AcctSvcrRef>ACSR-0004</ns2:AcctSvcrRef>
        <ns2:AddtlNtryInf>Kortköp Kontorsvaror</ns2:AddtlNtryInf>
      </ns2:Ntry>
    </ns2:Stmt>
    <ns2:Stmt>
      <ns2:Id>STMT-EUR-2026-01</ns2:Id>
      <ns2:Acct>
        <ns2:Id><ns2:IBAN>SE0000000000000000000003</ns2:IBAN></ns2:Id>
        <ns2:Ccy>EUR</ns2:Ccy>
      </ns2:Acct>
      <ns2:Ntry>
        <ns2:Amt Ccy="EUR">100.00</ns2:Amt>
        <ns2:CdtDbtInd>DBIT</ns2:CdtDbtInd>
        <ns2:Sts><ns2:Cd>BOOK</ns2:Cd></ns2:Sts>
        <ns2:BookgDt><ns2:Dt>2026-01-07</ns2:Dt></ns2:BookgDt>
        <ns2:AcctSvcrRef>ACSR-0005</ns2:AcctSvcrRef>
        <ns2:NtryDtls>
          <ns2:TxDtls>
            <ns2:RltdPties>
              <ns2:Cdtr><ns2:Pty><ns2:Nm>Leverantör GmbH</ns2:Nm></ns2:Pty></ns2:Cdtr>
              <ns2:CdtrAcct><ns2:Id><ns2:IBAN>DE00000000000000000004</ns2:IBAN></ns2:Id></ns2:CdtrAcct>
            </ns2:RltdPties>
            <ns2:RmtInf><ns2:Ustrd>Licens januari</ns2:Ustrd></ns2:RmtInf>
          </ns2:TxDtls>
        </ns2:NtryDtls>
      </ns2:Ntry>
    </ns2:Stmt>
  </ns2:BkToCstmrStmt>
</ns2:Document>`

/** A camt.053.001.02 statement with `count` booked entries, alternating in and out. */
export function camt053ManyEntries(count: number): string {
  const entries = Array.from({ length: count }, (_, i) => {
    const day = String((i % 28) + 1).padStart(2, '0')
    const month = String(Math.floor(i / 28) % 6 + 1).padStart(2, '0')
    return `<Ntry><NtryRef>REF-${i}</NtryRef><Amt Ccy="SEK">${100 + i}.25</Amt><CdtDbtInd>${i % 2 === 0 ? 'CRDT' : 'DBIT'}</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-${month}-${day}</Dt></BookgDt><AddtlNtryInf>Post ${i}</AddtlNtryInf></Ntry>`
  }).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt><Acct><Ccy>SEK</Ccy></Acct>
${entries}
</Stmt></BkToCstmrStmt></Document>`
}
