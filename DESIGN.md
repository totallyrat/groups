# Groups — Design Theme: **Golden Hour**

> Your people, every day.

## 1. The idea

Groups has exactly one heartbeat: **20:00**. That's when the day's memories unlock.
So the interface *is* a sky. It sits in deep night-indigo all day, and the closer the
clock gets to 20:00, the more a warm horizon glows up from the bottom of the screen.
At 20:00 the horizon ignites and the vault opens.

Everything else falls out of that single idea:

| Concept | Visual language |
| --- | --- |
| **Night** — the app's resting state, evening use, camera-friendly | near-black indigo canvas, OLED-true |
| **Horizon** — anticipation, the countdown to 20:00 | a warm gradient band that rises as the day progresses |
| **Ignition** — memories opening, videos playing | amber → coral → magenta, the only saturated colour |
| **Gather** vs **Capture** — the two verbs of the app | Ember (amber) vs Flare (coral/magenta) |

Two verbs, two colours, one clock. That's the whole system.

## 2. Palette

Dark-first and deliberately committed — this is an app you open at night, and half of
it is a camera viewfinder. `color-scheme: dark` everywhere; no light theme.

### Ink (surfaces)
| Token | Hex | Use |
| --- | --- | --- |
| `--ink-900` | `#08070E` | page canvas, behind everything |
| `--ink-800` | `#0F0D18` | app background |
| `--ink-700` | `#16142252` | raised surface (translucent) |
| `--ink-600` | `#211E31` | cards, sheets |
| `--ink-500` | `#2C2840` | inputs, chips |
| `--hairline` | `rgba(255,255,255,.09)` | 1px borders, dividers |

### Fog (type)
| Token | Hex | Contrast on `--ink-800` |
| --- | --- | --- |
| `--fog-100` | `#F6F3FF` | 17.4:1 — headings, primary |
| `--fog-300` | `#B3ACCB` | 8.1:1 — secondary |
| `--fog-500` | `#7C7597` | 4.6:1 — tertiary / timestamps |

### Ember — *gather* (Hangout)
`--ember-1 #FFC46B` → `--ember-2 #FF8A3D`. Warm, inviting, "come outside". Owns the
Hangout button, live pings, "I'm in" states.

### Flare — *capture* (Memories)
`--flare-1 #FF5C7A` → `--flare-2 #C86DD7`. The shutter ring, the record timer, the
reel progress bar, the unlocked-vault glow.

### Aurora — *live / yes*
`--aurora #4FE6A8`. Presence dots, "3 friends are in", upload-complete ticks. Used
sparingly; it's the only cool accent.

### Dusk gradient (hero / horizon)
`#241A46` → `#6C2A63` → `#FF8A3D`, angled 180°. The horizon element interpolates its
height and opacity from the fraction of the day elapsed toward 20:00.

## 3. Type

System stack — on iPhone that's SF Pro, which makes the PWA feel native the instant
it opens.

```
font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif;
```

| Role | Size / line | Weight | Tracking |
| --- | --- | --- | --- |
| Display (countdown, "Memories open in") | 40 / 1.0 | 800 | -0.03em |
| Title (screen headers) | 26 / 1.15 | 750 | -0.02em |
| Section | 15 / 1.2 | 650 | +0.04em, uppercase |
| Body | 16 / 1.45 | 450 | 0 |
| Caption / meta | 13 / 1.3 | 500 | +0.01em |

All numerals in timers use `font-variant-numeric: tabular-nums` so the countdown
never jitters.

## 4. Shape, depth, texture

- **Radii**: cards `28px`, sheets `32px` (top corners only), chips/pills `999px`,
  video tiles `22px`. Nothing sharp except the viewfinder.
- **Spacing**: 8-pt grid → `4 / 8 / 12 / 16 / 24 / 32 / 48`.
- **Depth**: one light source, top-center. Cards are translucent
  (`backdrop-filter: blur(24px) saturate(140%)`) with a 1px hairline and a soft
  ambient shadow `0 20px 50px -20px rgba(0,0,0,.75)`.
- **Grain**: a 3%-opacity SVG turbulence overlay across the whole app. It kills the
  banding you'd otherwise get on big dark gradients on an OLED panel, and it gives the
  night a bit of film texture.
- **Glow**: interactive accents get a coloured drop shadow rather than a border —
  `box-shadow: 0 8px 30px -6px rgba(255,138,61,.55)`.

## 5. Motion

| Curve | Value | Use |
| --- | --- | --- |
| `--spring` | `cubic-bezier(.2,.9,.24,1)` 420ms | sheets, view transitions |
| `--quick` | `cubic-bezier(.3,0,.2,1)` 180ms | taps, chips, toggles |
| `--breathe` | 4s ease-in-out infinite alternate | the countdown ring, idle glow |

- Press state is always `transform: scale(.96)` + slight brightness drop. Never a
  colour swap.
- Sheets rise from the bottom with a spring and a scrim that blurs the layer beneath.
- The reel plays like a story: segmented progress bar fills left→right, tap-right to
  skip, tap-left to go back, hold to pause.
- Everything respects `prefers-reduced-motion` — animations collapse to opacity fades.

## 6. The two buttons

The bottom bar is the app. It is a floating glass dock, safe-area aware, holding:

```
        ( Hangout )              ( ◉ )
      wide ember pill      flare shutter ring
```

- **Hangout** — a wide ember-gradient pill with the app's only ambient glow. Tapping
  it raises a sheet: pick a vibe (Food / Chill / Walk / Move / Game / Now), add a
  note, send. It becomes a live "ping" card at the top of the group.
- **Record** — a 68px circular shutter with a flare-gradient ring. Tap to open the
  viewfinder; in the viewfinder it becomes the record control, and the ring doubles as
  the 3-minute progress arc, sweeping clockwise as you film.

They sit side by side, never compete: one is a rounded rectangle, one is a circle;
one is warm-orange, one is pink-magenta.

## 7. Screens

1. **Welcome** — full-bleed dusk gradient, the mark, one field (your name), one
   button. Then: create a group or paste an invite code.
2. **Group (home)** — the horizon lives at the bottom of the scroll view and grows
   through the day. Above it: live hangout pings, the member row (avatar circles with
   presence dots), and the **Vault card** — locked before 20:00 (countdown + "4 clips
   inside"), ignited after (poster frames + "Watch today").
3. **Viewfinder** — pure black, edge-to-edge preview, minimal chrome: flip camera,
   timer, shutter. A thin flare arc traces the 3-minute limit.
4. **Reel** — fullscreen player, segmented progress, author chip and shot-time in the
   top-left, download and mute on the right.
5. **Memory Lane** — a scrollable strip of past days, each a poster frame with a date.
6. **Settings** — profile, notifications, invite link, recovery phrase.

## 8. Iconography & avatars

- Icons are inline SVG, 1.75px stroke, round caps/joins, 24px box. No icon fonts.
- Avatars are **emoji on a generated gradient**, deterministic per user id — no photo
  uploads, no empty-state grey circles, and instantly recognisable in a member row.

## 9. App identity

The mark is a **circle of three dots on a golden-hour gradient** — a group, and a
shutter, and a horizon at once. It's what you'll actually see on the home screen, so
it's built as a real 1024px raster with the dusk gradient and a soft inner glow, and
the iOS splash screens use the same gradient so launch feels continuous.

## 10. Rules of thumb

1. **One accent per screen.** If the Hangout ping is live and glowing, the vault card
   is quiet.
2. **Colour means action.** Grey means information. Saturated means "you can touch
   this" or "this is happening now".
3. **The clock is always visible** somewhere — the app is about a time of day.
4. **Nothing is more than two taps deep.** Hangout: 2 taps. Record: 2 taps.
5. **Never block on the network.** Everything optimistic, everything queued.
