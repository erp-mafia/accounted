import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Hedvig_Letters_Serif } from "next/font/google";
import {
  Fraunces,
  Lora,
  Playfair_Display,
  Public_Sans,
  Source_Sans_3,
  Work_Sans,
} from "next/font/google";
import Script from "next/script";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip-provider";
import { DeployReloadPrompt } from "@/components/system/DeployReloadPrompt";
import { ThemeColorSync } from "@/components/system/ThemeColorSync";
import { ThemeProvider } from "@/components/theme-provider";
import { PaletteProvider } from "@/components/providers/PaletteProvider";
import { SWRProvider } from "@/components/providers/SWRProvider";
import { ScrollbarReveal } from "@/components/ScrollbarReveal";
import { ensureInitialized } from "@/lib/init";
import { isSelfHosted } from "@/lib/env/public-flags";
import { getBranding } from "@/lib/branding/service";
import { resolveRequestBrand } from "@/lib/branding/request-brand";
import { getBrandFontPair } from "@/lib/branding/fonts";
import { BrandProvider } from "@/lib/branding/brand-context";
import { toPublicBrand } from "@/lib/branding/public-brand";
import { APP_TIME_ZONE } from "@/i18n/config";
import "./globals.css";

// Brand resolution (WL-12: the lookup runs in the root layout, not
// middleware) lives in lib/branding/request-brand.ts, shared with every
// other server component so the BRAND_DEV_DOMAIN dev override applies
// uniformly. The layout used to carry a private copy of the function, which
// silently skipped that override.

// Load extensions before metadata/viewport functions read the branding service.
// Without this, an extension that calls registerBrandingService() at its module
// load time would not have run yet when the first request hits this layout.
ensureInitialized();

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const hedvigSerif = Hedvig_Letters_Serif({
  variable: "--font-hedvig-serif",
  subsets: ["latin"],
  display: "swap",
  // Hedvig Letters Serif on Google Fonts only ships 400; the brand wordmark
  // requests 700, which browsers synthesize from this file. Keep the load
  // single-file to stay within the existing display-font budget.
  weight: "400",
});

// Curated brand font menu (WL-03/WL-12): every menu font registers here so
// its @font-face and CSS variable exist on every host, but with
// `preload: false`: only the default pair above preloads, and a browser only
// downloads a menu font when a branded host actually resolves its var()
// (lib/branding/fonts.ts picks the pair per request). All Google Fonts, OFL.
const loraSerif = Lora({
  variable: "--font-lora",
  subsets: ["latin"],
  display: "swap",
  preload: false,
});

const sourceSans = Source_Sans_3({
  variable: "--font-source-sans",
  subsets: ["latin"],
  display: "swap",
  preload: false,
});

const frauncesSerif = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  display: "swap",
  preload: false,
});

const workSans = Work_Sans({
  variable: "--font-work-sans",
  subsets: ["latin"],
  display: "swap",
  preload: false,
});

const playfairSerif = Playfair_Display({
  variable: "--font-playfair",
  subsets: ["latin"],
  display: "swap",
  preload: false,
});

const publicSans = Public_Sans({
  variable: "--font-public-sans",
  subsets: ["latin"],
  display: "swap",
  preload: false,
});

// The brand font menu's variable classes, appended to <html> so every menu
// pair's var() is resolvable whichever brand serves the request.
const brandFontVariables = [
  loraSerif.variable,
  sourceSans.variable,
  frauncesSerif.variable,
  workSans.variable,
  playfairSerif.variable,
  publicSans.variable,
].join(" ");

export async function generateMetadata(): Promise<Metadata> {
  const b = getBranding();
  const brand = await resolveRequestBrand();
  const appName = brand?.appName ?? b.appName;
  return {
    title: appName,
    description: b.appDescription,
    manifest: "/manifest.webmanifest",
    appleWebApp: {
      capable: true,
      statusBarStyle: "default",
      title: appName,
    },
  };
}

export async function generateViewport(): Promise<Viewport> {
  return {
    themeColor: getBranding().themeColor,
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const branding = getBranding();
  const brand = await resolveRequestBrand();
  const locale = await getLocale();
  const messages = await getMessages();

  // Brand COLOR theming deliberately removed (founder call 2026-08-04):
  // white-label is logo + app name + domain only; every host renders the
  // standard editorial-monochrome theme. buildBrandVarsCss and the
  // brands.brand_color/chrome_color columns stay dormant for a future
  // opt-in, but nothing stamps data-brand anymore.

  // Curated font menu (WL-03): inline style on <html> beats the :root
  // declarations in globals.css. Null (default pair or unknown key) means no
  // style attribute at all, keeping default hosts byte-identical.
  const fontPair = brand ? getBrandFontPair(brand.fontKey) : null;

  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${hedvigSerif.variable} ${brandFontVariables}`}
      style={
        fontPair
          ? ({
              "--font-display": fontPair.display,
              "--font-body": fontPair.body,
            } as React.CSSProperties)
          : undefined
      }
    >
      <head>
        <link rel="apple-touch-icon" href={branding.appleTouchIconPath} />
        {/* Tab icon: the brand's dedicated square favicon when set, else the
            logo (a wide lockup squeezed to 16px, but better than the default
            on a branded host). */}
        {brand?.faviconUrl || brand?.logoUrl ? (
          <link rel="icon" href={brand.faviconUrl ?? brand.logoUrl ?? undefined} />
        ) : null}
      </head>
      <body
        className="antialiased"
      >
        {/* timeZone is passed explicitly: client components must format in the
            same zone the server rendered with, or timestamps shift on hydration. */}
        <NextIntlClientProvider locale={locale} messages={messages} timeZone={APP_TIME_ZONE}>
          <BrandProvider brand={brand ? toPublicBrand(brand) : null}>
            <ThemeProvider
              attribute="class"
              defaultTheme="light"
              enableSystem
              disableTransitionOnChange
            >
              <PaletteProvider>
                <SWRProvider>
                  <TooltipProvider>
                    {children}
                    <Toaster />
                    <DeployReloadPrompt />
                    <ThemeColorSync />
                    <ScrollbarReveal />
                  </TooltipProvider>
                </SWRProvider>
              </PaletteProvider>
            </ThemeProvider>
          </BrandProvider>
        </NextIntlClientProvider>
        {/* Vercel Speed Insights is hosted-only telemetry: a self-hosted
            (AGPL) instance must not report its users' page timings to our
            Vercel project. Read through lib/env/public-flags, never compared
            in place (the Docker build folds in-place NEXT_PUBLIC_* reads). */}
        {!isSelfHosted() && <SpeedInsights />}
        <Script src="/sw-register.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
