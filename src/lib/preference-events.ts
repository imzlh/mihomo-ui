export const PREFERENCES_CHANGED = 'mihomo-verge:preferences-changed';

/** Refresh already mounted views after a validated preference restore. */
export function notifyPreferencesChanged(): void {
  window.dispatchEvent(new Event(PREFERENCES_CHANGED));
  window.dispatchEvent(new Event('theme-change'));
}
