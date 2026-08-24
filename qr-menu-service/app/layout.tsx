import { Analytics } from '@vercel/analytics/next'
import { DM_Sans, Fraunces } from 'next/font/google'
import type { Metadata, Viewport } from 'next'
import './globals.css'

const dmSans = DM_Sans({ subsets: ['latin', 'cyrillic'], variable: '--font-dm-sans' })
const fraunces = Fraunces({ subsets: ['latin', 'cyrillic'], variable: '--font-fraunces' })

export const metadata: Metadata = {
  title: 'qr.menu — цифровое меню для вашего бизнеса',
  description: 'Красивое меню по QR-коду за 5 минут.',
  generator: 'v0.app',
  icons: {
    icon: [
      {
        url: '/icon-light-32x32.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icon-dark-32x32.png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/icon.svg',
        type: 'image/svg+xml',
      },
    ],
    apple: '/apple-icon.png',
  },
}

export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: 'white' },
    { media: '(prefers-color-scheme: dark)', color: 'black' },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="ru" className="bg-background">
      <body className={`${dmSans.variable} ${fraunces.variable} antialiased`}>
        {children}
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
