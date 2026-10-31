# OpenTwin – Vorlage für die Tafel

Arbeitsstand: 31.10.2026. Ziel: Das Team versteht in einer Minute, was bereits funktioniert und was noch geprüft wird.

## 1. Hauptfluss: so auf die Tafel zeichnen

Den vorhandenen Titel **Context** behalten. Darunter diesen Ablauf ergänzen:

```text
INPUT                         SOURCE CONTEXT                 PERSONA

Interview guide ─┐
Transcript ──────┼──► Text + title + source kind ──► OpenAI ──► Name / summary
PDF / Text / CSV ┘           ▲                               Jobs / pains / objections
                            │                                        │
                      PDF → extract text                             ▼
                                                          Quote / source matching
                                                                     │
                                    ┌────────────────────────────────┴─────────┐
                                    ▼                                          ▼
                            Source-backed                                 Assumption
                            quote + source                                labelled guess
                                    │                                          │
                                    └────────────────┬─────────────────────────┘
                                                     ▼
                                              Upstash storage
                                                     ▼
                                              Simple persona UI
```

**Was in die Kästen gehört:**

- **Input:** Interviewleitfaden, vorhandene Transkripte, PDF oder Textdateien.
- **Source context:** mehrere Quellen mit Titel, Typ und Text; Text ist bearbeitbar.
- **Persona:** Profil sowie Jobs, Pains und Einwände.
- **Source-backed:** Aussage mit passender Textstelle und Quellenreferenz.
- **Assumption / guess:** Annahme ohne behaupteten Quellenbeleg.
- **Storage + UI:** Persona speichern, wieder abrufen und übersichtlich anzeigen.

## 2. Zwei Beschriftungen am bestehenden Board präzisieren

- `Context.md` mit **planned / concept** markieren. Im geprüften Produktfluss wird der Quellenkontext als Text/JSON verarbeitet; eine automatisch erzeugte Markdown-Datei ist dort nicht vorgesehen.
- Bei Miro **export / pasted text** ergänzen. Der aktuelle Weg ist ein Export oder eingefügter Text, kein direkter Miro-Anschluss.
- Beim Prototyp **description / exported text** ergänzen. Live-Screen-Verstehen folgt später.

Synthetische Interviewbeispiele deutlich als **synthetic demo data** beschriften. Ein passendes Zitat belegt die Textstelle in einer gelieferten Quelle; seine fachliche Aussage bewertet weiterhin das Team.

## 3. Rechts daneben: Status in drei Farben

| Farbe | Überschrift | Inhalt zum Aufschreiben |
|---|---|---|
| Grün | Implemented + checked | Quellenliste; Text-/PDF-Import; Persona; Belege/Annahmen; Speicherung; Eingabe- und Fehlerzustände |
| Gelb | Final verification | neuester kombinierter Commit; Nachtest des PDF-Sonderfalls; zwei echte lokale Probeläufe; Backup-Video |
| Blau | Next | Voice-Pilot vervollständigen → Gesprächsspeicherung → Debrief → Avatar / Screen Awareness |

**Kleine Prüfzeile unter dem Board:**

> Reviewed baseline: 61 backend tests + 15 browser checks passed.

Die Browserchecks liefen mit kontrollierten API-Antworten. Echte OpenAI-/Upstash-Aufrufe wurden separat auf Johans Rechner geprüft. Für den neuesten kombinierten Stand müssen Commit und Probelauf eindeutig zusammenpassen.

## 4. Verbindlicher Umfang bis 10:00

1. Quellen einfügen oder Dateien hinzufügen.
2. PDF-Text extrahieren und als normale Quelle bearbeiten.
3. Persona erzeugen und Belege/Annahmen zeigen.
4. Speicherung und einen verständlichen Fehlerfall zeigen.
5. Den finalen lokalen Ablauf zweimal durchspielen und ein Backup aufnehmen.

Voice bleibt ein zusätzlicher Prototyp. Der bisherige Realtime-Pilot belegt die Verbindung und Antworten auf getippte Fragen; echte Mikrofoneingabe, Unterbrechung und längere Gespräche sind noch offen.

## 5. Team-Briefing – etwa 30 Sekunden

> Wir können aus mehreren Quellen, einschliesslich PDFs, eine synthetische Interview-Persona erzeugen. Die Oberfläche zeigt Jobs, Pains und Einwände und trennt Aussagen mit Quellenzitaten von Annahmen. Die Persona wird gespeichert und kann wieder abgerufen werden. Die geprüfte Basis besteht 61 Backendtests und 15 Browserchecks. Wir prüfen gerade den letzten kombinierten Stand und die finalen Probeläufe. Danach folgen Voice, Gesprächsspeicherung und Debrief.

## 6. Aktuelle Arbeitsteilung

- **Johan / RusticCondor:** Produktfunktionen, Integration und echte lokale Probeläufe.
- **GreenCastle:** Leitung, Aufgabenabstimmung, unabhängiges Review und Tests.
- **Coding-Helfer:** Persona-Verhaltensprompt und Offline-Tests (#29), anschliessend unabhängiges Patch-Review. Patch erstellt und unabhängig geprüft; finaler Build und Übergabe laufen.
