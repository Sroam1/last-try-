// ══════════════════════════════════════════════════════════════════════
// ai-service.js — Frontida Pflegedokumentation
// Zentrales KI-Modul: OpenAI via Netlify Function, strikt feature-basiertes
// Prompt-Routing (Pflegebericht / SIS / Maßnahmen).
// ══════════════════════════════════════════════════════════════════════
// Der OpenAI API-Key liegt NICHT im Frontend, sondern serverseitig in der
// Netlify Function unter netlify/functions/generate-report.js
// (env var OPENAI_API_KEY). Dieses Modul spricht ausschließlich den
// Netlify-Endpunkt an. Die einzelnen Feature-Prompts liegen serverseitig
// und werden über `mode` / `sisField` ausgewählt — kein Cross-Contamination.
// ══════════════════════════════════════════════════════════════════════

// ── KONFIGURATION ────────────────────────────────────────────────────

const AI_ENDPOINT = '/.netlify/functions/generate-report';
const AI_RETRY_DELAYS_MS = [1200, 2500, 5000];


// ── KURZ-PROMPTS (Frontend-Aufgabentexte) ────────────────────────────
// Die "Rolle" und "Regeln" für jedes Feature sitzen serverseitig in
// netlify/functions/generate-report.js (PFLEGEBERICHT_SYSTEM_PROMPT etc.).
// Hier nur kurze Aufgabenstellungen, die als USER-Inhalt mitgehen.

function buildCareReportPrompt(inputText, typ) {
  return 'Berichtstyp: ' + (typ || 'Routinebericht') + '\n'
    + 'Erstelle aus der folgenden Eingabe einen vollständigen deutschen Pflegebericht '
    + 'gemäß den Vorgaben des System-Prompts.\n\n'
    + 'Eingabe:\n"' + (inputText || '') + '"\n\n'
    + 'Ausgabe:';
}

function buildAudioReportPrompt(typ) {
  return 'Berichtstyp: ' + (typ || 'Routinebericht') + '\n'
    + 'Ein Mitarbeiter hat eine Sprachaufnahme in beliebiger Sprache aufgenommen. '
    + 'Nutze das nachfolgende Transkript und erstelle daraus einen vollständigen '
    + 'deutschen Pflegebericht gemäß den Vorgaben des System-Prompts.';
}

function buildAudioNotesPrompt() {
  return 'Gib den Inhalt der folgenden Sprachaufnahme als klare deutsche Notizen '
    + 'wieder. 1 bis 3 vollständige Sätze. Keine Überschrift, keine Erklärung über '
    + 'Sprache oder Modell. Behalte: Beschwerden, Sturz, Erbrechen, Essen, Trinken, '
    + 'Medikamente, Verhalten, Maßnahmen.';
}

function buildRepairPrompt(cleaned, fallbackInput) {
  return 'Überarbeite den folgenden deutschen Pflegebericht zu einem vollständigen '
    + 'professionellen Pflegebericht.\n'
    + '- Keine neuen Fakten erfinden\n'
    + '- 4 bis 6 vollständige Sätze\n'
    + '- Letzter Satz vollständig, mit Punkt am Ende\n'
    + '- Nur der fertige Berichtstext, keine Überschrift\n\n'
    + 'Notizen als Grundlage:\n"' + (fallbackInput || '') + '"\n\n'
    + 'Aktueller Bericht:\n"' + (cleaned || '') + '"\n\n'
    + 'Fertiger Bericht:';
}

function buildSuggestionPrompt(typ) {
  return 'Berichtstyp: ' + (typ || 'Routinebericht') + '\n'
    + 'Erstelle einen kurzen, plausiblen Beispiel-Pflegebericht (4–5 Sätze) '
    + 'für einen ambulanten Pflegedienst, gemäß den Vorgaben des System-Prompts.';
}

// SIS-Generierung aus mehreren Berichten — produziert reines JSON-Objekt.
// Hier nutzen wir explizit einen eigenen System-Prompt (weil die Antwort
// strikt JSON sein muss und nicht in das Pflegebericht-Schema passt).
const SIS_JSON_SYSTEM_PROMPT =
  'Du bist eine examinierte Pflegefachkraft. '
+ 'Du erstellst eine SIS (Strukturierte Informationssammlung) ausschließlich '
+ 'aus den übergebenen Pflegeberichten. '
+ 'Du erfindest NICHTS. '
+ 'Wenn eine Information nicht vorhanden ist, schreibst du in das jeweilige '
+ 'Feld: "Keine ausreichenden Angaben vorhanden."\n'
+ 'Antworte AUSSCHLIESSLICH mit gültigem JSON ohne Markdown, ohne Backticks, '
+ 'ohne Kommentare.';

function buildSISPrompt(berichtTexte) {
  return 'Erstelle die SIS als gültiges JSON-Objekt aus den folgenden '
    + 'Pflegeberichten:\n\n'
    + berichtTexte + '\n\n'
    + 'Schema (alle Felder ausfüllen, jeweils kurzer deutscher Fließtext):\n'
    + '{'
    + '"frage":"Was beschäftigt den Klienten? Wünsche, Bedürfnisse, Erwartungen.",'
    + '"tf1":"TF1 Kognition/Kommunikation: Ressourcen | Probleme/Risiken | Bedarf",'
    + '"tf2":"TF2 Mobilität/Beweglichkeit: Ressourcen | Probleme/Risiken | Bedarf",'
    + '"tf3":"TF3 Krankheitsbezogene Anforderungen: Diagnosen, Medikamente, Therapien, Schmerzen",'
    + '"tf4":"TF4 Selbstversorgung: Körperpflege, Ernährung, Ausscheidung",'
    + '"tf5":"TF5 Soziale Beziehungen: Familie, Kontakte",'
    + '"tf6":"TF6 Wohnen / Häuslichkeit: Reinigung, Einkauf, Versorgung",'
    + '"ressourcen":"Stärken und Fähigkeiten des Klienten",'
    + '"unterstuetzung":"Konkreter Unterstützungsbedarf",'
    + '"massnahmen":"Pflegemaßnahmen die laut Berichten bereits durchgeführt werden oder geplant sind"'
    + '}';
}

const FALLBACK_SUGGESTION = 'Patient/in in gutem Allgemeinzustand angetroffen, kooperativ und freundlich. Pflegemaßnahmen planmäßig durchgeführt. Medikamente korrekt verabreicht. Vitalzeichen im Normbereich. Keine Auffälligkeiten festgestellt.';


// ── NETLIFY FUNCTION CLIENT ──────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return [429, 500, 502, 503, 504].includes(status);
}

// Low-level call to the Netlify function. Retries on transient errors.
async function callAIEndpoint(body, timeoutMs) {
  let lastMessage = 'KI nicht erreichbar.';

  for (let attempt = 0; attempt <= AI_RETRY_DELAYS_MS.length; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs || 60000);
    try {
      const r = await fetch(AI_ENDPOINT, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      clearTimeout(timeout);
      const data = await r.json().catch(() => ({}));
      if (r.ok) return data;
      lastMessage = data?.error || ('API Fehler ' + r.status);
      if (isRetryableStatus(r.status) && attempt < AI_RETRY_DELAYS_MS.length) {
        await sleep(AI_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      break;
    } catch (e) {
      clearTimeout(timeout);
      lastMessage = e.name === 'AbortError'
        ? 'Zeitüberschreitung – bitte erneut versuchen'
        : (e.message || 'Netzwerkfehler');
      if (attempt < AI_RETRY_DELAYS_MS.length) {
        await sleep(AI_RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  throw new Error(lastMessage);
}

// Text-Chat über Netlify-Function. `mode` und ggf. `sisField` werden
// serverseitig in den passenden System-Prompt gemappt. `systemPrompt` ist
// nur für Sonderfälle gedacht (z.B. Wundbild → eigener Vision-Prompt).
async function callOpenAI(prompt, maxTokens, opts) {
  const body = {
    prompt: prompt,
    maxTokens: maxTokens || 400,
    temperature: (opts && Number.isFinite(opts.temperature)) ? opts.temperature : 0.2
  };
  if (opts && opts.mode)         body.mode         = opts.mode;
  if (opts && opts.sisField)     body.sisField     = opts.sisField;
  if (opts && opts.systemPrompt) body.systemPrompt = opts.systemPrompt;
  const data = await callAIEndpoint(body, (opts && opts.timeoutMs) || 45000);
  return (data.text || '').trim();
}

// Reines Whisper-Transkript ohne Nachbearbeitung. Wird z.B. von der
// Wunddoku-Notiz oder zur reinen Diktat-Eingabe genutzt.
async function transcribeAudioOnly(base64, mimeType) {
  if (!base64) throw new Error('Keine Audio-Daten vorhanden.');
  const data = await callAIEndpoint({
    transcribeOnly: true,
    audio: { base64: base64, mimeType: mimeType || 'audio/webm' }
  }, 90000);
  return (data.text || '').trim();
}

// Audio + KI für ein konkretes SIS-/Maßnahmen-Feld:
// transkribiert die Aufnahme und formuliert sie sofort im richtigen
// deutschen Stil (Feld-spezifischer System-Prompt serverseitig).
//
//   mode     = 'sis' | 'massnahmen' | 'pflegebericht'
//   sisField = 'feldA' | 'frage' | 'tf1'..'tf6' | 'leitgedanken' | 'massnahmen'
async function generateFieldFromAudio(base64, mimeType, mode, sisField) {
  if (!base64) throw new Error('Keine Audio-Daten vorhanden.');
  const data = await callAIEndpoint({
    prompt: 'Bitte das Transkript dieser Sprachaufnahme als Inhalt für das '
          + 'oben definierte Feld in sauberem Deutsch formulieren.',
    mode: mode || 'sis',
    sisField: sisField || '',
    maxTokens: 400,
    temperature: 0.2,
    audio: { base64: base64, mimeType: mimeType || 'audio/webm' }
  }, 90000);
  return (data.text || '').trim();
}


// ── REPORT-VERARBEITUNG ──────────────────────────────────────────────

function cleanGeneratedReport(text) {
  return String(text || '')
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^(Pflegebericht|Bericht|Report)\s*[:\-–]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isUsefulAudioNotes(text) {
  const cleaned = cleanGeneratedReport(text);
  if (!cleaned) return false;
  if (cleaned.length < 20) return false;
  return !/^(sprachaufnahme|audio|mitarbeiter|routinebericht)\b/i.test(cleaned);
}

function isCompleteReport(text) {
  const cleaned = cleanGeneratedReport(text);
  if (!cleaned) return false;
  if (cleaned.length < 60) return false;
  if (!/[.!?…""]$/.test(cleaned)) return false;
  if ((cleaned.match(/[.!?](?=\s|$)/g) || []).length < 2) return false;
  return !/(und|oder|sowie|weil|dass|bei|mit|ohne|nach|vor|wegen|aufgrund|besteht|war|wurde|ist|hat|zeigt)\s*$/i.test(cleaned);
}

async function finalizeCareReport(text, fallbackInput, typ) {
  let cleaned = cleanGeneratedReport(text);
  if (isCompleteReport(cleaned)) return cleaned;

  // Repair-Versuch — wieder mit Pflegebericht-Prompt
  cleaned = cleanGeneratedReport(
    await callOpenAI(buildRepairPrompt(cleaned, fallbackInput), 500, { mode: 'pflegebericht' })
  );
  if (isCompleteReport(cleaned)) return cleaned;

  // Fallback auf Rohtext wenn kein Audio-Prefix
  if (fallbackInput && !/^Sprachaufnahme des Mitarbeiters zu\s+/i.test(cleanGeneratedReport(fallbackInput))) {
    return cleanGeneratedReport(fallbackInput);
  }
  return '';
}


// ── HIGH-LEVEL API ───────────────────────────────────────────────────

// Text-Eingabe → Pflegebericht.
// Default-Mode 'pflegebericht' kann nur in Sonderfällen überschrieben werden.
async function generateReport(inputText, typ, mode) {
  const useMode = mode || 'pflegebericht';
  const raw = await callOpenAI(buildCareReportPrompt(inputText, typ), 700, { mode: useMode });
  return finalizeCareReport(raw, inputText, typ);
}

// Audio (Base64) → Pflegebericht.
// Default-Mode 'pflegebericht'. Die Netlify Function transkribiert das Audio
// (Whisper) und generiert dann mit dem PFLEGEBERICHT_SYSTEM_PROMPT.
async function generateReportFromAudio(base64, mimeType, typ, mode) {
  const useMode = mode || 'pflegebericht';

  // Schritt 1: Direkt Bericht aus Audio-Transkript
  const firstData = await callAIEndpoint({
    prompt: buildAudioReportPrompt(typ),
    mode: useMode,
    maxTokens: 700,
    temperature: 0.2,
    audio: { base64: base64, mimeType: mimeType }
  }, 90000);
  let txt = (firstData.text || '').trim();

  // Schritt 2: Falls unvollständig → Notizen extrahieren → daraus Bericht
  if (!isCompleteReport(txt)) {
    const notesData = await callAIEndpoint({
      prompt: buildAudioNotesPrompt(),
      mode: useMode,
      maxTokens: 500,
      temperature: 0.1,
      audio: { base64: base64, mimeType: mimeType }
    }, 90000);
    const notes = (notesData.text || '').trim();
    if (isUsefulAudioNotes(notes)) {
      txt = await callOpenAI(buildCareReportPrompt(notes, typ), 700, { mode: useMode });
    }
  }

  // Schritt 3: Finalisierung
  return finalizeCareReport(txt, '', typ);
}

// KI-Vorschlag für leeres Berichtsfeld
async function generateSuggestion(typ, mode) {
  const useMode = mode || 'pflegebericht';
  return callOpenAI(buildSuggestionPrompt(typ), 300, { mode: useMode });
}

// Wundfoto → deutsche Wunddokumentation.
// Sonderfall: hier setzen wir explizit einen eigenen Vision-System-Prompt,
// weil das Bild rein deskriptiv ohne Diagnose beschrieben werden soll.
const WUND_SYSTEM_PROMPT =
  'Du bist eine examinierte Pflegefachkraft in Deutschland und unterstützt '
+ 'Pflegekräfte bei der Wunddokumentation. Du beschreibst ausschließlich, '
+ 'was auf dem Foto sichtbar ist. Du stellst KEINE Diagnosen, nennst keine '
+ 'Wundklassifikation (z.B. Dekubitus-Stadien), erfindest keine Werte und '
+ 'formulierst vorsichtig und sachlich. Wenn etwas nicht erkennbar ist, '
+ 'schreibe ausdrücklich "nicht eindeutig erkennbar".';

function buildWoundPrompt(ort) {
  return 'Analysiere das Wundfoto und erstelle eine kurze, vorsichtige deutsche '
    + 'Wunddokumentation für die Pflegeakte.\n\n'
    + (ort ? 'Lokalisation laut Pflegekraft: ' + ort + '\n\n' : '')
    + 'Bitte dokumentiere – nur soweit im Foto sichtbar – folgende Punkte in '
    + '3 bis 5 vollständigen deutschen Sätzen:\n'
    + '- Aussehen / Wundgrund (Farbe, Belag)\n'
    + '- Wundrand und umgebende Haut (Rötung, Mazeration, Schuppung)\n'
    + '- Feuchtigkeit / Exsudat (trocken, feucht, sichtbare Sekretion)\n'
    + '- Grobe Größe / Ausdehnung falls abschätzbar (sonst weglassen)\n'
    + '- Sonstige Auffälligkeiten (z.B. Blutungen, Krusten)\n\n'
    + 'WICHTIG:\n'
    + '- Keine Diagnose, keine Stadieneinteilung\n'
    + '- Keine erfundenen Angaben\n'
    + '- Wenn etwas unklar ist: "nicht eindeutig erkennbar"\n'
    + '- Nur der Dokumentationstext, keine Überschrift, keine Listen';
}

async function analyzeWoundPhoto(dataUrl, ort) {
  if (!dataUrl) throw new Error('Kein Foto vorhanden.');
  const data = await callAIEndpoint({
    prompt: buildWoundPrompt(ort || ''),
    systemPrompt: WUND_SYSTEM_PROMPT,
    maxTokens: 500,
    temperature: 0.2,
    image: { dataUrl: dataUrl }
  }, 60000);
  return cleanGeneratedReport(data.text || '');
}

// Berichte → SIS-JSON
async function generateSIS(berichte) {
  const berichtTexte = berichte.slice(0, 20).map(function(b, i) {
    return 'Bericht ' + (i + 1) + ' (' + b.dat + ', ' + b.autor + ', ' + b.typ + '): ' + b.text;
  }).join('\n\n');

  const raw = await callOpenAI(buildSISPrompt(berichtTexte), 2000, {
    systemPrompt: SIS_JSON_SYSTEM_PROMPT,
    timeoutMs: 60000
  });
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}
