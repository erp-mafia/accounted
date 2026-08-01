import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Hedvig_Letters_Serif } from "next/font/google";
import Script from "next/script";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip-provider";
import { DeployReloadPrompt } from "@/components/system/DeployReloadPrompt";
import { ThemeProvider } from "@/components/theme-provider";
import { PaletteProvider } from "@/components/providers/PaletteProvider";
import { SWRProvider } from "@/components/providers/SWRProvider";
import { ScrollbarReveal } from "@/components/ScrollbarReveal";
import { ensureInitialized } from "@/lib/init";
import { getBranding } from "@/lib/branding/service";
import { APP_TIME_ZONE } from "@/i18n/config";
import "./globals.css";

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

export function generateMetadata(): Metadata {
  const b = getBranding();
  return {
    title: b.appName,
    description: b.appDescription,
    manifest: "/manifest.webmanifest",
    appleWebApp: {
      capable: true,
      statusBarStyle: "default",
      title: b.appName,
    },
  };
}

export function generateViewport(): Viewport {
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
  const locale = await getLocale();
  const messages = await getMessages();
  return (
    <html lang={locale} suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} ${hedvigSerif.variable}`}>
      <head>
        <link rel="apple-touch-icon" href={branding.appleTouchIconPath} />
      </head>
      <body
        className="antialiased"
      >
        {/* timeZone is passed explicitly: client components must format in the
            same zone the server rendered with, or timestamps shift on hydration. */}
        <NextIntlClientProvider locale={locale} messages={messages} timeZone={APP_TIME_ZONE}>
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
                  <ScrollbarReveal />
                </TooltipProvider>
              </SWRProvider>
            </PaletteProvider>
          </ThemeProvider>
        </NextIntlClientProvider>
        <SpeedInsights />
        <Script src="/sw-register.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
