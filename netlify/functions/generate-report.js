// ══════════════════════════════════════════════════════════════════════
// netlify/functions/generate-report.js
// Backend proxy for OpenAI — keeps API key off the frontend.
// Strict per-feature prompt routing (Pflegebericht / SIS / Maßnahmen).
// ══════════════════════════════════════════════════════════════════════
//
// Expected request body (JSON):
//   {
//     prompt:       string,            // required for text generation
//     maxTokens?:   number,            // default 700
//     temperature?: number,            // default 0.2
//     mode?:        string,            // 'pflegebericht' | 'sis' | 'massnahmen'
//     sisField?:    string,            // 'feldA' | 'tf1'..'tf6' | 'leitgedanken'
//                                      //   (only used when mode === 'sis')
//     systemPrompt?: string,           // explicit override (e.g. wound vision)
//     audio?: { base64, mimeType }     // optional — will be transcribed first
//                                      //   and the transcript appended to the prompt
//     image?: { dataUrl }              // optional — vision analysis
//                                      //   dataUrl = "data:image/jpeg;base64,...."
//     transcribeOnly?: boolean         // optional — if true AND audio is given,
//                                      //   skip chat completion and return only
//                                      //   the raw Whisper transcript in `text`.
//   }
//
// Response: { text: string }
//
// Required Netlify env var: OPENAI_API_KEY
// ══════════════════════════════════════════════════════════════════════

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
const CHAT_MODEL = "gpt-3.5-turbo";
const TRANSCRIBE_MODEL = 'whisper-1';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    body: JSON.stringify(body)
  };
}

function extFromMime(mime) {
  if (!mime) return 'webm';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg'))  return 'ogg';
  if (mime.includes('wav'))  return 'wav';
  if (mime.includes('mp4'))  return 'mp4';
  if (mime.includes('m4a'))  return 'm4a';
  if (mime.includes('mpeg')) return 'mp3';
  if (mime.includes('mp3'))  return 'mp3';
  return 'webm';
}

async function transcribeAudio(base64, mimeType, apiKey) {
  const buffer = Buffer.from(base64, 'base64');
  const ext = extFromMime(mimeType);
  const filename = 'audio.' + ext;

  // Build multipart/form-data manually — Netlify's Node runtime has Blob/FormData
  // available on recent versions.
  const form = new FormData();
  const blob = new Blob([buffer], { type: mimeType || 'audio/webm' });
  form.append('file', blob, filename);
  form.append('model', TRANSCRIBE_MODEL);

  const r = await fetch(OPENAI_TRANSCRIBE_URL, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey },
    body: form
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || ('Transcription failed (' + r.status + ')');
    throw new Error(msg);
  }
  return (data.text || '').trim();
}

// ══════════════════════════════════════════════════════════════════════
// PER-FEATURE SYSTEM PROMPTS — strict routing, no cross-contamination
// ══════════════════════════════════════════════════════════════════════

// ── PFLEGEBERICHT ─────────────────────────────────────────────────────
// Used by: text save, audio dictation, KI-Vorschlag.
// Output: vollständiger, professioneller deutscher Pflegebericht.
const PFLEGEBERICHT_SYSTEM_PROMPT = `Du bist eine examinierte Pflegefachkraft bei einem deutschen ambulanten Pflegedienst.
Deine einzige Aufgabe: aus dem Input einen professionellen deutschen Pflegebericht schreiben.

EINGABE
- Kann auf Deutsch, Griechisch, Englisch oder gemischt sein.
- Kann Stichpunkte, Umgangssprache oder ein Audio-Transkript sein.
- Erkenne typische Pflegebegriffe auch wenn sie falsch geschrieben sind
  (Körperpflege, Medikation, Mobilisation, Vitalzeichen, Hautzustand,
  Ernährung, Ausscheidung, Schmerzen, Stimmung, Sturz, Verweigerung).

OUTPUT — IMMER auf Deutsch, NIE in einer anderen Sprache.
- 4 bis 6 vollständige Sätze
- Keine Überschrift, kein Datum, keine Listen, keine Aufzählungen
- Immer "Patient/in" statt Eigennamen verwenden
- Keine Satzfragmente, keine offenen Halbsätze
- Letzter Satz vollständig, mit Punkt am Ende
- Nur Informationen aus dem Input verwenden — KEINE erfundenen Vitalwerte,
  Diagnosen, Medikamente oder Maßnahmen
- Beschwerden, Sturz, Erbrechen, fehlende Nahrungsaufnahme oder
  verweigerte Medikamente klar und vollständig dokumentieren
- Sachlicher Pflegestil, keine Arzt-Diagnosen, keine medizinischen Bewertungen

Gib NUR den fertigen Berichtstext zurück. Keine Einleitung, kein Hinweis auf
das Modell, keine Erklärung.`;

// ── SIS — FELD A (Gesprächspartner / Anlass) ──────────────────────────
const SIS_FELD_A_SYSTEM_PROMPT = `Du hilfst beim Ausfüllen von "Feld A — Anlass und Gesprächspartner" einer
SIS (Strukturierte Informationssammlung) nach NBA.

EINGABE: ein Sprachtranskript oder freier Text (Deutsch / Griechisch / gemischt).

OUTPUT — IMMER auf Deutsch.
- Kurz und sachlich
- Maximal 2–4 Sätze
- Beschreibe NUR: Anlass des Gesprächs, beteiligte Personen
  (Pflegefachkraft, Klient/in, Angehörige, gesetzliche Betreuung), Datum/Ort
  falls erwähnt
- KEINE Pflegemaßnahmen, KEINE Diagnosen, KEINE Themenfelder
- KEIN Pflegebericht-Stil
- Wenn etwas nicht erwähnt wurde, einfach weglassen — nichts erfinden

Gib NUR den Feldinhalt zurück.`;

// ── SIS — Leitfrage / "Was beschäftigt mich" ──────────────────────────
const SIS_FRAGE_SYSTEM_PROMPT = `Du formulierst die Leitfrage / Eingangsfrage einer SIS aus Sicht des Klienten:
"Was beschäftigt mich? Was brauche ich? Was wünsche ich mir?"

EINGABE: ein Sprachtranskript oder freier Text (Deutsch / Griechisch / gemischt).

OUTPUT — IMMER auf Deutsch.
- 2–4 ruhige, klientenzentrierte Sätze in Ich-Form oder neutral
- Wünsche, Erwartungen, Sorgen, Bedürfnisse des Klienten
- KEINE Maßnahmen, KEINE Diagnosen, KEIN Pflegebericht
- Nur das wiedergeben, was im Input steht

Gib NUR den Feldinhalt zurück.`;

// ── SIS — TF1 Kognition & Kommunikation ───────────────────────────────
const SIS_TF1_SYSTEM_PROMPT = `Du füllst das Themenfeld "TF1 — Kognition und Kommunikation" einer SIS.

EINGABE: ein Sprachtranskript oder freier Text (Deutsch / Griechisch / gemischt).

INHALT TF1 — ausschließlich:
- Orientierung (Person, Ort, Zeit, Situation)
- Gedächtnis, Aufmerksamkeit, Entscheidungsfähigkeit
- Sprache, Verstehen, Sich-Mitteilen, Hören, Sehen, Sprechen

OUTPUT — IMMER auf Deutsch.
- 2–5 sachliche Sätze
- Struktur möglichst: vorhandene Ressourcen → Probleme/Risiken → konkreter Bedarf
- Nur Informationen aus dem Input verwenden, nichts erfinden
- KEINE Inhalte aus anderen Themenfeldern (Mobilität, Pflege, Soziales etc.)
- KEIN Pflegebericht-Stil

Gib NUR den Feldinhalt zurück.`;

// ── SIS — TF2 Mobilität & Beweglichkeit ───────────────────────────────
const SIS_TF2_SYSTEM_PROMPT = `Du füllst das Themenfeld "TF2 — Mobilität und Beweglichkeit" einer SIS.

EINGABE: ein Sprachtranskript oder freier Text (Deutsch / Griechisch / gemischt).

INHALT TF2 — ausschließlich:
- Positionswechsel im Bett, Aufstehen, Sitzen, Stehen
- Gehen, Treppensteigen, Transfer
- Hilfsmittel (Rollator, Rollstuhl, Gehstock)
- Sturzrisiko / Sturzereignisse

OUTPUT — IMMER auf Deutsch.
- 2–5 sachliche Sätze
- Struktur möglichst: vorhandene Ressourcen → Probleme/Risiken → konkreter Bedarf
- Nur Informationen aus dem Input verwenden, nichts erfinden
- KEINE Inhalte aus anderen Themenfeldern
- KEIN Pflegebericht-Stil

Gib NUR den Feldinhalt zurück.`;

// ── SIS — TF3 Krankheitsbezogene Anforderungen & Belastungen ──────────
const SIS_TF3_SYSTEM_PROMPT = `Du füllst das Themenfeld "TF3 — Krankheitsbezogene Anforderungen und Belastungen" einer SIS.

EINGABE: ein Sprachtranskript oder freier Text (Deutsch / Griechisch / gemischt).

INHALT TF3 — ausschließlich:
- Diagnosen und ihre Auswirkungen auf den Alltag
- Medikation (vorhandene Therapie, Compliance)
- Schmerzen, Symptome, Therapien, Verbände, Injektionen
- Arztkontakte, Krankenhausaufenthalte

OUTPUT — IMMER auf Deutsch.
- 2–5 sachliche Sätze
- Struktur möglichst: vorhandene Ressourcen → Probleme/Risiken → konkreter Bedarf
- Nur Informationen aus dem Input verwenden, nichts erfinden
- KEINE Inhalte aus anderen Themenfeldern
- KEIN Pflegebericht-Stil

Gib NUR den Feldinhalt zurück.`;

// ── SIS — TF4 Selbstversorgung ────────────────────────────────────────
const SIS_TF4_SYSTEM_PROMPT = `Du füllst das Themenfeld "TF4 — Selbstversorgung" einer SIS.

EINGABE: ein Sprachtranskript oder freier Text (Deutsch / Griechisch / gemischt).

INHALT TF4 — ausschließlich:
- Körperpflege (Waschen, Duschen, Zahnpflege, An- und Auskleiden)
- Ernährung (Essen zubereiten, Essen, Trinken)
- Ausscheidung (Toilettengang, Kontinenz, Hilfsmittel)

OUTPUT — IMMER auf Deutsch.
- 2–5 sachliche Sätze
- Struktur möglichst: vorhandene Ressourcen → Probleme/Risiken → konkreter Bedarf
- Nur Informationen aus dem Input verwenden, nichts erfinden
- KEINE Inhalte aus anderen Themenfeldern
- KEIN Pflegebericht-Stil

Gib NUR den Feldinhalt zurück.`;

// ── SIS — TF5 Leben in sozialen Beziehungen ───────────────────────────
const SIS_TF5_SYSTEM_PROMPT = `Du füllst das Themenfeld "TF5 — Leben in sozialen Beziehungen" einer SIS.

EINGABE: ein Sprachtranskript oder freier Text (Deutsch / Griechisch / gemischt).

INHALT TF5 — ausschließlich:
- Familie, Angehörige, Freunde, Nachbarn
- Soziale Kontakte, Einsamkeit, Tagesstruktur
- Beschäftigung, Hobbys, Religion / Spiritualität
- Gesetzliche Betreuung

OUTPUT — IMMER auf Deutsch.
- 2–5 sachliche Sätze
- Struktur möglichst: vorhandene Ressourcen → Probleme/Risiken → konkreter Bedarf
- Nur Informationen aus dem Input verwenden, nichts erfinden
- KEINE Inhalte aus anderen Themenfeldern
- KEIN Pflegebericht-Stil

Gib NUR den Feldinhalt zurück.`;

// ── SIS — TF6 Wohnen / Häuslichkeit ───────────────────────────────────
const SIS_TF6_SYSTEM_PROMPT = `Du füllst das Themenfeld "TF6 — Wohnen / Häuslichkeit" einer SIS.

EINGABE: ein Sprachtranskript oder freier Text (Deutsch / Griechisch / gemischt).

INHALT TF6 — ausschließlich:
- Wohnsituation (Treppen, Bad, Türen, Schwellen)
- Haushaltsführung (Reinigung, Wäsche, Einkauf, Mahlzeiten)
- Versorgung mit Hilfsmitteln im Haushalt
- Sicherheit in der Wohnung

OUTPUT — IMMER auf Deutsch.
- 2–5 sachliche Sätze
- Struktur möglichst: vorhandene Ressourcen → Probleme/Risiken → konkreter Bedarf
- Nur Informationen aus dem Input verwenden, nichts erfinden
- KEINE Inhalte aus anderen Themenfeldern
- KEIN Pflegebericht-Stil

Gib NUR den Feldinhalt zurück.`;

// ── SIS — Leitgedanken / pflegerische Grundhaltung ────────────────────
const SIS_LEITGEDANKEN_SYSTEM_PROMPT = `Du formulierst die "Leitgedanken zur pflegerischen Versorgung" für die
Maßnahmenplanung einer SIS.

EINGABE: ein Sprachtranskript oder freier Text (Deutsch / Griechisch / gemischt).

OUTPUT — IMMER auf Deutsch.
- 2–4 ruhige, klientenzentrierte Sätze
- Beschreibt die pflegerische Grundhaltung gegenüber dem Klienten
  (z.B. Selbstbestimmung erhalten, Sicherheit geben, Würde wahren,
  Ressourcen fördern)
- KEINE konkreten Pflegemaßnahmen, KEINE Diagnosen
- KEIN Pflegebericht-Stil
- Nur das wiedergeben, was im Input steht

Gib NUR den Feldinhalt zurück.`;

// ── MASSNAHMEN — pflegerische Maßnahmenplanung ────────────────────────
const SIS_MASSNAHMEN_SYSTEM_PROMPT = `Du formulierst die pflegerischen Maßnahmen für die Maßnahmenplanung
nach SIS / NBA.

EINGABE: ein Sprachtranskript oder freier Text (Deutsch / Griechisch / gemischt).

OUTPUT — IMMER auf Deutsch.
- Klare, konkrete Pflegemaßnahmen in Stichpunkten oder kurzen Sätzen
- Pro Maßnahme: was wird getan, wie oft / wann (falls erwähnt)
- Beispiele: "Unterstützung bei der Körperpflege täglich morgens",
  "Medikamentengabe nach ärztlichem Plan", "Hilfestellung beim Transfer
  vom Bett zum Rollstuhl", "Sturzprophylaxe — Hausschuhe mit Profil"
- KEIN Pflegebericht-Stil, KEIN Fließtext-Bericht
- KEINE erfundenen Maßnahmen — nur was aus dem Input hervorgeht
- KEINE Diagnosen, keine medizinischen Bewertungen
- Wenn der Input bereits stichpunkthaft ist: in saubere deutsche
  Maßnahmen-Formulierungen übertragen

Gib NUR die Maßnahmenliste zurück.`;

// ── Generischer Default (Fallback) ────────────────────────────────────
const DEFAULT_SYSTEM_PROMPT = PFLEGEBERICHT_SYSTEM_PROMPT;

// ══════════════════════════════════════════════════════════════════════
// ROUTING — single source of truth on the server
// ══════════════════════════════════════════════════════════════════════
function getSystemPrompt(mode, sisField) {
  const m = (mode || '').toLowerCase().trim();
  const f = (sisField || '').toLowerCase().trim();

  if (m === 'pflegebericht') return PFLEGEBERICHT_SYSTEM_PROMPT;
  if (m === 'massnahmen')    return SIS_MASSNAHMEN_SYSTEM_PROMPT;

  if (m === 'sis') {
    switch (f) {
      case 'felda':
      case 'feld_a':
      case 'feld-a':
      case 'a':            return SIS_FELD_A_SYSTEM_PROMPT;
      case 'frage':        return SIS_FRAGE_SYSTEM_PROMPT;
      case 'tf1':          return SIS_TF1_SYSTEM_PROMPT;
      case 'tf2':          return SIS_TF2_SYSTEM_PROMPT;
      case 'tf3':          return SIS_TF3_SYSTEM_PROMPT;
      case 'tf4':          return SIS_TF4_SYSTEM_PROMPT;
      case 'tf5':          return SIS_TF5_SYSTEM_PROMPT;
      case 'tf6':          return SIS_TF6_SYSTEM_PROMPT;
      case 'leitgedanke':
      case 'leitgedanken': return SIS_LEITGEDANKEN_SYSTEM_PROMPT;
      case 'massnahmen':   return SIS_MASSNAHMEN_SYSTEM_PROMPT;
      default:             return SIS_FELD_A_SYSTEM_PROMPT;
    }
  }

  return DEFAULT_SYSTEM_PROMPT;
}

// ══════════════════════════════════════════════════════════════════════
// CHAT COMPLETION
// ══════════════════════════════════════════════════════════════════════
async function chatCompletion(prompt, maxTokens, temperature, apiKey, systemPrompt, imageDataUrl) {
  const sysContent = (typeof systemPrompt === 'string' && systemPrompt.trim())
    ? systemPrompt
    : DEFAULT_SYSTEM_PROMPT;

  // User message: plain text when no image, multimodal content array otherwise.
  const userContent = imageDataUrl
    ? [
        { type: 'text', text: prompt || '' },
        { type: 'image_url', image_url: { url: imageDataUrl } }
      ]
    : prompt;

  const r = await fetch(OPENAI_CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: [
        { role: 'system', content: sysContent },
        { role: 'user',   content: userContent }
      ],
      max_tokens: maxTokens,
      temperature: temperature
    })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || ('OpenAI error (' + r.status + ')');
    throw new Error(msg);
  }
  const text = data?.choices?.[0]?.message?.content || '';
  return text.trim();
}

// ══════════════════════════════════════════════════════════════════════
// HANDLER
// ══════════════════════════════════════════════════════════════════════
exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return json(500, { error: 'Server misconfigured: OPENAI_API_KEY missing.' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (_e) {
    return json(400, { error: 'Invalid JSON body.' });
  }

  const prompt           = typeof payload.prompt === 'string' ? payload.prompt : '';
  const maxTokens        = Number.isFinite(payload.maxTokens) ? payload.maxTokens : 700;
  const temperature      = Number.isFinite(payload.temperature) ? payload.temperature : 0.2;
  const explicitSysPrompt = typeof payload.systemPrompt === 'string' ? payload.systemPrompt : '';
  const mode             = typeof payload.mode === 'string' ? payload.mode : '';
  const sisField         = typeof payload.sisField === 'string' ? payload.sisField : '';
  const audio            = payload.audio;
  const image            = payload.image;
  const transcribeOnly   = payload.transcribeOnly === true;

  if (!prompt && !audio && !image) {
    return json(400, { error: 'prompt, audio or image required.' });
  }

  // RESOLVED system prompt:
  //   1. If client passes an explicit systemPrompt (e.g. wound vision),
  //      respect it.
  //   2. Otherwise route by mode/sisField (server-side single source of truth).
  //   3. Otherwise fall back to PFLEGEBERICHT default.
  const resolvedSystemPrompt = explicitSysPrompt && explicitSysPrompt.trim()
    ? explicitSysPrompt
    : getSystemPrompt(mode, sisField);

  try {
    // Kurzschluss: nur Whisper-Transkript zurückgeben (Voice-Input ohne KI-Nachbearbeitung)
    if (transcribeOnly) {
      if (!audio || !audio.base64) {
        return json(400, { error: 'audio required for transcribeOnly.' });
      }
      const transcript = await transcribeAudio(audio.base64, audio.mimeType, apiKey);
      return json(200, { text: transcript });
    }

    let finalPrompt = prompt;

    if (audio && audio.base64) {
      const transcript = await transcribeAudio(audio.base64, audio.mimeType, apiKey);
      finalPrompt = (prompt ? prompt + '\n\n' : '')
        + 'Transkript der Sprachaufnahme:\n"' + transcript + '"';
    }

    const imageDataUrl = (image && typeof image.dataUrl === 'string') ? image.dataUrl : '';
    const text = await chatCompletion(finalPrompt, maxTokens, temperature, apiKey, resolvedSystemPrompt, imageDataUrl);
    return json(200, { text });
  } catch (e) {
    return json(502, { error: e.message || 'Upstream error' });
  }
};
