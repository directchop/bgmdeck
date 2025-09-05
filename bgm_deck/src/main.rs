use eframe::egui;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{fs::File, io::BufReader, path::Path, sync::Arc, thread, time::Duration};
use rodio::Source;
use std::fs as stdfs;
use cpal::traits::{DeviceTrait, HostTrait};

#[derive(Serialize, Deserialize, Clone, Default)]
struct SlotConfig {
    path: Option<String>,
    volume: f32, // 0.0 - 1.0
    name: Option<String>,
    looping: bool,
}

#[derive(Serialize, Deserialize)]
struct AppConfig {
    slots: [SlotConfig; 10],
    crossfade_sec: f32,
    output_device_name: Option<String>,
    master_volume: f32,
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
        }
    }
}

fn load_source(path: &str) -> anyhow::Result<rodio::Decoder<BufReader<File>>> {
    let file = File::open(Path::new(path))?;
    let reader = BufReader::new(file);
    let dec = rodio::Decoder::new(reader)?; // mp3/wav対応（rodio経由でSymphonia）
    Ok(dec)
}

fn crossfade(
    old_sink: Option<Arc<rodio::Sink>>,
    new_sink: Arc<rodio::Sink>,
    new_target_vol: f32,
    dur_sec: f32,
) {
    let steps = ((dur_sec * 1000.0) / 20.0).max(1.0) as u32; // 20ms刻み
    let old_start = old_sink.as_ref().map(|s| s.volume()).unwrap_or(0.0);
    let new_start = 0.0_f32;
    for i in 0..=steps {
        let t = i as f32 / steps as f32;
        if let Some(ref s) = old_sink {
            let v = old_start * (1.0 - t);
            s.set_volume(v.max(0.0));
        }
        let nv = new_start + (new_target_vol - new_start) * t;
        new_sink.set_volume(nv.clamp(0.0, 1.0));
        thread::sleep(Duration::from_millis(20));
    }
    if let Some(s) = old_sink {
        s.stop();
    }
}

struct AudioCtx {
    device_names: Vec<String>,
    current_device_idx: usize,
    _stream: rodio::OutputStream,
    handle: rodio::OutputStreamHandle,
    current_sink: Option<(Arc<rodio::Sink>, usize)>, // (sink, slot_idx)
}

struct App {
    cfg: AppConfig,
    audio: Arc<Mutex<AudioCtx>>,
    // DnD用のスロット枠（矩形）を保持してヒットテストに使う
    slot_rects: [egui::Rect; 10],
}

impl App {
    fn new(cc: &eframe::CreationContext<'_>) -> Self {
        // 日本語フォント（専用ファミリ jp）を登録（UI全体は既定フォントのまま）
        Self::install_japanese_font(&cc.egui_ctx);
        let cfg: AppConfig = confy::load("bgm_deck", None).unwrap_or_default();

        // デバイス列挙
        let host = cpal::default_host();
        let mut device_names = Vec::new();
        let mut selected_idx = 0usize;
        let mut selected_device = host.default_output_device();

        if let Ok(list) = host.output_devices() {
            for (i, d) in list.enumerate() {
                let name = d.name().unwrap_or_else(|_| "Unknown".into());
                if cfg.output_device_name.as_deref() == Some(&name) {
                    selected_idx = i;
                    selected_device = Some(d.clone());
                }
                device_names.push(name);
            }
        }

        // 選択デバイスでストリーム生成（なければデフォルト）
        let (stream, handle) = if let Some(dev) = selected_device {
            rodio::OutputStream::try_from_device(&dev)
                .unwrap_or_else(|_| rodio::OutputStream::try_default().unwrap())
        } else {
            rodio::OutputStream::try_default().unwrap()
        };

        let audio = AudioCtx {
            device_names,
            current_device_idx: selected_idx,
            _stream: stream,
            handle,
            current_sink: None,
        };

        Self {
            cfg,
            audio: Arc::new(Mutex::new(audio)),
            slot_rects: [egui::Rect::NAN; 10],
        }
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
            fonts.font_data.insert("jp".into(), egui::FontData::from_owned(bytes));
            fonts
                .families
                .insert(egui::FontFamily::Name("jp".into()), vec!["jp".into()]);
            ctx.set_fonts(fonts);
        }
    }

    fn save_cfg(&self) {
        let _ = confy::store("bgm_deck", None, &self.cfg);
    }

    fn switch_device(&mut self, idx: usize) {
        let host = cpal::default_host();
        if let Ok(mut list) = host.output_devices() {
            if let Some(dev) = list.nth(idx) {
                if let Ok((stream, handle)) = rodio::OutputStream::try_from_device(&dev) {
                    let mut a = self.audio.lock();
                    if let Some((s, _)) = a.current_sink.take() {
                        s.stop();
                    }
                    a._stream = stream;
                    a.handle = handle;
                    a.current_device_idx = idx;
                    self.cfg.output_device_name = Some(dev.name().unwrap_or_default());
                    drop(a);
                    self.save_cfg();
                }
            }
        }
    }

    fn play_slot(&mut self, slot_idx: usize) {
        let path = match &self.cfg.slots[slot_idx].path {
            Some(p) => p.clone(),
            None => return,
        };
        let vol_target = (self.cfg.slots[slot_idx].volume * self.cfg.master_volume).clamp(0.0, 1.0);

        let src = match load_source(&path) {
            Ok(s) => s,
            Err(err) => {
                eprintln!("failed to load: {err:?}");
                return;
            }
        };

        let (new_sink, old_sink_opt) = {
            let mut a = self.audio.lock();
            let sink = Arc::new(rodio::Sink::try_new(&a.handle).unwrap());
            if self.cfg.slots[slot_idx].looping {
                sink.append(src.repeat_infinite());
            } else {
                sink.append(src);
            }
            sink.set_volume(0.0);
            let old = a.current_sink.take().map(|(s, _)| s);
            a.current_sink = Some((sink.clone(), slot_idx));
            (sink, old)
        };

        let fade = self.cfg.crossfade_sec.max(0.01);
        thread::spawn(move || {
            crossfade(old_sink_opt, new_sink, vol_target, fade);
        });
    }

    fn stop_current(&mut self) {
        let mut a = self.audio.lock();
        if let Some((s, _)) = a.current_sink.take() {
            s.stop();
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
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // DnD受け取り
        self.handle_dropped_files(ctx);

        // キーボードショートカット: 1-9 で再生、0 で停止
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
            for s in 0..9 {
                if pressed[s] {
                    self.play_slot(s);
                }
            }
            if pressed[9] {
                self.stop_current();
            }
        }

        egui::CentralPanel::default().show(ctx, |ui| {
            ui.heading("BGM Deck (10 slots)");
            ui.separator();

            // 出力デバイス選択（日本語名のレンダリングに jp フォントを適用）
            {
                let names = self.audio.lock().device_names.clone();
                let mut idx = self.audio.lock().current_device_idx;
                let jp_font = egui::FontId::new(
                    ui.text_style_height(&egui::TextStyle::Body),
                    egui::FontFamily::Name("jp".into()),
                );

                let sel = names
                    .get(idx)
                    .cloned()
                    .unwrap_or_else(|| "Default".into());
                egui::ComboBox::from_label("Output Device")
                    .selected_text(egui::RichText::new(sel.clone()).font(jp_font.clone()))
                    .show_ui(ui, |ui| {
                        for (i, n) in names.iter().enumerate() {
                            let clicked = ui
                                .selectable_label(i == idx, egui::RichText::new(n).font(jp_font.clone()))
                                .clicked();
                            if clicked {
                                idx = i;
                            }
                        }
                    });
                if idx != self.audio.lock().current_device_idx {
                    self.switch_device(idx);
                }
            }

            ui.horizontal(|ui| {
                ui.label("CrossFade (sec)");
                let mut cf = self.cfg.crossfade_sec;
                if ui
                    .add(egui::DragValue::new(&mut cf).clamp_range(0.0..=10.0).speed(0.1))
                    .changed()
                {
                    self.cfg.crossfade_sec = cf;
                    self.save_cfg();
                }
                if ui.button("Stop").clicked() {
                    self.stop_current();
                }
                if ui.button("Clear All").clicked() {
                    self.stop_current();
                    for s in &mut self.cfg.slots {
                        *s = SlotConfig { path: None, volume: 1.0, name: None, looping: true };
                    }
                    self.save_cfg();
                }
            });

            ui.separator();

            // スロット描画（2列×5行）、左右を常に 50% に分割
            for row in 0..5 {
                ui.columns(2, |columns| {
                    for col in 0..2 {
                        let i = row * 2 + col;
                        let col_ui = &mut columns[col];
                        // 各スロットの確保領域（高さ固定）
                        let size = egui::vec2(col_ui.available_width(), 120.0);
                        let (rect, _resp) = col_ui.allocate_exact_size(size, egui::Sense::hover());
                        self.slot_rects[i] = rect;

                        col_ui.allocate_ui_at_rect(rect, |ui| {
                            // 再生中スロットは強調表示
                            let playing = self.is_slot_playing(i);
                            let mut frame = egui::Frame::group(ui.style());
                            if playing {
                                frame = frame.fill(ui.visuals().selection.bg_fill.gamma_multiply(0.6));
                            }
                            frame.show(ui, |ui| {
                                ui.horizontal(|ui| {
                                    // スロット名（任意）
                                    let display_name = self
                                        .cfg
                                        .slots[i]
                                        .name
                                        .clone()
                                        .unwrap_or_else(|| format!("Slot {}", i + 1));
                                    ui.label(egui::RichText::new(display_name).strong());
                                    // 名前編集フィールド（短め）
                                    let mut name_buf = self.cfg.slots[i].name.clone().unwrap_or_default();
                                    let name_resp = ui.add_sized(
                                        egui::vec2(140.0, ui.text_style_height(&egui::TextStyle::Body)),
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
                                            self.cfg.slots[i].path = Some(file.display().to_string());
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
                                        self.cfg.slots[i] = SlotConfig { path: None, volume: 1.0, name: None, looping: true };
                                        self.save_cfg();
                                    }
                                });
                                if let Some(p) = &self.cfg.slots[i].path {
                                    let name = Self::filename_only(p);
                                    let font = egui::FontId::new(
                                        ui.text_style_height(&egui::TextStyle::Small),
                                        egui::FontFamily::Name("jp".into()),
                                    );
                                    let resp = ui.label(egui::RichText::new(name).font(font.clone()));
                                    resp.on_hover_ui(|ui| {
                                        ui.label(egui::RichText::new(p).font(font.clone()));
                                    });
                                } else {
                                    ui.label(egui::RichText::new("Drag mp3/wav here").italics().weak());
                                }

                                let mut vol = self.cfg.slots[i].volume;
                                if ui
                                    .add(egui::Slider::new(&mut vol, 0.0..=1.0).text("Volume"))
                                    .changed()
                                {
                                    self.cfg.slots[i].volume = vol;
                                    // 再生中のスロットなら反映（マスター適用）
                                    if let Some((ref sink, cur)) = self.audio.lock().current_sink {
                                        if cur == i {
                                            sink.set_volume((vol * self.cfg.master_volume).clamp(0.0, 1.0));
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
