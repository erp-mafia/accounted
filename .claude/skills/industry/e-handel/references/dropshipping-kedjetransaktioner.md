# Dropshipping och kedjetransaktioner: beslutsschema

## Dimensioner

Varje dropship-scenario klassificeras längs fem dimensioner:

1. **Avgångsland**: EU-medlemsstat eller tredjeland (Kina, USA, UK, Turkiet vanligast).
2. **Destinationsland**: SE, annat EU-land, eller tredjeland.
3. **Varuvärde**: ≤ 150 EUR eller > 150 EUR (avgör IOSS-tillämplighet).
4. **Kanal**: egen butik (Shopify/WooCommerce) eller marketplace (Amazon/eBay/Etsy/Temu/Wish).
5. **Köparstatus**: B2B med giltigt VAT-nr i VIES eller B2C.

## Lagstöd

- **6 kap. 14-17 §§ ML 2023:200**: kedjetransaktionsregler (Quick Fixes, direktiv (EU) 2018/1910, ikraft SE 2020-01-01).
- **5 kap. 5-6 §§ ML**: deemed supplier (plattform anses ha köpt och sålt).
- **6 kap. 3 § ML**: leveransort vid transport från tredjeland.
- **6 kap. 11 § ML**: leveransort vid IOSS-tillämpning.
- **10 kap. 65 § ML**: undantag för IOSS-import.
- **10 kap.** + **art. 136a direktivet**: undantag för säljarens leverans till deemed supplier-plattform.
- **dnr 8-1293055** (2021-10-29, uppd. 2023-06-26): SKV:s ställningstagande om transportallokering.

## Beslutsmatris

### Scenario A: Svensk säljare, leverantör i EU, B2C-kund i annat EU-land
Exempel: Svensk Shopify-butik, leverantör i Polen, kund i Tyskland.

- Två leveranser i kedjan: PL-leverantör → svensk säljare → DE-konsument.
- Transport hänförs som huvudregel till leveransen *till* mellanhanden (svensk säljare) enligt 6 kap. 15 § ML.
- **Undantag**: om svensk säljare meddelar PL-leverantören sitt **polska VAT-nr**, hänförs transporten till leveransen *från* svensk säljare. I praktiken har svensk säljare normalt inte polskt VAT-nr → huvudregeln gäller.
- Resultat: PL-leverantör säljer momsfritt EU-B2B till svensk säljare (kräver VIES-giltigt svenskt VAT-nr). Svensk säljare gör förvärv i SE (4515 + 2614/2645). Försäljningen till DE-konsument är **distansförsäljning av varor** från SE till DE: OSS gäller om över tröskeln 99 680 SEK eller frivilligt registrerad (3106 + 2670-DE).
- Praktiskt problem: varan transporteras direkt PL → DE, men momsmässigt anses den ha rört sig PL → SE → DE. Krav på korrekt fakturering och bevisning.

### Scenario B: Svensk säljare, leverantör i EU, B2B-kund i annat EU-land (trepartshandel)
Exempel: Svensk säljare, leverantör i Polen, kund (företag) i Tyskland med tyskt VAT-nr.

- **Förenklingsregeln för trepartshandel** (10 kap. ML, art. 141 direktivet) kan tillämpas om alla tre parter är momsregistrerade i var sitt EU-land.
- Resultat: PL-leverantör säljer momsfritt till svensk säljare; svensk säljare säljer momsfritt till DE-kund som beskattar förvärvet i Tyskland. Svensk säljare rapporterar via periodisk sammanställning med kod för trepartshandel.
- Fakturakrav: hänvisning till "Trepartshandel: moms skall redovisas av köparen, art. 141 direktivet" eller motsvarande svensk formulering.

### Scenario C: Svensk säljare, leverantör i tredjeland (Kina), B2C-kund i SE
Exempel: Svensk Shopify-butik, AliExpress-leverantör i Kina, svensk konsument.

**C1: Varuvärde ≤ 150 EUR, säljaren använder IOSS**:
- Säljaren tar ut svensk moms (25 %) vid kassan, redovisar månatligt via IOSS (2670 + 3001 om vald registreringsstrategi; alternativt 3106 om annan modell).
- Importen är momsbefriad (10 kap. 65 § ML).
- Bokföringsmässigt: ingen importmoms (2615/2645).

**C2: Varuvärde ≤ 150 EUR, ingen IOSS**:
- Tullverket tar ut moms av mottagaren vid gränsen (eller via transportörens förmedling).
- Säljaren bokför försäljningen som vanlig svensk omsättning **endast om varan anses levererad i Sverige**. Vid direktleverans från Kina med säljaren som importör (DDP) → säljaren importerar och säljer i SE (4545 + 2615/2645 vid import, 3001 + 2611 vid försäljning). Vid DAP/DDU → mottagaren importerar, säljarens leverans sker utanför EU och faller utanför svensk moms.

**C3: Varuvärde > 150 EUR**:
- IOSS ej tillämpligt. Standard importförfarande.
- Vid DDP: säljaren importerar → 4545 + 2615/2645 + 3001 + 2611.
- Vid DAP/DDU: mottagaren importerar → säljarens transaktion sker utanför EU, ej svensk moms.

### Scenario D: Svensk säljare, leverantör i tredjeland, B2C-kund i annat EU-land
Exempel: Svensk Shopify-butik, leverantör i Kina, kund i Tyskland.

**D1: Varuvärde ≤ 150 EUR med IOSS**: 
- Tysk moms tas ut vid kassan, redovisas månatligt via IOSS, importen är momsbefriad. 3106-DE + 2670-DE-19.

**D2: Varuvärde > 150 EUR, DDP-leverans**:
- Säljaren importerar i Tyskland → kräver tysk momsregistrering eller indirekt representant.
- Försäljningen är inhemsk tysk omsättning (ej OSS: OSS gäller bara unionsintern distansförsäljning där transport börjar i EU). Tysk moms hanteras direkt i tysk momsdeklaration.

**D3: Varuvärde > 150 EUR, DAP/DDU**:
- Tysk konsument importerar och betalar tysk importmoms vid gränsen.
- Säljarens transaktion sker utanför EU → faller utanför svensk moms.

### Scenario E: Försäljning via marketplace som är deemed supplier
Exempel: Säljaren listar på Amazon, varan skickas från Kina till tysk konsument, värde 80 EUR.

- **5 kap. 5 § ML** tillämpas: Amazon anses ha köpt och sålt eftersom (i) säljaren är icke-EU-etablerad alt. det är distansförsäljning av importerade varor ≤ 150 EUR via elektroniskt gränssnitt.
- Amazon redovisar moms i destinationslandet via sitt IOSS.
- **Säljarens fiktiva leverans till Amazon är undantagen** (10 kap. ML, art. 136a): säljaren har ingen omsättning att redovisa i SE för denna transaktion.
- Bokföring hos säljaren: marketplace-payout (1580-AMZ) kommer netto. Provisioner Amazon bokas på 6050. Försäljning bokas på t.ex. 3990 (övrig försäljning) eller ej alls, beroende på K2/K3-tolkning: flagga för byråstandard.

### Scenario F: Direktleverans där säljaren har VAT-nr i avgångslandet
Exempel: Svensk säljare har även registrerat sig i Polen (lokal momsreg). Leverantör i Polen, kund i Tyskland.

- Genom att meddela PL-leverantören sitt **polska** VAT-nr triggar säljaren undantaget i 6 kap. 16 § ML (Quick Fixes).
- Transporten hänförs till leveransen *från* säljaren (mellanhanden).
- PL-leverantör fakturerar med polsk inhemsk moms (säljaren har polskt VAT-nr, ses som inhemsk B2B-omsättning).
- Säljaren gör momsfri unionsintern leverans från PL till DE (eller distansförsäljning DE-konsument via OSS): kräver alltid bevisad transport och VIES-koll om B2B.
- Säljarens polska momsregistrering ger avdragsrätt för polsk ingående moms via polsk momsdeklaration eller 13:e direktivet.

## Bevisning och dokumentation
- **Transport-bevis** vid momsfri EU-B2B-leverans: CMR, fraktsedel, leveransbevis från kund (Quick Fixes-kravet enligt art. 45a genomförandeförordning 282/2011: två oberoende handlingar).
- **VAT-nr-verifiering**: VIES-kontroll vid leveransdatum, sparas i ordersystemet. Materiellt villkor sedan 2020-01-01.
- **Tullhandlingar** vid import: tulldeklaration, importmomssedel.
