import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { t } from '../lib/i18n.ts';

type Mode = 'system' | 'light' | 'dark';
const ThemeContext = createContext({ mode: 'system' as Mode, dark: false, setMode: (_mode: Mode) => {} });

/** A display preference only: no storage, cookies, network or session activity. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>('system');
  const [systemDark, setSystemDark] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (mode === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = mode;
    return () => { delete document.documentElement.dataset.theme; };
  }, [mode]);
  return <ThemeContext.Provider value={{ mode, dark: mode === 'dark' || (mode === 'system' && systemDark), setMode }}>{children}</ThemeContext.Provider>;
}

export function ThemeControl() {
  const { mode, dark, setMode } = useContext(ThemeContext);
  const label = dark ? t('theme.dark') : t('theme.light');
  const action = dark ? t('theme.switchLight') : t('theme.switchDark');
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('theme.appearance')}>
      <button type="button" className="btn-secondary" aria-label={`${label}. ${action}`} title={action} onClick={() => setMode(dark ? 'light' : 'dark')}>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
          {dark ? <path strokeLinecap="round" strokeLinejoin="round" d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z" /> : <><circle cx="12" cy="12" r="4" /><path strokeLinecap="round" d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>}
        </svg>
        <span>{label}</span>
      </button>
      {mode !== 'system' ? <button type="button" className="inline-flex min-h-target min-w-target items-center rounded-lg px-2 text-sm text-link underline underline-offset-4" onClick={() => setMode('system')}>{t('theme.useDevice')}</button> : <span className="text-sm text-ink-3">{t('theme.device')}</span>}
    </div>
  );
}
