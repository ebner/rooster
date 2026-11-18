/**
 * The site's English copy. `sv.ts` has the same shape (`Copy`), so a missing Swedish string is
 * a type error. Inline markup: `code` and **strong** (see `inline()` in html.ts).
 */
export const en = {
  lang: 'en',
  otherLanguage: 'Svenska',
  meta: {
    title: 'rooster: a calm, keyboard-first task manager you host yourself',
    description:
      'A self-hosted task manager for you and a small team. The list works like a text editor: type a task, press Enter, type the next. Dates in plain words, a phone app that works offline, a CLI and MCP for AI agents. Free software under the AGPL.',
    ogAlt: 'The rooster logo next to its task list',
  },
  nav: {
    skip: 'Skip to content',
    features: 'Features',
    selfHost: 'Self-host',
    guide: 'User guide',
    github: 'GitHub',
    menu: 'Main',
    language: 'Language',
  },
  hero: {
    title: 'A calm, keyboard‑first task manager.',
    lead: 'Type a task, press Enter, type the next. rooster keeps a daily **My tasks** list for you and a small team, on your own server.',
    primary: 'Self-host it',
    secondary: 'Read the guide',
    facts: 'Free software · AGPL-3.0 · Version {version}',
    shotAlt:
      'My tasks with the detail pane open: an Inbox, the groups Today and Prio, coloured dates and tags, and a task with its description, subtasks and reminder',
    phoneAlt: 'Today on a phone, with the view switcher, the add button and the bottom bar',
  },
  editor: {
    kicker: 'The list',
    title: 'The list is a text editor.',
    body: 'Rename, re-date, tag, move and complete without leaving the keyboard, and undo anything. There are no dialogs: a side pane opens only when you want to write a description, add subtasks or comment.',
    groups:
      'Your own groups, like *Today*, *Prio* and *This week*, in exactly the order you choose. Smart views gather Today, Next 7 days, Overdue and No date, and work from others lands in an Inbox at the top.',
    keysLabel: 'A few of the shortcuts',
    keys: [
      { keys: ['Enter'], label: 'Next task' },
      { keys: ['Ctrl', 'Enter'], label: 'Complete' },
      { keys: ['Ctrl', '↑'], label: 'Move up' },
      { keys: ['Tab', 'D'], label: 'Set a date' },
      { keys: ['Ctrl', 'K'], label: 'Search and commands' },
      { keys: ['Ctrl', 'Z'], label: 'Undo' },
    ],
    keysNote: '⌘ instead of Ctrl on a Mac. Press `?` in the app for all of them.',
    shotAlt:
      'The command palette searching for "juniper", with matching tasks and sections of the guide',
  },
  dates: {
    kicker: 'Dates',
    title: 'Dates in plain words.',
    body: 'Write the date into the title, in English or Swedish, and rooster picks it up as you type. Add `#tags`, and `!1h` for a reminder. `every mon` or `every 3 days after done` makes a task repeat: the next one appears right below the one you finish.',
    demoLabel: 'Try it: type a task',
    demoHint: 'Runs the same parser as the app, in your browser. Nothing is sent anywhere.',
    examplesLabel: 'Examples',
    examples: [
      'Call the bank fri at 14 #finance !1h',
      'Water the plants every mon',
      'Meeting tomorrow at 10 #work !15m',
      'Renew the domain dec 1 !1d',
      'Send the report in 3 days',
      'Change the filter every 3 months after done',
    ],
    initial: 'Call the bank fri at 14 #finance !1h',
    result: {
      label: 'What rooster saves',
      title: 'Title',
      due: 'Due',
      noDue: 'No date',
      tags: 'Tags',
      reminders: 'Reminders',
      repeats: 'Repeats',
      empty: 'Type something above',
    },
    reminder: {
      atDue: 'At the due time',
      minutes: '{n} min before',
      hours: '{n} h before',
      days: '{n} days before',
      day: '1 day before',
    },
    repeat: {
      daily: 'Every day',
      dailyN: 'Every {n} days',
      weekly: 'Every {days}',
      weeklyN: 'Every {n} weeks on {days}',
      weekdays: 'Every weekday',
      monthly: 'Every month',
      monthlyN: 'Every {n} months',
      yearly: 'Every year',
      yearlyN: 'Every {n} years',
      afterDays: '{n} days after done',
      afterDay: '1 day after done',
      afterWeeks: '{n} weeks after done',
      afterWeek: '1 week after done',
      afterMonths: '{n} months after done',
      afterMonth: '1 month after done',
      afterYears: '{n} years after done',
      afterYear: '1 year after done',
    },
    pickerAlt: 'The date picker with quick picks, a calendar, a time, Repeat and Reminders',
    pickerCaption: 'Or pick: quick picks, a calendar, a time, Repeat and Reminders.',
  },
  team: {
    kicker: 'Together',
    title: 'Private and shared, kept apart.',
    body: 'Every task belongs to one organisation: your personal one, or a shared one for your team or your family. In a shared organisation you assign tasks, comment with @mentions and follow along. Everyone keeps their own groups and order.',
    points: [
      "**Everyone's tasks** shows the whole organisation, a section per person.",
      '**Views** gather tasks by tag, person and date. A project view collects one tag across the team and shows how far it has come: “11 open · 3 done”.',
      "**All organisations** shows today's tasks from all your organisations in one list: work, home and the club.",
      'An **inbox** collects mentions, comments and assignments.',
      'Notifications in the app, as **push** on each device and by **email**, with a daily digest.',
    ],
    projectAlt:
      'A project view: the tasks tagged juniper, grouped by person, with “11 open · 3 done” in the header',
    inboxAlt: 'The inbox with mentions, comments and assignments',
  },
  phone: {
    kicker: 'Phone',
    title: 'In your pocket, offline too.',
    body: 'Install rooster from the browser on iPhone or Android. Swipe to complete or re-date, press and hold to drag, and keep working without a connection: your edits wait in a queue until you are back online.',
    shots: [
      {
        name: 'my-tasks',
        alt: 'My tasks on a phone, with the view switcher, the add button and the bottom bar',
      },
      { name: 'swipe', alt: 'Swiping a task to the side to complete it' },
      { name: 'task-pane', alt: 'A task as a full-screen sheet' },
      { name: 'date-picker', alt: 'The quick date sheet' },
      {
        name: 'all-orgs-today',
        alt: "All organisations: today's tasks from every organisation in one list",
      },
    ],
  },
  terminal: {
    kicker: 'Terminal and agents',
    title: 'Also in the terminal, and for your AI agents.',
    body: 'The `rooster` CLI adds and lists tasks with the same plain-word dates, prints JSON for scripts, and opens a full-screen terminal app when you run it on its own.',
    agents:
      'AI agents connect to rooster over MCP. On a consent screen you choose what an agent may read and change, in which organisations and groups, and you can revoke it at any time.',
    tuiAlt:
      'The full-screen terminal app: My tasks with groups, coloured dates and tags, and the key hints at the bottom',
    consentAlt:
      'The consent screen where you choose what the CLI or an agent may do, and in which organisations',
    consentCaption: 'You decide what an agent may do, and where.',
    cliDocs: 'Command line, terminal app and agents',
    cliTask: 'Pay the invoice fri #finance !1h',
    cliLabel: 'The rooster CLI',
  },
  more: {
    title: 'And the rest',
    items: [
      {
        title: 'Search everything',
        body: 'Ctrl+K searches tasks and comments and runs every command, offline too.',
      },
      {
        title: 'Attachments',
        body: 'Paste or drop files on a task; images get thumbnails and a viewer.',
      },
      {
        title: 'Calendar feed',
        body: 'A secret iCal link for Google Calendar, Apple Calendar or Outlook.',
      },
      { title: 'Reminders', body: 'In the inbox, as a push and by email, at the time you choose.' },
      {
        title: 'Export and Trash',
        body: 'Export to JSON or Markdown. Deleted tasks wait 30 days in the Trash.',
      },
      {
        title: 'English and Swedish',
        body: 'The whole app, the dates you type and this guide, in both languages.',
      },
    ],
  },
  host: {
    kicker: 'Self-host',
    title: 'Your server, your data.',
    body: 'rooster is one Docker container with one SQLite file. Sign-in goes through Google or any OIDC provider (Keycloak, Authentik …), so there are no passwords to store. Nothing is sent anywhere else: no telemetry, no tracking.',
    facts: [
      'One container, one volume',
      'Nightly backups, and one before every upgrade',
      'Migrations run by themselves',
      'Google, Keycloak, Authentik or any OIDC',
      'Installable app for phones',
      'No telemetry',
    ],
    stepsTitle: 'Quick start',
    stepsIntro:
      'You need Docker, a domain with HTTPS behind a reverse proxy, and a Google or OIDC client for sign-in.',
    steps: [
      { title: 'Get the compose file and the configuration template', code: 'get' },
      {
        title: 'Fill in `.env`: the address, a secret, your email and one sign-in provider',
        code: 'env',
      },
      { title: 'Start it, and point your reverse proxy at `127.0.0.1:3000`', code: 'up' },
    ],
    after:
      'Open the address and sign in with your admin email. On a phone, open the same address and add it to the home screen.',
    operator: 'Operator guide',
    operatorBody: 'Every setting, the reverse proxy, backups, upgrades and monitoring.',
    oidc: 'Sign-in setup',
    oidcBody: 'Google, Keycloak and Authentik, step by step.',
    releases: 'Releases',
    releasesBody: 'The changelog, and the CLI for Linux, macOS and Windows.',
  },
  footer: {
    tagline: 'A calm, keyboard-first task manager.',
    project: 'Project',
    docs: 'Documentation',
    source: 'Source code',
    changelog: 'Changelog',
    security: 'Security',
    contributing: 'Contributing',
    license: 'Licence (AGPL-3.0)',
    notices: 'Third-party notices',
    userGuide: 'User guide',
    operatorGuide: 'Operator guide',
    signIn: 'Sign-in setup',
    copyright: '© 2026 Hannes Ebner. The people and companies in the screenshots are made up.',
  },
  guide: {
    title: 'User guide',
    intro:
      'How rooster works, page by page. The same guide is built into the app at `/help`, where it also works offline.',
    pages: 'Pages',
    previous: 'Previous',
    next: 'Next',
    edit: 'Edit this page on GitHub',
    home: 'rooster',
  },
  code: {
    copy: 'Copy',
    copied: 'Copied',
  },
  notFound: {
    title: 'Page not found',
    body: 'There is nothing at this address.',
    home: 'Go to the start page',
  },
};

export type Copy = typeof en;
