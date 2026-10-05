import { create } from 'zustand';

/** Chromium's install prompt event (not in the DOM typings). */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallPlatform = 'prompt' | 'ios' | 'other';

interface InstallState {
  /** The deferred `beforeinstallprompt`, while the browser offers installation. */
  deferred: BeforeInstallPromptEvent | null;
  installed: boolean;
  /** The iOS "Share → Add to Home Screen" sheet is open. */
  iosSheetOpen: boolean;
}

export const useInstallStore = create<InstallState>()(() => ({
  deferred: null,
  installed: isStandalone(),
  iosSheetOpen: false,
}));

/** 02 §13.5: the one-time install toast appears from this visit on. */
export const installToastFromVisit = 3;
const visitsKey = 'rooster.visits';
const toastShownKey = 'rooster.installToastShown';
const sessionKey = 'rooster.visitCounted';

/** Running as the installed app (standalone display, or iOS home screen). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true || nav.standalone === true
  );
}

/** iOS/iPadOS Safari: installs only through Share → Add to Home Screen. */
export function isIosSafari(userAgent: string, maxTouchPoints: number): boolean {
  const ios =
    /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  const otherBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(userAgent);
  return ios && /Safari\//.test(userAgent) && !otherBrowser;
}

export function installPlatform(state: Pick<InstallState, 'deferred'>): InstallPlatform {
  if (state.deferred) return 'prompt';
  if (
    typeof navigator !== 'undefined' &&
    isIosSafari(navigator.userAgent, navigator.maxTouchPoints)
  ) {
    return 'ios';
  }
  return 'other';
}

function read(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage: Storage | undefined, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Storage blocked: the count restarts, which only delays the toast.
  }
}

/** Counts this visit once per tab session and returns the total. */
export function countVisit(
  local: Storage | undefined = globalThis.localStorage,
  session: Storage | undefined = globalThis.sessionStorage,
): number {
  const visits = Number(read(local, visitsKey) ?? '0') || 0;
  if (read(session, sessionKey)) return visits;
  write(session, sessionKey, '1');
  write(local, visitsKey, String(visits + 1));
  return visits + 1;
}

/** Whether the one-time install toast may show now (and records that it did). */
export function claimInstallToast(
  visits: number,
  local: Storage | undefined = globalThis.localStorage,
): boolean {
  if (visits < installToastFromVisit || read(local, toastShownKey)) return false;
  write(local, toastShownKey, '1');
  return true;
}

/** Shows the browser's install dialog (Android/Chromium). */
export async function promptInstall(): Promise<boolean> {
  const event = useInstallStore.getState().deferred;
  if (!event) return false;
  useInstallStore.setState({ deferred: null });
  await event.prompt();
  const choice = await event.userChoice;
  return choice.outcome === 'accepted';
}

export function openIosInstallSheet(): void {
  useInstallStore.setState({ iosSheetOpen: true });
}

/**
 * Captures `beforeinstallprompt` so installation is offered by the app (the toast after the
 * 3rd visit, Settings → Install app) instead of the browser's mini-infobar.
 */
export function listenForInstall(onPromptAvailable: () => void): () => void {
  const onPrompt = (event: Event) => {
    event.preventDefault();
    useInstallStore.setState({ deferred: event as BeforeInstallPromptEvent });
    onPromptAvailable();
  };
  const onInstalled = () => useInstallStore.setState({ deferred: null, installed: true });
  window.addEventListener('beforeinstallprompt', onPrompt);
  window.addEventListener('appinstalled', onInstalled);
  return () => {
    window.removeEventListener('beforeinstallprompt', onPrompt);
    window.removeEventListener('appinstalled', onInstalled);
  };
}
