# 🛣️ Verkehrs-Sandbox (traffic-sandbox)

Build your own road system and manage dense traffic. A browser sandbox game (German UI):
unlimited road building through an endless, procedurally generated landscape, with a live
traffic simulation that shows whether your design flows or produces jams and accidents.

## Starten

Kein Build nötig – einfach `index.html` im Browser öffnen.
(Alternativ lokal servieren, z. B. `python3 -m http.server` und `http://localhost:8000` aufrufen.)

## Features

- **Unendliche Zufallswelt** mit Wiesen, Wäldern, Seen, Flüssen, Bergen und Orten (je Seed reproduzierbar).
- **Straßenbau** mit Ketten-Bauweise, Kurven (`C`), Winkel-Einrasten (`Shift`), Snapping an Straßen & Kreuzungen.
- **Straßentypen**: Stadt-, Land-, Haupt-, Schnellstraße, Autobahn, Einbahnstraße, Auffahrt – oder frei
  einstellbar (Spuren je Richtung, Tempolimit, Mittelstreifen).
- **Kreuzungen** entstehen automatisch beim Überschneiden; Steuerung per Vorfahrtsschildern,
  Stoppschildern, Allseitig-Stopp oder **adaptiver Ampel** (Zeitlücken-Steuerung).
- **Kreisverkehre** (ein- oder zweispurig), **Linksabbiegespuren**, **Brücken** und **Tunnel**
  (kreuzungsfreie Über-/Unterführungen). Über Wasser und durch Fels entstehen automatisch Brücken/Tunnel.
- **Verkehrssimulation**: Autos & LKW mit Intelligent-Driver-Model, Spurwechsel (MOBIL-artig,
  Rechtsfahrgebot), Vorfahrtsregeln inkl. rechts-vor-links, Lückenannahme mit Ungeduld,
  stauabhängige Routenwahl (Dijkstra), Rückstau und „Kreuzung nicht blockieren“.
- **Unfälle** entstehen emergent aus Fahrfehlern, zu kleinen Lücken und Konflikten in der Kreuzung –
  schnelle ungeregelte Kreuzungen sind gefährlicher als Ampeln oder Kreisverkehre.
- **Auswertung**: Verkehrsnote A–F, Verkehrsfluss, Stau-Anteil, Durchsatz, Unfälle pro 1000 Fahrten,
  Verlaufsdiagramm, Brennpunkte, Fluss-Ansicht (grün → rot) und Info-Werkzeug je Straße/Kreuzung.
- Speichern/Laden im Browser (localStorage, Auto-Save).

## Steuerung

| Taste | Funktion |
|---|---|
| `1`–`3` | Straße / Brücke / Tunnel bauen |
| `4` | Kreuzungssteuerung (Vorfahrt, Stopp, Ampel, Hauptrichtung) |
| `5` | Kreisverkehr |
| `6` | Linksabbiegespur |
| `7` | Umbauen (Typ übernehmen, Einbahnstraße umdrehen) |
| `8` / `X` | Abriss |
| `9` / `Q` | Info |
| `C` | Kurvenmodus |
| Ziehen / WASD / Mausrad | Karte verschieben / zoomen |
| Leertaste | Pause |
| `F` | Fluss-Ansicht |

## Code-Struktur

- `js/util.js` – Mathe, Rauschen, Bezier, Heap
- `js/terrain.js` – prozedurale Landschaft, Chunks, Orte
- `js/network.js` – Straßennetz, Spuren, Abbiegebeziehungen, Konflikte, Bauoperationen
- `js/sim.js` – Fahrzeuge, IDM, Spurwechsel, Vorfahrt, Ampeln, Routing, Unfälle, Statistik
- `js/render.js` – Canvas-Darstellung
- `js/ui.js` – Werkzeuge, Eingabe, Panels
- `js/main.js` – Hauptschleife, Speichern/Laden
