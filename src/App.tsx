import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

interface Session {
  text: string;
  words: number;
  timestamp: string;
  wpm: number;
}

interface Stats {
  words: number;
  sessions: number;
  seconds: number;
}

type Screen = "loading" | "welcome" | "hotkey" | "test" | "main";

const GRADIENT = "linear-gradient(135deg, #60a5fa, #a855f7)";

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

  useEffect(() => {
    (async () => {
      const done = await invoke<boolean>("get_onboarding_complete");
      const saved = await invoke<string>("get_saved_hotkey");
      setHotkey(saved);
      setDisplayHotkey(saved);
      setScreen(done ? "main" : "welcome");
    })();
  }, []);

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
    e.preventDefault();
    const parts: string[] = [];
    if (e.altKey) parts.push("Alt");
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.metaKey) parts.push("Super");
    if (e.shiftKey) parts.push("Shift");
    const key = e.key;
    if (!["Alt", "Control", "Meta", "Shift"].includes(key)) {
      parts.push(key === " " ? "Space" : key);
    }
    if (parts.length > 1) {
      const combo = parts.join("+");
      setHotkey(combo);
      const display = parts
        .map((p) =>
          p === "Alt"
            ? "⌥"
            : p === "Ctrl"
              ? "⌃"
              : p === "Super"
                ? "⌘"
                : p === "Shift"
                  ? "⇧"
                  : p,
        )
        .join(" ");
      setDisplayHotkey(display);
    }
  };

  const confirmHotkey = async () => {
    await invoke("save_hotkey", { hotkey });
    await invoke("restart_app");
    setScreen("test");
  };

  const finishOnboarding = () => setScreen("main");

  const wpm =
    stats.seconds > 0 ? Math.round((stats.words / stats.seconds) * 60) : 0;
  const wpmPct = Math.min(Math.round((wpm / 200) * 100), 100);

  const timeAgo = (ts: string) => {
    const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  };

  const bg = {
    width: "100vw",
    height: "100vh",
    background: "#0c0c0c",
    fontFamily: "system-ui, sans-serif",
    color: "#f0f0f0",
    display: "flex",
    flexDirection: "column" as const,
    overflow: "hidden",
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
          padding: "2rem",
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
          onClick={() => setScreen("hotkey")}
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
          padding: "2rem",
        }}
      >
        <div style={{ fontSize: 22, fontWeight: 500 }}>Set your hotkey</div>
        <div style={{ fontSize: 13, color: "#555", textAlign: "center" }}>
          Press the key combination you want to use to start and stop recording.
        </div>
        <div
          tabIndex={0}
          onKeyDown={captureHotkey}
          style={{
            width: "100%",
            maxWidth: 280,
            height: 64,
            borderRadius: 12,
            background: "#141414",
            border: "0.5px solid #2a2a2a",
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
        <div style={{ fontSize: 11, color: "#333" }}>
          Must include a modifier key (⌥ Alt, ⌃ Ctrl, ⌘ Cmd)
        </div>
        <button
          onClick={confirmHotkey}
          disabled={!hotkey}
          style={{
            padding: "10px 32px",
            borderRadius: 10,
            border: "none",
            cursor: hotkey ? "pointer" : "not-allowed",
            background: hotkey ? GRADIENT : "#1a1a1a",
            color: hotkey ? "#fff" : "#444",
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          Confirm
        </button>
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
          padding: "2rem",
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
    <div style={bg}>
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

      <div style={{ flex: 1, overflowY: "auto", padding: "1rem 1.5rem" }}>
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
              <div style={{ display: "flex", gap: 12, marginTop: 5 }}>
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
