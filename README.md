# 🛣️ Verkehrs-Sandbox (traffic-sandbox)

Ein Browser-Sandboxspiel für Handy, Tablet und PC: Straßen durch eine endlose, zufällig erzeugte
Landschaft bauen und mit Elementen des deutschen Straßenverkehrs Verkehrsführungen ausprobieren.
Die Verkehrssimulation zeigt, ob deine Konstruktion flüssig läuft oder Staus und Unfälle erzeugt.

**Spielen:** https://linoking09.github.io/traffic-sandbox/ (oder `index.html` lokal öffnen – kein Build nötig)

## Spielprinzip

- In der Landschaft liegen Dörfer und Städte. **Häuser neben einer Straße werden automatisch angebunden**
  (Grundstückszufahrt). Von dort fahren Autos und LKW zu anderen angebundenen Häusern und Geschäften.
- Straßen auf Häusern reißen diese ab. Autobahnen und Straßen mit Mittelstreifen haben keine Zufahrten.
- Im Kern geht es ums Ausprobieren: Abbiegespuren, Richtungspfeile, Vorfahrtsregeln, Ampeln,
  Kreisverkehre, Einbahnstraßen, Brücken und Tunnel.

## Werkzeuge

| Werkzeug | Funktion |
|---|---|
| 🛣️ Straße | Ziehen (oder tippen, tippen), dann mit dem gelben Punkt die Kurve formen und „✓ Bauen“. Fortsetzungen am Straßenende schließen automatisch tangential an. Straßentyp und Boden/Brücke/Tunnel in der Leiste darüber |
| 🚦 Kreuzung | Rechts vor links · Vorfahrtstraße (auch abknickend) · Stoppschild · adaptive Ampel mit Grünpfeil · Kreisverkehr |
| ↱ Spuren | Zufahrt antippen: Fahrstreifen, bis zu 2 Links- und 1 Rechtsabbiegespur, Richtungspfeile je Spur (ohne Pfeil = Abbiegeverbot) |
| 🔧 Umbauen | Gewählten Straßentyp übernehmen, Einbahnstraße umdrehen |
| 🧨 Abriss | Straße oder Kreuzung entfernen |
| 🔍 Info | Verkehrsstärke, Tempo, Wartezeit, Unfälle |

**Bedienung:** Touch – ein Finger baut, zwei Finger verschieben/zoomen. Maus – Linksziehen baut,
Rechtsziehen verschiebt, Mausrad zoomt. Tastatur: `1`–`6` Werkzeuge, `Enter` bauen, `B` Ebene, `F` Fluss-Ansicht, Leertaste Pause.

## Simulation

Intelligent-Driver-Model, Spurwechsel mit Rechtsfahrgebot, Einordnen auf Abbiegespuren, Vorfahrt
nach StVO (rechts vor links, Vorfahrtstraße, Linksabbieger warten auf Gegenverkehr), Lückenannahme mit
Ungeduld, stauabhängige Routenwahl, Rückstau, emergente Unfälle. Auswertung mit Verkehrsnote A–F,
Fluss, Stau-Anteil, Durchsatz, Unfällen und Brennpunkten.

## Code

`js/util.js` Mathe · `js/terrain.js` Landschaft & Orte · `js/network.js` Straßennetz, Spuren, Abbiegebeziehungen,
Hausanbindung · `js/sim.js` Verkehr · `js/render.js` Darstellung · `js/ui.js` Bedienung · `js/main.js` Hauptschleife.
