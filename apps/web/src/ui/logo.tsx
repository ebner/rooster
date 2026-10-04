import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';

export interface LogoProps {
  className?: string | undefined;
}

/** The rooster mark (public/icons/logo.svg). Decorative: pair it with visible text. */
export function LogoMark({ className }: LogoProps) {
  return (
    <img src="/icons/logo.svg" alt="" width={24} height={24} className={cn('size-6', className)} />
  );
}

/** Mark + lower-case wordmark (public/icons/wordmark.svg). */
export function Wordmark({ className }: LogoProps) {
  const { t } = useTranslation();
  return (
    <img
      src="/icons/wordmark.svg"
      alt={t('app.name')}
      width={90}
      height={24}
      className={cn('h-6 w-auto', className)}
    />
  );
}
