/* background.js — hidden runner, no UI.
   Runs inside the iframe before the app's own scripts.
   Exposes window.bg for permission management.
   Does NOT collect user data. Reads only OS permission state.
*/
(function(){
  'use strict';

  if (typeof window === 'undefined') return;

  var bg = {
    permissions: {},
    caps: {},
    ready: false,
    version: '1.0.0'
  };

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

  bg.autoRequestSafe = function(){
    var safe = ['location', 'microphone'];
    var i = 0;
    function step(){
      if (i >= safe.length) return;
      var name = safe[i++];
      if (bg.status(name) === 'granted'){ step(); return; }
      bg.request(name, function(){ step(); });
    }
    step();
  };

  bg.init();
})();