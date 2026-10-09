import {
  createRootRouteWithContext,
  Link,
  type NavigateOptions,
  Outlet,
  useRouter,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { I18nProvider, RouterProvider } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import type { RouterContext } from '../router';
import { buttonVariants } from '../ui/button';
import { Logo } from '../ui/logo';
import { ToastRegion } from '../ui/toast';
import { useKeymap } from '../use-keymap';

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFound,
  errorComponent: RootError,
});

declare module 'react-aria-components' {
  interface RouterConfig {
    routerOptions: Omit<NavigateOptions, 'to' | 'href'>;
  }
}

function RootLayout() {
  const { i18n } = useTranslation();
  const router = useRouter();
  useKeymap();
  return (
    <I18nProvider locale={i18n.language}>
      {/* React Aria links and menu items with `href` navigate client-side through TanStack. */}
      <RouterProvider
        navigate={(href, options) => router.navigate({ ...options, href })}
        useHref={(href) => href}
      >
        <Outlet />
        <ToastRegion />
      </RouterProvider>
    </I18nProvider>
  );
}

/** A full page outside the app frame, so it carries the logo itself (03 §2.10). */
function BrandedPage({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-bg-subtle px-6">
      <div className="flex flex-col items-center gap-6 text-center">
        <Link
          to="/"
          className="rounded-sm outline-offset-4 focus-visible:outline-2 focus-visible:outline-border-focus"
        >
          <Logo size={32} />
        </Link>
        <div className="flex flex-col items-center gap-3">{children}</div>
      </div>
    </main>
  );
}

function NotFound() {
  const { t } = useTranslation();
  return (
    <BrandedPage>
      <h1 className="text-xl">{t('notFound.title')}</h1>
      <p className="text-md text-text-secondary">{t('notFound.body')}</p>
      <Link
        to="/"
        className="text-sm font-medium text-text-accent hover:text-text-accent-hover hover:underline"
      >
        {t('notFound.home')}
      </Link>
    </BrandedPage>
  );
}

/** Replaces the router's bare default; a reload is the one fix a person can try. */
function RootError() {
  const { t } = useTranslation();
  return (
    <BrandedPage>
      <h1 className="text-xl">{t('error.title')}</h1>
      <p className="max-w-pane-min text-md text-text-secondary">{t('error.body')}</p>
      <button
        type="button"
        className={buttonVariants({ variant: 'secondary' })}
        onClick={() => window.location.reload()}
      >
        {t('error.reload')}
      </button>
    </BrandedPage>
  );
}
