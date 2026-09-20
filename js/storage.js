// Training Capture v0.1 — IndexedDB storage.
// Images are large binary blobs, so they live in IndexedDB (never
// localStorage — localStorage is string-only and tiny-quota). Each
// session/round/capture record is independently retrievable.
(function (global) {
  'use strict';

  var DB_NAME = 'TrainingCaptureDB';
  var DB_VERSION = 1;
  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('sessions')) {
          db.createObjectStore('sessions', { keyPath: 'session_id' });
        }
        if (!db.objectStoreNames.contains('rounds')) {
          var rounds = db.createObjectStore('rounds', { keyPath: 'round_id' });
          rounds.createIndex('by_session', 'session_id', { unique: false });
        }
        if (!db.objectStoreNames.contains('captures')) {
          var captures = db.createObjectStore('captures', { keyPath: 'capture_id' });
          captures.createIndex('by_round', 'round_id', { unique: false });
          captures.createIndex('by_session', 'session_id', { unique: false });
        }
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror = function (e) { reject(e.target.error); };
    });
    return dbPromise;
  }

  function tx(storeNames, mode) {
    return open().then(function (db) { return db.transaction(storeNames, mode); });
  }

  function put(storeName, value) {
    return tx([storeName], 'readwrite').then(function (t) {
      return new Promise(function (resolve, reject) {
        var req = t.objectStore(storeName).put(value);
        req.onsuccess = function () { resolve(value); };
        req.onerror = function (e) { reject(e.target.error); };
      });
    });
  }

  function get(storeName, key) {
    return tx([storeName], 'readonly').then(function (t) {
      return new Promise(function (resolve, reject) {
        var req = t.objectStore(storeName).get(key);
        req.onsuccess = function (e) { resolve(e.target.result || null); };
        req.onerror = function (e) { reject(e.target.error); };
      });
    });
  }

  function getAll(storeName) {
    return tx([storeName], 'readonly').then(function (t) {
      return new Promise(function (resolve, reject) {
        var req = t.objectStore(storeName).getAll();
        req.onsuccess = function (e) { resolve(e.target.result || []); };
        req.onerror = function (e) { reject(e.target.error); };
      });
    });
  }

  function getAllByIndex(storeName, indexName, value) {
    return tx([storeName], 'readonly').then(function (t) {
      return new Promise(function (resolve, reject) {
        var req = t.objectStore(storeName).index(indexName).getAll(value);
        req.onsuccess = function (e) { resolve(e.target.result || []); };
        req.onerror = function (e) { reject(e.target.error); };
      });
    });
  }

  function remove(storeName, key) {
    return tx([storeName], 'readwrite').then(function (t) {
      return new Promise(function (resolve, reject) {
        var req = t.objectStore(storeName).delete(key);
        req.onsuccess = function () { resolve(); };
        req.onerror = function (e) { reject(e.target.error); };
      });
    });
  }

  function deleteRoundCascade(roundId) {
    return getAllByIndex('captures', 'by_round', roundId).then(function (caps) {
      return Promise.all(caps.map(function (c) { return remove('captures', c.capture_id); }));
    }).then(function () {
      return remove('rounds', roundId);
    });
  }

  function deleteSessionCascade(sessionId) {
    return getAllByIndex('rounds', 'by_session', sessionId).then(function (rounds) {
      return Promise.all(rounds.map(function (r) { return deleteRoundCascade(r.round_id); }));
    }).then(function () {
      return remove('sessions', sessionId);
    });
  }

  global.TC = global.TC || {};
  global.TC.Storage = {
    saveSession: function (s) { return put('sessions', s); },
    getSession: function (id) { return get('sessions', id); },
    getAllSessions: function () { return getAll('sessions'); },

    saveRound: function (r) { return put('rounds', r); },
    getRound: function (id) { return get('rounds', id); },
    getRoundsForSession: function (sessionId) { return getAllByIndex('rounds', 'by_session', sessionId); },

    saveCapture: function (c) { return put('captures', c); },
    getCapture: function (id) { return get('captures', id); },
    getCapturesForRound: function (roundId) { return getAllByIndex('captures', 'by_round', roundId); },
    getCapturesForSession: function (sessionId) { return getAllByIndex('captures', 'by_session', sessionId); },
    deleteCapture: function (id) { return remove('captures', id); },

    deleteRound: function (roundId) { return deleteRoundCascade(roundId); },
    deleteSession: function (sessionId) { return deleteSessionCascade(sessionId); }
  };
})(window);
