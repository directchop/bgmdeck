//! MIDI input: list ports, connect to one, forward every message to the
//! webview as `midi-message` (raw bytes). The note → pad mapping and MIDI
//! learn live in `src/midiMap.ts`.

use midir::{Ignore, MidiInput, MidiInputConnection};
use std::sync::Mutex;

use crate::audio::lock_or_recover;

pub type OnMessage = std::sync::Arc<dyn Fn(Vec<u8>) + Send + Sync>;

pub struct MidiState {
    connection: Mutex<Option<(String, MidiInputConnection<()>)>>,
    on_message: OnMessage,
}

fn new_input() -> Result<MidiInput, String> {
    let mut input = MidiInput::new("BGM Deck").map_err(|e| e.to_string())?;
    input.ignore(Ignore::SysexAndTime);
    Ok(input)
}

impl MidiState {
    pub fn new(on_message: OnMessage) -> Self {
        Self {
            connection: Mutex::new(None),
            on_message,
        }
    }

    pub fn list_inputs() -> Vec<String> {
        let Ok(input) = new_input() else {
            return Vec::new();
        };
        input
            .ports()
            .iter()
            .enumerate()
            .map(|(i, p)| {
                input
                    .port_name(p)
                    .unwrap_or_else(|_| format!("MIDI Input {}", i + 1))
            })
            .collect()
    }

    #[allow(dead_code)]
    pub fn connected_name(&self) -> Option<String> {
        lock_or_recover(&self.connection)
            .as_ref()
            .map(|(n, _)| n.clone())
    }

    /// Connect to the port called `name`, or disconnect when None.
    pub fn connect(&self, name: Option<&str>) -> Result<(), String> {
        let mut slot = lock_or_recover(&self.connection);
        if slot.as_ref().map(|(n, _)| n.as_str()) == name {
            return Ok(());
        }
        *slot = None;
        let Some(name) = name.filter(|n| !n.is_empty()) else {
            log::info!("MIDI input off");
            return Ok(());
        };
        let input = new_input()?;
        let port = input
            .ports()
            .into_iter()
            .find(|p| input.port_name(p).ok().as_deref() == Some(name))
            .ok_or_else(|| format!("MIDI input \"{name}\" is not connected"))?;
        let on_message = std::sync::Arc::clone(&self.on_message);
        let conn = input
            .connect(
                &port,
                "bgmdeck-in",
                move |_stamp, message, _| {
                    on_message(message.to_vec());
                },
                (),
            )
            .map_err(|e| format!("Could not open MIDI input \"{name}\": {e}"))?;
        log::info!("MIDI input: {name}");
        *slot = Some((name.to_string(), conn));
        Ok(())
    }
}
