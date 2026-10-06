import './styles/theme.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { startSync } from './data/sync/engine';
import { PwaRoot } from './features/pwa/pwa-root';
import { i18n, i18nReady } from './lib/i18n';
import { queryClient, router } from './router';

const container = document.getElementById('root');
if (!container) throw new Error('#root element missing from index.html');

// 04 §6: the persisted cache and the outbox are restored before the first render, so a cold
// start (even offline) shows the last-seen data instead of skeletons.
await Promise.all([startSync({ queryClient }), i18nReady]);

const navigate = (href: string) => void router.navigate({ href });

createRoot(container).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <PwaRoot navigate={navigate} />
      </QueryClientProvider>
    </I18nextProvider>
  </StrictMode>,
);
