import { onSessionDataCleared } from '../../data/session-events';

/**
 * Unsent comment drafts per task, in memory: switching the pane to another task and back keeps
 * the text (02 §9.2 item 8), a reload starts empty. They go with their author's session data
 * (sign-out, a lost session, another account).
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

onSessionDataCleared(clearDrafts);
