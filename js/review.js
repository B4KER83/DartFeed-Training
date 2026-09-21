// Training Capture v0.1 — session/round/dart browser (spec section 23).
// Read-only against the original stored blobs except for the reviewer's
// own good/bad mark and explicit deletes — never mutates image bytes.
(function (global) {
  'use strict';

  var root = null;
  var objectUrls = [];

  function init(rootEl) {
    root = rootEl;
  }

  function revokeAllUrls() {
    objectUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    objectUrls = [];
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function refresh() {
    revokeAllUrls();
    root.innerHTML = '';
    global.TC.Storage.getAllSessions().then(function (sessions) {
      sessions.sort(function (a, b) { return (b.started_at || '').localeCompare(a.started_at || ''); });
      if (!sessions.length) {
        root.appendChild(el('p', null, 'No sessions recorded yet.'));
        return;
      }
      sessions.forEach(renderSession);
    });
  }

  function renderSession(session) {
    var block = el('div', 'session-block');
    var header = el('div', 'session-header');
    header.appendChild(el('b', null, 'Session ' + session.session_id));
    var actions = el('div', null);
    var exportBtn = el('button', null, 'Export ZIP');
    exportBtn.onclick = function () {
      exportBtn.disabled = true;
      exportBtn.textContent = 'Exporting…';
      global.TC.Exporter.exportSession(session.session_id).then(function () {
        exportBtn.textContent = 'Export ZIP';
        exportBtn.disabled = false;
      }).catch(function (err) {
        alert('Export failed: ' + err.message);
        exportBtn.textContent = 'Export ZIP';
        exportBtn.disabled = false;
      });
    };
    var deleteBtn = el('button', 'danger', 'Delete session');
    deleteBtn.onclick = function () {
      if (!confirm('Delete session ' + session.session_id + ' and all its rounds/captures? This cannot be undone.')) return;
      global.TC.Storage.deleteSession(session.session_id).then(refresh);
    };
    actions.appendChild(exportBtn);
    actions.appendChild(deleteBtn);
    header.appendChild(actions);
    block.appendChild(header);

    global.TC.Storage.getRoundsForSession(session.session_id).then(function (rounds) {
      rounds.sort(function (a, b) { return a.round_number - b.round_number; });
      if (!rounds.length) {
        block.appendChild(el('p', null, 'No rounds yet.'));
        return;
      }
      rounds.forEach(function (round) { renderRound(block, round); });
    });

    root.appendChild(block);
  }

  function renderRound(container, round) {
    var block = el('div', 'round-block');
    var header = el('div', 'round-header');
    header.appendChild(el('b', null, 'Round ' + global.TC.Utils.pad4(round.round_number)));
    var statusPill = el('span', 'round-status ' + round.round_status, round.round_status + ' (' + round.dart_count + ' dart' + (round.dart_count === 1 ? '' : 's') + ')');
    header.appendChild(statusPill);
    var deleteBtn = el('button', 'danger', 'Delete round');
    deleteBtn.onclick = function () {
      if (!confirm('Delete round ' + round.round_id + '?')) return;
      global.TC.Storage.deleteRound(round.round_id).then(refresh);
    };
    header.appendChild(deleteBtn);
    block.appendChild(header);

    var thumbs = el('div', 'dart-thumbs');
    block.appendChild(thumbs);

    global.TC.Storage.getCapturesForRound(round.round_id).then(function (captures) {
      captures.sort(function (a, b) { return a.dart_number - b.dart_number; });
      captures.forEach(function (capture) { thumbs.appendChild(renderCapture(capture)); });
    });

    container.appendChild(block);
  }

  function renderCapture(capture) {
    var wrap = el('div', 'dart-thumb' + (capture.mark ? ' mark-' + capture.mark : ''));
    var url = URL.createObjectURL(capture.thumbnail_blob || capture.image_blob);
    objectUrls.push(url);
    var img = document.createElement('img');
    img.src = url;
    img.alt = 'dart ' + capture.dart_number;
    img.onclick = function () { openLightbox(capture); };
    wrap.appendChild(img);
    wrap.appendChild(el('div', null, 'Dart ' + capture.dart_number + ' · conf ' + capture.detection_confidence));
    if (capture.camera_movement_detected) wrap.appendChild(el('div', null, '⚠ camera moved'));

    var markRow = el('div', 'mark-row');
    var goodBtn = el('button', null, 'Good');
    goodBtn.onclick = function () { setMark(capture, 'good'); };
    var badBtn = el('button', null, 'Bad');
    badBtn.onclick = function () { setMark(capture, 'bad'); };
    var delBtn = el('button', null, 'Delete');
    delBtn.onclick = function () {
      if (!confirm('Delete this capture?')) return;
      global.TC.Storage.deleteCapture(capture.capture_id).then(refresh);
    };
    markRow.appendChild(goodBtn);
    markRow.appendChild(badBtn);
    markRow.appendChild(delBtn);
    wrap.appendChild(markRow);
    return wrap;
  }

  function setMark(capture, mark) {
    capture.mark = (capture.mark === mark) ? null : mark;
    global.TC.Storage.saveCapture(capture).then(refresh);
  }

  function openLightbox(capture) {
    var url = URL.createObjectURL(capture.image_blob);
    objectUrls.push(url);
    var lb = document.getElementById('lightbox');
    document.getElementById('lightbox-img').src = url;
    lb.classList.remove('hidden');
  }

  global.TC = global.TC || {};
  global.TC.Review = { init: init, refresh: refresh };
})(window);
