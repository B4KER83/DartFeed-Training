// Training Capture v0.1 — session ID generation (spec section 4).
// Format: YYYY-MM-DD_NNN, sequence NNN counts sessions already recorded for
// today so IDs stay stable and human-sortable across multiple runs/day.
(function (global) {
  'use strict';

  function pad3(n) { var s = '' + n; while (s.length < 3) s = '0' + s; return s; }

  function generateSessionId() {
    return global.TC.Storage.getAllSessions().then(function (sessions) {
      var today = global.TC.Utils.todayDateString();
      var maxSeq = 0;
      sessions.forEach(function (s) {
        if (s.session_id.indexOf(today + '_') === 0) {
          var seq = parseInt(s.session_id.slice(today.length + 1), 10);
          if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
        }
      });
      return today + '_' + pad3(maxSeq + 1);
    });
  }

  global.TC = global.TC || {};
  global.TC.Session = { generateSessionId: generateSessionId };
})(window);
