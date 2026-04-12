use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{SampleFormat, WavSpec, WavWriter};
use std::process::Command;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_global_shortcut::ShortcutState;

const WHISPER_BIN: &str =
    "/Users/chiragjani/Documents/me/temp/wisp/whisper.cpp/build/bin/whisper-cli";
const WHISPER_MODEL: &str =
    "/Users/chiragjani/Documents/me/temp/wisp/whisper.cpp/models/ggml-base.en.bin";
const TRAY_ID: &str = "speakflow-tray";

#[derive(serde::Serialize, Clone)]
struct Session {
    text: String,
    words: usize,
    timestamp: String,
    wpm: u32,
    app_name: Option<String>,
}

#[derive(serde::Serialize, Clone)]
struct Stats {
    words: usize,
    sessions: usize,
    seconds: u64,
}

#[derive(serde::Deserialize, serde::Serialize, Clone, Default)]
struct PersistData {
    words: usize,
    sessions: usize,
    seconds: u64,
    history: Vec<HistoryEntry>,
    hotkey: Option<String>,
    onboarding_complete: Option<bool>,
    /// When true (default), paste after transcription. When false, clipboard only.
    #[serde(default)]
    auto_paste: Option<bool>,
}

#[derive(serde::Deserialize, serde::Serialize, Clone)]
struct HistoryEntry {
    text: String,
    words: usize,
    timestamp: String,
    seconds: u64,
    #[serde(default)]
    app_name: Option<String>,
}

fn data_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    std::path::PathBuf::from(home)
        .join(".speakflow")
        .join("data.json")
}

fn load_data() -> PersistData {
    let path = data_path();
    let Ok(content) = std::fs::read_to_string(&path) else {
        return PersistData::default();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

fn save_data(data: &PersistData) {
    let path = data_path();
    std::fs::create_dir_all(path.parent().unwrap()).ok();
    std::fs::write(path, serde_json::to_string(data).unwrap()).ok();
}

/// Trim ends and collapse whitespace / line breaks to single spaces (spoken text only).
fn normalize_transcription(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(target_os = "macos")]
fn get_frontmost_app_name() -> Option<String> {
    let output = Command::new("osascript")
        .arg("-e")
        .arg(
            r#"tell application "System Events" to get name of first application process whose frontmost is true"#,
        )
        .output()
        .ok()?;
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

#[cfg(not(target_os = "macos"))]
fn get_frontmost_app_name() -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn request_accessibility_if_needed() {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;

    extern "C" {
        fn AXIsProcessTrustedWithOptions(options: core_foundation::base::CFTypeRef) -> bool;
    }

    let key = CFString::new("AXTrustedCheckOptionPrompt");
    let val = CFBoolean::true_value();
    let dict = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), val.as_CFType())]);

    let trusted = unsafe { AXIsProcessTrustedWithOptions(dict.as_CFTypeRef()) };
    eprintln!("[SpeakFlow] AXIsProcessTrusted (with prompt) = {}", trusted);
}

#[cfg(target_os = "macos")]
fn is_speakflow_process(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("speakflow")
}

/// Bring another app forward so Cmd+V goes to the right place (packaged builds often leave SpeakFlow frontmost).
#[cfg(target_os = "macos")]
fn activate_app_by_name(name: &str) -> bool {
    let escaped = name.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(r#"tell application "{}" to activate"#, escaped);
    match Command::new("osascript").arg("-e").arg(&script).output() {
        Ok(o) if o.status.success() => {
            eprintln!("[SpeakFlow] Activated target app: {}", name);
            true
        }
        Ok(o) => {
            eprintln!(
                "[SpeakFlow] Could not activate \"{}\": {}",
                name,
                String::from_utf8_lossy(&o.stderr).trim()
            );
            false
        }
        Err(e) => {
            eprintln!("[SpeakFlow] osascript failed: {}", e);
            false
        }
    }
}

/// Cmd+V after transcription. Uses the app that was **frontmost when recording started** — not when
/// transcription finished (release builds often focus SpeakFlow by then, which used to skip paste).
#[cfg(target_os = "macos")]
fn paste_transcription(app: &tauri::AppHandle, recording_started_in: Option<String>) {
    if !load_data().auto_paste.unwrap_or(true) {
        eprintln!("[SpeakFlow] Auto-paste off — text is on the clipboard only");
        return;
    }

    fn simulate_cmd_v() {
        use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, KeyCode};
        use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

        let Ok(source) = CGEventSource::new(CGEventSourceStateID::CombinedSessionState) else {
            eprintln!("[SpeakFlow] CGEventSource failed");
            return;
        };

        let tap = CGEventTapLocation::Session;

        let Ok(v_down) = CGEvent::new_keyboard_event(source.clone(), KeyCode::ANSI_V, true) else {
            eprintln!("[SpeakFlow] CGEvent (V down) failed");
            return;
        };
        v_down.set_flags(CGEventFlags::CGEventFlagCommand);
        v_down.post(tap);

        let Ok(v_up) = CGEvent::new_keyboard_event(source, KeyCode::ANSI_V, false) else {
            eprintln!("[SpeakFlow] CGEvent (V up) failed");
            return;
        };
        v_up.set_flags(CGEventFlags::CGEventFlagCommand);
        v_up.post(tap);
    }

    // Onboarding / test: recording started with SpeakFlow focused — UI shows text; don't inject Cmd+V.
    if let Some(ref t) = recording_started_in {
        if is_speakflow_process(t) {
            eprintln!("[SpeakFlow] Recording started in SpeakFlow — skipping injected Cmd+V");
            return;
        }
    }

    // Normal case: user was in Notes, Safari, etc. — re-activate that app, then paste.
    if let Some(ref target) = recording_started_in {
        let _ = activate_app_by_name(target);
        std::thread::sleep(Duration::from_millis(220));
        if get_frontmost_app_name()
            .as_ref()
            .map(|n| is_speakflow_process(n))
            .unwrap_or(false)
        {
            eprintln!(
                "[SpeakFlow] SpeakFlow still frontmost after activate — allow Automation for SpeakFlow if macOS asked, or paste manually (⌘V)."
            );
            return;
        }
    } else if get_frontmost_app_name()
        .as_ref()
        .map(|n| is_speakflow_process(n))
        .unwrap_or(false)
    {
        eprintln!("[SpeakFlow] Frontmost is SpeakFlow and recording target unknown — skipping Cmd+V");
        return;
    }

    std::thread::sleep(Duration::from_millis(100));
    let (tx, rx) = mpsc::channel();
    let app = app.clone();
    if app
        .run_on_main_thread(move || {
            simulate_cmd_v();
            let _ = tx.send(());
        })
        .is_ok()
    {
        let _ = rx.recv();
    }
}

#[cfg(not(target_os = "macos"))]
fn paste_transcription(_app: &tauri::AppHandle, _recording_started_in: Option<String>) {
    eprintln!("[SpeakFlow] Auto-paste after transcription is only implemented on macOS");
}

fn handle_recording_toggle(app: &tauri::AppHandle) {
    let state = app.state::<Mutex<AppState>>();
    let mut s = state.lock().unwrap();
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        eprintln!("[SpeakFlow] Tray not found");
        return;
    };

    if !s.recording {
        let front = get_frontmost_app_name();
        eprintln!("[SpeakFlow] Starting recording. Frontmost app: {:?}", front);
        s.last_front_app = front;
        s.recording = true;
        s.recording_start = Some(std::time::SystemTime::now());
        tray.set_title(Some("REC")).ok();

        let host = cpal::default_host();
        let Some(device) = host.default_input_device() else {
            eprintln!("[SpeakFlow] No input device");
            s.recording = false;
            s.recording_start = None;
            tray.set_title(Some("IDLE")).ok();
            return;
        };
        let Ok(config) = device.default_input_config() else {
            eprintln!("[SpeakFlow] No input config");
            s.recording = false;
            s.recording_start = None;
            tray.set_title(Some("IDLE")).ok();
            return;
        };
        let sample_rate = config.sample_rate().0;
        let channels = config.channels() as usize;
        eprintln!(
            "[SpeakFlow] Audio in: {}Hz, {} ch → WAV mono (Whisper-friendly)",
            sample_rate, channels
        );

        // Mono WAV: whisper.cpp handles sample rate; stereo-as-interleaved was often mis-decoded → junk / "you".
        let spec = WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };

        let wav_path = std::env::temp_dir().join("speakflow_rec.wav");
        let writer = match WavWriter::create(&wav_path, spec) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[SpeakFlow] Failed to create WAV: {}", e);
                s.recording = false;
                s.recording_start = None;
                tray.set_title(Some("IDLE")).ok();
                return;
            }
        };
        let writer = Arc::new(Mutex::new(Some(writer)));
        let writer_clone = writer.clone();

        let stream = match device.build_input_stream(
            &config.into(),
            move |data: &[f32], _| {
                if let Some(w) = writer_clone.lock().unwrap().as_mut() {
                    let push = |w: &mut WavWriter<_>, v: f32| {
                        let v = v.clamp(-1.0, 1.0);
                        w.write_sample((v * i16::MAX as f32) as i16).unwrap();
                    };
                    match channels {
                        1 => {
                            for &sample in data {
                                push(w, sample);
                            }
                        }
                        2 => {
                            for chunk in data.chunks_exact(2) {
                                push(w, (chunk[0] + chunk[1]) * 0.5);
                            }
                        }
                        n if n > 2 => {
                            for frame in data.chunks_exact(n) {
                                let m: f32 = frame.iter().copied().sum::<f32>() / n as f32;
                                push(w, m);
                            }
                        }
                        _ => {}
                    }
                }
            },
            |e| eprintln!("[SpeakFlow] Stream error: {}", e),
            None,
        ) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[SpeakFlow] Failed to build input stream: {}", e);
                s.recording = false;
                s.recording_start = None;
                tray.set_title(Some("IDLE")).ok();
                return;
            }
        };

        if let Err(e) = stream.play() {
            eprintln!("[SpeakFlow] Failed to start recording: {}", e);
            s.recording = false;
            s.recording_start = None;
            tray.set_title(Some("IDLE")).ok();
            return;
        }
        s.stream = Some(Box::new(stream));
        s.writer = Some(writer);
    } else {
        s.recording = false;
        let elapsed = s
            .recording_start
            .take()
            .and_then(|t| t.elapsed().ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        eprintln!("[SpeakFlow] Stopping recording. Duration: {}s", elapsed);
        tray.set_title(Some("PROC")).ok();

        drop(s.stream.take());
        if let Some(writer) = s.writer.take() {
            if let Some(w) = writer.lock().unwrap().take() {
                w.finalize().expect("Failed to finalize WAV");
            }
        }

        let app2 = app.clone();
        let paste_target = s.last_front_app.take();

        std::thread::spawn(move || {
            let tray_idle = || {
                if let Some(tray) = app2.tray_by_id(TRAY_ID) {
                    tray.set_title(Some("IDLE")).ok();
                }
            };

            let wav_path = std::env::temp_dir().join("speakflow_rec.wav");
            let wav_meta = std::fs::metadata(&wav_path).ok().map(|m| m.len());
            eprintln!(
                "[SpeakFlow] WAV size: {:?} bytes — running whisper",
                wav_meta
            );

            let out_stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let out_base = std::env::temp_dir().join(format!("speakflow_whisper_{}", out_stamp));
            let out_txt = out_base.with_extension("txt");
            let out_base_str = match out_base.to_str() {
                Some(s) => s,
                None => {
                    eprintln!("[SpeakFlow] Bad temp path for whisper output");
                    let _ = std::fs::remove_file(&wav_path);
                    tray_idle();
                    return;
                }
            };

            let output = Command::new(WHISPER_BIN)
                .args([
                    "-m",
                    WHISPER_MODEL,
                    "-f",
                    wav_path.to_str().unwrap(),
                    "-nt",
                    "-np",
                    "-otxt",
                    "-of",
                    out_base_str,
                    "-l",
                    "en",
                    "-nth",
                    "0.82",
                ])
                .output();

            let output = match output {
                Ok(o) => o,
                Err(e) => {
                    eprintln!("[SpeakFlow] Whisper failed to run: {}", e);
                    let _ = std::fs::remove_file(&wav_path);
                    let _ = std::fs::remove_file(&out_txt);
                    tray_idle();
                    return;
                }
            };

            let _ = std::fs::remove_file(&wav_path).map_err(|e| {
                eprintln!("[SpeakFlow] Could not remove temp wav: {}", e);
            });

            if !output.status.success() {
                eprintln!("[SpeakFlow] Whisper exited with: {}", output.status);
                eprintln!(
                    "[SpeakFlow] stderr: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                let _ = std::fs::remove_file(&out_txt);
                tray_idle();
                return;
            }

            let raw = std::fs::read_to_string(&out_txt).unwrap_or_default();
            let _ = std::fs::remove_file(&out_txt);
            let text = normalize_transcription(raw.trim());
            eprintln!("[SpeakFlow] Transcribed: \"{}\"", text);

            if text.is_empty() {
                eprintln!("[SpeakFlow] Empty transcription after normalization; skipping save");
                tray_idle();
                return;
            }

            if elapsed > 300 {
                eprintln!(
                    "[SpeakFlow] Long recording ({}s); transcription may take a while",
                    elapsed
                );
            }

            let words = text.split_whitespace().count();
            let timestamp = chrono::Utc::now().to_rfc3339();

            let mut d = load_data();
            let auto_paste = d.auto_paste.unwrap_or(true);
            d.words += words;
            d.sessions += 1;
            d.seconds += elapsed;
            d.history.push(HistoryEntry {
                text: text.clone(),
                words,
                timestamp,
                seconds: elapsed,
                app_name: paste_target.clone(),
            });
            save_data(&d);

            let _ = app2.emit("transcription-result", text.clone());

            match arboard::Clipboard::new() {
                Ok(mut clipboard) => {
                    if let Err(e) = clipboard.set_text(&text) {
                        eprintln!("[SpeakFlow] Clipboard error: {}", e);
                    }
                }
                Err(e) => eprintln!("[SpeakFlow] Clipboard init error: {}", e),
            }

            if auto_paste {
                eprintln!(
                    "[SpeakFlow] Pasting (record started in: {:?})",
                    paste_target
                );
                std::thread::sleep(Duration::from_millis(80));
                paste_transcription(&app2, paste_target.clone());
            } else {
                eprintln!("[SpeakFlow] Auto-paste off; clipboard only");
            }

            tray_idle();
        });
    }
}

fn setup_recording_shortcut(app: &tauri::AppHandle, hotkey: &str) -> Result<(), String> {
    app.global_shortcut()
        .on_shortcut(hotkey, |app, shortcut, event| {
            if event.state == ShortcutState::Pressed {
                eprintln!("[SpeakFlow] Shortcut pressed: {}", shortcut);
                handle_recording_toggle(app);
            }
        })
        .map_err(|e| format!("{}", e))
}

#[tauri::command]
fn get_stats() -> Stats {
    let d = load_data();
    Stats {
        words: d.words,
        sessions: d.sessions,
        seconds: d.seconds,
    }
}

#[tauri::command]
fn get_history() -> Vec<Session> {
    let d = load_data();
    d.history
        .iter()
        .rev()
        .map(|h| {
            let wpm = if h.seconds > 0 {
                ((h.words as f64 / h.seconds as f64) * 60.0) as u32
            } else {
                0
            };
            Session {
                text: h.text.clone(),
                words: h.words,
                timestamp: h.timestamp.clone(),
                wpm,
                app_name: h.app_name.clone(),
            }
        })
        .collect()
}

#[tauri::command]
fn get_onboarding_complete() -> bool {
    load_data().onboarding_complete.unwrap_or(false)
}

#[tauri::command]
fn get_saved_hotkey() -> String {
    load_data()
        .hotkey
        .unwrap_or_else(|| "Alt+Space".to_string())
}

#[tauri::command]
fn save_hotkey(hotkey: String) {
    let mut d = load_data();
    d.hotkey = Some(hotkey);
    d.onboarding_complete = Some(false);
    save_data(&d);
}

#[tauri::command]
fn complete_onboarding() {
    let mut d = load_data();
    d.onboarding_complete = Some(true);
    save_data(&d);
}

#[tauri::command]
fn has_configured_hotkey() -> bool {
    load_data().hotkey.is_some()
}

#[tauri::command]
fn get_auto_paste() -> bool {
    load_data().auto_paste.unwrap_or(true)
}

#[tauri::command]
fn set_auto_paste(enabled: bool) {
    let mut d = load_data();
    d.auto_paste = Some(enabled);
    save_data(&d);
}

#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

#[tauri::command]
fn unregister_hotkeys(app: tauri::AppHandle) -> Result<(), String> {
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| format!("{}", e))
}

#[tauri::command]
fn register_hotkey(
    app: tauri::AppHandle,
    hotkey: String,
    preserve_onboarding: Option<bool>,
) -> Result<(), String> {
    let _ = app.global_shortcut().unregister_all();
    setup_recording_shortcut(&app, &hotkey)?;

    let mut d = load_data();
    d.hotkey = Some(hotkey);
    if !preserve_onboarding.unwrap_or(false) {
        d.onboarding_complete = Some(false);
    }
    save_data(&d);

    Ok(())
}

struct AppState {
    recording: bool,
    recording_start: Option<std::time::SystemTime>,
    stream: Option<Box<dyn StreamTrait>>,
    writer: Option<Arc<Mutex<Option<WavWriter<std::io::BufWriter<std::fs::File>>>>>>,
    /// macOS: frontmost app when recording started (for paste target)
    last_front_app: Option<String>,
}

unsafe impl Send for AppState {}
unsafe impl Sync for AppState {}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(Mutex::new(AppState {
            recording: false,
            recording_start: None,
            stream: None,
            writer: None,
            last_front_app: None,
        }))
        .setup(|app| {
            let _tray = TrayIconBuilder::with_id(TRAY_ID)
                .title("IDLE")
                .on_tray_icon_event(|tray, event| {
                    let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Down,
                        ..
                    } = event
                    else {
                        return;
                    };

                    let app = tray.app_handle();
                    let Some(window) = app.get_webview_window("main") else {
                        return;
                    };

                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        #[cfg(target_os = "macos")]
                        {
                            let _ = app.show();
                        }
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                })
                .build(app)?;

            #[cfg(target_os = "macos")]
            request_accessibility_if_needed();

            let saved_hotkey = load_data()
                .hotkey
                .unwrap_or_else(|| "Alt+Space".to_string());
            if let Err(e) = setup_recording_shortcut(app.handle(), &saved_hotkey) {
                eprintln!(
                    "[SpeakFlow] Failed to register hotkey '{}': {}",
                    saved_hotkey, e
                );
                let mut d = load_data();
                d.hotkey = None;
                d.onboarding_complete = Some(false);
                save_data(&d);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_stats,
            get_history,
            get_onboarding_complete,
            get_saved_hotkey,
            save_hotkey,
            complete_onboarding,
            has_configured_hotkey,
            unregister_hotkeys,
            register_hotkey,
            restart_app,
            get_auto_paste,
            set_auto_paste
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
