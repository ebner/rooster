import enAdmin from '../locales/en/admin.json' with { type: 'json' };
import enAuth from '../locales/en/auth.json' with { type: 'json' };
import enCli from '../locales/en/cli.json' with { type: 'json' };
import enCollab from '../locales/en/collab.json' with { type: 'json' };
import enCommon from '../locales/en/common.json' with { type: 'json' };
import enDates from '../locales/en/dates.json' with { type: 'json' };
import enDev from '../locales/en/dev.json' with { type: 'json' };
import enEditor from '../locales/en/editor.json' with { type: 'json' };
import enInbox from '../locales/en/inbox.json' with { type: 'json' };
import enList from '../locales/en/list.json' with { type: 'json' };
import enMail from '../locales/en/mail.json' with { type: 'json' };
import enMobile from '../locales/en/mobile.json' with { type: 'json' };
import enPalette from '../locales/en/palette.json' with { type: 'json' };
import enPane from '../locales/en/pane.json' with { type: 'json' };
import enPeople from '../locales/en/people.json' with { type: 'json' };
import enPwa from '../locales/en/pwa.json' with { type: 'json' };
import enSettings from '../locales/en/settings.json' with { type: 'json' };
import enShell from '../locales/en/shell.json' with { type: 'json' };
import enTags from '../locales/en/tags.json' with { type: 'json' };
import enViews from '../locales/en/views.json' with { type: 'json' };

/** Every en namespace, in one module so a client can load a single locale lazily. */
export const en = {
  common: enCommon,
  dev: enDev,
  shell: enShell,
  auth: enAuth,
  settings: enSettings,
  admin: enAdmin,
  dates: enDates,
  list: enList,
  pane: enPane,
  tags: enTags,
  editor: enEditor,
  pwa: enPwa,
  mobile: enMobile,
  views: enViews,
  palette: enPalette,
  people: enPeople,
  collab: enCollab,
  inbox: enInbox,
  mail: enMail,
  cli: enCli,
} as const;
