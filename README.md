# SpeakFlow (desktop)

Tauri + React. Work in the `app/` folder.

## Development

- `npm install`
- Run the app with your usual Tauri dev flow (`devUrl` is in `src-tauri/tauri.conf.json`).

## Production DMG (macOS)

- `npm run build:dmg` — runs the Vite build and `tauri build`. The `.dmg` is under `src-tauri/target/release/bundle/dmg/`.

Ad-hoc signing (`signingIdentity: "-"`) is fine for early releases; a paid Apple Developer ID + notarization removes Gatekeeper friction for users.

## Config touchpoints

| What | Where |
|------|--------|
| App window / bundle | `src-tauri/tauri.conf.json` |
| macOS entitlements (mic, etc.) | `src-tauri/entitlements.plist` |
