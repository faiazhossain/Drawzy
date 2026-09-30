# Drawzy

A single-event lottery checker. Guests add their ticket numbers, then tap digits
live as the announcer calls them — tickets light up, tension builds, and a
completed ticket triggers the full win moment. Everything runs client-side; each
person's tickets and draw state stay on their own device.

Built for ~150 simultaneous users at a live event. No backend, no accounts.

## Stack

- Plain HTML / CSS / vanilla JS (no build step)
- `localStorage` persistence with a 7-day expiry
- Generated sounds (Web Audio), vibration, confetti, screen wake lock
- Ticket photos can be OCR-scanned on-device (Tesseract.js from CDN — needs
  network the first time; everything else works offline)
- Service worker: network-first reloads; cache only as offline fallback
- Deploys as a static site (Vercel: import the folder, zero config)

## Structure

```
index.html   markup and screens
styles.css   all styling (mobile-first, 320px and up)
lottery.js   lottery rules only — matching, statuses, parsing
scan.js      ticket-photo OCR — format parsing, number extraction, Tesseract pipeline
effects.js   sound, haptics, confetti, wake lock
app.js       state, storage, routing, rendering
sw.js        offline cache
test/        rules tests (node --test)
```

## Changing the lottery rules

All matching behavior lives in `lottery.js` → `calculateTicketState()`.
Current rule: the announced digits spell out the winning number one digit at
a time. A ticket stays alive only while the calls match its digits in order
from the start; the first mismatch marks it **Missed**, and matching the full
length wins. E.g. ticket `123`: calls `1,2,4` → missed; `1,2,3` → won.
Adjust there — the UI picks it up.

## Local run

Any static server, e.g.:

```
python3 -m http.server 8080
```

Demo seeds for previews: `?demo` (mid-draw), `?demo=fresh`, `?demo=win`.
