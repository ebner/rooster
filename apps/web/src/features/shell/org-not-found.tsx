import { Link } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { buttonVariants } from '../../ui/button';
import { ViewBody, ViewHeader } from './app-shell';
import { paths } from './paths';

function Message({ title, body }: { title: string; body: string }) {
  const { t } = useTranslation('shell');
  return (
    <>
      <ViewHeader title={title} />
      <ViewBody>
        <div className="flex flex-col items-start gap-4 pt-8">
          <p className="text-md text-text-secondary">{body}</p>
          <Link
            href={paths.orgView('personal', 'my')}
            className={buttonVariants({ variant: 'secondary' })}
          >
            {t('notFound.home')}
          </Link>
        </div>
      </ViewBody>
    </>
  );
}

/** Non-members get 404 for org resources (06 §1), so the UI says "not found", not "forbidden". */
export function OrgNotFound() {
  const { t } = useTranslation('shell');
  return <Message title={t('notFound.orgTitle')} body={t('notFound.orgBody')} />;
}
