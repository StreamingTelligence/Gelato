# XIAO ESP32S3 Sense camera device

This headless ESP32-S3 device implements Gelato v1 directly. USB is used only
to install or restore firmware. First-time Wi-Fi configuration and Gelato
pairing happen over the board's temporary WPA2 access point; subsequent
control and JPEG uploads use authenticated outbound WSS. The board needs 2.4
GHz Wi-Fi and a camera Sense expansion board.

## Install

1. Verify the board is a Seeed XIAO ESP32S3 Sense (8 MB Flash and PSRAM) or
   uses its exact camera pinout. The firmware auto-detects the attached camera
   sensor. Do not flash it to another ESP32-S3 camera board without adapting
   `initCamera()`.
2. Install `arduino-cli`, the Espressif ESP32 core 3.3.12, and ArduinoJson
   7.4.2 plus ArduinoWebsockets 0.5.4:

   ```sh
   arduino-cli core update-index --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
   arduino-cli core install esp32:esp32@3.3.12 --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
   arduino-cli lib install ArduinoJson@7.4.2 ArduinoWebsockets@0.5.4
   ```

3. `gelato_trust_anchor.h` contains the public ISRG Root X1 CA. If your
   Controller's HTTPS certificate has a different issuer, replace the PEM
   with that issuer's trusted CA before flashing. Do not disable TLS
   validation; the device connection credential travels over WSS.
4. Run `bash device-sdk/esp32s3-xiao-camera/install.sh /dev/cu.usbmodemXXXX`.
   By default the installer makes a different random WPA2 setup password for
   each board. Set `GELATO_SETUP_PASSWORD` in the installer's environment to
   use a specific 8–63 character ASCII alphanumeric password instead. Save
   it privately; do not commit it. Build output and the password are not
   placed in this repository. The installer does not enter Wi-Fi credentials
   or pair over USB.

The installer does not erase NVS, so reflashing this firmware preserves an
existing Gelato pairing. To transfer ownership, revoke the old device pairing from the
Controller and re-pair through the local setup page. Existing firmware can be
restored from a full Flash backup when one is available.

## Wireless first pairing (no display)

1. Power the board, then join its `Gelato-Camera-XXXXXX` Wi-Fi using the
   installer-provided password. Open `http://192.168.4.1/` on the same phone
   or laptop. The rapidly blinking LED means the local setup page is open.
2. Confirm the page reports `Camera: ready`. This is the offline, pre-pair
   hardware checklist. Camera failure blocks first pairing and includes a
   repair hint; no server request is made automatically.
3. Create a one-use pairing code in Gelato Controller. On the local page,
   enter the 2.4 GHz Wi-Fi name/password, Controller HTTPS root origin and
   code, then choose “Configure wirelessly”. Only this explicit action
   starts pairing. The board leaves setup Wi-Fi, joins your Wi-Fi, validates
   Controller TLS, and sends `pairing.request` over WSS. It saves the issued
   device connection credential to NVS and uses `session.hello` on later connections.
4. Rejoin normal Wi-Fi to check the device pool. If Wi-Fi fails or the code is
   rejected, the setup AP reopens; enter a fresh code. Pairing and control
   consent are distinct. Remote camera access starts **off**.
5. After pairing, rejoin the same temporary `Gelato-Camera-XXXXXX` Wi-Fi and
   open `http://192.168.4.1/` again. Check “Allow remote camera capture” and
   optionally “Continuously send camera preview” for an outbound ~1 fps JPEG
   stream. The latter is a separate, initially-off local opt-in. Save the
   settings. This local access window lasts 10 minutes after pairing or power-on,
   and closes shortly after saving. To change consent or pause/resume the
   Controller connection later, power-cycle the board and use this page again.
   The page is reachable only over the device's temporary WPA2 Wi-Fi, not
   from the ordinary LAN. No physical button is required.

If accessible, the board's BOOT button remains an optional shortcut: a 1–3
second press pauses or resumes the Controller connection without deleting
pairing (one short LED blip every five seconds = disconnected by owner). A 3–8
second press toggles remote camera access (solid LED = connected and allowed).
Two short LED flashes per second indicate an active camera preview stream.
An 8+ second press reopens the setup page and pauses control without deleting
pairing. A short press publishes one JPEG observation only while control is
allowed.
With control paused, the device remains paired and connected, but its
`camera.capture@1` command and media streams are denied.

`device.describe@1` reports hardware/consent state. `camera.capture@1` returns
a completed authenticated `photo` stream reference, not base64 in JSON. The
board also accepts `reply.deliver`, makes its latest text available on the
password-protected local setup page, saves a 2 KB recovery preview in NVS,
then sends `reply.ack`. It has no speaker or display, so it does not pretend
to present text in real time.

With local preview opt-in enabled, the device autonomously sends sequential JPEG
frames over authenticated WSS while both the Controller connection and remote
camera access remain allowed. The stream stops when either is disabled; the
Controller treats these frames as transient observations, not a recording.
Effective frame rate depends on Wi-Fi, capture time and board temperature.
One-shot `camera.capture@1` and the local short press still upload a separate
completed photograph. No test data, device credentials, photographs, or
diagnostic backups belong in this repo.
