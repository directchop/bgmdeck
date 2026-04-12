use cpal::traits::{DeviceTrait, HostTrait};
use eframe::egui;
use midir::{Ignore, MidiInput, MidiInputConnection, MidiInputPort};
use parking_lot::Mutex;
use rodio::Source;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs as stdfs;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::{fs::File, io::BufReader, path::Path, sync::Arc, thread, time::Duration};

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
struct SlotConfig {
    path: Option<String>,
    volume: f32, // 0.0 - 1.0
    name: Option<String>,
    looping: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(default)]
struct AppConfig {
    slots: [SlotConfig; 10],
    crossfade_sec: f32,
    output_device_name: Option<String>,
    master_volume: f32,
    sample_rate: Option<u32>,
    midi_input_name: Option<String>,
    midi_slot_notes: [u8; 10],
    midi_stop_note: u8,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            slots: std::array::from_fn(|_| SlotConfig {
                path: None,
                volume: 1.0,
                name: None,
                looping: true,
            }),
            crossfade_sec: 2.0,
            output_device_name: None,
            master_volume: 1.0,
            sample_rate: None,
            midi_input_name: None,
            midi_slot_notes: std::array::from_fn(|i| 36 + i as u8),
            midi_stop_note: 46,
        }
    }
}

fn load_source(path: &str) -> anyhow::Result<rodio::Decoder<BufReader<File>>> {
    let file = File::open(Path::new(path))?;
    let reader = BufReader::new(file);
    let dec = rodio::Decoder::new(reader)?; // mp3/wav対応（rodio経由でSymphonia）
    Ok(dec)
}

fn create_output_stream_with_sample_rate(
    device: &cpal::Device,
    sample_rate: Option<u32>,
) -> Result<(rodio::OutputStream, rodio::OutputStreamHandle), rodio::StreamError> {
    let mut last_err: Option<rodio::StreamError> = None;
    if let Some(rate) = sample_rate {
        // Get supported configs and try to find one matching our desired sample rate
        if let Ok(mut configs) = device.supported_output_configs() {
            if let Some(config) =
                configs.find(|c| c.min_sample_rate().0 <= rate && c.max_sample_rate().0 >= rate)
            {
                // Create a config with the specified sample rate
                let config = config.with_sample_rate(cpal::SampleRate(rate));
                match rodio::OutputStream::try_from_device_config(device, config) {
                    Ok(stream) => return Ok(stream),
                    Err(e) => last_err = Some(e),
                }
            }
        }
    }

    // Fall back to default config
    rodio::OutputStream::try_from_device(device).or_else(|err| Err(last_err.unwrap_or(err)))
}

fn crossfade(
    old_sink: Option<Arc<rodio::Sink>>,
    new_sink: Arc<rodio::Sink>,
    new_target_vol: f32,
    dur_sec: f32,
    fade_generation: Arc<AtomicU64>,
    fade_op_id: u64,
) {
    let steps = ((dur_sec * 1000.0) / 20.0).max(1.0) as u32; // 20ms刻み
    let old_start = old_sink.as_ref().map(|s| s.volume()).unwrap_or(0.0);
    let new_start = 0.0_f32;
    for i in 0..=steps {
        if fade_generation.load(Ordering::Relaxed) != fade_op_id {
            return;
        }
        let t = i as f32 / steps as f32;
        if let Some(ref s) = old_sink {
            let v = old_start * (1.0 - t);
            s.set_volume(v.max(0.0));
        }
        let nv = new_start + (new_target_vol - new_start) * t;
        new_sink.set_volume(nv.clamp(0.0, 1.0));
        thread::sleep(Duration::from_millis(20));
    }
    if fade_generation.load(Ordering::Relaxed) != fade_op_id {
        return;
    }
    if let Some(s) = old_sink {
        s.stop();
    }
}

#[derive(Clone)]
struct AudioDeviceEntry {
    name: String,
    device: cpal::Device,
}

#[derive(Clone)]
struct MidiInputEntry {
    name: String,
    port: MidiInputPort,
}

struct MidiCtx {
    inputs: Vec<MidiInputEntry>,
    connection: Option<MidiInputConnection<()>>,
}

enum MidiAction {
    ReceivedNote { note: u8, velocity: u8 },
    PlaySlot(usize),
    FadeStop,
}

struct AudioCtx {
    devices: Vec<AudioDeviceEntry>,
    current_device_idx: usize,
    _stream: rodio::OutputStream,
    handle: rodio::OutputStreamHandle,
    current_sink: Option<(Arc<rodio::Sink>, usize)>, // (sink, slot_idx)
    fade_generation: Arc<AtomicU64>,
}

// Send + Sync を明示的に実装
unsafe impl Send for AudioCtx {}
unsafe impl Sync for AudioCtx {}

struct App {
    cfg: AppConfig,
    audio: Arc<Mutex<AudioCtx>>,
    midi: MidiCtx,
    midi_rx: Receiver<MidiAction>,
    midi_tx: Sender<MidiAction>,
    midi_error_message: Option<String>,
    last_midi_note: Option<(u8, u8)>,
    // DnD用のスロット枠（矩形）を保持してヒットテストに使う
    slot_rects: [egui::Rect; 10],
    error_message: Option<String>,
}

impl App {
    fn new(cc: &eframe::CreationContext<'_>) -> Self {
        // 日本語フォント（専用ファミリ jp）を登録（UI全体は既定フォントのまま）
        Self::install_japanese_font(&cc.egui_ctx);
        let egui_ctx = cc.egui_ctx.clone();
        let cfg: AppConfig = confy::load("bgm_deck", None).unwrap_or_default();

        // デバイス列挙
        let mut error_message = None;
        let devices = match Self::enumerate_output_devices() {
            Ok(list) => list,
            Err(e) => {
                error_message = Some(format!("デバイス列挙に失敗: {e}"));
                Vec::new()
            }
        };

        if devices.is_empty() && error_message.is_none() {
            error_message = Some("出力デバイスが見つかりません".into());
        }

        let mut selected_idx = 0usize;
        if let Some(ref name) = cfg.output_device_name {
            if let Some(idx) = devices.iter().position(|d| &d.name == name) {
                selected_idx = idx;
            }
        }
        if !devices.is_empty() {
            selected_idx = selected_idx.min(devices.len() - 1);
        }

        let selected_device = devices
            .get(selected_idx)
            .map(|entry| entry.device.clone())
            .or_else(|| cpal::default_host().default_output_device());

        // 選択デバイスでストリーム生成（なければデフォルト）
        let (stream, handle) = if let Some(dev) = selected_device {
            create_output_stream_with_sample_rate(&dev, cfg.sample_rate)
                .unwrap_or_else(|_| rodio::OutputStream::try_default().unwrap())
        } else {
            rodio::OutputStream::try_default().unwrap()
        };

        let audio = AudioCtx {
            devices,
            current_device_idx: selected_idx,
            _stream: stream,
            handle,
            current_sink: None,
            fade_generation: Arc::new(AtomicU64::new(0)),
        };
        let (midi_tx, midi_rx) = mpsc::channel();
        let midi_inputs = Self::enumerate_midi_inputs().unwrap_or_default();

        let mut app = Self {
            cfg,
            audio: Arc::new(Mutex::new(audio)),
            midi: MidiCtx {
                inputs: midi_inputs,
                connection: None,
            },
            midi_rx,
            midi_tx,
            midi_error_message: None,
            last_midi_note: None,
            slot_rects: [egui::Rect::NAN; 10],
            error_message,
        };
        app.connect_selected_midi_input(&egui_ctx);
        app
    }

    fn install_japanese_font(ctx: &egui::Context) {
        // 代表的な macOS の日本語フォント候補（OS バージョンにより異なる）
        let candidates = [
            "/System/Library/Fonts/ヒラギノ角ゴ ProN W3.otf",
            "/System/Library/Fonts/ヒラギノ角ゴ ProN W6.otf",
            "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
            "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc",
            "/System/Library/Fonts/Hiragino Sans GB.ttc",
            "/System/Library/Fonts/PingFang.ttc",
        ];
        let mut selected: Option<(String, Vec<u8>)> = None;
        for p in candidates {
            if let Ok(bytes) = stdfs::read(p) {
                selected = Some((p.to_string(), bytes));
                break;
            }
        }
        if let Some((_path, bytes)) = selected {
            let mut fonts = egui::FontDefinitions::default();
            // 既定フォントは維持しつつ、専用ファミリ "jp" を追加
            fonts
                .font_data
                .insert("jp".into(), egui::FontData::from_owned(bytes));
            fonts
                .families
                .insert(egui::FontFamily::Name("jp".into()), vec!["jp".into()]);
            ctx.set_fonts(fonts);
        }
    }

    fn save_cfg(&mut self) {
        if let Err(e) = confy::store("bgm_deck", None, &self.cfg) {
            self.error_message = Some(format!("設定の保存に失敗しました: {e}"));
        }
    }

    fn enumerate_midi_inputs() -> Result<Vec<MidiInputEntry>, String> {
        let midi_in = MidiInput::new("bgm-deck-midi").map_err(|e| e.to_string())?;
        let ports = midi_in.ports();
        let mut entries = Vec::with_capacity(ports.len());

        for (idx, port) in ports.into_iter().enumerate() {
            let name = midi_in
                .port_name(&port)
                .unwrap_or_else(|_| format!("MIDI Input {}", idx + 1));
            entries.push(MidiInputEntry { name, port });
        }

        Ok(entries)
    }

    fn refresh_midi_inputs(&mut self) {
        match Self::enumerate_midi_inputs() {
            Ok(inputs) => {
                self.midi.inputs = inputs;
                self.midi_error_message = None;
            }
            Err(e) => {
                self.midi.inputs.clear();
                self.midi.connection = None;
                self.midi_error_message = Some(format!(
                    "MIDI 入力の列挙に失敗: {e}. macOS 側で CoreMIDI が使えない状態の可能性があります。"
                ));
            }
        }
    }

    fn connect_selected_midi_input(&mut self, egui_ctx: &egui::Context) {
        self.midi.connection = None;
        self.midi_error_message = None;

        let Some(target_name) = self.cfg.midi_input_name.clone() else {
            return;
        };

        let Some(entry) = self
            .midi
            .inputs
            .iter()
            .find(|entry| entry.name == target_name)
            .cloned()
        else {
            self.midi_error_message = Some(format!("MIDI 入力が見つかりません: {target_name}"));
            return;
        };

        let mut midi_in = match MidiInput::new("bgm-deck-midi") {
            Ok(input) => input,
            Err(e) => {
                self.midi_error_message = Some(format!(
                    "MIDI の初期化に失敗: {e}. macOS 側で CoreMIDI クライアントを作れませんでした。"
                ));
                return;
            }
        };

        midi_in.ignore(Ignore::None);

        let tx = self.midi_tx.clone();
        let egui_ctx = egui_ctx.clone();
        let slot_notes = self.cfg.midi_slot_notes;
        let stop_note = self.cfg.midi_stop_note;
        match midi_in.connect(
            &entry.port,
            "bgm-deck-midi-input",
            move |_stamp, message, _| {
                if let Some((note, velocity)) = App::extract_note_on(message) {
                    let _ = tx.send(MidiAction::ReceivedNote { note, velocity });
                }
                if let Some(action) = App::decode_midi_message(slot_notes, stop_note, message) {
                    let _ = tx.send(action);
                }
                egui_ctx.request_repaint();
            },
            (),
        ) {
            Ok(connection) => {
                self.midi.connection = Some(connection);
                self.midi_error_message = None;
            }
            Err(e) => {
                self.midi_error_message = Some(format!(
                    "MIDI 入力への接続に失敗しました ({}): {e}",
                    entry.name
                ));
            }
        }
    }

    fn decode_midi_message(
        slot_notes: [u8; 10],
        stop_note: u8,
        message: &[u8],
    ) -> Option<MidiAction> {
        let (note, _) = Self::extract_note_on(message)?;

        if note == stop_note {
            return Some(MidiAction::FadeStop);
        }

        for (idx, slot_note) in slot_notes.iter().enumerate() {
            if note == *slot_note {
                return Some(MidiAction::PlaySlot(idx));
            }
        }

        None
    }

    fn extract_note_on(message: &[u8]) -> Option<(u8, u8)> {
        if message.len() < 3 {
            return None;
        }

        let status = message[0] & 0xF0;
        let note = message[1];
        let velocity = message[2];

        if status != 0x90 || velocity == 0 {
            return None;
        }

        Some((note, velocity))
    }

    fn handle_midi_actions(&mut self) {
        while let Ok(action) = self.midi_rx.try_recv() {
            match action {
                MidiAction::ReceivedNote { note, velocity } => {
                    self.last_midi_note = Some((note, velocity));
                }
                MidiAction::PlaySlot(idx) => self.play_slot(idx),
                MidiAction::FadeStop => self.stop_with_fadeout(),
            }
        }
    }

    fn enumerate_output_devices() -> Result<Vec<AudioDeviceEntry>, String> {
        let host = cpal::default_host();
        let mut entries = Vec::new();
        let mut seen = HashSet::new();
        let mut last_err: Option<String> = None;

        match host.output_devices() {
            Ok(devices) => {
                for device in devices {
                    if let Some(entry) = Self::device_to_entry(device) {
                        if seen.insert(entry.name.clone()) {
                            entries.push(entry);
                        }
                    }
                }
            }
            Err(e) => {
                last_err = Some(e.to_string());
            }
        }

        match host.devices() {
            Ok(devices) => {
                for device in devices {
                    if let Some(entry) = Self::device_to_entry(device) {
                        if seen.insert(entry.name.clone()) {
                            entries.push(entry);
                        }
                    }
                }
            }
            Err(e) => {
                if entries.is_empty() {
                    last_err = Some(e.to_string());
                }
            }
        }

        if entries.is_empty() {
            Err(last_err.unwrap_or_else(|| "No output devices available".into()))
        } else {
            Ok(entries)
        }
    }

    fn device_to_entry(device: cpal::Device) -> Option<AudioDeviceEntry> {
        let supports_output = match device.supported_output_configs() {
            Ok(mut configs) => configs.next().is_some(),
            Err(_) => device.default_output_config().is_ok(),
        };

        if !supports_output {
            let supports_input = device
                .supported_input_configs()
                .map(|mut cfg| cfg.next().is_some())
                .unwrap_or(false);
            if supports_input {
                return None;
            }
        }

        let name = device.name().unwrap_or_else(|_| "Unknown".into());
        Some(AudioDeviceEntry { name, device })
    }

    fn refresh_devices(&mut self) {
        let desired_name = if let Some(name) = self.cfg.output_device_name.clone() {
            Some(name)
        } else {
            let audio = self.audio.lock();
            audio
                .devices
                .get(audio.current_device_idx)
                .map(|entry| entry.name.clone())
        };

        match Self::enumerate_output_devices() {
            Ok(entries) => {
                let mut audio = self.audio.lock();
                let prev_idx = audio.current_device_idx;
                audio.devices = entries;

                if audio.devices.is_empty() {
                    audio.current_device_idx = 0;
                    self.error_message = Some("出力デバイスが見つかりません".into());
                } else {
                    if let Some(name) = desired_name {
                        if let Some(idx) = audio.devices.iter().position(|d| d.name == name) {
                            audio.current_device_idx = idx;
                        } else {
                            audio.current_device_idx = prev_idx.min(audio.devices.len() - 1);
                        }
                    } else {
                        audio.current_device_idx = prev_idx.min(audio.devices.len() - 1);
                    }
                    self.error_message = None;
                }
            }
            Err(e) => {
                self.error_message = Some(format!("デバイス列挙に失敗: {e}"));
            }
        }
    }

    fn switch_device(&mut self, idx: usize) {
        self.begin_fade_operation();
        let entry = {
            let audio = self.audio.lock();
            audio.devices.get(idx).cloned()
        };

        let Some(entry) = entry else {
            self.error_message = Some("指定されたデバイスが見つかりません".to_string());
            return;
        };

        match create_output_stream_with_sample_rate(&entry.device, self.cfg.sample_rate) {
            Ok((stream, handle)) => {
                let mut a = self.audio.lock();
                if let Some((s, _)) = a.current_sink.take() {
                    s.stop();
                }
                a._stream = stream;
                a.handle = handle;
                a.current_device_idx = idx;
                let device_name = entry.name.clone();
                drop(a);

                self.cfg.output_device_name = Some(device_name);
                self.save_cfg();
                self.error_message = None;
            }
            Err(e) => {
                self.error_message = Some(format!("デバイス切り替えに失敗: {e}"));
            }
        }
    }

    fn apply_sample_rate(&mut self) {
        // Re-create the stream with the new sample rate
        let idx = self.audio.lock().current_device_idx;
        self.switch_device(idx);
    }

    fn begin_fade_operation(&self) -> (Arc<AtomicU64>, u64) {
        let fade_generation = self.audio.lock().fade_generation.clone();
        let fade_op_id = fade_generation.fetch_add(1, Ordering::Relaxed) + 1;
        (fade_generation, fade_op_id)
    }

    fn play_slot(&mut self, slot_idx: usize) {
        let path = match &self.cfg.slots[slot_idx].path {
            Some(p) => {
                // ファイルの存在確認
                if !Path::new(p).exists() {
                    self.error_message = Some(format!("ファイルが見つかりません: {p}"));
                    return;
                }
                p.clone()
            }
            None => return,
        };
        let vol_target = (self.cfg.slots[slot_idx].volume * self.cfg.master_volume).clamp(0.0, 1.0);

        let src = match load_source(&path) {
            Ok(s) => s,
            Err(err) => {
                self.error_message = Some(format!("音声ファイルの読み込みに失敗: {err}"));
                return;
            }
        };

        let (fade_generation, fade_op_id) = self.begin_fade_operation();
        let (new_sink, old_sink_opt) = {
            let mut a = self.audio.lock();
            let sink = match rodio::Sink::try_new(&a.handle) {
                Ok(s) => Arc::new(s),
                Err(e) => {
                    self.error_message = Some(format!("再生の初期化に失敗: {e}"));
                    return;
                }
            };

            if self.cfg.slots[slot_idx].looping {
                sink.append(src.repeat_infinite());
            } else {
                sink.append(src);
            }
            sink.set_volume(0.0);

            let old = a.current_sink.take();
            let old_sink = old.as_ref().map(|(s, _)| s.clone());

            a.current_sink = Some((sink.clone(), slot_idx));
            (sink, old_sink)
        };

        let fade = self.cfg.crossfade_sec.max(0.01);
        thread::spawn(move || {
            crossfade(
                old_sink_opt,
                new_sink,
                vol_target,
                fade,
                fade_generation,
                fade_op_id,
            );
        });
    }

    fn stop_current(&mut self) {
        self.begin_fade_operation();
        let mut a = self.audio.lock();
        if let Some((s, _)) = a.current_sink.take() {
            s.stop();
        }
    }

    fn stop_with_fadeout(&mut self) {
        let fade_time = self.cfg.crossfade_sec.max(0.01);
        let (fade_generation, fade_op_id) = self.begin_fade_operation();
        let sink = {
            let audio = self.audio.lock();
            audio.current_sink.as_ref().map(|(sink, _)| sink.clone())
        };

        if let Some(sink_clone) = sink {
            let audio_arc = self.audio.clone();

            thread::spawn(move || {
                let start_vol = sink_clone.volume();
                let steps = ((fade_time * 1000.0) / 20.0).max(1.0) as u32;

                for i in 0..=steps {
                    if fade_generation.load(Ordering::Relaxed) != fade_op_id {
                        return;
                    }
                    let t = i as f32 / steps as f32;
                    let vol = start_vol * (1.0 - t);
                    sink_clone.set_volume(vol.max(0.0));
                    thread::sleep(Duration::from_millis(20));
                }

                if fade_generation.load(Ordering::Relaxed) != fade_op_id {
                    return;
                }
                sink_clone.stop();
                let mut a = audio_arc.lock();
                if fade_generation.load(Ordering::Relaxed) == fade_op_id
                    && a.current_sink
                        .as_ref()
                        .map(|(current_sink, _)| Arc::ptr_eq(current_sink, &sink_clone))
                        .unwrap_or(false)
                {
                    a.current_sink = None;
                }
            });
        }
    }

    fn handle_dropped_files(&mut self, ctx: &egui::Context) {
        let dropped = ctx.input(|i| i.raw.dropped_files.clone());
        if dropped.is_empty() {
            return;
        }
        for f in dropped {
            if let Some(path) = f.path {
                // マウス座標でどのスロットに落ちたか判定
                let pos = ctx.input(|i| i.pointer.interact_pos());
                if let Some(mouse_pos) = pos {
                    // ヒットした最初のスロットに割当
                    let mut assigned = false;
                    for (i, rect) in self.slot_rects.iter().enumerate() {
                        if rect.contains(mouse_pos) {
                            self.cfg.slots[i].path = Some(path.to_string_lossy().to_string());
                            self.save_cfg();
                            assigned = true;
                            break;
                        }
                    }
                    if !assigned {
                        // どこにも当たってなければ空きスロットに順次割当
                        if let Some(slot) = self.cfg.slots.iter_mut().find(|s| s.path.is_none()) {
                            slot.path = Some(path.to_string_lossy().to_string());
                            self.save_cfg();
                        }
                    }
                }
            }
        }
    }

    fn is_slot_playing(&self, idx: usize) -> bool {
        self.audio
            .lock()
            .current_sink
            .as_ref()
            .map(|(_, i)| *i == idx)
            .unwrap_or(false)
    }

    fn filename_only(path: &str) -> String {
        std::path::Path::new(path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(path)
            .to_string()
    }

    fn midi_note_name(note: u8) -> String {
        const NOTE_NAMES: [&str; 12] = [
            "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
        ];
        let octave = (note / 12) as i32 - 1;
        format!("{}{}", NOTE_NAMES[(note % 12) as usize], octave)
    }
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // DnD受け取り
        self.handle_dropped_files(ctx);
        self.handle_midi_actions();

        // キーボードショートカット: 1-9 で再生、0 でフェード停止
        if !ctx.wants_keyboard_input() {
            let pressed = ctx.input(|i| {
                [
                    i.key_pressed(egui::Key::Num1),
                    i.key_pressed(egui::Key::Num2),
                    i.key_pressed(egui::Key::Num3),
                    i.key_pressed(egui::Key::Num4),
                    i.key_pressed(egui::Key::Num5),
                    i.key_pressed(egui::Key::Num6),
                    i.key_pressed(egui::Key::Num7),
                    i.key_pressed(egui::Key::Num8),
                    i.key_pressed(egui::Key::Num9),
                    i.key_pressed(egui::Key::Num0),
                ]
            });
            for (s, &is_pressed) in pressed.iter().enumerate().take(9) {
                if is_pressed {
                    self.play_slot(s);
                }
            }
            if pressed[9] {
                self.stop_with_fadeout();
            }
        }

        egui::CentralPanel::default().show(ctx, |ui| {
            ui.heading("BGM Deck (10 slots)");

            // エラーメッセージの表示
            if let Some(ref msg) = self.error_message {
                ui.colored_label(egui::Color32::RED, msg);
                if ui.button("閉じる").clicked() {
                    self.error_message = None;
                }
            }

            ui.separator();

            // 出力デバイス選択（日本語名のレンダリングに jp フォントを適用）
            {
                let (names, current_idx) = {
                    let audio = self.audio.lock();
                    let list = audio
                        .devices
                        .iter()
                        .map(|entry| entry.name.clone())
                        .collect::<Vec<_>>();
                    (list, audio.current_device_idx)
                };
                let mut idx = current_idx;
                let jp_font = egui::FontId::new(
                    ui.text_style_height(&egui::TextStyle::Body),
                    egui::FontFamily::Name("jp".into()),
                );
                let mut refresh_clicked = false;

                ui.horizontal(|ui| {
                    if !names.is_empty() && idx >= names.len() {
                        idx = names.len() - 1;
                    }
                    let selected_text = names.get(idx).cloned().unwrap_or_else(|| "Default".into());
                    egui::ComboBox::from_label("Output Device")
                        .selected_text(egui::RichText::new(selected_text).font(jp_font.clone()))
                        .show_ui(ui, |ui| {
                            for (i, n) in names.iter().enumerate() {
                                let clicked = ui
                                    .selectable_label(
                                        i == idx,
                                        egui::RichText::new(n).font(jp_font.clone()),
                                    )
                                    .clicked();
                                if clicked {
                                    idx = i;
                                }
                            }
                        });
                    if ui.button("Refresh").clicked() {
                        refresh_clicked = true;
                    }
                });

                if refresh_clicked {
                    self.refresh_devices();
                } else if idx != current_idx {
                    self.switch_device(idx);
                }
            }

            ui.horizontal(|ui| {
                ui.label("CrossFade (sec)");
                let mut cf = self.cfg.crossfade_sec;
                if ui
                    .add(
                        egui::DragValue::new(&mut cf)
                            .clamp_range(0.0..=10.0)
                            .speed(0.1),
                    )
                    .changed()
                {
                    self.cfg.crossfade_sec = cf;
                    self.save_cfg();
                }
                if ui.button("Stop").clicked() {
                    self.stop_current();
                }
                if ui.button("Stop (Fade)").clicked() {
                    self.stop_with_fadeout();
                }
                if ui.button("Clear All").clicked() {
                    self.stop_current();
                    for s in &mut self.cfg.slots {
                        *s = SlotConfig {
                            path: None,
                            volume: 1.0,
                            name: None,
                            looping: true,
                        };
                    }
                    self.save_cfg();
                }
            });

            egui::CollapsingHeader::new("MIDI Settings")
                .default_open(false)
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        let current_midi = self
                            .cfg
                            .midi_input_name
                            .clone()
                            .unwrap_or_else(|| "Off".into());
                        let mut selected_midi = self.cfg.midi_input_name.clone();
                        let mut refresh_clicked = false;

                        egui::ComboBox::from_label("MIDI Input")
                            .selected_text(current_midi)
                            .show_ui(ui, |ui| {
                                if ui
                                    .selectable_label(selected_midi.is_none(), "Off")
                                    .clicked()
                                {
                                    selected_midi = None;
                                }
                                for entry in &self.midi.inputs {
                                    if ui
                                        .selectable_label(
                                            selected_midi.as_ref() == Some(&entry.name),
                                            &entry.name,
                                        )
                                        .clicked()
                                    {
                                        selected_midi = Some(entry.name.clone());
                                    }
                                }
                            });
                        if ui.button("Refresh MIDI").clicked() {
                            refresh_clicked = true;
                        }

                        if refresh_clicked {
                            self.refresh_midi_inputs();
                            if self.cfg.midi_input_name.is_some() {
                                self.connect_selected_midi_input(ctx);
                            }
                        } else if selected_midi != self.cfg.midi_input_name {
                            self.cfg.midi_input_name = selected_midi;
                            self.save_cfg();
                            self.connect_selected_midi_input(ctx);
                        }
                    });

                    if let Some(msg) = &self.midi_error_message {
                        ui.colored_label(egui::Color32::YELLOW, msg);
                    }

                    let received_text = self
                        .last_midi_note
                        .map(|(note, velocity)| {
                            format!(
                                "Last Note On: {} ({}) vel {}",
                                note,
                                Self::midi_note_name(note),
                                velocity
                            )
                        })
                        .unwrap_or_else(|| "Last Note On: none".into());
                    ui.label(received_text);

                    ui.group(|ui| {
                        ui.label("MIDI Note Mapping");
                        let mut midi_changed = false;

                        egui::Grid::new("midi_mapping_grid")
                            .num_columns(3)
                            .spacing([12.0, 6.0])
                            .show(ui, |ui| {
                                for i in 0..10 {
                                    ui.label(format!("Slot {}", i + 1));
                                    let mut note = self.cfg.midi_slot_notes[i] as u32;
                                    if ui
                                        .add(
                                            egui::DragValue::new(&mut note)
                                                .clamp_range(0..=127)
                                                .speed(1.0),
                                        )
                                        .changed()
                                    {
                                        self.cfg.midi_slot_notes[i] = note as u8;
                                        midi_changed = true;
                                    }
                                    ui.label(Self::midi_note_name(self.cfg.midi_slot_notes[i]));
                                    ui.end_row();
                                }

                                ui.label("Stop (Fade)");
                                let mut stop_note = self.cfg.midi_stop_note as u32;
                                if ui
                                    .add(
                                        egui::DragValue::new(&mut stop_note)
                                            .clamp_range(0..=127)
                                            .speed(1.0),
                                    )
                                    .changed()
                                {
                                    self.cfg.midi_stop_note = stop_note as u8;
                                    midi_changed = true;
                                }
                                ui.label(Self::midi_note_name(self.cfg.midi_stop_note));
                                ui.end_row();
                            });

                        if midi_changed {
                            self.save_cfg();
                            if self.cfg.midi_input_name.is_some() {
                                self.connect_selected_midi_input(ctx);
                            }
                        }
                    });
                });

            ui.separator();

            // スロット描画（2列×5行）、左右を常に 50% に分割
            for row in 0..5 {
                ui.columns(2, |columns| {
                    for (col, col_ui) in columns.iter_mut().enumerate().take(2) {
                        let i = row * 2 + col;
                        // 各スロットの確保領域（高さ固定）
                        let size = egui::vec2(col_ui.available_width(), 120.0);
                        let (rect, _resp) = col_ui.allocate_exact_size(size, egui::Sense::hover());
                        self.slot_rects[i] = rect;

                        col_ui.allocate_ui_at_rect(rect, |ui| {
                            // 再生中スロットは強調表示
                            let playing = self.is_slot_playing(i);
                            let mut frame = egui::Frame::group(ui.style());
                            if playing {
                                frame =
                                    frame.fill(ui.visuals().selection.bg_fill.gamma_multiply(0.6));
                            }
                            frame.show(ui, |ui| {
                                ui.horizontal(|ui| {
                                    // スロット名（任意）
                                    let display_name = self.cfg.slots[i]
                                        .name
                                        .clone()
                                        .unwrap_or_else(|| format!("Slot {}", i + 1));
                                    ui.label(egui::RichText::new(display_name).strong());
                                    // 名前編集フィールド（短め）
                                    let mut name_buf =
                                        self.cfg.slots[i].name.clone().unwrap_or_default();
                                    let name_resp = ui.add_sized(
                                        egui::vec2(
                                            140.0,
                                            ui.text_style_height(&egui::TextStyle::Body),
                                        ),
                                        egui::TextEdit::singleline(&mut name_buf).hint_text("Name"),
                                    );
                                    if name_resp.changed() {
                                        if name_buf.trim().is_empty() {
                                            self.cfg.slots[i].name = None;
                                        } else {
                                            self.cfg.slots[i].name = Some(name_buf);
                                        }
                                        self.save_cfg();
                                    }
                                    if ui.button("Open…").clicked() {
                                        if let Some(file) = rfd::FileDialog::new()
                                            .add_filter("Audio", &["mp3", "wav"])
                                            .pick_file()
                                        {
                                            self.cfg.slots[i].path =
                                                Some(file.display().to_string());
                                            self.save_cfg();
                                        }
                                    }
                                    if ui.button("Play").clicked() {
                                        self.play_slot(i);
                                    }
                                    let mut looping = self.cfg.slots[i].looping;
                                    if ui.checkbox(&mut looping, "Loop").changed() {
                                        self.cfg.slots[i].looping = looping;
                                        self.save_cfg();
                                    }
                                    if ui.button("Clear").clicked() {
                                        self.cfg.slots[i] = SlotConfig {
                                            path: None,
                                            volume: 1.0,
                                            name: None,
                                            looping: true,
                                        };
                                        self.save_cfg();
                                    }
                                });
                                if let Some(p) = &self.cfg.slots[i].path {
                                    let name = Self::filename_only(p);
                                    let font = egui::FontId::new(
                                        ui.text_style_height(&egui::TextStyle::Small),
                                        egui::FontFamily::Name("jp".into()),
                                    );
                                    let resp =
                                        ui.label(egui::RichText::new(name).font(font.clone()));
                                    resp.on_hover_ui(|ui| {
                                        ui.label(egui::RichText::new(p).font(font.clone()));
                                    });
                                } else {
                                    ui.label(
                                        egui::RichText::new("Drag mp3/wav here").italics().weak(),
                                    );
                                }

                                let mut vol = self.cfg.slots[i].volume;
                                if ui
                                    .add(egui::Slider::new(&mut vol, 0.0..=1.0).text("Volume"))
                                    .changed()
                                {
                                    self.cfg.slots[i].volume = vol;
                                    // 再生中のスロットなら反映（マスター適用）
                                    if let Some((ref sink, cur)) = self.audio.lock().current_sink
                                    {
                                        if cur == i {
                                            sink.set_volume(
                                                (vol * self.cfg.master_volume).clamp(0.0, 1.0),
                                            );
                                        }
                                    }
                                    self.save_cfg();
                                }
                            });
                        });
                    }
                });
            }
        });

        // 画面下部にマスターボリューム
        egui::TopBottomPanel::bottom("footer").show(ctx, |ui| {
            ui.separator();
            ui.horizontal(|ui| {
                ui.label("Master Volume");
                let mut mv = self.cfg.master_volume;
                if ui
                    .add(egui::Slider::new(&mut mv, 0.0..=1.0).fixed_decimals(2))
                    .changed()
                {
                    self.cfg.master_volume = mv;
                    // 再生中に反映
                    if let Some((ref sink, cur)) = self.audio.lock().current_sink {
                        let vol = self.cfg.slots[cur].volume * self.cfg.master_volume;
                        sink.set_volume(vol.clamp(0.0, 1.0));
                    }
                    self.save_cfg();
                }

                ui.separator();

                // サンプリングレート選択
                ui.label("Sample Rate");
                let sample_rates = [
                    ("Auto", None),
                    ("44.1 kHz", Some(44100)),
                    ("48 kHz", Some(48000)),
                    ("88.2 kHz", Some(88200)),
                    ("96 kHz", Some(96000)),
                    ("192 kHz", Some(192000)),
                ];

                let current_text = sample_rates
                    .iter()
                    .find(|(_, rate)| *rate == self.cfg.sample_rate)
                    .map(|(text, _)| *text)
                    .unwrap_or("Auto");

                egui::ComboBox::from_label("")
                    .selected_text(current_text)
                    .show_ui(ui, |ui| {
                        for (text, rate) in &sample_rates {
                            if ui
                                .selectable_label(self.cfg.sample_rate == *rate, *text)
                                .clicked()
                            {
                                if self.cfg.sample_rate != *rate {
                                    self.cfg.sample_rate = *rate;
                                    self.save_cfg();
                                    self.apply_sample_rate();
                                }
                            }
                        }
                    });
            });
        });
    }
}

fn main() -> eframe::Result<()> {
    // 固定サイズのウィンドウ（リサイズ不可）
    let native_options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([960.0, 720.0])
            .with_resizable(false),
        ..Default::default()
    };
    eframe::run_native(
        "BGM Deck",
        native_options,
        Box::new(|cc| Box::new(App::new(cc))),
    )
}
