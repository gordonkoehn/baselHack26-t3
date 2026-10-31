# Design

OpenTwin has one design system, and every page follows it: the start page, the interview room, the debrief and the report.

- **Live system:** https://claude.ai/artifact/1gtnRf163VDRipjg3bMpAZ (tokens, components, logos, brand book)
- **In the repo:** `assets/presentations/ci/README.md` (brand book) and `assets/presentations/ci/tokens.json` (exact values); logos in `assets/presentations/logo/`
- **In code:** `code/frontend/src/app/globals.css` turns the tokens into Tailwind colours

If the system and the code disagree, the system wins; fix the token in `globals.css`, not the component.

## Colours

Use the Tailwind names, never hex in a component.

| Tailwind | Token | Use |
|---|---|---|
| `bg-background` | papier `#F5F6F5` | Page ground |
| `text-foreground` | ink `#121413` | Headlines and body |
| `bg-surface` | surface `#FDFDFC` | Cards, inputs |
| `text-muted` | ink-muted `#5E6563` | Descriptions, meta text |
| `border-line` | border-strong `#D5DAD8` | Card and input borders |
| `bg-accent` / `text-accent` | smaragd `#0F7A5C` | Primary buttons, active state, eyebrows on light |
| `bg-accent-soft` | tint `#E2F2EB` | Chips, highlighted rows |
| `bg-signal` | signal `#14A37F` | The dot: bullets, before eyebrows. Never as text on light |
| `bg-room`, `bg-room-raised`, `text-room-text`, `text-room-muted` | tinte and dark surfaces | The live interview (dark ground) |

A colour that isn't here: add it to `:root` and `@theme` in `globals.css` first, named after the system's token.

## Type

- Inter only (`font-sans`). Weights: 800 headlines, 700 card titles, labels and buttons, 400 text.
- Headlines are whole sentences with a full stop ("Your persona is ready."). Under a headline, one line in `text-muted`.
- Eyebrows and status tags in CAPITALS, letter-spaced, with a `signal` dot before them.

## Shapes and spacing

- Radii: 8px buttons, 16px cards, full round for chips and tags.
- Light cards: `bg-surface`, 1px `border-line`, soft shadow. Dark cards: `bg-room-raised` with a border, no shadow.
- One feature card in `bg-accent` per row at most.
- Focus: 2px `accent` ring with 2px offset (already global in `globals.css`).

## Voice

- Short, direct, second person. Product terms stay English: persona, twin, debrief, sprint.
- No emojis. Meaning comes from words, icons and the signal dot.
- Status is never colour alone: always a word (CONFIRMED, GUESS, ON RECORD) and, where possible, an icon or the solid/hatched mark.

## Icons and images

- Line icons, 2px stroke, round caps, 24px grid: use Lucide.
- Logo: `opentwin-logo.svg` on light, `opentwin-icon.svg` as app icon on light and dark. Never recolour or stretch.

## Checklist for a PR that changes UI

- [ ] No hex values or Tailwind palette colours (`bg-green-600`, `text-red-500`) in components
- [ ] Headlines end with a full stop; one muted line under them
- [ ] Text contrast at least 4.5:1 (`signal` and `accent-soft` are not text colours on light)
- [ ] Status has a word, not just a colour
- [ ] Looks right on the light pages and in the dark room
