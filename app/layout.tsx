import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost";
  const imageUrl = `${protocol}://${host}/og.png`;
  const title = "Rosis Tagebuch · Fütterung";
  const description = "Rosis privates Fütterungstagebuch mit Tagesplan und dauerhaftem Verlauf.";
  return {
    title,
    description,
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: {
      title: "Rosis Tagebuch",
      description,
      type: "website",
      images: [{ url: imageUrl, width: 1731, height: 909, alt: "Rosis Tagebuch – Fütterung im Blick" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Rosis Tagebuch",
      description,
      images: [imageUrl],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de">
      <body className={`${geistSans.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
