import type { Metadata, Viewport } from "next";
import { Inter, Sora, JetBrains_Mono } from "next/font/google";
import { TelegramProvider } from "@/components/mini-app/telegram-provider";
import "./globals.css";

const inter = Inter({ subsets: ["latin", "cyrillic"], variable: "--font-inter" });
const sora = Sora({ subsets: ["latin"], variable: "--font-sora", display: "swap" });
const jetbrains = JetBrains_Mono({ subsets: ["latin", "cyrillic"], variable: "--font-jetbrains", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL("https://app.healthai.uz"),
  title: {
    default: "Health AI — Klinika",
    template: "%s — Health AI",
  },
  description: "Klinika qabuliga yozilish va ma‘lumot olish xizmati",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#f7f5f0",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="uz" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${sora.variable} ${jetbrains.variable} bg-[var(--tg-bg,var(--background))] text-[var(--tg-text,var(--foreground))] antialiased`}
      >
        <TelegramProvider>
          <main className="min-h-dvh">{children}</main>
        </TelegramProvider>
      </body>
    </html>
  );
}