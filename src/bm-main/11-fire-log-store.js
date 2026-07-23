// ── 11-fire-log-store.js ── Durable Fire Diagnostic Log V2 ───────────────
// Kept dependency-free because this file is concatenated into the MAIN world.

var _FIRE_LOG_V2_SENSITIVE_HEADERS = {
  'authorization': true,
  'cookie': true,
  'proxy-authorization': true,
  'bigmodel-organization': true,
  'bigmodel-project': true,
  'set-cookie': true
};

function _fireLogV2Sanitize(value, inHeaders) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    var list = [];
    for (var i = 0; i < value.length; i++) {
      var item = value[i];
      if (inHeaders && Array.isArray(item) && typeof item[0] === 'string' && _FIRE_LOG_V2_SENSITIVE_HEADERS[item[0].toLowerCase()]) continue;
      list.push(_fireLogV2Sanitize(item, inHeaders));
    }
    return list;
  }
  var copy = {};
  for (var key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (inHeaders && _FIRE_LOG_V2_SENSITIVE_HEADERS[key.toLowerCase()]) continue;
    copy[key] = _fireLogV2Sanitize(value[key], key.toLowerCase() === 'headers');
  }
  return copy;
}

function _fireLogV2ManifestVersion() {
  try {
    if (typeof _runtimeManifestVersion !== 'undefined' && _runtimeManifestVersion) return _runtimeManifestVersion;
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) return chrome.runtime.getManifest().version || '';
    if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.getManifest) return browser.runtime.getManifest().version || '';
  } catch (e) {}
  return '';
}

function createFireLogStore(options) {
  options = options || {};
  var dbName = options.dbName || 'qianggouDiagnostics';
  var idb = options.indexedDB || (typeof indexedDB !== 'undefined' ? indexedDB : null);
  var extensionVersion = options.extensionVersion !== undefined ? options.extensionVersion : _fireLogV2ManifestVersion();
  var onPersistenceError = typeof options.onPersistenceError === 'function' ? options.onPersistenceError : function() {};
  var fallback = { sessions: {}, runs: {}, events: [], shots: {} };
  var fallbackChanges = { sessions: {}, runs: {}, shots: {} };
  var fallbackRevision = 0;
  var fallbackEventSequence = Date.now() * 1000;
  var dbPromise = null;

  function warn(error) {
    try { onPersistenceError(error); } catch (e) {}
  }

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function(resolve) {
      if (!idb || !idb.open) { warn(new Error('IndexedDB unavailable')); resolve(null); return; }
      var request;
      try { request = idb.open(dbName, 1); } catch (error) { warn(error); resolve(null); return; }
      request.onupgradeneeded = function() {
        var db = request.result;
        if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'sessionId' });
        if (!db.objectStoreNames.contains('runs')) db.createObjectStore('runs', { keyPath: 'runId' });
        if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'sequence', autoIncrement: true });
        if (!db.objectStoreNames.contains('shots')) db.createObjectStore('shots', { keyPath: 'shotId' });
      };
      request.onsuccess = function() { resolve(request.result); };
      request.onerror = function() { warn(request.error || new Error('IndexedDB open failed')); resolve(null); };
    });
    return dbPromise;
  }

  function keyFor(store, record) {
    return store === 'sessions' ? record.sessionId : store === 'runs' ? record.runId : record.shotId;
  }

  function remember(store, record) {
    if (store === 'events') {
      var eventRecord = _fireLogV2Sanitize(record, false);
      if (eventRecord.sequence == null) eventRecord.sequence = ++fallbackEventSequence;
      for (var i = 0; i < fallback.events.length; i++) {
        if (fallback.events[i].sequence === eventRecord.sequence) {
          fallback.events[i] = mergeValues(fallback.events[i], eventRecord);
          return fallback.events[i];
        }
      }
      fallback.events.push(eventRecord);
      return eventRecord;
    }
    var key = keyFor(store, record);
    if (key != null) {
      var clean = _fireLogV2Sanitize(record, false);
      fallback[store][key] = mergeValues(fallback[store][key], clean);
      if (!fallbackChanges[store][key]) fallbackChanges[store][key] = [];
      fallbackChanges[store][key].push({ revision: ++fallbackRevision, value: clean });
    }
    return fallback[store][key] || _fireLogV2Sanitize(record, false);
  }

  function clearAbsorbedFallback(store, key, absorbedRevision) {
    var changes = fallbackChanges[store][key] || [];
    var remaining = [];
    for (var i = 0; i < changes.length; i++) {
      if (changes[i].revision > absorbedRevision) remaining.push(changes[i]);
    }
    if (!remaining.length) {
      delete fallback[store][key];
      delete fallbackChanges[store][key];
      return;
    }
    var record;
    for (var j = 0; j < remaining.length; j++) record = mergeValues(record, remaining[j].value);
    fallback[store][key] = record;
    fallbackChanges[store][key] = remaining;
  }

  function write(store, record) {
    var clean = _fireLogV2Sanitize(record || {}, false);
    return open().then(function(db) {
      if (!db) return remember(store, clean);
      var recordKey = store === 'events' ? null : keyFor(store, clean);
      var fallbackSnapshot = recordKey == null ? undefined : fallback[store][recordKey];
      var changes = recordKey == null ? null : fallbackChanges[store][recordKey];
      var fallbackRevisionSnapshot = changes && changes.length ? changes[changes.length - 1].revision : 0;
      return new Promise(function(resolve) {
        var transaction;
        try { transaction = db.transaction(store, 'readwrite'); } catch (error) { warn(error); resolve(remember(store, clean)); return; }
        var settled = false;
        var written = clean;
        function fallbackWrite(error) {
          if (settled) return;
          settled = true;
          warn(error || new Error('IndexedDB transaction failed'));
          resolve(remember(store, clean));
        }
        function completeWrite() {
          if (settled) return;
          settled = true;
          if (fallbackSnapshot !== undefined) clearAbsorbedFallback(store, recordKey, fallbackRevisionSnapshot);
          resolve(written);
        }
        transaction.oncomplete = completeWrite;
        transaction.onabort = function() { fallbackWrite(transaction.error || new Error('IndexedDB transaction aborted')); };
        transaction.onerror = function() { fallbackWrite(transaction.error || new Error('IndexedDB transaction failed')); };
        function put(record) {
          var request;
          try { request = transaction.objectStore(store).put(record); } catch (error) { fallbackWrite(error); return; }
          request.onsuccess = function() { written = record; };
          request.onerror = function() { fallbackWrite(request.error || new Error('IndexedDB write failed')); };
        }
        if (store === 'events') {
          var eventRequest;
          try { eventRequest = transaction.objectStore(store).add(clean); } catch (error) { fallbackWrite(error); return; }
          eventRequest.onsuccess = function() { clean.sequence = eventRequest.result; written = clean; };
          eventRequest.onerror = function() { fallbackWrite(eventRequest.error || new Error('IndexedDB write failed')); };
        } else {
          var getRequest;
          try { getRequest = transaction.objectStore(store).get(recordKey); } catch (error) { fallbackWrite(error); return; }
          getRequest.onsuccess = function() {
            put(mergeValues(mergeValues(getRequest.result, fallbackSnapshot), clean));
          };
          getRequest.onerror = function() { fallbackWrite(getRequest.error || new Error('IndexedDB read before write failed')); };
        }
      });
    }).catch(function(error) { warn(error); return remember(store, clean); });
  }

  function getAll(store) {
    return open().then(function(db) {
      if (!db) return [];
      return new Promise(function(resolve) {
        var transaction;
        try { transaction = db.transaction(store, 'readonly'); } catch (error) { warn(error); resolve([]); return; }
        var settled = false;
        var records = [];
        function finish(value, error) {
          if (settled) return;
          settled = true;
          if (error) warn(error);
          resolve(value);
        }
        transaction.oncomplete = function() { finish(records); };
        transaction.onabort = function() { finish([], transaction.error || new Error('IndexedDB read transaction aborted')); };
        transaction.onerror = function() { finish([], transaction.error || new Error('IndexedDB read transaction failed')); };
        var request = transaction.objectStore(store).getAll();
        request.onsuccess = function() { records = request.result || []; };
        request.onerror = function() { finish([], request.error || new Error('IndexedDB read failed')); };
      });
    }).catch(function(error) { warn(error); return []; });
  }

  function mergeValues(dbValue, fallbackValue) {
    var key;
    if (fallbackValue === undefined) return dbValue;
    if (dbValue === undefined) return fallbackValue;
    if (Array.isArray(dbValue) && Array.isArray(fallbackValue)) {
      var mergedArray = dbValue.slice();
      for (var i = 0; i < fallbackValue.length; i++) {
        var duplicate = false;
        for (var j = 0; j < mergedArray.length; j++) {
          if (JSON.stringify(mergedArray[j]) === JSON.stringify(fallbackValue[i])) { duplicate = true; break; }
        }
        if (!duplicate) mergedArray.push(fallbackValue[i]);
      }
      return mergedArray;
    }
    if (dbValue && fallbackValue && typeof dbValue === 'object' && typeof fallbackValue === 'object') {
      var mergedObject = {}, dbKey;
      for (dbKey in dbValue) if (Object.prototype.hasOwnProperty.call(dbValue, dbKey)) mergedObject[dbKey] = dbValue[dbKey];
      for (key in fallbackValue) if (Object.prototype.hasOwnProperty.call(fallbackValue, key)) mergedObject[key] = mergeValues(mergedObject[key], fallbackValue[key]);
      return mergedObject;
    }
    return fallbackValue;
  }

  function mergeByKey(dbRecords, memoryRecords, key) {
    var result = {}, i;
    for (i = 0; i < dbRecords.length; i++) result[dbRecords[i][key]] = dbRecords[i];
    for (i = 0; i < memoryRecords.length; i++) {
      var id = memoryRecords[i][key];
      result[id] = mergeValues(result[id], memoryRecords[i]);
    }
    var merged = [];
    for (var id in result) if (Object.prototype.hasOwnProperty.call(result, id)) merged.push(result[id]);
    return merged;
  }

  function readAll(sessionId) {
    return Promise.all([getAll('sessions'), getAll('runs'), getAll('events'), getAll('shots')]).then(function(records) {
      var sessions = mergeByKey(records[0], Object.keys(fallback.sessions).map(function(key) { return fallback.sessions[key]; }), 'sessionId');
      var runs = mergeByKey(records[1], Object.keys(fallback.runs).map(function(key) { return fallback.runs[key]; }), 'runId');
      var events = mergeByKey(records[2], fallback.events, 'sequence');
      var shots = mergeByKey(records[3], Object.keys(fallback.shots).map(function(key) { return fallback.shots[key]; }), 'shotId');
      function belongs(record) { return !sessionId || record.sessionId === sessionId; }
      events.sort(function(a, b) { return a.sequence - b.sequence; });
      return {
        session: sessions.filter(function(record) { return !sessionId || record.sessionId === sessionId; })[0] || {},
        runs: runs.filter(belongs), events: events.filter(belongs), shots: shots.filter(belongs)
      };
    });
  }

  return {
    writeSession: function(record) { return write('sessions', record); },
    writeRun: function(record) { return write('runs', record); },
    writeEvent: function(record) { return write('events', record); },
    writeShot: function(record) { return write('shots', record); },
    readAll: readAll,
    exportLog: function(sessionId) {
      return readAll(sessionId).then(function(data) {
        return { schemaVersion: 2, exportedAt: new Date().toISOString(), extensionVersion: extensionVersion || '', session: data.session, runs: data.runs, events: data.events, shots: data.shots };
      });
    },
    setPersistenceErrorHandler: function(handler) { onPersistenceError = typeof handler === 'function' ? handler : function() {}; }
  };
}
