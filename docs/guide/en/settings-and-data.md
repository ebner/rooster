# Settings and your data

Open **Settings** from the menu under your name at the bottom of the sidebar, with `G` then `S`, or from the bottom bar on a phone. Changes are saved as soon as you make them.

| Section | What's there |
|---|---|
| **Profile** | Name, picture, language, time zone, date and time format, installing the app |
| **Behaviour** | Swipe actions on phones |
| **Notifications** | What reaches you where, push on this device, reminder and digest times |
| **Calendar feed** | Your due dates in a calendar app |
| **Security** | Signed-in devices, linked identities, connected apps and tokens |
| **Data** | Export and the Trash |

## Profile

- **Name:** how others see you in shared organisations.
- **Picture:** **Upload picture** (PNG, JPEG, GIF, WebP or AVIF, at most 2 MB), **Change picture**, or **Remove picture** to go back to the one from your sign-in provider.
- **Language:** English or Svenska. It also decides which words rooster understands in [dates typed into titles](./dates-and-repeats.md).
- **Time zone:** what "today" and due times mean for you. rooster suggests your browser's time zone.
- **Week starts on:** Monday or Sunday.
- **Date format** (Oct 12 or 12 Oct) and **Time format** (24 h or 12 h). Swedish always shows the day first.
- **Install app:** see [Phone and offline](./phone-and-offline.md#install-the-app).

## Behaviour

Choose what happens when you swipe a task right or left on a phone: Complete, Set date, Move to group, Delete, or Nothing. A preview shows what the swipe uncovers.

## Notifications and calendar feed

See [Notifications](./notifications.md) and [Calendar feeds](./calendar-feeds.md).

## Security

- **Signed-in devices:** every browser and app where you are signed in, with when it was last active. **Sign out** signs that device out on its next request.
- **Linked identities:** the accounts you can sign in with, for example Google and your company's sign-in. **Unlink** one you no longer use; the last one can't be unlinked.
- **Connected apps:** tokens, command-line logins and AI agents that use rooster for you, with what they may do and when they were last used. **Edit** narrows what one may do, **Revoke** stops it at once, and **New token** creates a personal access token. See [Terminal and AI agents](./cli-tui-mcp.md#what-a-connection-may-do).

## Data

Choose an **Organisation** at the top; both parts work per organisation.

- **Export:** **Export JSON** or **Export Markdown** downloads your groups, tasks, subtasks and tags in that organisation.
- **Trash:** deleted tasks stay here for 30 days and are then removed for good. The Trash is shared by everyone in the organisation and shows who deleted what. **Restore** puts a task back where it was; **Delete permanently** removes it now and can't be undone.

If your administrator has set a storage quota for attachments, files on tasks in the Trash keep counting towards it until they are removed. See [Attachments](./attachments.md#limits).

Export and the Trash need a connection.

## Organisation settings

Open them from the **⋯** menu next to an organisation in the sidebar (**Organisation settings**). Owners manage the name, members and invites; every member can manage tags and leave.

- **General:** the organisation's name, icon and colour. Your personal organisation can't be renamed, shared or deleted.
- **Members:** change someone's role (**Owner** or **Member**) or **Remove** them. Their tasks become unassigned and their groups are deleted. Every organisation keeps at least one owner.
- **Invites:** invite by email or create an **Invite link**, used **Once** or **Many times**, that expires after a number of days. Open invites are listed and can be revoked. Without email set up on the server, both give you a link to copy.
- **Tags:** rename a tag, change its colour, merge it into another tag (**Merge into…**), or delete it from every task.
- **Danger zone:** **Leave…** the organisation (you need a new invite to come back), or, as an owner, **Delete…** it with all its tasks, groups and tags, after typing its name.

See [Working together](./collaboration.md) for what members share.

## Sign out

Choose **Sign out** in the menu under your name. rooster removes everything it stored on this device for you: cached tasks, changes that haven't been sent yet, recent searches and drafts, and push for this device. Wait until the sync status in the header has gone before you sign out, so no changes are lost. Signing out of rooster doesn't sign you out of Google or your company's sign-in.

## Admin

If you are an administrator of your rooster server, the menu under your name also has **Admin**: who may sign in (the allowlist), users (disable or enable them), backups (download one, or **Back up now**) and the server's push keys. The operator guide covers running the server.
