// AUTO-GENERATED — do not edit. Run `npm run setup:extensions` to regenerate.
import type { ExtensionDefinition } from '../types'

export const EXTENSION_DEFINITIONS: Record<string, ExtensionDefinition[]> = {
  'general': [
    {
          "slug": "enable-banking",
          "name": "Bankintegration (PSD2)",
          "sector": "general",
          "category": "import",
          "icon": "Landmark",
          "dataPattern": "manual",
          "description": "Automatisk banktransaktionssynk via PSD2",
          "longDescription": "Koppla ditt bankkonto direkt och synka transaktioner automatiskt via säker PSD2-bankintegration. Stöder de flesta svenska banker.",
          "hasOwnData": true,
          "subscriptionNotice": "Denna integration kräver ett aktivt Enable Banking-abonnemang. Utan abonnemang kommer bankintegration inte att fungera."
    },
    {
          "slug": "email",
          "name": "E-post (Resend)",
          "sector": "general",
          "category": "operations",
          "icon": "Mail",
          "dataPattern": "core",
          "description": "Skicka fakturor och påminnelser via e-post",
          "longDescription": "Aktiverar e-postfunktioner: skicka fakturor till kunder, automatiska betalningspåminnelser (15/30/45 dagar), och e-postmeddelanden. Kräver ett Resend-konto med verifierad domän.",
          "readsCoreTables": [
                "invoices",
                "customers",
                "company_settings"
          ]
    },
    {
          "slug": "arcim-migration",
          "name": "Systemmigration",
          "sector": "general",
          "category": "import",
          "icon": "ArrowRightLeft",
          "dataPattern": "manual",
          "description": "Migrera bokföring från Fortnox, Visma, Bokio, Björn Lundén eller Briox",
          "longDescription": "Flytta all bokföringsdata från ditt gamla system till gnubok. Importerar kontoplan, verifikationer, kunder, leverantörer och öppna fakturor automatiskt via säker API-integration direkt med leverantören."
    },
    {
          "slug": "tic",
          "name": "Bolagsuppgifter",
          "sector": "general",
          "category": "import",
          "icon": "Building2",
          "dataPattern": "manual",
          "description": "Hämta företagsinformation automatiskt vid registrering",
          "longDescription": "Fyll i företagsuppgifter automatiskt genom att ange organisationsnummer. Hämtar adress, momsregistrering, F-skattestatus och bankuppgifter från offentliga register via TIC.",
          "hasOwnData": true,
          "quickAction": {
                "label": "Företagsprofil",
                "description": "Visa offentliga uppgifter",
                "icon": "Building2",
                "href": "/e/general/tic",
                "order": 10
          }
    },
    {
          "slug": "mcp-server",
          "name": "MCP-server (API)",
          "sector": "general",
          "category": "operations",
          "icon": "Terminal",
          "dataPattern": "manual",
          "description": "Gör bokföring via Claude, Cursor eller annan MCP-klient",
          "longDescription": "Exponerar gnuboks bokföringsmotor som MCP-verktyg (Model Context Protocol). Koppla din MCP-klient med en API-nyckel och gör bokföring genom konversation: visa okategoriserade transaktioner, bokför dem, skapa fakturor."
    },
    {
          "slug": "cloud-backup",
          "name": "Molnsynkronisering",
          "sector": "general",
          "category": "operations",
          "icon": "Cloud",
          "dataPattern": "manual",
          "description": "Synka säkerhetsbackup till din egen molnlagring",
          "longDescription": "Koppla ditt Google Drive-konto och ladda upp en fullständig säkerhetsbackup med ett klick. Gnubok skapar en ZIP med SIE-filer, kvitton och behandlingshistorik och laddar upp till en egen mapp i din Drive. Perfekt för att uppfylla egna krav på redundans.",
          "hasOwnData": true,
          "subscriptionNotice": "Kräver ett Google-konto. Uppladdningar sker direkt till din Drive — ingen data lagras hos tredje part utöver Google."
    },
    {
          "slug": "skatteverket",
          "name": "Skatteverket Integration",
          "sector": "general",
          "category": "operations",
          "icon": "FileCheck",
          "dataPattern": "core",
          "description": "Skicka momsdeklaration direkt till Skatteverket via BankID.",
          "longDescription": "Anslut till Skatteverket med BankID och skicka din momsdeklaration direkt från gnubok. Spara utkast, validera, lås och signera — utan att lämna appen."
    },
    {
          "slug": "invoice-inbox",
          "name": "Dokumentinkorg",
          "sector": "general",
          "category": "import",
          "icon": "Inbox",
          "dataPattern": "both",
          "description": "Vidarebefordra leverantörsfakturor till en unik adress – dokumenten landar här med extraherade fält",
          "longDescription": "Varje bolag får en unik fakturainkorg-adress. Fakturor som skickas dit fångas automatiskt och fält som org.nr, OCR, bankgiro, belopp och förfallodatum extraheras deterministiskt från PDF-texten. Inga AI-anrop, inga molntjänster utöver Resend för e-postmottagning.",
          "readsCoreTables": [
                "document_attachments",
                "suppliers"
          ],
          "hasOwnData": true
    },
    {
          "slug": "document-extraction",
          "name": "AI-extrahering av underlag",
          "sector": "general",
          "category": "accounting",
          "icon": "MessageCircle",
          "dataPattern": "both",
          "description": "Läser kvitton och fakturor med AI och fyller i leverantör, belopp, moms och datum automatiskt",
          "longDescription": "Lyssnar på document.uploaded-händelser och kör Sonnet 4.6 via AWS Bedrock på varje uppladdat kvitto eller faktura (PDF eller bild). De extraherade fälten skrivs till document_attachments.extracted_data så att den specialiserade bokföringsassistenten kan föreslå rätt BAS-konto utan att fråga användaren om sådant som redan står på underlaget. Hoppar över dokument som redan extraherats av andra extensions (t.ex. invoice-inbox) för att undvika dubbla AI-anrop.",
          "readsCoreTables": [
                "document_attachments",
                "invoice_inbox_items"
          ]
    },
  ],
}
