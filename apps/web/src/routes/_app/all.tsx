import { createFileRoute, Outlet, useLocation } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useMe } from '../../data';
import { AllScreen } from '../../features/all-orgs/all-screen';
import { allListViewOf, allViewOfPath, useLastAllView } from '../../features/all-orgs/last-view';

/**
 * All organisations (ADR 0073 A, 02 §10.1): one layout for `/all/today`, `/all/week`,
 * `/all/overdue` and `/all/t/:taskId`, so the list stays mounted (selection, drafts, scroll)
 * while the pane opens, follows and closes over the last All view.
 */
export const Route = createFileRoute('/_app/all')({
  component: AllLayout,
});

function AllLayout() {
  const { pathname } = useLocation();
  const me = useMe();
  const lastView = useLastAllView((s) => s.view);
  const view = allListViewOf(pathname, lastView) ?? 'today';
  const ownView = allViewOfPath(pathname);
  useEffect(() => {
    if (ownView) useLastAllView.setState({ view: ownView });
  }, [ownView]);
  if (!me.data) return null;
  return (
    <>
      <AllScreen me={me.data} view={view} />
      <Outlet />
    </>
  );
}
