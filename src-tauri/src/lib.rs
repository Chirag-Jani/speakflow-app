use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{SampleFormat, WavSpec, WavWriter};
use std::process::Command;
use std::sync::{Arc, Mutex};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_global_shortcut::ShortcutState;

const WHISPER_BIN: &str =
    "/Users/chiragjani/Documents/me/temp/wisp/whisper.cpp/build/bin/whisper-cli";
const WHISPER_MODEL: &str =
    "/Users/chiragjani/Documents/me/temp/wisp/whisper.cpp/models/ggml-base.en.bin";

#[derive(serde::Serialize, Clone)]
struct Session {
    text: String,
    words: usize,
    timestamp: String,
    wpm: u32,
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
}

#[derive(serde::Deserialize, serde::Serialize, Clone)]
struct HistoryEntry {
    text: String,
    words: usize,
    timestamp: String,
    seconds: u64,
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
    d.onboarding_complete = Some(true);
    save_data(&d);
}

#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

struct AppState {
    recording: bool,
    recording_start: Option<std::time::SystemTime>,
    stream: Option<Box<dyn StreamTrait>>,
    writer: Option<Arc<Mutex<Option<WavWriter<std::io::BufWriter<std::fs::File>>>>>>,
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
        }))
        .setup(|app| {
            let tray = TrayIconBuilder::new()
                .title("IDLE")
                .build(app)?;

            let tray_id = tray.id().clone();

            let saved_hotkey = load_data().hotkey.unwrap_or_else(|| "Alt+Space".to_string());
            app.global_shortcut().on_shortcut(saved_hotkey.as_str(), move |app, shortcut, event| {
                println!("Shortcut pressed: {}", shortcut.to_string());
                if event.state == ShortcutState::Pressed {
                    let state = app.state::<Mutex<AppState>>();
                    let mut s = state.lock().unwrap();
                    let tray = app.tray_by_id(&tray_id).unwrap();

                    if !s.recording {
                        s.recording = true;
                        s.recording_start = Some(std::time::SystemTime::now());
                        tray.set_title(Some("REC")).ok();

                        let host = cpal::default_host();
                        let device = host.default_input_device().unwrap();
                        let config = device.default_input_config().unwrap();
                        let sample_rate = config.sample_rate().0;
                        let channels = config.channels();

                        let spec = WavSpec {
                            channels,
                            sample_rate,
                            bits_per_sample: 16,
                            sample_format: SampleFormat::Int,
                        };

                        let wav_path = std::env::temp_dir().join("speakflow_rec.wav");
                        let writer = WavWriter::create(&wav_path, spec).unwrap();
                        let writer = Arc::new(Mutex::new(Some(writer)));
                        let writer_clone = writer.clone();

                        let stream = device.build_input_stream(
                            &config.into(),
                            move |data: &[f32], _| {
                                if let Some(w) = writer_clone.lock().unwrap().as_mut() {
                                    for &sample in data {
                                        let s = (sample * i16::MAX as f32) as i16;
                                        w.write_sample(s).unwrap();
                                    }
                                }
                            },
                            |e| eprintln!("Stream error: {}", e),
                            None,
                        ).unwrap();

                        stream.play().unwrap();
                        s.stream = Some(Box::new(stream));
                        s.writer = Some(writer);

                    } else {
                        s.recording = false;
                        let elapsed = s.recording_start
                            .take()
                            .and_then(|t| t.elapsed().ok())
                            .map(|d| d.as_secs())
                            .unwrap_or(0);
                        tray.set_title(Some("PROC")).ok();

                        drop(s.stream.take());
                        let writer = s.writer.take().unwrap();
                        writer.lock().unwrap().take().unwrap().finalize().unwrap();

                        let app2 = app.clone();
                        let tray_id2 = tray_id.clone();

                        std::thread::spawn(move || {
                            let wav_path = std::env::temp_dir().join("speakflow_rec.wav");
                            let output = Command::new(WHISPER_BIN)
                                .args(["-m", WHISPER_MODEL, "-f", wav_path.to_str().unwrap(), "-nt"])
                                .output()
                                .unwrap();

                            let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
                            let words = text.split_whitespace().count();
                            let timestamp = chrono::Utc::now().to_rfc3339();

                            let mut d = load_data();
                            d.words += words;
                            d.sessions += 1;
                            d.seconds += elapsed;
                            d.history.push(HistoryEntry {
                                text: text.clone(),
                                words,
                                timestamp,
                                seconds: elapsed,
                            });
                            save_data(&d);

                            let mut clipboard = arboard::Clipboard::new().unwrap();
                            clipboard.set_text(text).unwrap();

                            Command::new("osascript")
                                .args(["-e", "tell application \"System Events\" to keystroke \"v\" using command down"])
                                .output()
                                .unwrap();

                            let tray = app2.tray_by_id(&tray_id2).unwrap();
                            tray.set_title(Some("IDLE")).ok();
                        });
                    }
                }
            })?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_stats,
            get_history,
            get_onboarding_complete,
            get_saved_hotkey,
            save_hotkey,
            restart_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
