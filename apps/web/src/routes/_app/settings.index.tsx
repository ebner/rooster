import { createFileRoute, Navigate, redirect } from '@tanstack/react-router';
import { SettingsIndex } from '../../features/settings/settings-index';
import { isMobileViewport, useIsMobile } from '../../ui/use-media';

/**
 * Phones show the settings index to drill into; tablet and desktop go straight to the first
 * section beside the side menu. Decided before rendering, so neither layout flashes.
 */
export const Route = createFileRoute('/_app/settings/')({
  beforeLoad: () => {
    if (!isMobileViewport()) throw redirect({ to: '/settings/profile', replace: true });
  },
  component: SettingsIndexRoute,
});

function SettingsIndexRoute() {
  // A phone turned or resized past the breakpoint while on the index.
  if (!useIsMobile()) return <Navigate to="/settings/profile" replace />;
  return <SettingsIndex />;
}
