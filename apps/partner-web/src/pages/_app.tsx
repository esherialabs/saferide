import type { AppProps } from 'next/app';
import Head from 'next/head';

import { AttentionWatcher } from '../components/AttentionWatcher.tsx';
import { SessionManager } from '../components/SessionManager.tsx';
import { ThemeProvider } from '../components/ThemeControl.tsx';
import '../styles/globals.css';

export default function PartnerApp({ Component, pageProps }: AppProps) {
  return (
    <ThemeProvider>
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <Component {...pageProps} />
      <SessionManager />
      <AttentionWatcher />
    </ThemeProvider>
  );
}
