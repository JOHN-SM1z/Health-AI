import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  async headers() {
    const telegramCsp = "frame-ancestors 'self' https://t.me https://telegram.me https://web.telegram.org https://*.telegram.org";
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
      {
        // Patient Mini App pages: allow embedding within official Telegram surfaces only.
        source: "/:route((?!admin|doctor|api).*)",
        headers: [
          { key: "Content-Security-Policy", value: telegramCsp },
        ],
      },
      {
        // Staff portals & APIs: strictly prohibit framing.
        source: "/:route(admin|doctor|api)/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
};

export default nextConfig;