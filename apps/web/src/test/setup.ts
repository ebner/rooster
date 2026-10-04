import { createI18n } from '@rooster/i18n';
import { cleanup } from '@testing-library/react';
import { initReactI18next } from 'react-i18next';
import { afterEach } from 'vitest';

// Components read translations through react-i18next's global instance.
createI18n('en', { plugins: [initReactI18next] });

afterEach(() => {
  cleanup();
});
