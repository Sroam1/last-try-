// ══════════════════════════════════════════════════════════════════════
// data-store.js — Frontida Pflegedokumentation
// Supabase-first Datenhaltung mit localStorage als Offline-Cache
// ══════════════════════════════════════════════════════════════════════
//
// ARCHITEKTUR:
//   Supabase  = Primary (Source of Truth)
//   localStorage = Cache (Offline-Fallback, schneller Boot)
//   PC-Server = Optional (wird über pushToServer() in der HTML getriggert)
//
// ABHÄNGIGKEITEN (globale Variablen):
//   patients, allBerichte, TOUR_DATA, users — In-Memory-State im Haupt-Script
//   parseDate(datStr) — Datum-Parser im Haupt-Script
//   hashPin(pin) — PIN-Hashing im Haupt-Script
//
// ══════════════════════════════════════════════════════════════════════

// ── SUPABASE CONFIG ──────────────────────────────────────────────────

const SUPA_URL = 'https://xvnrkcoraihvmqfaefym.supabase.co';
const SUPA_KEY = 'sb_publishable_RvwPrZ6p66rG5DHbsC2a1A_T_a3YY38';
const SUPA_TABLE = 'frontida_data';

// ── OFFLINE QUEUE ────────────────────────────────────────────────────

let _offlineQueue = [];
let _syncInProgress = false;
let _lastSyncTime = 0;

// ── SUPABASE LOW-LEVEL API ───────────────────────────────────────────

async function supaGet(id) {
  const r = await fetch(
    SUPA_URL + '/rest/v1/' + SUPA_TABLE + '?id=eq.' + encodeURIComponent(id) + '&select=data,updated_at',
    { headers: { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY } }
  );
  if (!r.ok) throw new Error('Supabase GET error: ' + r.status);
  const d = await r.json();
  return d && d[0] ? d[0] : null;
}

async function supaSet(id, data) {
  const r = await fetch(SUPA_URL + '/rest/v1/' + SUPA_TABLE, {
    method: 'POST',
    headers: {
      'apikey': SUPA_KEY,
      'Authorization': 'Bearer ' + SUPA_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify({ id, data, updated_at: new Date().toISOString() })
  });
  if (!r.ok) throw new Error('Supabase SET error: ' + r.status);
}

function isOnline() {
  return navigator.onLine !== false;
}


// ── localStorage CACHE (Hilfsfunktionen) ─────────────────────────────

function cacheWrite(key, data) {
  try { localStorage.setItem('frontida_' + key, JSON.stringify(data)); }
  catch (e) { console.warn('Cache-Write fehlgeschlagen:', key, e); }
}

function cacheRead(key) {
  try {
    const raw = localStorage.getItem('frontida_' + key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}


// ── MERGE-STRATEGIEN ─────────────────────────────────────────────────
// Keine Daten gehen verloren: Union-Merge mit Deduplizierung

function mergeBerichte(local, remote) {
  // Berichte sind append-only. Merge = Union aller einzigartigen Einträge.
  // Einzigartigkeit: patId + dat + autor (wie im bisherigen supaSync)
  const all = [...(remote || [])];
  const keys = new Set(all.map(b => b.patId + '|' + b.dat + '|' + b.autor));
  (local || []).forEach(b => {
    const key = b.patId + '|' + b.dat + '|' + b.autor;
    if (!keys.has(key)) { all.push(b); keys.add(key); }
  });
  all.sort((a, b) => {
    const da = parseDate(a.dat), db = parseDate(b.dat);
    return (db || 0) - (da || 0);
  });
  return all;
}

function mergePatients(local, remote) {
  // Patienten mergen: Remote als Basis, lokale Ergänzungen dazu.
  // Bei Konflikten: mehr Berichte + neuere SIS gewinnt.
  const merged = [...(remote || [])];
  const byId = {};
  merged.forEach((p, i) => { byId[p.id] = i; });

  (local || []).forEach(lp => {
    if (byId[lp.id] !== undefined) {
      const rp = merged[byId[lp.id]];
      // Mehr Berichte gewinnen
      if (lp.berichte && (!rp.berichte || lp.berichte.length > rp.berichte.length)) {
        rp.berichte = lp.berichte;
        rp.status = lp.status;
      }
      // SIS: neuere gewinnt (falls vorhanden)
      if (lp.sis && (!rp.sis || (lp.sis.lastEditedAt && (!rp.sis.lastEditedAt || lp.sis.lastEditedAt > rp.sis.lastEditedAt)))) {
        rp.sis = lp.sis;
      }
      // Wunden mergen
      if (lp.wunden && (!rp.wunden || lp.wunden.length > rp.wunden.length)) {
        rp.wunden = lp.wunden;
      }
      // active/note: lokale Änderung übernehmen wenn vorhanden
      if (typeof lp.active !== 'undefined') rp.active = lp.active;
      if (lp.note) rp.note = lp.note;
    } else {
      // Neuer Patient nur lokal → hinzufügen
      merged.push(lp);
      byId[lp.id] = merged.length - 1;
    }
  });
  return merged;
}

function mergeTours(local, remote) {
  // Tours mergen: alle Tour-IDs aus beiden Quellen, bei Konflikten mehr Patienten gewinnt
  const merged = Object.assign({}, remote || {});
  Object.keys(local || {}).forEach(k => {
    if (!merged[k]) {
      merged[k] = local[k];
    } else {
      if ((local[k].ids || []).length > (merged[k].ids || []).length) {
        merged[k] = local[k];
      }
    }
  });
  return merged;
}

function mergeUsers(local, remote) {
  // Users mergen: Remote als Basis, lokale neue Benutzer dazu
  const merged = [...(remote || [])];
  const ids = new Set(merged.map(u => u.id));
  (local || []).forEach(u => {
    if (!ids.has(u.id)) { merged.push(u); ids.add(u.id); }
  });
  return merged;
}


// ── DATEN LADEN (Supabase-first) ─────────────────────────────────────

async function DataStore_loadAll() {
  let source = 'cache';

  if (isOnline()) {
    try {
      // Supabase als primäre Quelle
      const [berRow, patRow, tourRow, userRow] = await Promise.all([
        supaGet('berichte'),
        supaGet('patients'),
        supaGet('tours'),
        supaGet('users')
      ]);

      const remoteBerichte = berRow?.data?.berichte || [];
      const remotePatients = patRow?.data?.patients || [];
      const remoteTours = tourRow?.data?.tours || {};
      const remoteUsers = userRow?.data?.users || [];

      // Lokalen Cache lesen für Merge (falls offline Daten entstanden sind)
      const cachedBerichte = cacheRead('berichte') || [];
      const cachedPatStatus = cacheRead('pat_status') || {};
      const cachedTours = cacheRead('tours') || {};
      const cachedUsers = cacheRead('users') || [];

      // Lokale Patienten aus Cache rekonstruieren
      let cachedPatients = [];
      if (cachedPatStatus && Object.keys(cachedPatStatus).length > 0) {
        cachedPatients = Object.keys(cachedPatStatus).map(id => ({
          id,
          berichte: cachedPatStatus[id].berichte || [],
          status: cachedPatStatus[id].status || 'offen',
          active: typeof cachedPatStatus[id].active !== 'undefined' ? cachedPatStatus[id].active : true,
          note: cachedPatStatus[id].note || '',
          sis: cachedPatStatus[id].sis || null,
          wunden: cachedPatStatus[id].wunden || []
        }));
      }

      // Merge: Remote + lokal vereinen (kein Datenverlust)
      allBerichte = mergeBerichte(cachedBerichte, remoteBerichte);
      const mergedPatients = mergePatients(cachedPatients, remotePatients);
      TOUR_DATA = mergeTours(cachedTours, remoteTours);

      // Patienten in globales Array übernehmen
      patients.length = 0;
      mergedPatients.forEach(p => patients.push(p));

      // Users: Remote-Daten verfügbar?
      if (remoteUsers.length > 0) {
        const mergedUsers = mergeUsers(cachedUsers, remoteUsers);
        users.length = 0;
        mergedUsers.forEach(u => users.push(u));
      } else if (cachedUsers.length > 0) {
        users.length = 0;
        cachedUsers.forEach(u => users.push(u));
      }
      // (Falls weder Remote noch Cache Users hat → loadUsers() im Haupt-Script
      //  erstellt Defaults. Das passiert beim allerersten Start.)

      source = 'supabase';

      // Lokalen Cache aktualisieren
      DataStore_cacheAll();

      // Wenn lokale Daten dazugemischt wurden, zurück nach Supabase pushen
      if (cachedBerichte.length > 0 || Object.keys(cachedPatStatus).length > 0) {
        DataStore_pushAll().catch(e => console.warn('Post-merge push error:', e));
      }

      console.log('Daten geladen von Supabase:', allBerichte.length, 'Berichte,', patients.length, 'Patienten');
      _lastSyncTime = Date.now();
      return { ok: true, source };

    } catch (e) {
      console.warn('Supabase-Load fehlgeschlagen, nutze Cache:', e.message);
      // Fallthrough zu Cache
    }
  }

  // Offline-Fallback: Aus localStorage laden
  DataStore_loadFromCache();
  console.log('Daten geladen aus Cache:', allBerichte.length, 'Berichte,', patients.length, 'Patienten');
  return { ok: true, source: 'cache' };
}

function DataStore_loadFromCache() {
  // Berichte aus Cache
  const cachedBerichte = cacheRead('berichte');
  if (cachedBerichte && cachedBerichte.length > 0) {
    allBerichte = cachedBerichte;
  }

  // Patienten-Status aus Cache
  const cachedPatStatus = cacheRead('pat_status');
  if (cachedPatStatus) {
    // Falls patients-Array schon Einträge hat (aus Supabase beim vorherigen Load),
    // enriche sie. Falls leer, erstelle aus Cache.
    if (patients.length === 0) {
      Object.keys(cachedPatStatus).forEach(id => {
        patients.push({
          id,
          berichte: cachedPatStatus[id].berichte || [],
          status: cachedPatStatus[id].status || 'offen',
          active: typeof cachedPatStatus[id].active !== 'undefined' ? cachedPatStatus[id].active : true,
          note: cachedPatStatus[id].note || '',
          sis: cachedPatStatus[id].sis || null,
          wunden: cachedPatStatus[id].wunden || []
        });
      });
    } else {
      patients.forEach(p => {
        if (cachedPatStatus[p.id]) {
          p.berichte = cachedPatStatus[p.id].berichte || p.berichte || [];
          p.status = cachedPatStatus[p.id].status || p.status || 'offen';
          if (typeof cachedPatStatus[p.id].active !== 'undefined') p.active = cachedPatStatus[p.id].active;
          if (cachedPatStatus[p.id].note) p.note = cachedPatStatus[p.id].note;
          if (cachedPatStatus[p.id].sis) p.sis = cachedPatStatus[p.id].sis;
          if (cachedPatStatus[p.id].wunden) p.wunden = cachedPatStatus[p.id].wunden;
        }
      });
    }
  }

  // Tours aus Cache
  const cachedTours = cacheRead('tours');
  if (cachedTours && Object.keys(cachedTours).length > 0) {
    TOUR_DATA = cachedTours;
  }

  // Users aus Cache
  const cachedUsers = cacheRead('users');
  if (cachedUsers && cachedUsers.length > 0) {
    users.length = 0;
    cachedUsers.forEach(u => users.push(u));
  }
}


// ── DATEN SPEICHERN (Supabase-first) ─────────────────────────────────

async function DataStore_saveAll() {
  // Immer lokal cachen (schnell, synchron)
  DataStore_cacheAll();

  // Supabase pushen
  if (isOnline()) {
    try {
      await DataStore_pushAll();
      _lastSyncTime = Date.now();
      return { ok: true, target: 'supabase' };
    } catch (e) {
      console.warn('Supabase-Save fehlgeschlagen, in Queue:', e.message);
      _queueRetry();
      return { ok: false, target: 'cache', error: e.message };
    }
  } else {
    _queueRetry();
    return { ok: false, target: 'cache', error: 'offline' };
  }
}

// Einzelne Entität speichern (für gezielte Saves)
async function DataStore_saveBerichte() {
  const patData = _buildPatData();
  cacheWrite('berichte', allBerichte);
  cacheWrite('pat_status', patData);
  if (isOnline()) {
    try {
      await Promise.all([
        supaSet('berichte', { berichte: allBerichte, updated_at: new Date().toISOString() }),
        supaSet('patients', { patients: _buildPatArray(), updated_at: new Date().toISOString() })
      ]);
    } catch (e) {
      console.warn('Bericht-Save zu Supabase fehlgeschlagen:', e.message);
      _queueRetry();
    }
  } else { _queueRetry(); }
}

async function DataStore_saveTours() {
  cacheWrite('tours', TOUR_DATA);
  if (isOnline()) {
    try {
      await supaSet('tours', { tours: TOUR_DATA, updated_at: new Date().toISOString() });
    } catch (e) {
      console.warn('Tour-Save zu Supabase fehlgeschlagen:', e.message);
      _queueRetry();
    }
  } else { _queueRetry(); }
}

async function DataStore_saveUsers() {
  const userData = users.map(u => ({ id: u.id, name: u.name, pinHash: u.pinHash, role: u.role, canSIS: u.canSIS }));
  cacheWrite('users', userData);
  if (isOnline()) {
    try {
      await supaSet('users', { users: userData, updated_at: new Date().toISOString() });
    } catch (e) {
      console.warn('User-Save zu Supabase fehlgeschlagen:', e.message);
      _queueRetry();
    }
  } else { _queueRetry(); }
}


// ── INTERNES ─────────────────────────────────────────────────────────

function _buildPatData() {
  const patData = {};
  patients.forEach(p => {
    patData[p.id] = {
      berichte: p.berichte, status: p.status, active: p.active,
      note: p.note || '', sis: p.sis || null, wunden: p.wunden || []
    };
  });
  return patData;
}

function _buildPatArray() {
  return patients.map(p => ({
    id: p.id, berichte: p.berichte, status: p.status,
    active: p.active, note: p.note || '', sis: p.sis || null, wunden: p.wunden || []
  }));
}

function DataStore_cacheAll() {
  cacheWrite('berichte', allBerichte);
  cacheWrite('pat_status', _buildPatData());
  cacheWrite('tours', TOUR_DATA);
  const userData = users.map(u => ({ id: u.id, name: u.name, pinHash: u.pinHash, role: u.role, canSIS: u.canSIS }));
  cacheWrite('users', userData);
  cacheWrite('last_save', Date.now());
}

async function DataStore_pushAll() {
  const patArray = _buildPatArray();
  const userData = users.map(u => ({ id: u.id, name: u.name, pinHash: u.pinHash, role: u.role, canSIS: u.canSIS }));
  const ts = new Date().toISOString();
  await Promise.all([
    supaSet('berichte', { berichte: allBerichte, updated_at: ts }),
    supaSet('patients', { patients: patArray, updated_at: ts }),
    supaSet('tours', { tours: TOUR_DATA, updated_at: ts }),
    supaSet('users', { users: userData, updated_at: ts })
  ]);
}

function _queueRetry() {
  // Markiere dass ein Push ausstehend ist
  if (!_offlineQueue.includes('pending')) {
    _offlineQueue.push('pending');
  }
}

async function DataStore_flushQueue() {
  if (_offlineQueue.length === 0 || _syncInProgress) return;
  if (!isOnline()) return;
  _syncInProgress = true;
  try {
    await DataStore_pushAll();
    _offlineQueue = [];
    console.log('Offline-Queue geflusht');
  } catch (e) {
    console.warn('Queue-Flush fehlgeschlagen:', e.message);
  } finally {
    _syncInProgress = false;
  }
}


// ── SYNC (bidirektional, mit Merge) ──────────────────────────────────

async function DataStore_sync() {
  if (_syncInProgress) return false;
  if (!isOnline()) return false;
  _syncInProgress = true;

  try {
    // Schritt 1: Remote-Daten laden
    const [berRow, patRow, tourRow, userRow] = await Promise.all([
      supaGet('berichte'),
      supaGet('patients'),
      supaGet('tours'),
      supaGet('users')
    ]);

    // Schritt 2: Merge mit lokalen Daten
    const remoteBerichte = berRow?.data?.berichte || [];
    const remotePatients = patRow?.data?.patients || [];
    const remoteTours = tourRow?.data?.tours || {};
    const remoteUsers = userRow?.data?.users || [];

    allBerichte = mergeBerichte(allBerichte, remoteBerichte);

    const mergedPatients = mergePatients(
      patients.map(p => ({ id: p.id, berichte: p.berichte, status: p.status, active: p.active, note: p.note || '', sis: p.sis || null, wunden: p.wunden || [] })),
      remotePatients
    );
    patients.length = 0;
    mergedPatients.forEach(p => patients.push(p));

    TOUR_DATA = mergeTours(TOUR_DATA, remoteTours);

    if (remoteUsers.length > 0) {
      const currentUsers = users.map(u => ({ id: u.id, name: u.name, pinHash: u.pinHash, role: u.role, canSIS: u.canSIS }));
      const mergedUsers = mergeUsers(currentUsers, remoteUsers);
      users.length = 0;
      mergedUsers.forEach(u => users.push(u));
    }

    // Schritt 3: Merged state zurück nach Supabase + Cache
    await DataStore_pushAll();
    DataStore_cacheAll();
    _offlineQueue = [];
    _lastSyncTime = Date.now();

    console.log('Sync OK:', allBerichte.length, 'Berichte,', patients.length, 'Patienten,', Object.keys(TOUR_DATA).length, 'Touren');
    return true;

  } catch (e) {
    console.warn('Sync-Fehler:', e.message);
    return false;
  } finally {
    _syncInProgress = false;
  }
}


// ── ONLINE/OFFLINE LISTENER ──────────────────────────────────────────

window.addEventListener('online', function() {
  console.log('Wieder online — Queue wird geflusht');
  setTimeout(function() { DataStore_flushQueue(); }, 2000);
});


// ── RÜCKWÄRTSKOMPATIBILITÄT ──────────────────────────────────────────
// Diese Aliase erlauben den schrittweisen Umbau im Haupt-Script.
// Bestehender Code der saveBerichte() aufruft, funktioniert weiter.

var saveBerichte = DataStore_saveBerichte;
var saveUsers = DataStore_saveUsers;
var saveTourData = DataStore_saveTours;
