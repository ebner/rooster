/**
 * Unsent comment drafts per task, in memory: switching the pane to another task and back keeps
 * the text (02 §9.2 item 8), a reload starts empty. Signing out reloads the app, so a draft
 * never outlives its author's session.
 */
const drafts = new Map<string, string>();

export function readDraft(taskId: string): string {
  return drafts.get(taskId) ?? '';
}

export function writeDraft(taskId: string, text: string): void {
  if (text.trim() === '') drafts.delete(taskId);
  else drafts.set(taskId, text);
}

export function clearDrafts(): void {
  drafts.clear();
}
