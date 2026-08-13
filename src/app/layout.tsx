import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { TelegramProvider } from "@/components/mini-app/telegram-provider";
import "./globals.css";

const inter = Inter({ subsets: ["latin", "cyrillic"] });

export const metadata: Metadata = {
  title: {
    default: "Health AI — Klinika",
    template: "%s — Health AI",
  },
  description: "Klinika qabuliga yozilish va ma‘lumot olish xizmati",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="uz" suppressHydrationWarning>
      <body className={`${inter.className} bg-[var(--tg-bg,#f8fafc)] text-[var(--tg-text,#0f172a)] antialiased`}>
        <TelegramProvider>
          <main className="mx-auto min-h-dvh w-full max-w-md px-4 pb-10 pt-4">{children}</main>
        </TelegramProvider>
      </body>
    </html>
  );
}