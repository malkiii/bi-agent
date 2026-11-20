import type { Metadata } from 'next';
import { JetBrains_Mono, Space_Grotesk } from 'next/font/google';
import type { ReactNode } from 'react';
import { BotleyProvider } from '@/web/botley/BotleyProvider';
import { getThemePreference } from '@/web/theme/current-theme';
import { themeAttribute } from '@/web/theme/theme';
import './globals.css';

const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-space-grotesk' });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains-mono' });

export const metadata: Metadata = {
  title: 'Botley',
  description: 'Ask your business data anything.',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = await getThemePreference();
  return (
    <html
      lang="en"
      className={`${spaceGrotesk.variable} ${jetbrainsMono.variable}`}
      data-theme={themeAttribute(theme)}
    >
      <body>
        <BotleyProvider>{children}</BotleyProvider>
      </body>
    </html>
  );
}
