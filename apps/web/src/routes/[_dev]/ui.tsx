import { createFileRoute, notFound } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

// Dev builds only (WP 0.4): in production `import.meta.env.DEV` is statically false,
// so the kitchen sink import is dropped from the bundle and the route 404s.
const KitchenSink = import.meta.env.DEV
  ? lazy(() =>
      import('../../features/dev-ui/kitchen-sink').then((m) => ({ default: m.KitchenSink })),
    )
  : null;

export const Route = createFileRoute('/_dev/ui')({
  beforeLoad: () => {
    if (!KitchenSink) throw notFound();
  },
  component: DevUiRoute,
});

function DevUiRoute() {
  if (!KitchenSink) return null;
  return (
    <Suspense>
      <KitchenSink />
    </Suspense>
  );
}
