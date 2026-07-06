# Payment Provider: bokföringsmappning per aktör

Per provider: jurisdiktion, reverse charge-status, faktureringsmodell, payout-cykel, BAS-konton, fee-struktur.

## Stripe

**Faktureringsentitet (EEA)**: Stripe Technology Europe Ltd, Dublin, Irland.
**Reverse charge**: JA (B2B-tjänst från IE till SE, 6 kap. 33 § ML, huvudregeln). Konto 4535 + 2614/2645.
**Faktureringsmodell**: Avgifter debiteras netto från payout. Månatlig faktura med specifikation laddas ner från Dashboard → Documents.
**Payout-cykel**: T+2 för SEK, T+7 för EUR/USD (default; konfigurerbart per konto).
**BAS-konton**:
- 1581: Fordringar Stripe (clearingunderkonto till 1580)
- 6040: Kontokortsavgifter (transaktionsavgifter)
- 4535: Inköp av tjänster från annat EU-land 25 % (reverse charge på den momspliktiga delen)
- 2614 + 2645: utgående/ingående RC-moms
- 3960/7960: FX vid USD/EUR-payout
**Fee-struktur (EEA-kort, default 2025)**: 1,4 % + 1,80 SEK; non-EEA: 2,9 % + 1,80 SEK; valutaväxling +2 %; Klarna via Stripe +1,99 %.
**Momsbedömning per komponent** (dnr 8-5507): processing fee = momspliktig teknisk tjänst (RC tillämpas); interchange/scheme fees = vidaredebiterad pass-through, normalt momsfri. Stripe specificerar inte alltid uppdelning: i praktiken behandlas hela transaktionsavgiften som RC-tjänst om Stripe inte tydligt anger annat.

## Klarna

**Faktureringsentitet**: Klarna Bank AB, Stockholm, Sverige (org.nr 556737-0431).
**Reverse charge**: NEJ, svensk entitet, svensk moms på faktura (eller momsfri finansiell tjänst där tillämpligt).
**Faktureringsmodell**: Settlement reports veckovis (måndagar för föregående vecka, kan variera). Avgifter debiteras netto från payout.
**Payout-cykel**: 1-2 gånger per vecka, varierar per avtal (kan vara 14 dagar för nya merchants under verifikation).
**BAS-konton**:
- 1582: Fordringar Klarna (clearingunderkonto)
- 1513: Klarna Pay Later/Slice it (kundfordran innan settlement)
- 6040: Kontokortsavgifter (transaktionsdelen)
- 6062: Kreditfees, ej-godkända faktorerade fakturor
- 2611: Svensk utgående moms (Klarna är svensk entitet, ingen RC)
**Fee-struktur**: Pay Now ~1,49 % + 2,50 SEK; Pay Later (faktura/delbetalning) 2,49-3,29 % + 2,50 SEK; Financing varierar.
**Momsbedömning**: Klarnas kreditbedömning är momsfri finansiell tjänst (3 kap. 9 § ML 2023:200), transaktionsdelen är momspliktig teknisk tjänst. Klarnas faktura ska specificera. **Varning**: Klarna Inc (US) och Klarna AB-dotterbolag i andra länder fakturerar med RC: verifiera entiteten per faktura, inte per varumärke.

## Adyen

**Faktureringsentitet (EEA)**: Adyen N.V., Amsterdam, Nederländerna.
**Reverse charge**: JA. Konto 4535 + 2614/2645.
**Faktureringsmodell**: Månatlig invoice; transaktionsavgifter kan debiteras antingen netto från payout eller separat.
**Payout-cykel**: Konfigurerbart: veckovis vanligast, dagligt möjligt med tillägg.
**BAS-konton**: Som Stripe.
**Fee-struktur**: 0,11 EUR processing fee + interchange + scheme fee + payment method fee (transparent pricing).
**Anmärkning**: Adyens fakturaspecifikation är tydligare än Stripes: uppdelningen mellan processing fee (RC-momspliktigt) och interchange (RC-momsfritt) ska följas per komponent.

## PayPal

**Faktureringsentitet (EEA)**: PayPal (Europe) S.à r.l. et Cie, S.C.A., Luxemburg (banklicensierad).
**Reverse charge**: NEJ för rena betalningstjänster (banklicens → momsfri finansiell tjänst enligt 3 kap. 9 § ML). JA för icke-finansiella tilläggstjänster.
**Faktureringsmodell**: Avgifter debiteras netto från transaktionen direkt. Månatlig statement.
**Payout-cykel**: Manuell utbetalning från PayPal-konto till bank, eller veckovis automatisk om aktiverat.
**BAS-konton**:
- 1583: Fordringar PayPal
- 6040: PayPal-avgifter (momsfri finansiell tjänst)
- 3960/7960: FX (PayPals interna växling är ofta sämre än ECB; kursdifferens bokas här)
**Fee-struktur**: 1,9-3,4 % + 3,25 SEK + valutaväxling 3-4 %.
**Anmärkning**: PayPals momsbedömning är komplex: kontrollera per fakturarad om RC ska tillämpas.

## Shopify Payments

**Faktureringsentitet (EEA)**: Shopify International Ltd, Dublin, Irland (för Payments). Plattformsavgifter (subscription) från samma entitet.
**Reverse charge**: JA. Konto 4535 + 2614/2645.
**Faktureringsmodell**: Avgifter debiteras netto från payout. Månatlig invoice för subscription (Basic/Shopify/Advanced).
**Payout-cykel**: Daglig (default), konfigurerbar till veckovis eller månadsvis.
**BAS-konton**:
- 1584: Fordringar Shopify Payments
- 6040: Transaktionsavgifter Payments
- 4535: Subscription (Basic Shopify-prenumeration etc.) + RC
- 6540: Övriga IT-tjänster (om annan klassificering föredras för subscription)
**Fee-struktur**: 1,6 % + 0,25 EUR för EEA-kort på Basic-planen; varierar med plan och kortregion.
**Anmärkning**: Shopify Payments använder Stripe som underliggande processor men fakturerar i eget namn: behandlas som Shopify, inte Stripe, i bokföringen.

## Mollie

**Faktureringsentitet**: Mollie B.V., Amsterdam, Nederländerna.
**Reverse charge**: JA. Konto 4535 + 2614/2645.
**Payout-cykel**: Daglig (T+1) som default.
**BAS-konton**:
- 1585: Fordringar Mollie
- 6040: Avgifter
**Anmärkning**: Stark i Benelux och EU-marknader, mindre vanlig i Sverige.

## Qliro

**Faktureringsentitet**: Qliro AB, Stockholm, Sverige.
**Reverse charge**: NEJ, svensk entitet.
**Payout-cykel**: Varierar per avtal, vanligen veckovis.
**BAS-konton**:
- 1586: Fordringar Qliro
- 1513: Faktura/delbetalning innan settlement
- 6040 / 6062: Avgifter / kreditfees
- 2611: Svensk moms på fakturan
**Anmärkning**: Nordisk konkurrent till Klarna. Faktura/delbetalning vanligast.

## Generella rekonciliationsmönster

1. **Order ledger (Shopify/Centra/WooCommerce) ↔ provider gross**: matcha per orderID och brutto-belopp innan avgifter. Diff = öresavrundning (3740) eller felaktig orderstatus.

2. **Provider gross − avgifter ↔ bankpayout**: matcha per payout-batch och netto-belopp. Diff = chargebacks, refunds eller reserves som provider håller.

3. **FX-omräkning fordringskonto**: om provider håller saldo i EUR/USD och payout sker i samma valuta till valutakonto 1980, ingen FX-diff vid payout: diffen uppstår först vid växling till SEK på 1930. Om provider växlar internt vid payout, bokas diff på 3960/7960 vid varje payout.

4. **Reserves och hold**: vissa providers håller en del av payouten i reserve (vanligt första 6 mån för nya merchants). Reserve-saldot ska synas separat på underkonto till 1580.
