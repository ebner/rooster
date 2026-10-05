import {
  createRootRouteWithContext,
  Link,
  type NavigateOptions,
  Outlet,
  useRouter,
} from '@tanstack/react-router';
import { I18nProvider, RouterProvider } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import type { RouterContext } from '../router';
import { ToastRegion } from '../ui/toast';
import { useKeymap } from '../use-keymap';

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFound,
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

function NotFound() {
  const { t } = useTranslation();
  return (
    <main className="grid min-h-dvh place-items-center px-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <h1 className="text-xl">{t('notFound.title')}</h1>
        <p className="text-md text-text-secondary">{t('notFound.body')}</p>
        <Link
          to="/"
          className="text-sm font-medium text-text-accent hover:text-text-accent-hover hover:underline"
        >
          {t('notFound.home')}
        </Link>
      </div>
    </main>
  );
}
