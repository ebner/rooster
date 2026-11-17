import { isProjectView } from '@rooster/core/saved-views';
import type { SavedView } from '@rooster/core/schemas';
import { Archive, ArchiveRestore, Hash, Search, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link as AriaLink } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import type { Org } from '../../data/types';
import { cn } from '../../lib/cn';
import { Banner } from '../../ui/banner';
import { Button, iconStrokeWidth } from '../../ui/button';
import { SettingsSection } from '../settings/settings-section';
import { orgUrlSlug, paths } from '../shell/paths';

export interface ViewsSectionProps {
  org: Pick<Org, 'name' | 'slug' | 'isPersonal'>;
  /** The live views (shared ones and the viewer's private ones), in the viewer's order. */
  views: readonly SavedView[];
  /** The archived ones (ADR 0073 B10). */
  archived: readonly SavedView[];
  onArchive: (view: SavedView) => unknown;
  onRestore: (view: SavedView) => unknown;
  onDelete: (view: SavedView) => unknown;
}

/**
 * Org settings → Views (ADR 0073 B10, B13): the views in every sidebar, to archive or delete,
 * then the archived ones, to restore or delete. Deleting asks inline, never in a modal (02 §1).
 * In a shared org the section says what a shared view is not: access control.
 */
export function ViewsSection({
  org,
  views,
  archived,
  onArchive,
  onRestore,
  onDelete,
}: ViewsSectionProps) {
  const { t } = useTranslation('settings');
  const slug = orgUrlSlug(org);
  return (
    <SettingsSection
      id="views"
      title={t('org.views.title')}
      description={t('org.views.description')}
    >
      {!org.isPersonal && (
        <Banner tone="info">{t('org.views.sharedNote', { org: org.name })}</Banner>
      )}
      <ViewList
        label={t('org.views.live')}
        empty={t('org.views.empty')}
        views={views}
        render={(view) => (
          <ViewRow
            key={view.id}
            view={view}
            href={paths.savedView(slug, view.id)}
            showSharing={!org.isPersonal}
            primary={{
              label: t('org.views.archive'),
              name: t('org.views.archiveNamed', { name: view.name }),
              icon: Archive,
              run: () => onArchive(view),
            }}
            onDelete={() => onDelete(view)}
          />
        )}
      />
      <h3 className="text-md font-medium">{t('org.views.archivedTitle')}</h3>
      <ViewList
        label={t('org.views.archivedTitle')}
        empty={t('org.views.archivedEmpty')}
        views={archived}
        render={(view) => (
          <ViewRow
            key={view.id}
            view={view}
            showSharing={!org.isPersonal}
            primary={{
              label: t('org.views.restore'),
              name: t('org.views.restoreNamed', { name: view.name }),
              icon: ArchiveRestore,
              run: () => onRestore(view),
            }}
            onDelete={() => onDelete(view)}
          />
        )}
      />
    </SettingsSection>
  );
}

function ViewList({
  label,
  empty,
  views,
  render,
}: {
  label: string;
  empty: string;
  views: readonly SavedView[];
  render: (view: SavedView) => ReactNode;
}) {
  if (views.length === 0) return <p className="text-sm text-text-secondary">{empty}</p>;
  return (
    <ul className="flex flex-col divide-y divide-border" aria-label={label}>
      {views.map(render)}
    </ul>
  );
}

interface RowAction {
  label: string;
  /** The accessible name, with the view's name. */
  name: string;
  icon: typeof Archive;
  run: () => unknown;
}

function ViewRow({
  view,
  href,
  showSharing,
  primary,
  onDelete,
}: {
  view: SavedView;
  /** Live views link to themselves; archived ones have no page to open. */
  href?: string;
  showSharing: boolean;
  primary: RowAction;
  onDelete: () => unknown;
}) {
  const { t } = useTranslation('settings');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<'primary' | 'delete' | null>(null);
  const project = isProjectView(view.query);
  const Icon = project ? Hash : Search;

  const act = async (which: 'primary' | 'delete', fn: () => unknown) => {
    setBusy(which);
    try {
      await fn();
      setConfirming(false);
    } catch {
      // The caller reports the failure; the row stays as it was.
    } finally {
      setBusy(null);
    }
  };

  const meta = [
    showSharing ? t(view.shared ? 'org.views.shared' : 'org.views.private') : null,
    project ? t('org.views.project') : null,
    t('org.views.open', { count: view.openCount }),
  ].filter(Boolean);

  const name = (
    <span className="flex min-w-0 items-center gap-2">
      <Icon
        className="size-4 shrink-0 text-icon-subtle"
        strokeWidth={iconStrokeWidth}
        aria-hidden
      />
      <span className="truncate">{view.name}</span>
    </span>
  );

  return (
    <li className="flex flex-col gap-2 py-2" data-testid="view-settings-row" data-view={view.name}>
      <div className="flex min-h-control flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {href ? (
            <AriaLink
              href={href}
              className={cn(
                'min-w-0 cursor-default rounded-xs text-sm font-medium text-text hover:underline',
                'outline-offset-2 focus-ring:outline-2 focus-ring:outline-border-focus',
              )}
            >
              {name}
            </AriaLink>
          ) : (
            <span className="text-sm font-medium text-text">{name}</span>
          )}
          <span className="ps-6 text-xs text-text-muted">{meta.join(' · ')}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="secondary"
            size="sm"
            aria-label={primary.name}
            isLoading={busy === 'primary'}
            onPress={() => act('primary', primary.run)}
          >
            <primary.icon className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
            {primary.label}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('org.views.deleteNamed', { name: view.name })}
            aria-expanded={confirming}
            onPress={() => setConfirming(true)}
          >
            <Trash2 className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
            {t('org.views.delete')}
          </Button>
        </div>
      </div>
      {confirming && (
        <fieldset
          aria-label={t('org.views.deleteAction')}
          className="m-0 flex min-w-0 flex-wrap items-center gap-2 rounded-md border-0 bg-bg-subtle p-3 text-sm text-text-secondary"
        >
          <p className="min-w-0 flex-1">
            {t(view.shared ? 'org.views.deleteConfirm' : 'org.views.deleteConfirmPrivate', {
              name: view.name,
            })}
          </p>
          <Button variant="secondary" size="sm" onPress={() => setConfirming(false)}>
            {t('org.views.cancel')}
          </Button>
          <Button
            variant="danger"
            size="sm"
            isLoading={busy === 'delete'}
            onPress={() => act('delete', onDelete)}
          >
            {t('org.views.deleteAction')}
          </Button>
        </fieldset>
      )}
    </li>
  );
}
