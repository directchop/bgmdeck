import { useEffect } from "react";
import { installAudioRecovery } from "./audioRecovery";
import { oscConfigure } from "./bridge";
import { handleShortcutKeyDown } from "./commands";
import { checkMissingFiles, installCloseGuard } from "./deckIO";
import { installFileDrop } from "./dropFiles";
import { installEngineSync, startEngine } from "./engineSync";
import { installMenu } from "./menu";
import { installMidi } from "./midiMap";
import { installOscFeedback } from "./oscFeedback";
import { installOscListener, installOscReceive } from "./oscReceive";
import { loadUiPrefs, saveUiPrefs } from "./prefs";
import { useDeckStore } from "./store/deck";
import { useUiStore } from "./uiStore";
import { checkForUpdates } from "./updater";
import { loadUpdatePrefs, shouldCheckOnStartup } from "./updatePolicy";
import { BankTabs } from "./components/BankTabs";
import { Header } from "./components/Header";
import { NowPlaying } from "./components/NowPlaying";
import { PadGrid } from "./components/PadGrid";
import { SettingsView } from "./components/SettingsView";
import { ShortcutHelp } from "./components/ShortcutHelp";

export function App() {
  const tab = useUiStore((s) => s.tab);
  const showShortcuts = useUiStore((s) => s.showShortcuts);
  const setShowShortcuts = useUiStore((s) => s.setShowShortcuts);

  // Engine + glue. Order matters: sync subscriptions first so the initial
  // seed after the engine starts sees every pad.
  useEffect(() => {
    const offs = [
      installEngineSync(),
      installAudioRecovery(),
      installMenu(),
      installCloseGuard(),
      installFileDrop(),
      installOscReceive(),
      installOscListener(oscConfigure),
      installOscFeedback(),
      installMidi(),
    ];
    void startEngine();
    void checkMissingFiles();
    return () => offs.forEach((off) => off());
  }, []);

  useEffect(() => {
    window.addEventListener("keydown", handleShortcutKeyDown);
    return () => window.removeEventListener("keydown", handleShortcutKeyDown);
  }, []);

  // Waveform preference
  useEffect(() => {
    useUiStore.getState().setShowWaveforms(loadUiPrefs().showWaveforms);
    return useUiStore.subscribe((s, p) => {
      if (s.showWaveforms !== p.showWaveforms) saveUiPrefs({ showWaveforms: s.showWaveforms });
    });
  }, []);

  // Startup update check, a few seconds in, only when idle.
  useEffect(() => {
    const t = setTimeout(() => {
      if (shouldCheckOnStartup(loadUpdatePrefs(), useDeckStore.getState().voices.length > 0)) void checkForUpdates(true);
    }, 4000);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="h-full flex flex-col bg-bg-darker text-text">
      <Header />
      {tab === "pads" ? (
        <>
          <BankTabs />
          <PadGrid />
        </>
      ) : (
        <SettingsView />
      )}
      <NowPlaying />
      {showShortcuts && <ShortcutHelp onClose={() => setShowShortcuts(false)} />}
    </div>
  );
}
