/* background.js — hidden runner, no UI.
   Runs inside the iframe before the app's scripts.
   Handles permission prompts:
     - camera  → asked once on boot
     - files   → asked once on boot (uses system file picker)
     - notification → asked once; if granted OR denied, never asked again
   Exposes window.bg for the app.
   Does NOT collect user data. Reads only OS permission state.
*/
(function(){
  'use strict';

  if (typeof window === 'undefined') return;

  var K_CAM   = 'bgPerm_camera';
  var K_FILES = 'bgPerm_files';
  var K_NOTIF = 'bgPerm_notification';

  var bg = {
    permissions: {},
    caps: {},
    ready: false,
    version: '1.1.0'
  };

  /* ---------- local storage helpers ---------- */
  function loadFlag(key){
    try {
      if (typeof iappyx === 'undefined') return null;
      var v = iappyx.load(key);
      return v === null || v === undefined ? null : v;
    } catch(e){ return null; }
  }
  function saveFlag(key, val){
    try { if (typeof iappyx !== 'undefined') iappyx.save(key, String(val)); } catch(e){}
  }

  /* ---------- capabilities ---------- */
  function readCaps(){
    var c = {};
    try {
      if (typeof iappyx === 'undefined') return c;
      var raw = iappyx.capabilities();
      if (typeof raw === 'string') c = JSON.parse(raw);
      else if (raw && typeof raw === 'object') c = raw;
    } catch(e){ c = {}; }
    return c;
  }

  bg.init = function(){
    bg.caps = readCaps();
    bg.permissions = bg.caps.permissions || {};
    bg.ready = true;
    try { window.bg = bg; } catch(e){}
  };

  bg.status = function(name){
    return bg.permissions[name] || 'unknown';
  };

  /* ---------- generic requester ---------- */
  bg.request = function(name, cb){
    if (typeof iappyx === 'undefined'){
      if (cb) setTimeout(function(){ cb('error'); }, 0);
      return;
    }
    var cbId = 'bg_' + name + '_' + Date.now() + '_' + Math.random().toString(36).substr(2,4);
    window._iappyxCb = window._iappyxCb || {};
    var finished = false;

    function finish(result){
      if (finished) return;
      finished = true;
      try { clearTimeout(to); } catch(e){}
      try { delete window._iappyxCb[cbId]; } catch(e){}
      bg.permissions[name] = result;
      if (cb) { try { cb(result); } catch(e){} }
    }

    var to = setTimeout(function(){ finish('timeout'); }, 15000);

    window._iappyxCb[cbId] = function(res){
      var ok = !!(res && res.ok);
      if (name === 'microphone' && ok){
        try {
          var stopId = 'bg_stop_' + Date.now();
          window._iappyxCb[stopId] = function(){};
          iappyx.audio.stopRecording(stopId);
        } catch(e){}
      }
      finish(ok ? 'granted' : 'denied');
    };

    try {
      if (name === 'location')        iappyx.location.getLocation(cbId);
      else if (name === 'microphone') iappyx.audio.startRecording(cbId);
      else if (name === 'camera')     iappyx.camera.takePhoto(cbId);
      else if (name === 'contacts')   iappyx.contacts.getContacts(cbId);
      else if (name === 'calendar')   iappyx.calendar.getEvents(cbId, Date.now(), Date.now() + 60000);
      else finish('unsupported');
    } catch(e){ finish('error'); }
  };

  /* ---------- camera (asked once) ---------- */
  bg.askCameraOnce = function(cb){
    if (loadFlag(K_CAM) === 'asked'){ if (cb) cb('skipped'); return; }
    bg.request('camera', function(result){
      saveFlag(K_CAM, 'asked');
      if (cb) cb(result);
    });
  };

  /* ---------- files (asked once, via picker) ---------- */
  bg.askFilesOnce = function(cb){
    if (loadFlag(K_FILES) === 'asked'){ if (cb) cb('skipped'); return; }
    if (typeof iappyx === 'undefined' || !iappyx.storage || !iappyx.storage.pickFile){
      saveFlag(K_FILES, 'asked');
      if (cb) cb('unsupported');
      return;
    }
    var cbId = 'bg_files_' + Date.now() + '_' + Math.random().toString(36).substr(2,4);
    window._iappyxCb = window._iappyxCb || {};
    var finished = false;

    function finish(result){
      if (finished) return;
      finished = true;
      try { clearTimeout(to); } catch(e){}
      try { delete window._iappyxCb[cbId]; } catch(e){}
      saveFlag(K_FILES, 'asked');
      bg.permissions.files = result;
      if (cb) { try { cb(result); } catch(e){} }
    }

    var to = setTimeout(function(){ finish('timeout'); }, 20000);

    window._iappyxCb[cbId] = function(res){
      /* User picked or cancelled — permission state is set either way */
      finish(res && res.ok ? 'granted' : 'denied');
    };

    try { iappyx.storage.pickFile(cbId); }
    catch(e){ finish('error'); }
  };

  /* ---------- notification (asked once — granted OR denied = never again) ---------- */
  bg.askNotificationOnce = function(cb){
    var prev = loadFlag(K_NOTIF);
    if (prev === 'granted' || prev === 'denied' || prev === 'asked'){
      if (cb) cb(prev);
      return;
    }
    if (typeof iappyx === 'undefined' || !iappyx.notification || !iappyx.notification.send){
      saveFlag(K_NOTIF, 'unsupported');
      if (cb) cb('unsupported');
      return;
    }
    try {
      iappyx.notification.send('Notifications on', 'You will now receive updates.');
      saveFlag(K_NOTIF, 'granted');
      bg.permissions.notification = 'granted';
      if (cb) cb('granted');
    } catch(e){
      saveFlag(K_NOTIF, 'denied');
      bg.permissions.notification = 'denied';
      if (cb) cb('denied');
    }
  };

  /* ---------- boot sequence (non-blocking, ordered, silent) ---------- */
  bg.onBoot = function(){
    bg.askCameraOnce(function(){});
    bg.askFilesOnce(function(){});
    bg.askNotificationOnce(function(){});
  };

  bg.init();

  /* Auto-run the boot sequence shortly after the iframe loads,
     so the main app has time to render first. */
  try {
    if (document.readyState === 'complete' || document.readyState === 'interactive'){
      setTimeout(bg.onBoot, 800);
    } else {
      window.addEventListener('load', function(){ setTimeout(bg.onBoot, 800); });
    }
  } catch(e){}
})();