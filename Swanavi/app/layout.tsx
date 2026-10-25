import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Swanavi",
  description: "Plan the city, the days, and the hours between them.",
  icons: { icon: "/swan-logo.jpg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "light",
  themeColor: [
    { media: "(max-width: 640px)", color: "#ffffff" },
    { color: "#e6e6eb" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
