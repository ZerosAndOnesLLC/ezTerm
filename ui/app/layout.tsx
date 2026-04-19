import './globals.css';
import type { ReactNode } from 'react';

export const metadata = { title: 'ezTerm', description: 'SSH client' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
