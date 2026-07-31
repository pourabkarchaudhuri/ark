# Ark v1.0.43 — Broadcast Card Redesign

Follow-up hotfix to v1.0.42. The Scheduled Broadcast cards in the Transmissions view were rendering cover art as a stark 128 px logo-banner strip at the top of each card. For events whose `og:image` is a simple product logo on solid colour (Steam Next Fest, MAGFest, Brasil Game Show / Nintendo, PAX West, …), that produced blocky product-tile cards that looked amateur. Photo-based hero images (Esports World Cup, Gamescom Opening Night Live) fared better but still made the cards uncomfortably tall.

## Fixed

- **Cover images are now atmospheric backdrops, not banners.** Each card renders the image across the entire card at 55% opacity with `saturate(0.85)` + a `0.45 → 0.92` top-to-bottom black gradient overlay + a subtle top-right radial highlight for brand-cue. Product logos become tasteful colour washes; photo heroes look cinematic; text remains fully readable regardless of image contents.
- **Broadcast cards ~35% shorter.** Removed the dedicated image row entirely. Tightened outer padding (`px-5 py-5` → `px-4 py-4`), inner gap (`gap-4` → `gap-2.5`), title size (15 px → 14 px), date size (20 px → 16 px), countdown size (17 px → 14 px), and footer padding. Cards now hold their information densely without towering above the rest of the strip.
- **Card width tightened** 280 px → 260 px; scroll step updated 296 → 276. More events fit in view before scrolling is required.

---

**Tests:** 666/666 passing. Electron and renderer typecheck clean.
**Data compatibility:** No IDB migration required. No new dependencies.
