import { create } from "zustand";

export const TABS = ["pads", "settings"] as const;
export type Tab = (typeof TABS)[number];

export type SettingsSection = "audio" | "fades" | "remote" | "updates" | "about";

interface UiState {
  tab: Tab;
  settingsSection: SettingsSection;
  showWaveforms: boolean;
  showShortcuts: boolean;
  /** Pad being renamed inline. */
  renamingSlotId: string | null;
  /** Bank tab being renamed inline. */
  renamingBankId: string | null;
  setTab: (tab: Tab) => void;
  setSettingsSection: (s: SettingsSection) => void;
  setShowWaveforms: (v: boolean) => void;
  setShowShortcuts: (v: boolean) => void;
  setRenamingSlotId: (id: string | null) => void;
  setRenamingBankId: (id: string | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  tab: "pads",
  settingsSection: "audio",
  showWaveforms: true,
  showShortcuts: false,
  renamingSlotId: null,
  renamingBankId: null,
  setTab: (tab) => set({ tab }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  setShowWaveforms: (showWaveforms) => set({ showWaveforms }),
  setShowShortcuts: (showShortcuts) => set({ showShortcuts }),
  setRenamingSlotId: (renamingSlotId) => set({ renamingSlotId }),
  setRenamingBankId: (renamingBankId) => set({ renamingBankId }),
}));
