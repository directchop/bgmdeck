// When the app may look for / install an update: never while something is
// playing, and the operator can turn startup checks off on a show machine.
export const UPDATE_PREFS_KEY = "bgmdeck.updates.v1";

export interface UpdatePrefs {
  checkOnStartup: boolean;
  channel: "stable" | "beta";
}

export const DEFAULT_UPDATE_PREFS: UpdatePrefs = { checkOnStartup: true, channel: "stable" };

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadUpdatePrefs(): UpdatePrefs {
  try {
    const raw = storage()?.getItem(UPDATE_PREFS_KEY);
    if (!raw) return DEFAULT_UPDATE_PREFS;
    const p = JSON.parse(raw) as Partial<UpdatePrefs>;
    return {
      checkOnStartup: typeof p.checkOnStartup === "boolean" ? p.checkOnStartup : DEFAULT_UPDATE_PREFS.checkOnStartup,
      channel: p.channel === "beta" ? "beta" : "stable",
    };
  } catch {
    return DEFAULT_UPDATE_PREFS;
  }
}

export function saveUpdatePrefs(prefs: UpdatePrefs): void {
  try {
    storage()?.setItem(UPDATE_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}

export function updatesAllowedNow(playing: boolean): boolean {
  return !playing;
}

export function shouldCheckOnStartup(prefs: UpdatePrefs, playing: boolean): boolean {
  return prefs.checkOnStartup && updatesAllowedNow(playing);
}
