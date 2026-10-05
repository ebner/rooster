import type { ListGroup } from '../../data/types';

/** The default groups every membership starts with (FR-AUTH-3); names come localised from the server. */
export const fixtureGroups: ListGroup[] = [
  { id: 'group-inbox', kind: 'inbox', name: 'Inbox' },
  { id: 'group-today', kind: 'normal', name: 'Today' },
  { id: 'group-prio', kind: 'normal', name: 'Prio' },
  { id: 'group-upcoming', kind: 'normal', name: 'Upcoming' },
];
