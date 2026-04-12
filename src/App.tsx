import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";

interface Session {
  text: string;
  words: number;
  timestamp: string;
  wpm: number;
  app_name?: string | null;
}

interface Stats {
  words: number;
  sessions: number;
  seconds: number;
}

type Screen = "loading" | "welcome" | "hotkey" | "test" | "main";

const GRADIENT = "linear-gradient(135deg, #60a5fa, #a855f7)";

/** DOM KeyboardEvent.code values that are modifier keys only (no main key). */
const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
  "MetaLeft",
  "MetaRight",
  "OSLeft",
  "OSRight",
]);

/** Map `e.code` to global-hotkey token; `"modifier"` = modifier-only; `null` = unsupported. */
function eventCodeToTauriKey(code: string): string | "modifier" | null {
  if (MODIFIER_CODES.has(code)) return "modifier";
  if (code.startsWith("Key") && code.length === 4) return code;
  if (code.startsWith("Digit")) return code;
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;

  const map: Record<string, string> = {
    Space: "Space",
    Tab: "Tab",
    Enter: "Enter",
    Backspace: "Backspace",
    Escape: "Escape",
    Delete: "Delete",
    Minus: "Minus",
    Equal: "Equal",
    BracketLeft: "BracketLeft",
    BracketRight: "BracketRight",
    Backslash: "Backslash",
    Semicolon: "Semicolon",
    Quote: "Quote",
    Comma: "Comma",
    Period: "Period",
    Slash: "Slash",
    Backquote: "Backquote",
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Insert: "Insert",
    Pause: "Pause",
    PrintScreen: "PrintScreen",
    ScrollLock: "ScrollLock",
    NumLock: "NumLock",
    CapsLock: "CapsLock",
    Numpad0: "Numpad0",
    Numpad1: "Numpad1",
    Numpad2: "Numpad2",
    Numpad3: "Numpad3",
    Numpad4: "Numpad4",
    Numpad5: "Numpad5",
    Numpad6: "Numpad6",
    Numpad7: "Numpad7",
    Numpad8: "Numpad8",
    Numpad9: "Numpad9",
    NumpadDecimal: "NumpadDecimal",
    NumpadAdd: "NumpadAdd",
    NumpadSubtract: "NumpadSubtract",
    NumpadMultiply: "NumpadMultiply",
    NumpadDivide: "NumpadDivide",
    NumpadEnter: "NumpadEnter",
    NumpadEqual: "NumpadEqual",
    AudioVolumeMute: "AudioVolumeMute",
    AudioVolumeDown: "AudioVolumeDown",
    AudioVolumeUp: "AudioVolumeUp",
    MediaTrackNext: "MediaTrackNext",
    MediaTrackPrevious: "MediaTrackPrevious",
    MediaStop: "MediaStop",
    MediaPlayPause: "MediaPlayPause",
  };
  if (map[code]) return map[code];
  return null;
}

/** Letters, top-row digits, and numpad digits need at least one modifier (Shift counts). */
function needsModifierForMainKey(main: string): boolean {
  return (
    /^Key[A-Z]$/i.test(main) ||
    /^Digit\d$/i.test(main) ||
    /^Numpad[0-9]$/i.test(main)
  );
}

function formatPart(p: string): string {
  const t = p.trim();
  const u = t.toUpperCase();
  if (u === "ALT" || u === "OPTION") return "⌥";
  if (u === "CTRL" || u === "CONTROL") return "⌃";
  if (u === "SUPER" || u === "CMD" || u === "COMMAND") return "⌘";
  if (u === "SHIFT") return "⇧";
  if (/^KEY([A-Z])$/.test(u)) return u.slice(3);
  {
    const dm = u.match(/^DIGIT(\d)$/);
    if (dm) return dm[1];
  }
  if (u === "SPACE") return "Space";
  if (u === "ESCAPE" || u === "ESC") return "Esc";
  if (/^[A-Z]$/.test(u)) return u;
  if (/^\d$/.test(t)) return t;
  const arrows: Record<string, string> = {
    ARROWUP: "↑",
    ARROWDOWN: "↓",
    ARROWLEFT: "←",
    ARROWRIGHT: "→",
  };
  if (arrows[u]) return arrows[u];
  {
    const nm = u.match(/^NUMPAD(\d)$/);
    if (nm) return `Num ${nm[1]}`;
  }
  return t;
}

function formatDisplay(raw: string): string {
  return raw.split("+").map(formatPart).join(" ");
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [hotkey, setHotkey] = useState("");
  const [displayHotkey, setDisplayHotkey] = useState("");
  const [testResult, setTestResult] = useState("");
  const [stats, setStats] = useState<Stats>({
    words: 0,
    sessions: 0,
    seconds: 0,
  });
  const [history, setHistory] = useState<Session[]>([]);
  /** After saving hotkey: onboarding → test, main settings → main */
  const [hotkeyReturnTo, setHotkeyReturnTo] = useState<"test" | "main">("test");
  const [hotkeyError, setHotkeyError] = useState("");
  const hotkeyCaptureRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      const done = await invoke<boolean>("get_onboarding_complete");
      const saved = await invoke<string>("get_saved_hotkey");
      const hasHotkey = await invoke<boolean>("has_configured_hotkey");
      setHotkey(saved);
      setDisplayHotkey(formatDisplay(saved));
      if (done) setScreen("main");
      else if (hasHotkey) setScreen("test");
      else setScreen("welcome");
    })();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>("transcription-result", (event) => {
      setTestResult(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (screen === "hotkey") {
      setHotkeyError("");
      queueMicrotask(() => hotkeyCaptureRef.current?.focus());
    }
  }, [screen]);

  /** Global shortcuts steal key events from the webview — unregister while editing. */
  useEffect(() => {
    if (screen !== "hotkey") return;
    void invoke("unregister_hotkeys").catch(() => {});
    return () => {
      void (async () => {
        try {
          const saved = await invoke<string>("get_saved_hotkey");
          await invoke("register_hotkey", {
            hotkey: saved,
            preserve_onboarding: true,
          });
        } catch (e) {
          console.error(e);
        }
      })();
    };
  }, [screen]);

  useEffect(() => {
    if (screen !== "main") return;
    const load = async () => {
      const s = await invoke<Stats>("get_stats");
      const h = await invoke<Session[]>("get_history");
      setStats(s);
      setHistory(h);
    };
    load();
    const interval = setInterval(load, 2000);
    return () => clearInterval(interval);
  }, [screen]);

  const captureHotkey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setHotkey("");
      setDisplayHotkey("");
      setHotkeyError("");
      return;
    }
    if (e.repeat) return;
    e.preventDefault();

    const main = eventCodeToTauriKey(e.code);
    if (main === "modifier") {
      setHotkeyError(
        "Add a main key (Space, letter, F-key, etc.). Modifier keys alone can't be a shortcut.",
      );
      return;
    }
    if (main === null) {
      setHotkeyError("This key isn't supported as a global shortcut.");
      return;
    }

    const parts: string[] = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.metaKey) parts.push("Super");
    if (e.shiftKey) parts.push("Shift");

    if (needsModifierForMainKey(main) && parts.length === 0) {
      setHotkeyError(
        "Letters and numbers need a modifier — e.g. ⌥+1 or ⌃+A (Shift counts).",
      );
      return;
    }

    const combo = parts.length > 0 ? `${parts.join("+")}+${main}` : main;
    setHotkeyError("");
    setHotkey(combo);
    setDisplayHotkey(formatDisplay(combo));
  };

  const confirmHotkey = async () => {
    try {
      await invoke("register_hotkey", {
        hotkey,
        preserve_onboarding: hotkeyReturnTo === "main",
      });
      setScreen(hotkeyReturnTo);
    } catch (e) {
      console.error("Failed to register hotkey:", e);
    }
  };

  const openHotkeySettings = async () => {
    const saved = await invoke<string>("get_saved_hotkey");
    setHotkey(saved);
    setDisplayHotkey(formatDisplay(saved));
    setHotkeyError("");
    setHotkeyReturnTo("main");
    setScreen("hotkey");
  };

  const finishOnboarding = async () => {
    await invoke("complete_onboarding");
    setScreen("main");
  };

  const wpm =
    stats.seconds > 0 ? Math.round((stats.words / stats.seconds) * 60) : 0;
  const wpmPct = Math.min(Math.round((wpm / 200) * 100), 100);

  const timeAgo = (ts: string) => {
    const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  };

  const bg: React.CSSProperties = {
    width: "100%",
    height: "100%",
    maxHeight: "100%",
    margin: 0,
    boxSizing: "border-box",
    background: "#0c0c0c",
    fontFamily: "system-ui, sans-serif",
    color: "#f0f0f0",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    minHeight: 0,
  };

  // LOADING
  if (screen === "loading")
    return (
      <div style={{ ...bg, alignItems: "center", justifyContent: "center" }}>
        <div
          style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: GRADIENT,
          }}
        />
      </div>
    );

  // WELCOME
  if (screen === "welcome")
    return (
      <div
        style={{
          ...bg,
          alignItems: "center",
          justifyContent: "center",
          gap: 24,
          padding: "1.5rem",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: 20,
            background: "#141414",
            border: "0.5px solid #2a2a2a",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: "50%",
              background: GRADIENT,
            }}
          />
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 28, fontWeight: 500, marginBottom: 8 }}>
            SpeakFlow
          </div>
          <div style={{ fontSize: 14, color: "#555", lineHeight: 1.6 }}>
            Voice to text. Instant. Local.
            <br />
            No cloud. No subscription. Just speak.
          </div>
        </div>
        <button
          onClick={() => {
            setHotkeyReturnTo("test");
            setScreen("hotkey");
          }}
          style={{
            marginTop: 8,
            padding: "10px 32px",
            borderRadius: 10,
            border: "none",
            cursor: "pointer",
            background: GRADIENT,
            color: "#fff",
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          Get Started
        </button>
      </div>
    );

  // HOTKEY
  if (screen === "hotkey")
    return (
      <div
        style={{
          ...bg,
          alignItems: "center",
          justifyContent: "center",
          gap: 24,
          padding: "1.5rem",
          flexShrink: 0,
        }}
      >
        <div style={{ fontSize: 22, fontWeight: 500 }}>
          {hotkeyReturnTo === "main" ? "Change hotkey" : "Set your hotkey"}
        </div>
        <div style={{ fontSize: 13, color: "#555", textAlign: "center" }}>
          Press the key combination you want to use to start and stop recording.
        </div>
        <div
          ref={hotkeyCaptureRef}
          tabIndex={0}
          autoFocus
          onClick={(e) => e.currentTarget.focus()}
          onKeyDown={captureHotkey}
          style={{
            width: "100%",
            maxWidth: 280,
            height: 64,
            borderRadius: 12,
            background: "#141414",
            border: hotkeyError
              ? "0.5px solid #5c2a2a"
              : "0.5px solid #2a2a2a",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: displayHotkey ? 22 : 14,
            color: displayHotkey ? "#f0f0f0" : "#444",
            cursor: "text",
            outline: "none",
            userSelect: "none",
          }}
        >
          {displayHotkey || "Click here and press keys"}
        </div>
        {hotkeyError ? (
          <div
            style={{
              fontSize: 12,
              color: "#c97a7a",
              textAlign: "center",
              maxWidth: 320,
            }}
          >
            {hotkeyError}
          </div>
        ) : null}
        <div style={{ fontSize: 11, color: "#333", textAlign: "center" }}>
          Letters and numbers need a modifier (⌥ ⌃ ⌘ ⇧). F-keys, Space, arrows,
          etc. can be used alone. Press Esc to clear.
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {hotkeyReturnTo === "main" && (
            <button
              type="button"
              onClick={() => setScreen("main")}
              style={{
                padding: "10px 20px",
                borderRadius: 10,
                border: "0.5px solid #2a2a2a",
                cursor: "pointer",
                background: "#141414",
                color: "#888",
                fontSize: 14,
                fontWeight: 500,
              }}
            >
              Cancel
            </button>
          )}
          <button
            onClick={confirmHotkey}
            disabled={!hotkey || !!hotkeyError}
            style={{
              padding: "10px 32px",
              borderRadius: 10,
              border: "none",
              cursor: hotkey && !hotkeyError ? "pointer" : "not-allowed",
              background: hotkey && !hotkeyError ? GRADIENT : "#1a1a1a",
              color: hotkey && !hotkeyError ? "#fff" : "#444",
              fontSize: 14,
              fontWeight: 500,
            }}
          >
            Save
          </button>
        </div>
      </div>
    );

  // TEST
  if (screen === "test")
    return (
      <div
        style={{
          ...bg,
          alignItems: "center",
          justifyContent: "center",
          gap: 24,
          padding: "1.5rem",
          flexShrink: 0,
        }}
      >
        <div style={{ fontSize: 22, fontWeight: 500 }}>Try it out</div>
        <div style={{ fontSize: 13, color: "#555", textAlign: "center" }}>
          Press <span style={{ color: "#a855f7" }}>{displayHotkey}</span> and
          speak something.
          <br />
          Press it again to stop.
        </div>
        <div
          style={{
            width: "100%",
            maxWidth: 320,
            minHeight: 80,
            borderRadius: 12,
            background: "#141414",
            border: "0.5px solid #2a2a2a",
            padding: "1rem",
            fontSize: 13,
            color: testResult ? "#d0d0d0" : "#333",
            lineHeight: 1.6,
          }}
        >
          {testResult || "Your transcription will appear here..."}
        </div>
        <button
          onClick={finishOnboarding}
          style={{
            padding: "10px 32px",
            borderRadius: 10,
            border: "none",
            cursor: "pointer",
            background: GRADIENT,
            color: "#fff",
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          Looks good, let's go →
        </button>
      </div>
    );

  // MAIN
  return (
    <div style={{ ...bg, minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "1rem 1.5rem",
          borderBottom: "0.5px solid #1e1e1e",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: GRADIENT,
            }}
          />
          <span style={{ fontSize: 15, fontWeight: 500 }}>SpeakFlow</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            type="button"
            onClick={openHotkeySettings}
            style={{
              padding: "6px 12px",
              borderRadius: 8,
              border: "0.5px solid #2a2a2a",
              cursor: "pointer",
              background: "#141414",
              color: "#888",
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            Change hotkey
          </button>
          <span
            style={{
              fontSize: 11,
              padding: "3px 10px",
              borderRadius: 99,
              background: "#1a1a1a",
              color: "#555",
              border: "0.5px solid #2a2a2a",
            }}
          >
            IDLE
          </span>
        </div>
      </div>

      <div
        style={{
          padding: "1.25rem 1.5rem",
          borderBottom: "0.5px solid #1e1e1e",
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: "#444",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            marginBottom: 10,
          }}
        >
          Today
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0,1fr))",
            gap: 8,
          }}
        >
          {[
            { val: stats.words.toLocaleString(), label: "Words spoken" },
            { val: wpm, label: "WPM avg" },
            { val: stats.sessions, label: "Sessions" },
          ].map((s) => (
            <div
              key={s.label}
              style={{
                background: "#141414",
                border: "0.5px solid #1e1e1e",
                borderRadius: 10,
                padding: "0.875rem",
              }}
            >
              <div
                style={{
                  fontSize: 24,
                  fontWeight: 500,
                  background: GRADIENT,
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                }}
              >
                {s.val}
              </div>
              <div style={{ fontSize: 11, color: "#555", marginTop: 3 }}>
                {s.label}
              </div>
            </div>
          ))}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 12,
          }}
        >
          <span style={{ fontSize: 11, color: "#444", whiteSpace: "nowrap" }}>
            Speed
          </span>
          <div
            style={{
              flex: 1,
              height: 3,
              background: "#1e1e1e",
              borderRadius: 99,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${wpmPct}%`,
                background: GRADIENT,
                borderRadius: 99,
                transition: "width 0.5s ease",
              }}
            />
          </div>
          <span style={{ fontSize: 11, color: "#444", whiteSpace: "nowrap" }}>
            {wpm} / 200 wpm
          </span>
        </div>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          overflowX: "hidden",
          padding: "1rem 1.5rem",
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: "#444",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            marginBottom: 12,
          }}
        >
          Recent transcriptions
        </div>
        {history.length === 0 ? (
          <div style={{ fontSize: 13, color: "#333", paddingTop: "1rem" }}>
            No transcriptions yet. Press {displayHotkey} to start.
          </div>
        ) : (
          history.slice(0, 20).map((h, i) => (
            <div
              key={i}
              style={{
                paddingBottom: "0.875rem",
                marginBottom: "0.875rem",
                borderBottom:
                  i < history.length - 1 ? "0.5px solid #1a1a1a" : "none",
              }}
            >
              <div style={{ fontSize: 13, color: "#c0c0c0", lineHeight: 1.6 }}>
                {h.text}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 5 }}>
                {h.app_name ? (
                  <span style={{ fontSize: 11, color: "#5a5a5a" }} title={h.app_name}>
                    {h.app_name}
                  </span>
                ) : null}
                <span style={{ fontSize: 11, color: "#3a3a3a" }}>
                  {timeAgo(h.timestamp)}
                </span>
                <span style={{ fontSize: 11, color: "#3a3a3a" }}>
                  {h.words} words
                </span>
                <span style={{ fontSize: 11, color: "#3a3a3a" }}>
                  {h.wpm} wpm
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0.75rem 1.5rem",
          borderTop: "0.5px solid #1e1e1e",
          background: "#080808",
        }}
      >
        <span style={{ fontSize: 12, color: "#444" }}>Hotkey to record</span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 500,
            color: "#888",
            background: "#141414",
            border: "0.5px solid #2a2a2a",
            borderRadius: 6,
            padding: "3px 8px",
          }}
        >
          {displayHotkey}
        </span>
      </div>
    </div>
  );
}
