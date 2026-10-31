OpenTwin ist das Designsystem für den Basel-Hack. Es übernimmt die Gestaltung von Sprintbox AI unverändert, nur der Name ist neu. Das System ist dunkel-grün, ruhig und präzise — Smaragd auf Papier oder Tinte, eine einzige Schrift (Inter), ein Signal-Punkt als Markenzeichen. Alle Masse stammen aus dem Strategie-Deck (960 × 540 pt) und sind in px umgerechnet (pt × 4/3, Folie = 1280 × 720 px).

## Stimme und Inhalte

- **Du-Form, direkt, kurz.** «Bring dein Thema. Wir machen daraus einen Sprint.» — «Du führst. Du gibst frei. Du setzt Ziele und Leitplanken.»
- **Headlines sind ganze Sätze mit Punkt.** «Drei Ebenen Mehrwert.» «Entscheidungen dauern Wochen.» Fragen nur, wenn das Problem benannt wird: «Warum dauern Entscheidungen Wochen?»
- **Dreiklang und Kontrast.** Wiederholte Strukturen in drei Teilen: «Digital starten. Mit Agenten skalieren. Mit allen sprinten.» — «Stunden statt Wochen.» — «Heute digital, morgen mit Agents, übermorgen autonom.»
- **Gliederung mit Mittelpunkt ` · `.** «Ebene 1 · Der digitalisierte Sprint.» «LEAN CANVAS · EBENE 2 · ALS NÄCHSTES». Kein Bindestrich, kein Doppelpunkt als Trenner in Titeln.
- **Schweizer Schreibweise.** «ss» statt «ß» (regelmässig, fliessen, grösser), Guillemets «…» für Zitate, Tausender-Apostroph: `CHF 1'200`, `CHF 9'600`.
- **Englische Fachbegriffe bleiben englisch**, wo sie Produktsprache sind: Sprint, Skills, Agents, Human-in-the-Loop, Swiss & European Trusted AI. Sonst Deutsch.
- **Eyebrows sind GROSSBUCHSTABEN**, Status-Tags auch: `MVP · JETZT`, `ALS NÄCHSTES`, `ZUKUNFT`, `FERTIG`, `FREIGABE NÖTIG`.
- **Keine Emojis.** Bedeutung tragen Signal-Punkte, Icons und Wörter.
- **Bolli** ist der AI-Facilitator (Maskottchen). Er «führt», «bereitet vor», «moderiert» — der Mensch «entscheidet». Diese Rollenverteilung nie umdrehen.

## Farben

- Vier Markenfarben, so benannt: **Smaragd** `smaragd` #0F7A5C, **Signal** `signal` #14A37F, **Tinte** `tinte` #0B0F0E, **Papier** `papier` #F5F6F5. Dazu aus dem Theme `mint` #9FD8C2 und `smaragd-tief` #0B5A44.
- Zwei Themes: `light` (Papier-Grund) und `dark` (Tinte-Grund). Das Deck wechselt Folie für Folie zwischen beiden; dunkle Folien tragen Positionierung und Vision, helle Folien Details, Tabellen und Canvas.
- Setze Flächen mit `bg`, `surface`, `surface-raised`, `surface-sunken`; Text mit `ink` (Titel), `ink-body` (Fliesstext), `ink-muted` (Beschreibungen), `subtitle` (Zeile unter der Headline — grau auf hell, mint auf dunkel).
- **Smaragd ist Fläche und Akzent.** `primary` für Buttons, aktive Schritte, Feature-Karten («Wertangebot», «Compact — empfohlen»), App-Icon. Smaragd als Textfarbe nur auf hellem Grund (`eyebrow`, Hervorhebungen in Sätzen).
- **Signal ist der Punkt.** Nutze `signal` für den Punkt im Logo, vor Eyebrows, als Bullet, als Fussnoten-Marker. Auf hellem Grund nie als Text (2.95:1).
- `tint` + `on-tint` für Skill-Chips und «als nächstes»-Zustände; `warn-tint` + `on-warn` nur für «Freigabe nötig» — die einzige Warnfarbe im System. Es gibt kein Rot.
- `inverse` + `on-inverse` + `on-inverse-label` für den Callout-Balken am Folienende («WEITER ZU EBENE 2, WENN …»).
- Ganze Folien in Smaragd (Statement-Folien, Abschluss) nutzen das Bild `bg-smaragd-glow.png`; Text darauf `on-primary`.

## Typografie

- **Eine Familie: Inter** (`--font-sans`, Google Fonts, Gewichte 400 / 700 / 800). Die Corporate-ID-Folie legt fest: **800 für Headlines, 400 für Text**; Kartentitel, Labels und Buttons in 700.
- Headlines: `display` (Titel- und Schlussfolien), `title-xl` (Ebenen- und Einstiegs-Folien), `title` (Standard), `title-sm` (dichte Folien). Leicht negative Laufweite, immer mit Punkt am Ende.
- Unter jeder Headline genau eine Zeile `subtitle` in der Farbe `subtitle`.
- Fliesstext: `lead` neben grossen Headlines, `body` in Karten, `body-sm` in dichten Karten, `caption` in Tabellen.
- Labels: `eyebrow` (GROSS, 2pt gesperrt, mit Signal-Punkt davor) über Headlines; `eyebrow-sm` und `tag-sm` in Karten; `tag` für Status- und Phasen-Tags.
- Zahlen: `stat` für eine einzelne Kennzahl («2–3×»), `price` für Preise, `step-number` in Schritt-Badges (immer zweistellig: 01, 02, 03).

## Layout und Abstände

- Arbeitsfläche 16:9, `size-canvas-w` × `size-canvas-h`. Seitenrand `space-9` (dichte Folien `space-8`). Headline oben links, nie zentriert — ausser Titel-, Statement- und Schlussfolien, die zentriert sind.
- Headline-Block → Inhalt: `space-7`. Karten in Reihen von 2, 3 oder 4 mit `space-4` Abstand, gleich hoch.
- Kartenpolster: `space-5` hell, `space-6` dunkel. Tabellen- und Statuszeilen: `space-3`.
- Auf der Folie unten links optional eine Fussnote: Signal-Punkt + ein Satz, der die Folie zusammenfasst («Bolli bereitet vor. Der Mensch entscheidet.»).
- Zweispaltige Folien: links Eyebrow + Headline + Lead, rechts ein UI-Ausschnitt oder eine Kartenliste.

## Flächen, Rahmen, Schatten, Radien

- **Helle Karten:** `surface`, `radius-lg`, `shadow-card`, kein oder ein `border`-Rahmen (1px). Dichte Karten (Lean Canvas, Tests): `surface-raised` mit `border`.
- **Dunkle Karten:** `surface` (#121A18) mit `border` (#2A3532), kein Schatten. Das Theme `dark` setzt das automatisch — `shadow-card` ist dort `none`.
- **Feature-Karte:** `primary`-Fläche, Text `on-primary`, Nebentext `on-primary-muted`. Pro Reihe höchstens eine.
- Radien: `radius-sm` Buttons, `radius-row` Statuszeilen, `radius-md` Tabellenzeilen und Callouts, `radius-tile` Icon-Kacheln, `radius-lg` Karten, `radius-xl` grosse Panels, `radius-pill` Chips, Tags, Badges, Punkte.
- Dunkle Folien liegen auf einem Glow-Hintergrund (Gruppe Backgrounds): ein weicher smaragdgrüner Schein aus einer Ecke auf `tinte`. Keine anderen Verläufe.
- Fokus: 2px `focus`-Ring mit 2px Abstand.

## Logos

Drei Wege, die Box zu zeigen (Folie «Corporate ID · Logo-Varianten»). Alle SVGs sind aus der Folien-Geometrie übernommen, Text in Pfade umgewandelt.

- **A · Die Box** `sprintbox-box.svg` — abgerundete Box mit SPRINT / BOX / AI und Signal-Punkt. Das bestehende Logo, verfeinert. Auf hellem Grund. Für dunklen Grund `sprintbox-box-icon-dark.svg` (Box ohne Text, Linie Papier).
- **B · App-Icon** `sprintbox-app-icon.svg` und `sprintbox-app-lockup.svg` (Icon + Wortmarke «Sprintbox AI»). Produkt zuerst: App, Favicon, Folien-Titel. Das Icon funktioniert auf hell und dunkel.
- **C · Wortmarke** `sprintbox-wordmark.svg` — «sprintb□x.ai», die Box wird zum «o». Web zuerst. Für dunklen Grund die Box-o-Glyphe `sprintbox-box-o-glyph-dark.svg`.
- Logos nie umfärben, verzerren oder mit Effekten versehen. Mindestens die halbe Icon-Breite Freiraum rundherum.

## Ikonografie

- Lineare Icons mit 2px-Strich, runde Enden, 24px-Raster — dieselbe Familie wie Lucide (Namen in der Gruppe Icons folgen Lucide). Für neue Icons Lucide verwenden.
- Im Deck liegen sie als 256px-PNG in drei Tinten: `-white` (auf Smaragd-Kacheln und dunklen Flächen), `-emerald` (#0F7A5C, auf hellen Flächen), plus Einzelfälle `-signal`, `-mint`, `-amber` (#8A5A12, nur für «Freigabe nötig»).
- Standardform: Icon `size-icon` in einer `primary`-Kachel `size-icon-tile` mit `radius-tile`, Icon in `on-primary`. Auf hellen Listen auch frei stehend in Smaragd.
- Nie Emojis statt Icons.

## Bildwelt

- **Bolli** (`bolli-ai-facilitator.jpg`): der Roboter-Würfel mit Bildschirm-Gesicht, auf dunklem Petrol-Grund. Immer in einer Karte mit `radius-lg` und `shadow-photo`, mit dunklem Pill-Label («Bolli · AI-Facilitator»).
- **Team-Porträts** (`team-*.jpg`): Brustbild, dunkles T-Shirt, kühler Petrol-Hintergrund, 4:5. Neue Porträts im selben Licht und Hintergrund.
- Keine Stockfotos, keine generischen Büroszenen.

## Bewegung

- `intro-warum-dauern-entscheidungen.mp4` (1280 × 720, 22 s) ist die Referenz: helle Papier-Fläche, grosse schwarze Headline links, Karten mit Problemen gleiten schräg herein. Ruhige, weiche Bewegungen; keine Sprünge, kein Bounce.

## Zugänglichkeit

- Alle Textpaare oben halten 4.5:1 in beiden Themes, ausser diesen exakt aus dem Deck übernommenen: `signal` als Text auf hell (2.95:1 → nur dekorativ), `ink-faint` auf hell (2.9:1 → nur nicht-essentielle Daten), `mint` auf `primary` (3.3:1) und `on-primary-muted` (4.2:1) → nur grosse oder fette Schrift, `border-strong` als Button-Rahmen (unter 3:1).
- Status nie nur über Farbe: Status-Tags tragen immer ein Wort (FERTIG, LIVE, FREIGABE NÖTIG) und ein Icon.
