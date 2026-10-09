import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { Logo } from '../../ui/logo';
import { LanguageSwitch } from '../locale/language-switch';

export interface AuthLayoutProps {
  children: ReactNode;
  /** Kitchen sink: drop the full-viewport height. */
  embedded?: boolean | undefined;
}

/**
 * Centred, quiet frame for the signed-out screens: the logo (drawn in once per load, 03
 * §2.10), content, language switch.
 */
export function AuthLayout({ children, embedded = false }: AuthLayoutProps) {
  const { t } = useTranslation();
  return (
    <div className={cn('flex flex-col bg-bg-subtle', embedded ? 'rounded-lg' : 'min-h-dvh')}>
      <main className="flex flex-1 flex-col items-center justify-center px-3 py-12 tablet:px-6">
        <div className="flex w-full max-w-pane-min flex-col items-center gap-8 text-center">
          <div className="flex flex-col items-center gap-2">
            <Logo layout="stack" size={64} animated />
            <p className="text-sm text-text-secondary">{t('app.tagline')}</p>
          </div>
          <div className="flex w-full flex-col gap-6 rounded-lg border border-border bg-bg-elevated px-6 py-8 shadow-sm tablet:px-8">
            {children}
          </div>
        </div>
      </main>
      <footer className="flex justify-center pb-8">
        <LanguageSwitch />
      </footer>
    </div>
  );
}
