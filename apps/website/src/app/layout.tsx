import type { ReactNode } from 'react';

type Props = {
  children: ReactNode;
};

// Root layout required by Next.js. The actual layout with <html> and <body>
// is in [locale]/layout.tsx, handled by next-intl.
export default function RootLayout({ children }: Props) {
  return children;
}
