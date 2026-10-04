import { createFileRoute, Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { LanguageSwitch } from '../features/locale/language-switch';
import { LogoMark, Wordmark } from '../ui/logo';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-dvh flex-col bg-bg-app">
      <header className="flex h-toolbar items-center justify-between gap-4 px-3 tablet:px-6 desktop:px-8">
        <Wordmark />
        <LanguageSwitch />
      </header>
      <main className="flex flex-1 flex-col items-center justify-center gap-6 px-3 pb-16 text-center tablet:px-6">
        <LogoMark className="size-16" />
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-2xl">{t('home.title')}</h1>
          <p className="text-md text-text-secondary">{t('app.tagline')}</p>
          <p className="max-w-pane-min text-sm text-text-muted">{t('home.body')}</p>
        </div>
        {import.meta.env.DEV && (
          <Link
            to="/_dev/ui"
            className="rounded-xs text-sm font-medium text-text-accent underline-offset-2 hover:text-text-accent-hover hover:underline"
          >
            {t('home.kitchenSink')}
          </Link>
        )}
      </main>
    </div>
  );
}
