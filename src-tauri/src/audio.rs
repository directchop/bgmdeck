//! Streaming playback engine.
//!
//! Each slot that has a file gets a *primed* decoder: a background thread
//! that decodes the file (symphonia), converts it to stereo at the device
//! sample rate and keeps a few seconds ahead in a lock-free ring buffer. On
//! play the primed source becomes a voice in the mixer and a new primed
//! source is prepared, so the next trigger of the same pad is instant too.
//! Nothing is ever decoded whole into memory, so a deck with 80 long tracks
//! costs a few megabytes, not gigabytes.
//!
//! Fades (crossfade, stop, duck) are sample-accurate envelopes computed in the
//! audio callback: there is no stepping / zipper noise.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, FromSample, Sample, SampleFormat, Stream, StreamConfig};
use rtrb::{Consumer, Producer, RingBuffer};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::{Decoder as SymDecoder, DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, FormatReader};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Lock a mutex even if another thread panicked while holding it. The audio
/// callback must never die because of a poisoned lock: silence on stage.
pub(crate) fn lock_or_recover<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------------------
// Fade shapes / ramps
// ---------------------------------------------------------------------------

/// Shape of fade-in / fade-out envelopes. `apply(t)` maps the envelope
/// position 0..1 to a gain; fade-outs run the same curve backwards so a
/// crossfade of two equal-power curves keeps constant loudness.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum FadeCurve {
    #[default]
    EqualPower,
    Linear,
    SCurve,
}

impl FadeCurve {
    pub fn parse(s: &str) -> Self {
        match s {
            "linear" => FadeCurve::Linear,
            "s-curve" | "scurve" => FadeCurve::SCurve,
            _ => FadeCurve::EqualPower,
        }
    }

    #[inline]
    pub fn apply(self, t: f32) -> f32 {
        let t = t.clamp(0.0, 1.0);
        match self {
            FadeCurve::Linear => t,
            FadeCurve::SCurve => t * t * (3.0 - 2.0 * t),
            FadeCurve::EqualPower => (t * std::f32::consts::FRAC_PI_2).sin(),
        }
    }
}

/// Linear ramp towards a target over a given time (master, duck).
#[derive(Debug, Clone, Copy)]
pub struct Ramp {
    cur: f32,
    target: f32,
    step: f32,
}

impl Ramp {
    pub fn new(v: f32) -> Self {
        Self {
            cur: v,
            target: v,
            step: 0.0,
        }
    }

    pub fn set(&mut self, target: f32, seconds: f32, sample_rate: f32) {
        self.target = target;
        let frames = (seconds.max(0.0) * sample_rate).round();
        self.step = if frames < 1.0 {
            f32::INFINITY
        } else {
            (target - self.cur).abs() / frames
        };
    }

    #[inline]
    pub fn tick(&mut self) -> f32 {
        if self.cur != self.target {
            let d = self.target - self.cur;
            if d.abs() <= self.step {
                self.cur = self.target;
            } else {
                self.cur += self.step.copysign(d);
            }
        }
        self.cur
    }

    pub fn value(&self) -> f32 {
        self.cur
    }
}

/// One-pole smoothing for slider-driven gains (~10 ms), so dragging a
/// fader while a track plays never clicks.
#[derive(Debug, Clone, Copy)]
struct Smooth {
    cur: f32,
    target: f32,
    coef: f32,
}

impl Smooth {
    fn new(v: f32, sample_rate: f32) -> Self {
        Self {
            cur: v,
            target: v,
            coef: 1.0 - (-1.0 / (0.010 * sample_rate)).exp(),
        }
    }
    #[inline]
    fn tick(&mut self) -> f32 {
        self.cur += (self.target - self.cur) * self.coef;
        self.cur
    }
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

struct Decoded {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn SymDecoder>,
    track_id: u32,
    sample_rate: u32,
    channels: u16,
}

fn open_file(path: &str) -> Result<Decoded, String> {
    let file = File::open(path).map_err(|e| format!("Open error: {e}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("Unsupported or damaged file: {e}"))?;
    let format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| "No decodable audio track".to_string())?;
    let track_id = track.id;
    let params = track.codec_params.clone();
    let sample_rate = params.sample_rate.ok_or("Unknown sample rate")?;
    let channels = params
        .channels
        .map(|c| c.count() as u16)
        .ok_or("Unknown channel layout")?;
    let decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions::default())
        .map_err(|e| format!("Decoder error: {e}"))?;
    Ok(Decoded {
        format,
        decoder,
        track_id,
        sample_rate,
        channels,
    })
}

/// Decode the next packet into stereo interleaved f32 frames appended to
/// `out`. Returns Ok(false) at end of file.
fn next_stereo_frames(d: &mut Decoded, out: &mut Vec<f32>) -> Result<bool, String> {
    loop {
        let packet = match d.format.next_packet() {
            Ok(p) => p,
            Err(SymphoniaError::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                return Ok(false)
            }
            Err(SymphoniaError::ResetRequired) => {
                d.decoder.reset();
                continue;
            }
            Err(e) => return Err(format!("Read error: {e}")),
        };
        if packet.track_id() != d.track_id {
            continue;
        }
        match d.decoder.decode(&packet) {
            Ok(buf) => {
                append_stereo(&buf, out);
                return Ok(true);
            }
            Err(SymphoniaError::DecodeError(_)) => continue, // skip bad frames
            Err(e) => return Err(format!("Decode error: {e}")),
        }
    }
}

/// Downmix any channel layout to stereo: mono is duplicated, anything wider
/// than stereo keeps its first two channels.
fn append_stereo(buf: &AudioBufferRef, out: &mut Vec<f32>) {
    use symphonia::core::audio::AudioBufferRef::*;
    macro_rules! stereo {
        ($buf:expr, $to_f32:expr) => {{
            let spec = $buf.spec();
            let channels = spec.channels.count();
            let frames = $buf.frames();
            out.reserve(frames * 2);
            if channels == 1 {
                for f in 0..frames {
                    let v = $to_f32($buf.chan(0)[f]);
                    out.push(v);
                    out.push(v);
                }
            } else {
                for f in 0..frames {
                    out.push($to_f32($buf.chan(0)[f]));
                    out.push($to_f32($buf.chan(1)[f]));
                }
            }
        }};
    }
    match buf {
        F32(b) => stereo!(b, |x: f32| x),
        F64(b) => stereo!(b, |x: f64| x as f32),
        S8(b) => stereo!(b, |x: i8| x as f32 / i8::MAX as f32),
        S16(b) => stereo!(b, |x: i16| x as f32 / i16::MAX as f32),
        S24(b) => stereo!(b, |x: symphonia::core::sample::i24| x.inner() as f32 / 8_388_607.0),
        S32(b) => stereo!(b, |x: i32| x as f32 / i32::MAX as f32),
        U8(b) => stereo!(b, |x: u8| (x as f32 - 128.0) / 128.0),
        U16(b) => stereo!(b, |x: u16| (x as f32 - 32768.0) / 32768.0),
        U24(b) => stereo!(b, |x: symphonia::core::sample::u24| (x.inner() as f32 - 8_388_608.0)
            / 8_388_608.0),
        U32(b) => stereo!(b, |x: u32| (x as f32 - 2_147_483_648.0) / 2_147_483_648.0),
    }
}

/// What the UI needs to know about a file: length and a waveform thumbnail.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub duration: f64,
    pub sample_rate: u32,
    pub channels: u16,
    /// Normalized 0..1 peak per bucket (`PEAK_BUCKETS` entries, fewer for
    /// very short files).
    pub peaks: Vec<f32>,
}

pub const PEAK_BUCKETS: usize = 240;
const PEAK_WINDOW_FRAMES: usize = 1024;

/// Read the whole file once (streaming, constant memory) to measure its
/// length and waveform. MP3 without a Xing header has no reliable frame
/// count in the header, so counting is the only exact way.
pub fn scan_file(path: &str) -> Result<FileInfo, String> {
    let mut d = open_file(path)?;
    let mut frames: u64 = 0;
    let mut windows: Vec<f32> = Vec::new();
    let mut window_peak = 0.0f32;
    let mut window_fill = 0usize;
    let mut buf: Vec<f32> = Vec::new();
    loop {
        buf.clear();
        if !next_stereo_frames(&mut d, &mut buf)? {
            break;
        }
        for frame in buf.chunks_exact(2) {
            let p = frame[0].abs().max(frame[1].abs());
            if p > window_peak {
                window_peak = p;
            }
            window_fill += 1;
            if window_fill == PEAK_WINDOW_FRAMES {
                windows.push(window_peak.min(1.0));
                window_peak = 0.0;
                window_fill = 0;
            }
        }
        frames += (buf.len() / 2) as u64;
    }
    if window_fill > 0 {
        windows.push(window_peak.min(1.0));
    }
    Ok(FileInfo {
        duration: frames as f64 / d.sample_rate as f64,
        sample_rate: d.sample_rate,
        channels: d.channels,
        peaks: bucket_peaks(&windows, PEAK_BUCKETS),
    })
}

/// Reduce per-window peaks to at most `buckets` values (max per bucket).
pub fn bucket_peaks(windows: &[f32], buckets: usize) -> Vec<f32> {
    if windows.is_empty() || buckets == 0 {
        return Vec::new();
    }
    let n = buckets.min(windows.len());
    let per = (windows.len() + n - 1) / n;
    windows
        .chunks(per)
        .map(|c| c.iter().cloned().fold(0.0f32, f32::max))
        .collect()
}

// ---------------------------------------------------------------------------
// Streaming source (decoder thread + ring buffer)
// ---------------------------------------------------------------------------

/// Linear-interpolation resampler for interleaved stereo frames.
pub struct Resampler {
    ratio: f64,
    pos: f64,
    pending: Vec<f32>,
}

impl Resampler {
    pub fn new(src_rate: u32, out_rate: u32) -> Self {
        Self {
            ratio: src_rate as f64 / out_rate as f64,
            pos: 0.0,
            pending: Vec::new(),
        }
    }

    pub fn is_identity(&self) -> bool {
        (self.ratio - 1.0).abs() < 1e-9
    }

    /// Feed stereo frames, append resampled stereo frames to `out`.
    pub fn push(&mut self, frames: &[f32], out: &mut Vec<f32>) {
        if self.is_identity() && self.pending.is_empty() {
            out.extend_from_slice(frames);
            return;
        }
        self.pending.extend_from_slice(frames);
        let n = self.pending.len() / 2;
        while (self.pos as usize) + 1 < n {
            let i = self.pos as usize;
            let f = (self.pos - i as f64) as f32;
            for c in 0..2 {
                let a = self.pending[i * 2 + c];
                let b = self.pending[(i + 1) * 2 + c];
                out.push(a + (b - a) * f);
            }
            self.pos += self.ratio;
        }
        let keep_from = (self.pos as usize).min(n.saturating_sub(1));
        if keep_from > 0 {
            self.pending.drain(..keep_from * 2);
            self.pos -= keep_from as f64;
        }
    }

    /// End of stream: emit whatever is still pending (last frame held).
    pub fn flush(&mut self, out: &mut Vec<f32>) {
        let n = self.pending.len() / 2;
        while (self.pos as usize) < n {
            let i = self.pos as usize;
            let f = (self.pos - i as f64) as f32;
            for c in 0..2 {
                let a = self.pending[i * 2 + c];
                let b = if i + 1 < n { self.pending[(i + 1) * 2 + c] } else { a };
                out.push(a + (b - a) * f);
            }
            self.pos += self.ratio;
        }
        self.pending.clear();
        self.pos = 0.0;
    }
}

/// Seconds of audio kept decoded ahead of the playhead.
const RING_SECONDS: usize = 4;
/// The decoder tops the ring up whenever this much room is free.
const REFILL_FRAMES: usize = 4096;

/// Consumer end of a decoder thread. Dropping it stops the thread.
pub struct StreamSource {
    consumer: Consumer<f32>,
    /// Output frame indices at which a new pass of the file starts (written
    /// by the decoder when it wraps). Lets the mixer stop at the end of the
    /// current pass when loop is switched off, and reset the position.
    boundaries: Consumer<u64>,
    next_boundary: Option<u64>,
    looping: Arc<AtomicBool>,
    eof: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
}

impl Drop for StreamSource {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl StreamSource {
    /// Open `path` and start decoding into a ring at `out_rate`. Errors that
    /// happen before the first packet (missing / unsupported file) are
    /// returned here; later errors end the stream and are logged.
    pub fn open(path: &str, out_rate: u32, looping: Arc<AtomicBool>) -> Result<Self, String> {
        let decoded = open_file(path)?;
        let (producer, consumer) = RingBuffer::<f32>::new(RING_SECONDS * out_rate as usize * 2);
        let (boundary_tx, boundaries) = RingBuffer::<u64>::new(64);
        let eof = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let error = Arc::new(Mutex::new(None));
        let worker = DecoderWorker {
            path: path.to_string(),
            decoded: Some(decoded),
            producer,
            boundary_tx,
            produced: 0,
            out_rate,
            eof: Arc::clone(&eof),
            stop: Arc::clone(&stop),
            looping: Arc::clone(&looping),
            error: Arc::clone(&error),
        };
        std::thread::Builder::new()
            .name("bgm-decoder".into())
            .spawn(move || worker.run())
            .map_err(|e| format!("Decoder thread: {e}"))?;
        Ok(Self {
            consumer,
            boundaries,
            next_boundary: None,
            looping,
            eof,
            stop,
            error,
        })
    }

    /// A source fed from memory (tests).
    #[cfg(test)]
    pub fn from_samples(stereo: &[f32]) -> Self {
        let (mut producer, consumer) = RingBuffer::<f32>::new(stereo.len().max(2));
        for &s in stereo {
            let _ = producer.push(s);
        }
        let (_tx, boundaries) = RingBuffer::<u64>::new(1);
        Self {
            consumer,
            boundaries,
            next_boundary: None,
            looping: Arc::new(AtomicBool::new(false)),
            eof: Arc::new(AtomicBool::new(true)),
            stop: Arc::new(AtomicBool::new(false)),
            error: Arc::new(Mutex::new(None)),
        }
    }

    /// Frames currently buffered.
    #[allow(dead_code)]
    pub fn buffered_frames(&self) -> usize {
        self.consumer.slots() / 2
    }

    pub fn take_error(&self) -> Option<String> {
        lock_or_recover(&self.error).take()
    }

    /// Does a new pass start at output frame `frame`? Consumes the marker.
    #[inline]
    fn pass_starts_at(&mut self, frame: u64) -> bool {
        if self.next_boundary.is_none() {
            self.next_boundary = self.boundaries.pop().ok();
        }
        match self.next_boundary {
            Some(b) if b <= frame => {
                self.next_boundary = None;
                true
            }
            _ => false,
        }
    }
}

struct DecoderWorker {
    path: String,
    decoded: Option<Decoded>,
    producer: Producer<f32>,
    boundary_tx: Producer<u64>,
    /// Output frames handed to the ring so far.
    produced: u64,
    out_rate: u32,
    eof: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    looping: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
}

impl DecoderWorker {
    fn run(mut self) {
        let mut d = match self.decoded.take() {
            Some(d) => d,
            None => return,
        };
        let mut resampler = Resampler::new(d.sample_rate, self.out_rate);
        let mut raw: Vec<f32> = Vec::new();
        let mut out: Vec<f32> = Vec::new();
        loop {
            if self.stop.load(Ordering::Relaxed) {
                return;
            }
            if self.producer.slots() < REFILL_FRAMES * 2 {
                std::thread::sleep(Duration::from_millis(10));
                continue;
            }
            raw.clear();
            out.clear();
            match next_stereo_frames(&mut d, &mut raw) {
                Ok(true) => {
                    resampler.push(&raw, &mut out);
                    if !self.push_all(&out) {
                        return;
                    }
                }
                Ok(false) => {
                    if self.looping.load(Ordering::Relaxed) {
                        match open_file(&self.path) {
                            Ok(next) => {
                                if next.sample_rate != d.sample_rate {
                                    resampler = Resampler::new(next.sample_rate, self.out_rate);
                                }
                                d = next;
                                // Frames still pending in the resampler belong
                                // to this pass; the marker is close enough.
                                let _ = self.boundary_tx.push(self.produced);
                                continue;
                            }
                            Err(e) => {
                                log::warn!("Loop reopen failed for {}: {e}", self.path);
                                *lock_or_recover(&self.error) = Some(e);
                            }
                        }
                    }
                    resampler.flush(&mut out);
                    let _ = self.push_all(&out);
                    self.eof.store(true, Ordering::Release);
                    return;
                }
                Err(e) => {
                    log::warn!("Decode stopped for {}: {e}", self.path);
                    *lock_or_recover(&self.error) = Some(e);
                    resampler.flush(&mut out);
                    let _ = self.push_all(&out);
                    self.eof.store(true, Ordering::Release);
                    return;
                }
            }
        }
    }

    /// Push every sample, waiting for room. Returns false when stopped.
    fn push_all(&mut self, samples: &[f32]) -> bool {
        self.produced += (samples.len() / 2) as u64;
        for &s in samples {
            let mut v = s;
            loop {
                match self.producer.push(v) {
                    Ok(()) => break,
                    Err(rtrb::PushError::Full(x)) => {
                        v = x;
                        if self.stop.load(Ordering::Relaxed) || self.producer.is_abandoned() {
                            return false;
                        }
                        std::thread::sleep(Duration::from_millis(5));
                    }
                }
            }
        }
        true
    }
}

// ---------------------------------------------------------------------------
// Voices and the mixer
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    FadeIn,
    Steady,
    FadeOut,
}

pub struct Voice {
    pub gen: u64,
    src: StreamSource,
    consumed: u64,
    /// Output frame at which the current pass of the file began.
    pass_start: u64,
    volume: Smooth,
    env: f32,
    env_step: f32,
    stage: Stage,
    finished: bool,
    underruns: u32,
}

impl Voice {
    fn new(gen: u64, src: StreamSource, volume: f32, fade_in: f32, sample_rate: f32) -> Self {
        let frames = (fade_in.max(0.0) * sample_rate).round();
        let (env, env_step, stage) = if frames < 1.0 {
            (1.0, 0.0, Stage::Steady)
        } else {
            (0.0, 1.0 / frames, Stage::FadeIn)
        };
        Self {
            gen,
            src,
            consumed: 0,
            pass_start: 0,
            volume: Smooth::new(volume, sample_rate),
            env,
            env_step,
            stage,
            finished: false,
            underruns: 0,
        }
    }

    fn fade_out(&mut self, seconds: f32, sample_rate: f32) {
        if self.stage == Stage::FadeOut {
            return;
        }
        let frames = (seconds.max(0.0) * sample_rate).round();
        self.stage = Stage::FadeOut;
        self.env_step = if frames < 1.0 { f32::INFINITY } else { self.env / frames.max(1.0) };
    }

    /// Next stereo frame (already enveloped and volume-scaled).
    #[inline]
    fn next_frame(&mut self, curve: FadeCurve) -> (f32, f32) {
        if self.finished {
            return (0.0, 0.0);
        }
        if self.src.pass_starts_at(self.consumed) {
            if !self.src.looping.load(Ordering::Relaxed) {
                // Loop was switched off during this pass: end here even
                // though the decoder already buffered the next pass.
                self.finished = true;
                return (0.0, 0.0);
            }
            self.pass_start = self.consumed;
        }
        let (a, b) = if self.src.consumer.slots() >= 2 {
            let a = self.src.consumer.pop().unwrap_or(0.0);
            let b = self.src.consumer.pop().unwrap_or(0.0);
            (a, b)
        } else if self.src.eof.load(Ordering::Acquire) || self.src.consumer.is_abandoned() {
            self.finished = true;
            return (0.0, 0.0);
        } else {
            self.underruns += 1;
            (0.0, 0.0)
        };
        self.consumed += 1;
        match self.stage {
            Stage::FadeIn => {
                self.env += self.env_step;
                if self.env >= 1.0 - 1e-6 {
                    self.env = 1.0;
                    self.stage = Stage::Steady;
                }
            }
            Stage::Steady => {}
            Stage::FadeOut => {
                self.env -= self.env_step;
                if self.env <= 1e-6 {
                    self.env = 0.0;
                    self.finished = true;
                }
            }
        }
        let g = curve.apply(self.env) * self.volume.tick();
        (a * g, b * g)
    }
}

/// Per-voice status copied out of the callback for the UI.
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    pub gen: u64,
    pub frames: u64,
    pub stage: Stage,
    pub env: f32,
}

/// State shared between the audio callback and the commands.
pub struct Shared {
    pub voices: Vec<Voice>,
    graveyard: Vec<Voice>,
    pub master: Ramp,
    pub duck: Ramp,
    pub curve: FadeCurve,
    /// Output channel indices for left / right.
    pub routing: (usize, usize),
    pub sample_rate: f32,
    pub peak: [f32; 2],
    pub status: Vec<VoiceStatus>,
    pub underruns: u64,
}

impl Shared {
    fn new(sample_rate: f32) -> Self {
        Self {
            voices: Vec::with_capacity(8),
            graveyard: Vec::with_capacity(8),
            master: Ramp::new(1.0),
            duck: Ramp::new(1.0),
            curve: FadeCurve::EqualPower,
            routing: (0, 1),
            sample_rate,
            peak: [0.0; 2],
            status: Vec::with_capacity(16),
            underruns: 0,
        }
    }
}

/// Mix every voice into `out` (interleaved, `channels` wide). Also refreshes
/// the per-voice status list and the peak meters. Called from the audio
/// thread; must not allocate on the steady path.
pub fn render(s: &mut Shared, out: &mut [f32], channels: usize) {
    let frames = if channels == 0 { 0 } else { out.len() / channels };
    let (li, ri) = s.routing;
    let curve = s.curve;
    let mut peak_l = 0.0f32;
    let mut peak_r = 0.0f32;
    for frame in 0..frames {
        let mut l = 0.0f32;
        let mut r = 0.0f32;
        for v in s.voices.iter_mut() {
            let (a, b) = v.next_frame(curve);
            l += a;
            r += b;
        }
        let m = s.master.tick() * s.duck.tick();
        l *= m;
        r *= m;
        let base = frame * channels;
        if li < channels {
            out[base + li] += l;
        }
        if ri < channels {
            out[base + ri] += r;
        }
        peak_l = peak_l.max(l.abs());
        peak_r = peak_r.max(r.abs());
    }
    // Peak hold with decay (~ -20 dB/s at typical callback sizes).
    let decay = 0.85f32;
    s.peak[0] = peak_l.max(s.peak[0] * decay);
    s.peak[1] = peak_r.max(s.peak[1] * decay);

    // Retire finished voices without freeing on this thread.
    let mut i = 0;
    while i < s.voices.len() {
        if s.voices[i].finished {
            let v = s.voices.swap_remove(i);
            s.underruns += v.underruns as u64;
            if s.graveyard.len() < s.graveyard.capacity() {
                s.graveyard.push(v);
            } else {
                drop(v);
            }
        } else {
            i += 1;
        }
    }
    s.status.clear();
    for v in s.voices.iter() {
        if s.status.len() < s.status.capacity() {
            s.status.push(VoiceStatus {
                gen: v.gen,
                frames: v.consumed - v.pass_start,
                stage: v.stage,
                env: v.env,
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceInfo {
    /// Stable selector: `"<host>::<device name>"`.
    pub id: String,
    pub name: String,
    pub host: String,
    pub max_channels: u16,
    pub default_sample_rate: u32,
    pub is_default: bool,
}

fn device_id(host: &str, name: &str) -> String {
    format!("{host}::{name}")
}

fn hosts() -> Vec<(String, cpal::Host)> {
    cpal::available_hosts()
        .into_iter()
        .filter_map(|id| match cpal::host_from_id(id) {
            Ok(h) => Some((id.name().to_string(), h)),
            Err(e) => {
                log::warn!("Audio host {} unavailable: {e}", id.name());
                None
            }
        })
        .collect()
}

fn find_output_device(selector: Option<&str>) -> Result<(Device, String), String> {
    let Some(sel) = selector.filter(|s| !s.trim().is_empty()) else {
        let host = cpal::default_host();
        let dev = host
            .default_output_device()
            .ok_or("No output device found")?;
        return Ok((dev, host.id().name().to_string()));
    };
    let (want_host, want_name) = match sel.split_once("::") {
        Some((h, n)) => (Some(h), n),
        None => (None, sel),
    };
    for (host_name, host) in hosts() {
        if want_host.is_some_and(|h| h != host_name) {
            continue;
        }
        let Ok(mut devs) = host.output_devices() else {
            continue;
        };
        if let Some(d) = devs.find(|d| d.name().ok().as_deref() == Some(want_name)) {
            return Ok((d, host_name));
        }
    }
    Err(format!("Device not found: {sel}"))
}

pub fn list_devices() -> Vec<AudioDeviceInfo> {
    let default_host = cpal::default_host().id().name().to_string();
    let mut devices = Vec::new();
    for (host_name, host) in hosts() {
        let default_name = if host_name == default_host {
            host.default_output_device().and_then(|d| d.name().ok())
        } else {
            None
        };
        let output_devices = match host.output_devices() {
            Ok(d) => d,
            Err(e) => {
                log::warn!("{host_name}: cannot enumerate output devices: {e}");
                continue;
            }
        };
        for device in output_devices {
            let name = device.name().unwrap_or_else(|_| "Unknown".to_string());
            let (max_ch, sr) = match device.default_output_config() {
                Ok(c) => (c.channels(), c.sample_rate().0),
                Err(e) => {
                    log::warn!("{host_name}: {name}: no default output config: {e}");
                    (2, 48000)
                }
            };
            devices.push(AudioDeviceInfo {
                id: device_id(&host_name, &name),
                is_default: default_name.as_deref() == Some(name.as_str()),
                name,
                host: host_name.clone(),
                max_channels: max_ch,
                default_sample_rate: sr,
            });
        }
    }
    log::info!(
        "Audio devices: {}",
        devices
            .iter()
            .map(|d| format!("{} ({}ch @ {})", d.id, d.max_channels, d.default_sample_rate))
            .collect::<Vec<_>>()
            .join(", ")
    );
    devices
}

#[allow(dead_code)]
struct SendStream(Stream);
unsafe impl Send for SendStream {}
unsafe impl Sync for SendStream {}

pub type StreamErrorHandler = Arc<dyn Fn(String) + Send + Sync>;

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

struct SlotEntry {
    path: String,
    looping: Arc<AtomicBool>,
    primed: Option<StreamSource>,
    info: Option<FileInfo>,
}

/// Snapshot of what is sounding right now, resolved to slot ids.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlayingVoice {
    pub gen: u64,
    pub slot_id: String,
    pub position: f64,
    pub duration: Option<f64>,
    pub stage: Stage,
    pub env: f32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeckStatus {
    pub voices: Vec<PlayingVoice>,
    pub peak: [f32; 2],
    pub master: f32,
    pub duck: f32,
    pub underruns: u64,
}

pub struct Engine {
    shared: Arc<Mutex<Shared>>,
    slots: HashMap<String, SlotEntry>,
    gens: HashMap<u64, String>,
    next_gen: AtomicU64,
    stream: Option<SendStream>,
    sample_rate: u32,
    channels: u16,
    device_id: Option<String>,
    on_error: Option<StreamErrorHandler>,
    // Settings re-applied after a device restart.
    master: f32,
    duck_on: bool,
    duck_level: f32,
    duck_fade: f32,
    routing: (usize, usize),
    curve: FadeCurve,
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

impl Engine {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(Mutex::new(Shared::new(48_000.0))),
            slots: HashMap::new(),
            gens: HashMap::new(),
            next_gen: AtomicU64::new(1),
            stream: None,
            sample_rate: 48_000,
            channels: 2,
            device_id: None,
            on_error: None,
            master: 1.0,
            duck_on: false,
            duck_level: 0.25,
            duck_fade: 0.5,
            routing: (0, 1),
            curve: FadeCurve::EqualPower,
        }
    }

    pub fn set_error_handler(&mut self, handler: StreamErrorHandler) {
        self.on_error = Some(handler);
    }

    pub fn is_running(&self) -> bool {
        self.stream.is_some()
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn output_channels(&self) -> u16 {
        self.channels
    }

    pub fn device_id(&self) -> Option<&str> {
        self.device_id.as_deref()
    }

    /// Start (or restart) the output stream. Playback stops and every primed
    /// decoder is rebuilt for the new sample rate.
    pub fn start_with(
        &mut self,
        device: Option<&str>,
        sample_rate: Option<u32>,
        buffer_size: Option<u32>,
    ) -> Result<(), String> {
        self.stream = None;
        let (device, host_name) = find_output_device(device)?;
        let resolved_name = device.name().unwrap_or_else(|_| "Unknown".to_string());
        let default_cfg = device
            .default_output_config()
            .map_err(|e| format!("Config error: {e}"))?;

        let (channels_used, sr_used) = if let Some(req) = sample_rate {
            let req_sr = cpal::SampleRate(req);
            let matched = device
                .supported_output_configs()
                .map_err(|e| format!("Supported configs error: {e}"))?
                .filter(|r| r.min_sample_rate() <= req_sr && req_sr <= r.max_sample_rate())
                .max_by_key(|r| r.channels());
            match matched {
                Some(range) => (range.channels(), req_sr),
                None => {
                    log::warn!(
                        "Requested sample rate {req} Hz not supported; using default {}",
                        default_cfg.sample_rate().0
                    );
                    (default_cfg.channels(), default_cfg.sample_rate())
                }
            }
        } else {
            (default_cfg.channels(), default_cfg.sample_rate())
        };
        let channels_used = channels_used.max(2);
        self.sample_rate = sr_used.0;
        self.channels = channels_used;

        // Fresh shared state at the new rate; old voices are dropped.
        {
            let mut s = lock_or_recover(&self.shared);
            *s = Shared::new(self.sample_rate as f32);
            s.master = Ramp::new(self.master);
            s.duck = Ramp::new(if self.duck_on { self.duck_level } else { 1.0 });
            s.routing = self.routing;
            s.curve = self.curve;
        }
        self.gens.clear();

        let mut config = StreamConfig {
            channels: channels_used,
            sample_rate: sr_used,
            buffer_size: match buffer_size {
                Some(n) if n > 0 => cpal::BufferSize::Fixed(n),
                _ => cpal::BufferSize::Default,
            },
        };
        let format = default_cfg.sample_format();
        let stream = match self.build_stream_any(&device, &config, format) {
            Ok(s) => s,
            Err(e) if matches!(config.buffer_size, cpal::BufferSize::Fixed(_)) => {
                log::warn!(
                    "{host_name}: {resolved_name}: buffer size {:?} rejected ({e}); using the device default",
                    config.buffer_size
                );
                config.buffer_size = cpal::BufferSize::Default;
                self.build_stream_any(&device, &config, format)?
            }
            Err(e) => return Err(e),
        };
        stream
            .play()
            .map_err(|e| format!("Stream play error: {e}"))?;
        self.stream = Some(SendStream(stream));
        self.device_id = Some(device_id(&host_name, &resolved_name));
        log::info!(
            "Audio engine started: {host_name}: {resolved_name}: {}ch @ {}Hz, buffer {:?}, format {:?}",
            self.channels,
            self.sample_rate,
            config.buffer_size,
            format
        );

        // Re-prime every slot at the new rate.
        let ids: Vec<String> = self.slots.keys().cloned().collect();
        for id in ids {
            self.prime(&id);
        }
        Ok(())
    }

    fn build_stream_any(
        &self,
        device: &Device,
        config: &StreamConfig,
        format: SampleFormat,
    ) -> Result<Stream, String> {
        macro_rules! build {
            ($t:ty) => {
                Self::build_stream::<$t>(
                    device,
                    config,
                    Arc::clone(&self.shared),
                    self.on_error.clone(),
                    self.channels as usize,
                )
            };
        }
        match format {
            SampleFormat::F32 => build!(f32),
            SampleFormat::F64 => build!(f64),
            SampleFormat::I16 => build!(i16),
            SampleFormat::U16 => build!(u16),
            SampleFormat::I32 => build!(i32),
            other => Err(format!("Unsupported sample format {other:?}")),
        }
    }

    fn build_stream<T: cpal::SizedSample + FromSample<f32> + Sample>(
        device: &Device,
        config: &StreamConfig,
        shared: Arc<Mutex<Shared>>,
        on_error: Option<StreamErrorHandler>,
        channels: usize,
    ) -> Result<Stream, String> {
        let mut mix: Vec<f32> = Vec::with_capacity(8192 * channels);
        device
            .build_output_stream(
                config,
                move |data: &mut [T], _| {
                    mix.clear();
                    mix.resize(data.len(), 0.0);
                    {
                        let mut s = lock_or_recover(&shared);
                        render(&mut s, &mut mix, channels);
                    }
                    for (o, &v) in data.iter_mut().zip(mix.iter()) {
                        *o = T::from_sample(v.clamp(-1.0, 1.0));
                    }
                },
                move |err| {
                    log::error!("Audio stream error: {err}");
                    if let Some(h) = &on_error {
                        h(err.to_string());
                    }
                },
                None,
            )
            .map_err(|e| format!("Build stream error: {e}"))
    }

    // ---- slots ----

    /// Register / replace the file behind a slot. Verifies the file opens,
    /// primes a decoder, and returns immediately; `scan_slot` measures it.
    pub fn load_slot(&mut self, slot_id: &str, path: &str, looping: bool) -> Result<(), String> {
        // Opening is the validation step; the primed source does the same
        // open again but that is cheap (header only).
        open_file(path)?;
        let flag = Arc::new(AtomicBool::new(looping));
        self.slots.insert(
            slot_id.to_string(),
            SlotEntry {
                path: path.to_string(),
                looping: flag,
                primed: None,
                info: None,
            },
        );
        self.prime(slot_id);
        Ok(())
    }

    #[allow(dead_code)]
    pub fn slot_path(&self, slot_id: &str) -> Option<String> {
        self.slots.get(slot_id).map(|s| s.path.clone())
    }

    pub fn set_slot_info(&mut self, slot_id: &str, path: &str, info: FileInfo) {
        if let Some(s) = self.slots.get_mut(slot_id) {
            if s.path == path {
                s.info = Some(info);
            }
        }
    }

    pub fn unload_slot(&mut self, slot_id: &str) {
        self.slots.remove(slot_id);
        self.stop_slot(slot_id, 0.05);
    }

    pub fn set_slot_looping(&mut self, slot_id: &str, looping: bool) {
        if let Some(s) = self.slots.get(slot_id) {
            s.looping.store(looping, Ordering::Relaxed);
        }
    }

    fn prime(&mut self, slot_id: &str) {
        let Some(entry) = self.slots.get_mut(slot_id) else {
            return;
        };
        match StreamSource::open(&entry.path, self.sample_rate, Arc::clone(&entry.looping)) {
            Ok(src) => entry.primed = Some(src),
            Err(e) => {
                log::warn!("Could not prime {}: {e}", entry.path);
                entry.primed = None;
            }
        }
    }

    // ---- transport ----

    /// Start `slot_id`, fading everything else out over `fade_out`.
    /// Returns the voice generation id.
    pub fn play(
        &mut self,
        slot_id: &str,
        volume: f32,
        fade_in: f32,
        fade_out: f32,
    ) -> Result<u64, String> {
        if !self.is_running() {
            return Err("Audio engine is not running".into());
        }
        let sr = self.sample_rate;
        let src = {
            let entry = self
                .slots
                .get_mut(slot_id)
                .ok_or_else(|| format!("Slot {slot_id} has no file"))?;
            match entry.primed.take() {
                Some(s) => s,
                None => StreamSource::open(&entry.path, sr, Arc::clone(&entry.looping))?,
            }
        };
        let gen = self.next_gen.fetch_add(1, Ordering::Relaxed);
        {
            let mut s = lock_or_recover(&self.shared);
            let sr_f = s.sample_rate;
            for v in s.voices.iter_mut() {
                v.fade_out(fade_out, sr_f);
            }
            let voice = Voice::new(gen, src, volume.clamp(0.0, 1.0), fade_in, sr_f);
            s.voices.push(voice);
        }
        self.gens.insert(gen, slot_id.to_string());
        self.prime(slot_id);
        Ok(gen)
    }

    /// Fade every voice out (0 = immediately).
    pub fn stop_all(&mut self, fade_out: f32) {
        let mut s = lock_or_recover(&self.shared);
        let sr = s.sample_rate;
        for v in s.voices.iter_mut() {
            v.fade_out(fade_out, sr);
        }
    }

    /// Fade out the voices playing one slot.
    pub fn stop_slot(&mut self, slot_id: &str, fade_out: f32) {
        let gens: Vec<u64> = self
            .gens
            .iter()
            .filter(|(_, id)| id.as_str() == slot_id)
            .map(|(g, _)| *g)
            .collect();
        let mut s = lock_or_recover(&self.shared);
        let sr = s.sample_rate;
        for v in s.voices.iter_mut() {
            if gens.contains(&v.gen) {
                v.fade_out(fade_out, sr);
            }
        }
    }

    pub fn set_slot_volume(&mut self, slot_id: &str, volume: f32) {
        let gens: Vec<u64> = self
            .gens
            .iter()
            .filter(|(_, id)| id.as_str() == slot_id)
            .map(|(g, _)| *g)
            .collect();
        let mut s = lock_or_recover(&self.shared);
        for v in s.voices.iter_mut() {
            if gens.contains(&v.gen) {
                v.volume.target = volume.clamp(0.0, 1.0);
            }
        }
    }

    pub fn set_master(&mut self, volume: f32) {
        self.master = volume.clamp(0.0, 1.0);
        let mut s = lock_or_recover(&self.shared);
        let sr = s.sample_rate;
        s.master.set(self.master, 0.02, sr);
    }

    pub fn set_duck(&mut self, on: bool, level: f32, fade: f32) {
        self.duck_on = on;
        self.duck_level = level.clamp(0.0, 1.0);
        self.duck_fade = fade.max(0.0);
        let mut s = lock_or_recover(&self.shared);
        let sr = s.sample_rate;
        s.duck
            .set(if on { self.duck_level } else { 1.0 }, self.duck_fade, sr);
    }

    pub fn set_routing(&mut self, left: usize, right: usize) {
        self.routing = (left, right);
        lock_or_recover(&self.shared).routing = (left, right);
    }

    pub fn set_curve(&mut self, curve: FadeCurve) {
        self.curve = curve;
        lock_or_recover(&self.shared).curve = curve;
    }

    /// Resolve the callback's status list to slot ids / seconds. Also frees
    /// retired voices (decoder threads) off the audio thread.
    pub fn status(&mut self) -> DeckStatus {
        let (status, peak, master, duck, underruns, graveyard, live) = {
            let mut s = lock_or_recover(&self.shared);
            let g: Vec<Voice> = s.graveyard.drain(..).collect();
            // Voices pushed by `play` since the last callback are live too.
            let live: Vec<u64> = s.voices.iter().map(|v| v.gen).collect();
            (
                s.status.clone(),
                s.peak,
                s.master.value(),
                s.duck.value(),
                s.underruns,
                g,
                live,
            )
        };
        for v in &graveyard {
            if let Some(e) = v.src.take_error() {
                log::warn!("Voice {} ended with error: {e}", v.gen);
            }
        }
        drop(graveyard);
        self.gens.retain(|g, _| live.contains(g));
        let sr = self.sample_rate as f64;
        let voices = status
            .iter()
            .filter_map(|v| {
                let slot_id = self.gens.get(&v.gen)?.clone();
                let duration = self
                    .slots
                    .get(&slot_id)
                    .and_then(|s| s.info.as_ref())
                    .map(|i| i.duration);
                let mut position = v.frames as f64 / sr;
                if let Some(d) = duration {
                    if d > 0.0 && position >= d {
                        position %= d;
                    }
                }
                Some(PlayingVoice {
                    gen: v.gen,
                    slot_id,
                    position,
                    duration,
                    stage: v.stage,
                    env: v.env,
                })
            })
            .collect();
        DeckStatus {
            voices,
            peak,
            master,
            duck,
            underruns,
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn stereo_const(frames: usize, v: f32) -> Vec<f32> {
        vec![v; frames * 2]
    }

    fn shared_with(voices: Vec<Voice>) -> Shared {
        let mut s = Shared::new(1000.0);
        s.voices = voices;
        s
    }

    #[test]
    fn equal_power_crossfade_keeps_constant_power() {
        let c = FadeCurve::EqualPower;
        for i in 0..=10 {
            let t = i as f32 / 10.0;
            let p = c.apply(t).powi(2) + c.apply(1.0 - t).powi(2);
            assert!((p - 1.0).abs() < 1e-5, "t={t} p={p}");
        }
        assert_eq!(FadeCurve::Linear.apply(0.25), 0.25);
        assert!((FadeCurve::SCurve.apply(0.5) - 0.5).abs() < 1e-6);
        assert_eq!(FadeCurve::parse("linear"), FadeCurve::Linear);
        assert_eq!(FadeCurve::parse("nonsense"), FadeCurve::EqualPower);
    }

    #[test]
    fn ramp_reaches_target_in_time() {
        let mut r = Ramp::new(1.0);
        r.set(0.0, 0.01, 1000.0); // 10 frames
        let mut v = Vec::new();
        for _ in 0..12 {
            v.push(r.tick());
        }
        assert!((v[0] - 0.9).abs() < 1e-5);
        assert!((v[8] - 0.1).abs() < 1e-5);
        assert_eq!(v[9], 0.0);
        assert_eq!(v[11], 0.0);
        // Zero seconds jumps.
        r.set(1.0, 0.0, 1000.0);
        assert_eq!(r.tick(), 1.0);
    }

    #[test]
    fn resampler_identity_passes_through_and_ratio_two_halves() {
        let mut r = Resampler::new(48_000, 48_000);
        let mut out = Vec::new();
        r.push(&[1.0, 2.0, 3.0, 4.0], &mut out);
        assert_eq!(out, vec![1.0, 2.0, 3.0, 4.0]);

        let mut r = Resampler::new(96_000, 48_000);
        let mut out = Vec::new();
        let input: Vec<f32> = (0..8).flat_map(|i| [i as f32, -(i as f32)]).collect();
        r.push(&input, &mut out);
        r.flush(&mut out);
        let left: Vec<f32> = out.chunks(2).map(|f| f[0]).collect();
        assert_eq!(left, vec![0.0, 2.0, 4.0, 6.0]);
    }

    #[test]
    fn resampler_upsamples_across_packet_boundaries() {
        let mut r = Resampler::new(1000, 2000);
        let mut out = Vec::new();
        r.push(&[0.0, 0.0, 1.0, 1.0], &mut out);
        r.push(&[2.0, 2.0], &mut out);
        r.flush(&mut out);
        let left: Vec<f32> = out.chunks(2).map(|f| f[0]).collect();
        assert_eq!(left, vec![0.0, 0.5, 1.0, 1.5, 2.0, 2.0]);
    }

    #[test]
    fn bucket_peaks_takes_max_per_bucket() {
        assert_eq!(bucket_peaks(&[0.1, 0.9, 0.2, 0.3, 0.4, 0.5], 3), vec![0.9, 0.3, 0.5]);
        assert_eq!(bucket_peaks(&[0.7], 240), vec![0.7]);
        assert!(bucket_peaks(&[], 10).is_empty());
    }

    #[test]
    fn fade_in_then_steady_then_natural_end() {
        let src = StreamSource::from_samples(&stereo_const(20, 0.5));
        let v = Voice::new(1, src, 1.0, 0.01, 1000.0); // 10-frame fade
        let mut s = shared_with(vec![v]);
        s.curve = FadeCurve::Linear;
        let mut out = vec![0.0f32; 2 * 25];
        render(&mut s, &mut out, 2);
        // frame 0: env 0.1 -> 0.05 ; frame 9: env 1.0 -> 0.5 ; frame 19 still 0.5
        assert!((out[0] - 0.05).abs() < 1e-5, "{}", out[0]);
        assert!((out[9 * 2] - 0.5).abs() < 1e-5);
        assert!((out[19 * 2] - 0.5).abs() < 1e-5);
        assert_eq!(out[20 * 2], 0.0);
        assert!(s.voices.is_empty(), "voice retired at end of data");
        assert_eq!(s.graveyard.len(), 1);
        assert!(s.status.is_empty());
    }

    #[test]
    fn crossfade_sums_to_constant_level_with_equal_power() {
        let old = StreamSource::from_samples(&stereo_const(200, 1.0));
        let new = StreamSource::from_samples(&stereo_const(200, 1.0));
        let mut s = Shared::new(1000.0);
        let mut v_old = Voice::new(1, old, 1.0, 0.0, 1000.0);
        v_old.fade_out(0.1, 1000.0); // 100 frames
        let v_new = Voice::new(2, new, 1.0, 0.1, 1000.0);
        s.voices = vec![v_old, v_new];
        let mut out = vec![0.0f32; 2 * 100];
        render(&mut s, &mut out, 2);
        for frame in 0..100 {
            let l = out[frame * 2];
            // sin^2 + cos^2 crossfade in amplitude: sum of gains ≥ 1, ≤ √2
            assert!(l >= 0.999 && l <= 1.4143, "frame {frame}: {l}");
        }
        assert_eq!(s.voices.len(), 1, "old voice finished after its fade");
        assert_eq!(s.voices[0].gen, 2);
    }

    #[test]
    fn immediate_fade_out_finishes_on_first_frame() {
        let src = StreamSource::from_samples(&stereo_const(50, 1.0));
        let mut v = Voice::new(1, src, 1.0, 0.0, 1000.0);
        v.fade_out(0.0, 1000.0);
        let mut s = shared_with(vec![v]);
        let mut out = vec![0.0f32; 2 * 4];
        render(&mut s, &mut out, 2);
        assert!(out.iter().all(|&x| x == 0.0));
        assert!(s.voices.is_empty());
    }

    #[test]
    fn routing_writes_to_chosen_channels_and_master_scales() {
        let src = StreamSource::from_samples(&stereo_const(4, 1.0));
        let v = Voice::new(1, src, 1.0, 0.0, 1000.0);
        let mut s = shared_with(vec![v]);
        s.routing = (2, 3);
        s.master = Ramp::new(0.5);
        let mut out = vec![0.0f32; 4 * 4];
        render(&mut s, &mut out, 4);
        assert_eq!(&out[0..4], &[0.0, 0.0, 0.5, 0.5]);
        // Routing to a channel the device doesn't have is dropped silently.
        let src = StreamSource::from_samples(&stereo_const(4, 1.0));
        let v = Voice::new(2, src, 1.0, 0.0, 1000.0);
        let mut s = shared_with(vec![v]);
        s.routing = (0, 7);
        let mut out = vec![0.0f32; 4 * 2];
        render(&mut s, &mut out, 2);
        assert_eq!(&out[0..2], &[1.0, 0.0]);
    }

    #[test]
    fn underrun_outputs_silence_but_keeps_voice_alive() {
        let (producer, consumer) = RingBuffer::<f32>::new(16);
        let (_btx, boundaries) = RingBuffer::<u64>::new(1);
        let src = StreamSource {
            consumer,
            boundaries,
            next_boundary: None,
            looping: Arc::new(AtomicBool::new(false)),
            eof: Arc::new(AtomicBool::new(false)),
            stop: Arc::new(AtomicBool::new(false)),
            error: Arc::new(Mutex::new(None)),
        };
        let v = Voice::new(1, src, 1.0, 0.0, 1000.0);
        let mut s = shared_with(vec![v]);
        let mut out = vec![0.0f32; 2 * 4];
        render(&mut s, &mut out, 2);
        assert!(out.iter().all(|&x| x == 0.0));
        assert_eq!(s.voices.len(), 1);
        assert_eq!(s.voices[0].underruns, 4);
        drop(producer);
    }

    /// Minimal 16-bit PCM WAV writer for the end-to-end decode tests.
    fn write_wav(path: &std::path::Path, sample_rate: u32, channels: u16, frames: usize, f: impl Fn(usize, usize) -> f32) {
        let mut data = Vec::with_capacity(frames * channels as usize * 2);
        for i in 0..frames {
            for c in 0..channels as usize {
                let v = (f(i, c).clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                data.extend_from_slice(&v.to_le_bytes());
            }
        }
        let byte_rate = sample_rate * channels as u32 * 2;
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&channels.to_le_bytes());
        out.extend_from_slice(&sample_rate.to_le_bytes());
        out.extend_from_slice(&byte_rate.to_le_bytes());
        out.extend_from_slice(&(channels * 2).to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&data);
        std::fs::write(path, out).unwrap();
    }

    fn temp_wav(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("bgmdeck-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn scan_measures_a_real_file() {
        let path = temp_wav("scan.wav");
        // 0.5 s mono at 44.1k, loud in the second half.
        write_wav(&path, 44_100, 1, 22_050, |i, _| if i < 11_025 { 0.1 } else { 0.9 });
        let info = scan_file(path.to_str().unwrap()).unwrap();
        assert!((info.duration - 0.5).abs() < 1e-3, "{}", info.duration);
        assert_eq!(info.sample_rate, 44_100);
        assert_eq!(info.channels, 1);
        assert!(!info.peaks.is_empty() && info.peaks.len() <= PEAK_BUCKETS);
        let first = info.peaks[0];
        let last = *info.peaks.last().unwrap();
        assert!(first < 0.2 && last > 0.8, "{first} {last}");
        assert!(scan_file("/nope/missing.wav").is_err());
    }

    #[test]
    fn stream_source_decodes_resamples_and_loops() {
        let path = temp_wav("loop.wav");
        // 0.25 s stereo at 44.1k: constant 0.5 left, -0.5 right.
        write_wav(&path, 44_100, 2, 11_025, |_, c| if c == 0 { 0.5 } else { -0.5 });
        let p = path.to_str().unwrap();

        // Looping: keeps delivering well past one file length, resampled to 48k.
        let looping = Arc::new(AtomicBool::new(true));
        let src = StreamSource::open(p, 48_000, Arc::clone(&looping)).unwrap();
        let mut v = Voice::new(1, src, 1.0, 0.0, 48_000.0);
        let mut s = shared_with(vec![v]);
        std::thread::sleep(Duration::from_millis(300)); // let the decoder fill the ring
        let frames = 48_000 / 2; // 0.5 s of output = two loops of the file
        let mut out = vec![0.0f32; frames * 2];
        render(&mut s, &mut out, 2);
        assert_eq!(s.voices.len(), 1, "looping voice still alive");
        assert_eq!(s.voices[0].underruns, 0, "ring never ran dry");
        let l: Vec<f32> = out.chunks(2).map(|f| f[0]).collect();
        let r: Vec<f32> = out.chunks(2).map(|f| f[1]).collect();
        assert!(l.iter().all(|&x| (x - 0.5).abs() < 0.01), "left constant across the loop seam");
        assert!(r.iter().all(|&x| (x + 0.5).abs() < 0.01));

        // Turning loop off ends the stream at the next file end.
        looping.store(false, Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(200));
        let mut out = vec![0.0f32; 48_000 * 2];
        render(&mut s, &mut out, 2);
        assert!(s.voices.is_empty(), "voice finished after the last pass");
        let nonzero = out.chunks(2).filter(|f| f[0].abs() > 0.1).count();
        assert!(nonzero > 0 && nonzero < 48_000, "played the tail then stopped: {nonzero}");

        // Non-looping from the start: exactly one pass (~0.25 s at 48k = 12 000 frames).
        let src = StreamSource::open(p, 48_000, Arc::new(AtomicBool::new(false))).unwrap();
        v = Voice::new(2, src, 1.0, 0.0, 48_000.0);
        let mut s = shared_with(vec![v]);
        std::thread::sleep(Duration::from_millis(200));
        let mut out = vec![0.0f32; 48_000 * 2];
        render(&mut s, &mut out, 2);
        let played = out.chunks(2).filter(|f| f[0].abs() > 0.1).count();
        assert!((played as i64 - 12_000).abs() < 50, "{played}");
        assert!(s.voices.is_empty());
        assert!(StreamSource::open("/nope/missing.wav", 48_000, Arc::new(AtomicBool::new(false))).is_err());
    }

    #[test]
    fn engine_slot_management_without_a_device() {
        let mut e = Engine::new();
        assert!(e.load_slot("s1", "/definitely/missing.wav", true).is_err());
        assert!(e.play("s1", 1.0, 1.0, 1.0).is_err());
        let st = e.status();
        assert!(st.voices.is_empty());
        assert_eq!(st.master, 1.0);
        e.set_master(0.5);
        e.set_duck(true, 0.2, 0.0);
        e.set_routing(2, 3);
        e.set_curve(FadeCurve::Linear);
        let s = lock_or_recover(&e.shared);
        assert_eq!(s.routing, (2, 3));
        assert_eq!(s.curve, FadeCurve::Linear);
        assert_eq!(s.duck.target, 0.2);
        assert_eq!(s.master.target, 0.5);
    }
}
