// Training Capture v0.1 — manual board Region Of Interest.
// Spec explicitly allows (section 15) a manual ROI in place of automatic
// board localisation for v0.1: "Do not make sophisticated automatic
// calibration a prerequisite." The overlay canvas's backing resolution is
// kept equal to the detection resolution, so a click on it maps 1:1 to
// detection-space pixel coordinates with no extra scaling math.
(function (global) {
  'use strict';

  var overlayCanvas = null;
  var dragging = false;
  var dragStart = null;
  var currentDrag = null;
  var onChangeCb = null;

  function init(canvasEl, onChange) {
    overlayCanvas = canvasEl;
    onChangeCb = onChange;
    overlayCanvas.addEventListener('mousedown', function (e) {
      if (!overlayCanvas.dataset.roiEditing) return;
      var rect = overlayCanvas.getBoundingClientRect();
      var scaleX = overlayCanvas.width / rect.width;
      var scaleY = overlayCanvas.height / rect.height;
      dragging = true;
      dragStart = { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
      currentDrag = null;
    });
    overlayCanvas.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var rect = overlayCanvas.getBoundingClientRect();
      var scaleX = overlayCanvas.width / rect.width;
      var scaleY = overlayCanvas.height / rect.height;
      var x = (e.clientX - rect.left) * scaleX, y = (e.clientY - rect.top) * scaleY;
      currentDrag = rectFromPoints(dragStart, { x: x, y: y });
    });
    ['mouseup', 'mouseleave'].forEach(function (evt) {
      overlayCanvas.addEventListener(evt, function () {
        if (!dragging) return;
        dragging = false;
        if (currentDrag && currentDrag.w > 10 && currentDrag.h > 10) {
          global.TC.Config.set('ROI', currentDrag);
          if (onChangeCb) onChangeCb(currentDrag);
        }
        currentDrag = null;
      });
    });
  }

  function rectFromPoints(a, b) {
    var x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    var w = Math.abs(a.x - b.x), h = Math.abs(a.y - b.y);
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  }

  function setEditing(enabled) {
    if (enabled) overlayCanvas.dataset.roiEditing = '1';
    else delete overlayCanvas.dataset.roiEditing;
  }

  function isEditing() {
    return !!overlayCanvas.dataset.roiEditing;
  }

  function getPendingDragRect() {
    return currentDrag;
  }

  function ensureRoi(detectionWidth, detectionHeight) {
    var cfg = global.TC.Config.current;
    if (!cfg.ROI || cfg.ROI.w <= 0 || cfg.ROI.h <= 0) {
      var roi = global.TC.Utils.defaultRoi(detectionWidth, detectionHeight);
      global.TC.Config.set('ROI', roi);
    }
    return global.TC.Config.current.ROI;
  }

  global.TC = global.TC || {};
  global.TC.Roi = {
    init: init,
    setEditing: setEditing,
    isEditing: isEditing,
    getPendingDragRect: getPendingDragRect,
    ensureRoi: ensureRoi
  };
})(window);
