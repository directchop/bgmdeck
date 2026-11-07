//! OSC: one UDP listener for remote control (playque, TouchOSC, QLab
//! scripts, ...) and a tiny sender for state feedback.
//!
//! Incoming messages are forwarded to the webview as `osc-received`; the
//! address → action mapping lives in `src/oscReceive.ts` so it is testable
//! and shown in Settings from the same table.

use rosc::{decoder, encoder, OscMessage, OscPacket, OscType};
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, ToSocketAddrs, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::audio::lock_or_recover;

/// A local IPv4 interface.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct NetInterface {
    pub name: String,
    pub address: String,
}

fn ipv4_interfaces() -> Vec<(String, Ipv4Addr, Option<u32>)> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|i| match i.ip() {
            IpAddr::V4(ip) => Some((i.name, ip, i.index)),
            IpAddr::V6(_) => None,
        })
        .collect()
}

pub(crate) fn interface_ipv4(name: &str) -> Option<(Ipv4Addr, Option<u32>)> {
    ipv4_interfaces()
        .into_iter()
        .find(|(n, _, _)| n == name)
        .map(|(_, ip, index)| (ip, index))
}

/// One entry per interface (its first IPv4), loopback last.
pub fn list_interfaces() -> Vec<NetInterface> {
    let mut list: Vec<NetInterface> = Vec::new();
    for (name, ip, _) in ipv4_interfaces() {
        if !list.iter().any(|i| i.name == name) {
            list.push(NetInterface {
                name,
                address: ip.to_string(),
            });
        }
    }
    list.sort_by_key(|i| i.address.starts_with("127."));
    list
}

// ---------------------------------------------------------------------------
// Receive
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ReceivedArg {
    #[serde(rename = "type")]
    pub kind: String,
    pub value: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ReceivedMessage {
    pub address: String,
    pub args: Vec<ReceivedArg>,
    /// Sender "ip:port", so replies (/bgmdeck/ping) can go back.
    pub from: String,
}

fn arg_of(v: &OscType) -> ReceivedArg {
    let (kind, value) = match v {
        OscType::Int(i) => ("int", i.to_string()),
        OscType::Long(i) => ("int", i.to_string()),
        OscType::Float(f) => ("float", f.to_string()),
        OscType::Double(f) => ("float", f.to_string()),
        OscType::String(s) => ("string", s.clone()),
        OscType::Bool(b) => ("bool", b.to_string()),
        OscType::Char(c) => ("string", c.to_string()),
        other => ("other", format!("{other:?}")),
    };
    ReceivedArg {
        kind: kind.into(),
        value,
    }
}

pub fn flatten(packet: OscPacket, from: &str, out: &mut Vec<ReceivedMessage>) {
    match packet {
        OscPacket::Message(m) => out.push(ReceivedMessage {
            address: m.addr,
            args: m.args.iter().map(arg_of).collect(),
            from: from.to_string(),
        }),
        OscPacket::Bundle(b) => {
            for p in b.content {
                flatten(p, from, out);
            }
        }
    }
}

pub type OnReceive = Arc<dyn Fn(ReceivedMessage) + Send + Sync>;

struct Listener {
    port: u16,
    interface: String,
    ip: Ipv4Addr,
    stop: Arc<AtomicBool>,
    thread: std::thread::JoinHandle<()>,
}

/// Single configurable UDP listener.
pub struct OscReceiver {
    listener: Mutex<Option<Listener>>,
    on_receive: OnReceive,
}

impl OscReceiver {
    pub fn new(on_receive: OnReceive) -> Self {
        Self {
            listener: Mutex::new(None),
            on_receive,
        }
    }

    /// Listen on `port` (on `interface`, or every interface when empty), or
    /// stop listening when `port` is None. Rebinds only when something
    /// changed. Returns a user-facing error when the bind fails.
    pub fn configure(&self, port: Option<u16>, interface: &str) -> Result<(), String> {
        let interface = interface.trim().to_string();
        let want = match port {
            Some(p) if p > 0 => {
                let (ip, index) = if interface.is_empty() {
                    (Ipv4Addr::UNSPECIFIED, None)
                } else {
                    interface_ipv4(&interface).ok_or_else(|| {
                        format!("Receive interface \"{interface}\" is not connected")
                    })?
                };
                Some((p, ip, index))
            }
            _ => None,
        };
        let mut slot = lock_or_recover(&self.listener);
        if let Some(l) = slot.as_ref() {
            let same = want
                .as_ref()
                .is_some_and(|(p, ip, _)| l.port == *p && l.ip == *ip && l.interface == interface);
            if same {
                return Ok(());
            }
        }
        if let Some(old) = slot.take() {
            old.stop.store(true, Ordering::Relaxed);
            let _ = old.thread.join();
        }
        let Some((port, ip, index)) = want else {
            log::info!("OSC receive off");
            return Ok(());
        };
        let socket = bind_listener(ip, index, port).map_err(|e| {
            let on = if interface.is_empty() {
                String::new()
            } else {
                format!(" on {interface}")
            };
            format!("Can't listen on UDP port {port}{on}: {e}")
        })?;
        socket
            .set_read_timeout(Some(Duration::from_millis(100)))
            .map_err(|e| e.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        let (flag, on_receive) = (Arc::clone(&stop), Arc::clone(&self.on_receive));
        let thread = std::thread::Builder::new()
            .name("osc-recv".into())
            .spawn(move || {
                let mut buf = [0u8; 65536];
                while !flag.load(Ordering::Relaxed) {
                    let Ok((n, from)) = socket.recv_from(&mut buf) else {
                        continue;
                    };
                    let Ok((_, packet)) = decoder::decode_udp(&buf[..n]) else {
                        continue;
                    };
                    let mut messages = Vec::new();
                    flatten(packet, &from.to_string(), &mut messages);
                    for m in messages {
                        on_receive(m);
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        log::info!(
            "OSC receive on {}:{port}",
            if interface.is_empty() { "*".to_string() } else { format!("{interface} ({ip})") }
        );
        *slot = Some(Listener {
            port,
            interface,
            ip,
            stop,
            thread,
        });
        Ok(())
    }
}

fn bind_listener(ip: Ipv4Addr, index: Option<u32>, port: u16) -> std::io::Result<UdpSocket> {
    use socket2::{Domain, Protocol, Socket, Type};
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    if let Some(idx) = index.and_then(std::num::NonZeroU32::new) {
        socket.bind_device_by_index_v4(Some(idx))?;
    }
    let _ = index;
    socket.bind(&SocketAddr::from((ip, port)).into())?;
    Ok(socket.into())
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

#[derive(Deserialize, Clone, Debug)]
pub struct OscArg {
    #[serde(rename = "type")]
    pub kind: String,
    pub value: String,
}

pub fn parse_target(target: &str) -> Result<SocketAddr, String> {
    target
        .trim()
        .to_socket_addrs()
        .map_err(|e| format!("Bad OSC target \"{target}\": {e}"))?
        .find(|a| a.is_ipv4())
        .ok_or_else(|| format!("Bad OSC target \"{target}\": no IPv4 address"))
}

pub fn encode_message(address: &str, args: &[OscArg]) -> Result<Vec<u8>, String> {
    if !address.starts_with('/') {
        return Err(format!("OSC address must start with '/': {address}"));
    }
    let mut osc_args = Vec::with_capacity(args.len());
    for a in args {
        let v = match a.kind.as_str() {
            "int" => OscType::Int(
                a.value
                    .trim()
                    .parse::<i32>()
                    .map_err(|_| format!("Not an int: {}", a.value))?,
            ),
            "float" => OscType::Float(
                a.value
                    .trim()
                    .parse::<f32>()
                    .map_err(|_| format!("Not a float: {}", a.value))?,
            ),
            "bool" => OscType::Bool(a.value.trim() == "true" || a.value.trim() == "1"),
            _ => OscType::String(a.value.clone()),
        };
        osc_args.push(v);
    }
    encoder::encode(&OscPacket::Message(OscMessage {
        addr: address.to_string(),
        args: osc_args,
    }))
    .map_err(|e| format!("OSC encode error: {e:?}"))
}

/// Fire-and-forget sender sharing one socket.
pub struct OscSender {
    socket: UdpSocket,
}

impl OscSender {
    pub fn new() -> std::io::Result<Self> {
        let socket = UdpSocket::bind("0.0.0.0:0")?;
        let _ = socket.set_broadcast(true);
        Ok(Self { socket })
    }

    pub fn send(&self, target: &str, address: &str, args: &[OscArg]) -> Result<(), String> {
        let dest = parse_target(target)?;
        let bytes = encode_message(address, args)?;
        self.socket
            .send_to(&bytes, dest)
            .map(|_| ())
            .map_err(|e| format!("OSC send to {target} failed: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rosc::{OscBundle, OscTime};
    use std::sync::mpsc;

    fn free_port() -> u16 {
        UdpSocket::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    #[test]
    fn receives_messages_and_flattens_bundles() {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let receiver = OscReceiver::new(Arc::new(move |m| {
            tx.lock().unwrap().send(m).unwrap();
        }));
        let port = free_port();
        receiver.configure(Some(port), "").unwrap();

        let msg = |addr: &str, args| {
            OscPacket::Message(OscMessage {
                addr: addr.into(),
                args,
            })
        };
        let bundle = OscPacket::Bundle(OscBundle {
            timetag: OscTime {
                seconds: 0,
                fractional: 1,
            },
            content: vec![
                msg("/bgmdeck/play", vec![OscType::Int(3)]),
                msg("/bgmdeck/stop", vec![OscType::Float(2.5)]),
            ],
        });
        let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
        sender
            .send_to(&encoder::encode(&bundle).unwrap(), ("127.0.0.1", port))
            .unwrap();

        let first = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(first.address, "/bgmdeck/play");
        assert_eq!(first.args[0].kind, "int");
        assert_eq!(first.args[0].value, "3");
        assert!(first.from.starts_with("127.0.0.1:"));
        let second = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(second.address, "/bgmdeck/stop");
        assert_eq!(second.args[0].value, "2.5");

        // Reconfiguring to the same port is a no-op; turning off stops the thread.
        receiver.configure(Some(port), "").unwrap();
        receiver.configure(None, "").unwrap();
        assert!(lock_or_recover(&receiver.listener).is_none());
    }

    #[test]
    fn bind_failure_is_reported_not_fatal() {
        let holder = UdpSocket::bind("0.0.0.0:0").unwrap();
        let port = holder.local_addr().unwrap().port();
        let receiver = OscReceiver::new(Arc::new(|_| {}));
        let err = receiver.configure(Some(port), "").unwrap_err();
        assert!(err.contains(&port.to_string()), "{err}");
        assert!(receiver
            .configure(Some(port), "no-such-if0")
            .unwrap_err()
            .contains("not connected"));
    }

    #[test]
    fn encodes_typed_args_and_sends() {
        let bytes = encode_message(
            "/bgmdeck/state",
            &[
                OscArg { kind: "string".into(), value: "playing".into() },
                OscArg { kind: "int".into(), value: "2".into() },
                OscArg { kind: "float".into(), value: "1.5".into() },
            ],
        )
        .unwrap();
        let (_, packet) = decoder::decode_udp(&bytes).unwrap();
        let OscPacket::Message(m) = packet else { panic!() };
        assert_eq!(m.addr, "/bgmdeck/state");
        assert_eq!(m.args, vec![OscType::String("playing".into()), OscType::Int(2), OscType::Float(1.5)]);
        assert!(encode_message("noslash", &[]).is_err());
        assert!(encode_message("/x", &[OscArg { kind: "int".into(), value: "abc".into() }]).is_err());

        let recv = UdpSocket::bind("127.0.0.1:0").unwrap();
        recv.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let port = recv.local_addr().unwrap().port();
        let sender = OscSender::new().unwrap();
        sender.send(&format!("127.0.0.1:{port}"), "/bgmdeck/pong", &[]).unwrap();
        let mut buf = [0u8; 256];
        let (n, _) = recv.recv_from(&mut buf).unwrap();
        let (_, packet) = decoder::decode_udp(&buf[..n]).unwrap();
        let OscPacket::Message(m) = packet else { panic!() };
        assert_eq!(m.addr, "/bgmdeck/pong");
        assert!(sender.send("not a target", "/x", &[]).is_err());
    }
}
