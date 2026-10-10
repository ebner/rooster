import svAdmin from '../locales/sv/admin.json' with { type: 'json' };
import svAttachments from '../locales/sv/attachments.json' with { type: 'json' };
import svAuth from '../locales/sv/auth.json' with { type: 'json' };
import svCalendar from '../locales/sv/calendar.json' with { type: 'json' };
import svCli from '../locales/sv/cli.json' with { type: 'json' };
import svCollab from '../locales/sv/collab.json' with { type: 'json' };
import svCommon from '../locales/sv/common.json' with { type: 'json' };
import svDates from '../locales/sv/dates.json' with { type: 'json' };
import svDev from '../locales/sv/dev.json' with { type: 'json' };
import svEditor from '../locales/sv/editor.json' with { type: 'json' };
import svInbox from '../locales/sv/inbox.json' with { type: 'json' };
import svList from '../locales/sv/list.json' with { type: 'json' };
import svMail from '../locales/sv/mail.json' with { type: 'json' };
import svMobile from '../locales/sv/mobile.json' with { type: 'json' };
import svPalette from '../locales/sv/palette.json' with { type: 'json' };
import svPane from '../locales/sv/pane.json' with { type: 'json' };
import svPeople from '../locales/sv/people.json' with { type: 'json' };
import svPwa from '../locales/sv/pwa.json' with { type: 'json' };
import svSettings from '../locales/sv/settings.json' with { type: 'json' };
import svShell from '../locales/sv/shell.json' with { type: 'json' };
import svTags from '../locales/sv/tags.json' with { type: 'json' };
import svTui from '../locales/sv/tui.json' with { type: 'json' };
import svViews from '../locales/sv/views.json' with { type: 'json' };

/** Every sv namespace, in one module so a client can load a single locale lazily. */
export const sv = {
  common: svCommon,
  dev: svDev,
  shell: svShell,
  auth: svAuth,
  settings: svSettings,
  admin: svAdmin,
  dates: svDates,
  list: svList,
  pane: svPane,
  tags: svTags,
  editor: svEditor,
  pwa: svPwa,
  mobile: svMobile,
  views: svViews,
  palette: svPalette,
  people: svPeople,
  collab: svCollab,
  inbox: svInbox,
  attachments: svAttachments,
  calendar: svCalendar,
  mail: svMail,
  cli: svCli,
  tui: svTui,
} as const;
