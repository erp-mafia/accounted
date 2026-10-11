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
