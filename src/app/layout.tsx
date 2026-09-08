import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';

const inter = localFont({ src: './fonts/inter-latin.woff2', variable: '--font-inter', weight: '400 600', display: 'swap' });

export const metadata: Metadata = {
  title: 'Kamour Sales OS',
  description: 'Internal sales CRM',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.variable}>{children}</body>
    </html>
  );
}
