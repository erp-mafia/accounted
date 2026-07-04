# OSS- och IOSS-mekanik

## OSS: unionsordningen för distansförsäljning

### Registreringsförfarande
- Anmälan via Skatteverkets e-tjänst "Moms: särskilda ordningar" (kräver BankID och momsregistrering i Sverige).
- Ikraftträdande: från första dagen i nästkommande kalenderkvartal efter anmälan.
- Frivillig anmälan under tröskeln 99 680 SEK: bindande i minst två kalenderår.
- Vid passerande av tröskeln 6 kap. 62 § ML 2023:200: anmälan ska göras senast den 10:e i månaden efter den månad då tröskeln passerades; OSS kan tillämpas retroaktivt från överskridandetransaktionen.
- Identifieringsstat = Sverige för svenska säljare. Vid flytt av etableringsstat krävs avregistrering + omregistrering.

### Deklarationsperiod
- **Kvartalsvis**: Q1 (jan-mar) → deklaration senast 30 april; Q2 → 31 juli; Q3 → 31 oktober; Q4 → 31 januari.
- Betalning samtidigt med deklaration till Skatteverkets särskilda OSS-bankgiro.
- Noll-deklaration krävs även om ingen omsättning skett under perioden.

### Valutaomräkning
- Deklareras i EUR oavsett faktureringsvaluta.
- Omräkningskurs: ECB:s referenskurs **sista dagen i deklarationsperioden** (eller närmast föregående bankdag om sista dagen ej är bankdag).
- Bokföringen får hållas i SEK med löpande omräkning per transaktion till destinationslandets momssats; vid deklaration sker konsoliderad omräkning till EUR.

### Korrigeringar
- Korrigering av tidigare period görs i en senare deklaration (max 3 år bakåt) med referens till ursprunglig deklarationsperiod.
- Lagstöd: kommissionens genomförandeförordning (EU) 2020/194.
- Retur eller kreditnota = negativ post per destinationsland och momssats i den period kreditnotan ställs ut.

### Underkontostruktur i BAS för OSS
Rekommenderad struktur på **2670**:
- 2670-DE-19 (Tyskland 19 %)
- 2670-DE-7 (Tyskland 7 %)
- 2670-FR-20 (Frankrike 20 %)
- 2670-FR-10 (Frankrike 10 %)
- 2670-FR-5.5 (Frankrike 5,5 %)
- 2670-NL-21, 2670-NL-9, etc. per land och sats.

Motsvarande underkontostruktur på **3106** för försäljningssidan.

## IOSS: importordningen

### Tillämpningsområde
- Försändelser från tredjeland till EU-konsument, **verkligt värde ≤ 150 EUR** exkl. punktskattepliktiga varor.
- Verkligt värde = pris exkl. transport, försäkring och skatter (Tullverkets praxis enligt TFS 2022:5, Unionstullkodexen art. 23).
- Frivilligt: alternativ är standardimportförfarande där mottagaren betalar moms vid gränsen.

### Registreringsförfarande
- IOSS-nummer (IM-prefix) tilldelas av Skatteverket vid registrering.
- Försäljare utanför EU måste utse en EU-baserad förmedlare (mellanman): den blir solidariskt ansvarig för momsen.

### Deklarationsperiod
- **Månadsvis**: deklaration + betalning senast sista dagen i månaden efter rapporteringsmånaden.
- Noll-deklaration krävs vid utebliven omsättning.

### Tullhantering
- IOSS-numret anges i tulldeklarationen (H7 standardförfarande för försändelser ≤ 150 EUR).
- Importen blir momsbefriad (10 kap. 65 § ML, art. 143.1 ca direktivet).
- Saknas IOSS-nummer på paketet → standard importmomshantering, Tullverket tar ut moms av mottagaren (eller transportören som agerar förmedlare).

### Bokföring
- Intäkt på **3106** med underkonto per destinationsland.
- Utgående moms på **2670** med destinationslandets sats.
- Inget importmomskonto (2615/2645) används: själva importen är momsbefriad vid korrekt IOSS-tillämpning.

## Samspel med ordinarie momsdeklaration
- OSS-omsättning ska **inte** redovisas i ordinarie momsdeklaration (Ruta 35 är för B2B intra-EU varor, ej OSS).
- Periodisk sammanställning (VIES) krävs inte för OSS-försäljning (B2C).
- Ingående moms på inköp i destinationslandet återbetalas via 13:e direktivet (utländsk MOSS-återbetalning, ej via OSS-deklarationen).

## Avregistrering
- 15 dagars notice till identifieringsstaten innan tillämpning upphör.
- Vid avregistrering pga upphört användande av OSS: karantäntid 2 år innan återanmälan tillåten.
