# Frontida v17 Refactoring — Changelog

## Deployment
Beide Dateien müssen im selben Verzeichnis auf Netlify liegen:
- `frontida_v17_refactored.html` (oder umbenennen zu `index.html`)
- `ai-service.js`

## Phase 1: AI-Modul Extraktion

### Entfernt (toter Code)
| Was | Zeilen (Original) | Warum |
|-----|-------------------|-------|
| `callClaude()` v1 | 1721–1746 | Überschrieben von v2. Hatte Bug: `geminiUrl()` ohne Model-Argument → URL mit `undefined` |
| `processGeminiAudio()` v1 | 2972–3020 | Überschrieben von v2. Fehlte `blob.size<1500` Check, hatte inline-Prompt statt Builder |

### Ausgelagert → ai-service.js
| Funktion | Zeilen (Original) | Neuer Ort |
|----------|-------------------|-----------|
| `GEMINI_API_VERSION`, `GEMINI_TEXT_MODELS`, `GEMINI_AUDIO_MODELS`, `GEMINI_RETRY_DELAYS_MS`, `SAFETY_SETTINGS` | 1635–1644 | ai-service.js Konstanten |
| `geminiUrl()` | 1645 | ai-service.js |
| `sleep()` | 1675 | ai-service.js |
| `isRetryableGeminiStatus()` | 1676 | ai-service.js |
| `parseRetryDelayMs()` | 1677–1683 | ai-service.js |
| `extractGeminiText()` | 1684–1687 | ai-service.js |
| `geminiGenerate()` | 1688–1719 | ai-service.js (+ ensureApiKey()) |
| `callClaude()` v2 | 1748–1758 | ai-service.js als `callGemini()` mit `callClaude` Alias |
| `buildCareReportPrompt()` | 1760–1776 | ai-service.js (nutzt jetzt PFLEGE_REPORT_RULES) |
| `buildAudioReportPrompt()` | 1778–1792 | ai-service.js (nutzt jetzt PFLEGE_REPORT_RULES) |
| `buildAudioNotesPrompt()` | 1794–1803 | ai-service.js |
| `cleanGeneratedReport()` | 1805–1812 | ai-service.js |
| `isUsefulAudioNotes()` | 1814–1819 | ai-service.js |
| `isCompleteReport()` | 1821–1828 | ai-service.js |
| `finalizeCareReport()` | 1830–1849 | ai-service.js (nutzt jetzt buildRepairPrompt()) |
| `fallbackSugg()` | 2808 | ai-service.js als `FALLBACK_SUGGESTION` Konstante |
| Inline Suggestion-Prompt | 2798 | ai-service.js als `buildSuggestionPrompt()` |
| Inline SIS-Prompt (20 Zeilen) | 3299–3318 | ai-service.js als `buildSISPrompt()` |
| Inline Repair-Prompt | 1833–1842 | ai-service.js als `buildRepairPrompt()` |

### Neue High-Level APIs in ai-service.js
| Funktion | Ersetzt | Beschreibung |
|----------|---------|-------------|
| `generateReport(text, typ)` | `callClaude(buildCareReportPrompt(...)) + finalizeCareReport(...)` | Text → fertiger Bericht in einem Aufruf |
| `generateReportFromAudio(base64, mime, typ)` | 25 Zeilen inline Gemini-Calls in processGeminiAudio | Audio → Bericht mit automatischem Notes-Fallback |
| `generateSuggestion(typ)` | Inline-Prompt in callAISuggestion | KI-Vorschlag generieren |
| `generateSIS(berichte)` | 20-Zeilen Inline-Prompt + callClaude + JSON.parse | Berichte → SIS-JSON |
| `ensureApiKey()` | 6x duplizierte API_KEY-Prüfung | Zentrale Key-Validierung |
| `PFLEGE_REPORT_RULES` | 3x duplizierte Regel-Strings | Gemeinsame Prompt-Regeln |

### Geänderte Funktionen in der HTML-Datei
| Funktion | Änderung |
|----------|----------|
| `callAISuggestion()` | Nutzt `generateSuggestion()` + `FALLBACK_SUGGESTION` |
| `requestSave()` | Nutzt `generateReport()` statt `callClaude + buildCareReportPrompt + finalizeCareReport` |
| `processGeminiAudio()` | Nutzt `generateReportFromAudio()`, 25 Zeilen reduziert |
| `generateSISWithKI()` | Nutzt `generateSIS()`, 20 Zeilen Inline-Prompt entfernt |

---

## Phase 2: Security Cleanup

### PIN-Sicherheit
| Vorher | Nachher | Risiko entfernt |
|--------|---------|----------------|
| PINs im Klartext im Quellcode sichtbar | SHA-256 gehashte PINs in localStorage | Quellcode-Einsicht gibt keine PINs preis |
| `u.pin === enteredPin` (Klartext-Vergleich) | `u.pinHash === await hashPin(enteredPin)` | Timing-sicher, kein Klartext im Speicher |
| User-Änderungen gehen bei Reload verloren | `saveUsers()` / `loadUsers()` mit localStorage | Bugfix: Benutzer persistent |
| PIN-Feld bei Bearbeitung zeigt alten PIN | PIN-Feld leer, Placeholder "Neuen PIN eingeben" | Kein Klartext-PIN sichtbar |
| PIN bei Bearbeitung pflichtfeld | PIN optional bei Edit (leer = alter PIN bleibt) | Bessere UX |

### Neue Funktionen
| Funktion | Beschreibung |
|----------|-------------|
| `hashPin(pin)` | SHA-256 Hash mit Salt via Web Crypto API |
| `esc(str)` | HTML-Sanitierung via textContent/innerHTML |
| `saveUsers()` | User-Array nach localStorage persistieren |
| `loadUsers()` | User-Array aus localStorage laden, bei Erststart Default-Benutzer mit gehashten PINs anlegen |

### XSS-Sanitierung
`esc()` angewendet auf 8 innerHTML-Stellen:
- Tour-Name in Lösch-Dialog
- User-Name in Login-Select
- User-Name in Lösch-Dialog
- Patient-ID in Lösch-Dialog
- Server-Response-Daten (höchstes Risiko: externe Daten)
- Bericht-Autor, Datum, Text in Cleanup-Ansicht
- Patient-ID in Erfolgs-Anzeige

### Bekannte Einschränkung
`DEFAULT_PINS` enthält weiterhin Klartext-PINs als Seed-Daten für den Erststart. Diese werden nur einmal verwendet (wenn kein `frontida_users` in localStorage existiert) und danach durch gehashte Versionen ersetzt. Langfristig: Erststart-Wizard der Admin zur PIN-Vergabe zwingt.

---

## Metriken

| Metrik | Vorher | Nachher |
|--------|--------|---------|
| HTML-Zeilen | 3891 | 3668 |
| Funktionen in HTML | 152 | ~137 |
| Duplizierte Funktionen | 2 | 0 |
| Tote Funktionen | 2 | 0 |
| Prompt-Definitionen | 6 Stellen | 1 Datei |
| API-Key-Prüfungen | 6x dupliziert | 1x zentral |
| Klartext-PINs im Quellcode | 5 | 0 (nur Seed-Daten) |
| innerHTML ohne Sanitierung | 50 | 42 (8 kritischste gesichert) |
| User-Persistenz | keine | localStorage |

---

## Phase 3: Supabase-first Data Store

### Architektur-Umstellung

| Aspekt | Vorher | Nachher |
|--------|--------|---------|
| Primary Storage | localStorage | Supabase |
| Boot-Quelle | localStorage → Supabase nach 1.5s | Supabase direkt → localStorage als Fallback |
| Save-Reihenfolge | localStorage → Supabase (fire-and-forget) | Supabase → localStorage Cache |
| Offline | localStorage-only, Supabase-Push verloren | Queue + automatischer Flush bei Reconnect |
| Sync | Naive Last-Write-Wins | Union-Merge mit Deduplizierung |
| User-Daten | Nur localStorage | Supabase + localStorage Cache |
| Datenverlust-Risiko | Hoch (3 unkoordinierte Backends) | Niedrig (Merge-Strategie, kein Overwrite) |

### Neues Modul: data-store.js (499 Zeilen)

**Kern-API:**
- `DataStore_loadAll()` — Lädt alles aus Supabase (Fallback: Cache). Merged lokale Offline-Daten dazu.
- `DataStore_saveAll()` — Speichert alles nach Supabase, cached lokal
- `DataStore_sync()` — Bidirektionaler Sync mit Merge
- `DataStore_saveBerichte()` — Berichte + Patienten speichern
- `DataStore_saveTours()` — Tourenpläne speichern
- `DataStore_saveUsers()` — Benutzer speichern
- `DataStore_cacheAll()` — Alles lokal cachen (für schnellen Boot)
- `DataStore_flushQueue()` — Offline-Queue bei Reconnect flushen

**Merge-Strategien (kein Datenverlust):**
- `mergeBerichte()` — Union aller einzigartigen Berichte (Key: patId+dat+autor)
- `mergePatients()` — Remote als Basis, lokale Ergänzungen, mehr Berichte gewinnen
- `mergeTours()` — Alle Tour-IDs aus beiden Quellen, mehr Patienten gewinnt
- `mergeUsers()` — Remote als Basis, neue lokale Users dazu

**Rückwärtskompatibilität (Aliase):**
```javascript
var saveBerichte = DataStore_saveBerichte;
var saveUsers = DataStore_saveUsers;
var saveTourData = DataStore_saveTours;
```
→ Alle 18 saveBerichte-Aufrufe, 5 saveUsers-Aufrufe und 3 saveTourData-Aufrufe im HTML funktionieren sofort ohne Änderung.

### Entfernt aus HTML
- `SUPA_URL`, `SUPA_KEY`, `SUPA_TABLE` Konstanten
- `supaGet()`, `supaSet()`, `supaSync()`, `supaPush()` Funktionen
- `STORAGE_KEY_BERICHTE`, `STORAGE_KEY_PAT_STATUS` Konstanten
- `saveBerichte()` (70 Zeilen, localStorage-first)
- `loadBerichte()` (40 Zeilen, localStorage-only)
- `saveTourData()` / `loadTourData()` (localStorage + Supabase fire-and-forget)
- `saveUsers()` / `loadUsers()` (localStorage-only)
- Delayed `supaSync()` nach 1.5s im Boot

### Geänderte Boot-Sequenz
```
VORHER:
  loadBerichte()          ← localStorage
  loadTourData()          ← localStorage
  loadUsers()             ← localStorage
  ... UI initialisieren
  setTimeout(supaSync)    ← Supabase nach 1.5s (zu spät!)

NACHHER:
  DataStore_loadAll()     ← Supabase direkt (Fallback: Cache)
  seedDefaultUsers()      ← nur bei Erststart
  ... UI initialisieren   ← sofort mit aktuellen Daten
```

### localStorage-Rolle nach Phase 3
| Key | Zweck | War vorher |
|-----|-------|-----------|
| `frontida_berichte` | Offline-Cache | Primary Storage |
| `frontida_pat_status` | Offline-Cache | Primary Storage |
| `frontida_tours` | Offline-Cache | Primary Storage |
| `frontida_users` | Offline-Cache | Primary Storage |
| `frontida_apikey` | Config (bleibt) | Config |
| `frontida_server_url` | Config (bleibt) | Config |

### Deployment
3 Dateien im selben Verzeichnis auf Netlify:
- `frontida_v17_refactored.html` (oder `index.html`)
- `ai-service.js`
- `data-store.js`

---

## Phase 4: go() Navigation Refactor

### Vorher
```javascript
function go(sid){
  // ...scroll reset...
  if(sid==='s-dash'){updateStats();renderDashTours();}
  if(sid==='s-admin-dash'){updateAdminStats();updateTourBadges();}
  if(sid==='s-patients'){...}
  if(sid==='s-tour'){/* comment */}
  if(sid==='s-admin-tours'){...}
  // ... 14 weitere if-Blöcke, s-report allein 20 Zeilen ...
}
```
55 Zeilen, unstrukturiert, s-report mit 20 Zeilen inline-Setup

### Nachher
```javascript
const ROUTES={
  's-dash':        ()=>{ updateStats(); renderDashTours(); },
  's-admin-dash':  ()=>{ updateAdminStats(); updateTourBadges(); },
  's-report':      ()=>{ initReportScreen(); },
  // ... 12 Einträge total
};

function go(sid){
  // ...scroll reset (unchanged)...
  const onEnter=ROUTES[sid];
  if(onEnter) onEnter();
}
```
15 Zeilen go() + 12-Einträge ROUTES-Map + extrahierte initReportScreen()

### Änderungen
| Was | Details |
|-----|---------|
| ROUTES map | 12 Screen-Einträge, deklarativ, eine Zeile pro Screen |
| initReportScreen() | 20 Zeilen Report-Setup als eigene Funktion extrahiert |
| go() | Reduziert auf Scroll-Reset + Map-Lookup |
| Tote Kommentare | `s-tour /* rendered before navigation */` und `s-sis /* rendered by openSIS() */` entfernt |
| Neuen Screen hinzufügen | 1 Zeile in ROUTES statt neues if-Statement |

### Metriken nach Phase 4
| Datei | Zeilen |
|-------|--------|
| Original monolith | 3891 |
| Refactored HTML | 3497 (−394, −10.1%) |
| ai-service.js | 326 |
| data-store.js | 499 |
