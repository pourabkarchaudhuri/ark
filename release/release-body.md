## What's New in Ark v1.0.35

### Playtime no longer resets
- **Baseline + sessions** — Custom or manually entered hours are now preserved when the app tracks your game executable. Total hours = **baseline** (your past/manual hours) + **session-tracked** time.
- **Library and custom games** — Both library entries and custom games use a baseline; editing hours in My Progress and then playing with the exe tracked adds on top instead of overwriting your previous total.
- **Migration** — Existing entries without a baseline get one inferred on the next session update, so no data loss.

### Transmissions (from 1.0.34)
- **Prev/Next scroll** — Scheduled Broadcasts strip has Previous and Next buttons for event tiles.
- **Broadcast card glow** — Live and imminent event cards use a theme-aligned magenta glow; padding prevents glow clipping.
- **Event location** — Transmission cards show **city** (e.g. San Francisco, Boston) or **Online**, with MapPin/Globe icons.

### Technical
- New `hoursBaseline` field on library and custom entries; session tracker calls `updateHoursFromSessions` (baseline-preserving) instead of overwriting `hoursPlayed`.
- Optional baseline set when adding to library or custom game with initial hours (e.g. import).
