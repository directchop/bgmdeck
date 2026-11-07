# BGM Deck

パッド型 BGM プレイヤー（開場 / 転換 / 休憩の音楽を出す専用機）。playque の姉妹アプリで、
技術スタック・リリース基盤・メニュー / コマンド構造・アップデーターを playque と揃えてある。

## Tech Stack
- Tauri 2 (Rust) + React / TypeScript / Tailwind v4 / zustand
- オーディオ: cpal 出力、symphonia デコード、`rtrb` リングバッファ（パッドごとにデコードスレッド）
- OSC: rosc、MIDI: midir

## 設計メモ（Claude へ）
- **全部をメモリにデコードしない。** パッドは「プライム済みデコーダ」を持ち、再生時にそれを voice に昇格させて
  すぐ次をプライムする（`audio.rs` の `StreamSource` / `Engine::prime`）。曲の長さに関係なく RAM は数 MB。
- フェード / ダック / マスターはオーディオコールバック内で 1 サンプルごとに計算する（`render`）。
  `set_volume` を刻むような実装に戻さない。
- audio callback と常駐スレッドで `Mutex::lock().unwrap()` を書かない。`audio::lock_or_recover` を使う。
  callback 内でヒープ確保・解放をしない（終了した voice は `graveyard` に積んで `status()` で捨てる）。
- オーディオデバイスは `"<host>::<name>"` の ID。`audio_restart` が実際に開いた ID を返す。
  デバイス再起動で全 voice は止まり、全パッドが新しいサンプルレートで再プライムされる。
- メニュー: `src-tauri/src/menu.rs` → `menu-command` → `src/commands.ts` の `runCommand(id)`。
  キーボードも同じ `runCommand` を通る。修飾キー無しのキー（数字 / Space / D / [ ]）はメニューのアクセラレータにしない。
  メニューの有効 / チェックは `menu_sync`。
- OSC / MIDI → `RemoteCommand`（`src/remoteCommands.ts`）→ ストア。アドレス表は `src/oscReceive.ts` の
  `OSC_REFERENCE` が Settings と README の正。パッド / バンクは wire 上 1 始まり。
- リモートからの play は常に再生（トグルしない）。UI のタップは `tapToStop` 設定でトグル。
- デッキファイル（`.bgmdeck`）は `src/deckFile.ts` で寛容にパースする（欠損・不正はデフォルトに落とす、
  新しい `version` は拒否）。マシン依存の設定（デバイス / OSC ポート / MIDI）はファイルに入れず localStorage。
- ログは常時ファイル出力（`bgmdeck.log`）。失敗経路には `log::warn!/error!` を添える。webview 側は `logFrontend`。
- アップデートは `updates-worker/`（Cloudflare Worker + R2、playque と同じコード）。再生中はチェックも
  インストールもしない。リリース後 `scripts/publish-updates.sh <tag>`。
- ヘッダにロゴ / バージョンは出さない。バージョンは About と Settings → Updates。

## テスト
- `npm test`: `tests/load-deck.mjs` が実際の TS モジュールを vm に読み込み、`bridge.ts` だけ差し替える。
  新しいモジュールは `MODULES` に足す。vm 越しのオブジェクトは `node:assert`（非 strict）で比較する。
- `cd src-tauri && cargo test`: エンジンの純粋部分（カーブ、ランプ、リサンプラ、ミキサー）、OSC 送受信。

## 開発ルール
- 区切りの良いところでコミット。PR → CI（mac / Windows / Linux）→ マージ。
- リリース: `package.json` / `package-lock.json` / `src-tauri/Cargo.toml`（+ `Cargo.lock`）/
  `src-tauri/tauri.conf.json` / `CHANGELOG.md` を上げて `vX.Y.Z` タグ → `release.yml` → `publish-updates.sh`。
