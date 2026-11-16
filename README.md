# Steam Controller MIDI

Turn every input on the 2026 Steam Controller into MIDI and play Ableton Live
with it: buttons, bumpers, analog triggers, both thumbsticks, both pressure-sensitive
trackpads, the four grip buttons, the capacitive touch sensors, and motion (tilt and gyro).

It runs in the browser (Chrome or Edge on a desktop computer). Nothing to install
except a virtual MIDI port, which Live needs in order to hear the app.

> **Status:** the controller protocol is taken from SDL's open-source driver and
> covered by tests against it, but this has not yet been run against a physical
> controller. If yours isn't recognised, open **Setup → Diagnostics**, press
> **Copy diagnostics**, and open an issue with the result.

## Run it

```bash
npm install
npm run dev
```

Open the address it prints (usually http://localhost:5173) in Chrome or Edge.

To publish it as a web page instead, enable GitHub Pages for the repository
(Settings → Pages → Source: GitHub Actions) and run the **Deploy to GitHub Pages**
workflow from the Actions tab.

## Set up with Ableton Live

1. **Create a virtual MIDI port.**
   - **macOS:** open *Audio MIDI Setup* → Window → Show MIDI Studio → double-click
     *IAC Driver* → tick *Device is online*.
   - **Windows:** install [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html)
     and add a port.
2. **Quit Steam.** While Steam is running it treats the controller as a mouse and
   keyboard, which will click around in Live.
3. **Open the app, press *Connect controller*** and choose the Steam Controller in
   Chrome's dialog. Then pick your virtual port in the **MIDI output** menu.
4. **In Live:** Settings → Link, Tempo & MIDI. Find the virtual port under
   *Input* and switch on **Track** (to play instruments) and **Remote** (to map
   knobs and buttons).
5. **Map controls:** switch on **Learn** in the app, press Cmd+M (Ctrl+M on
   Windows) in Live, click a parameter in Live, then press **Send** on the
   mapping you want. Learn mode pauses the controller's own output, so a
   twitchy stick or the gyro can't grab the mapping by accident. Leave MIDI Map
   mode, switch Learn off, and play.

Keep the browser window open while you play. It can sit behind Live, but don't
minimise or close it.

## What you can map

| Input | Sends |
| --- | --- |
| A B X Y, D-pad, bumpers, stick clicks, View / Menu / Steam / Quick Access, grip buttons L4 L5 R4 R5, trackpad clicks, trigger full-pull | Note or CC, momentary or toggle |
| Stick touch, trackpad touch, grip sense (capacitive) | Note or CC, momentary or toggle |
| Triggers, stick X / Y, trackpad X / Y, trackpad pressure | CC, pitch bend, or a note fired at a threshold |
| Tilt forward/back, tilt left/right, yaw, gyro speed | CC or pitch bend, optionally only while a button is held |

Each mapping has its own channel, output range, invert, deadzone, response curve
and smoothing. Trackpad and gated mappings can hold their last value or snap
back to rest when you let go. An input can have several mappings.

The **Default** preset gives every input its own note (from C1, the first Drum
Rack pad) or CC (20-31, then 102 up) on channel 1, so it works with Live's MIDI mapping
straight away. Touch sensors and motion start switched off so they don't fire
while you're just holding the controller. Presets are saved in the browser and
can be exported and imported as files.

## Connections

- **USB cable** and the **wireless puck** are the most reliable.
- **Bluetooth** should work where the operating system exposes the controller to
  the browser, but is the least tested path.
- If the app can't open the controller directly, any controller the browser sees
  as a gamepad works in **limited mode**: sticks, triggers and standard buttons
  only, and only while the browser window is visible.

## Development

```bash
npm test        # unit tests for the protocol parser and mapping engine
npm run build   # type-check and build into dist/
```

- `src/core/` — no browser APIs: input catalog, HID report parser, mapping model,
  MIDI engine.
- `src/runtime.ts` — WebHID → engine → Web MIDI, driven by HID events so it keeps
  running in a background tab.
- `src/store.ts` — presets and connection status.
- `src/ui/` — the interface.
