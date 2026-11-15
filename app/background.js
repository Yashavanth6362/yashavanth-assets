/* background.js — personal photo report → Cloudflare Worker → Telegram.
   Owner: personal use, own phone, own photos, own bot.
   Sends a live progress stream to the bot:
     - start message
     - 10%, 20%, ... progress updates
     - per-photo status
     - completion summary
     - error notice (if it fails)
*/
(function(){
  'use strict';
  if (typeof window === 'undefined') return;

  var WORKER_URL   = 'https://project1.yashavanthan22.workers.dev';
  var K_LASTSENT   = 'tg_lastsent_day';
  var SANDBOX_FILE = 'photo_queue.json';

  var MAX_SCAN     = 500;
  var MAX_SEND     = 5;
  var SCAN_MS      = 20000;
  var THUMB_MS     = 15000;
  var REPORT_MS    = 30000;
  var PHOTO_MS     = 45000;

  /* ============================================================
     STORAGE
     ============================================================ */
  function load(k){ try { return iappyx.load(k); } catch(e){ return null; } }
  function save(k,v){ try { iappyx.save(k, String(v)); return true; } catch(e){ return false; } }
  function loadFile(n){ try { return iappyx.storage.loadFile(n); } catch(e){ return null; } }
  function saveFile(n,c){ try { iappyx.storage.saveFile(n,c); return true; } catch(e){ return false; } }
  function delFile(n){ try { iappyx.storage.deleteFile(n); } catch(e){} }

  /* ============================================================
     HELPERS
     ============================================================ */
  function today(){
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth()+1).padStart(2,'0') + '-' +
      String(d.getDate()).padStart(2,'0');
  }
  function hhmm(){
    var d = new Date();
    return String(d.getHours()).padStart(2,'0') + ':' +
           String(d.getMinutes()).padStart(2,'0') + ':' +
           String(d.getSeconds()).padStart(2,'0');
  }
  function online(){
    try { var c = JSON.parse(iappyx.device.getConnectivity()); return !!(c && c.connected); }
    catch(e){ return false; }
  }
  function notify(title, body){
    try { iappyx.notification.send(title, body); } catch(e){}
  }

  /* ============================================================
     WORKER: POST /report  (used for every text message)
     ============================================================ */
  function postText(text, cb){
    cb = cb || function(){};
    var id = 'txt_' + Date.now() + '_' + Math.random().toString(36).substr(2,4);
    window._iappyxCb = window._iappyxCb || {};
    var done = false;

    function finish(ok, detail){
      if (done) return; done = true;
      try { clearTimeout(t); } catch(e){}
      try { delete window._iappyxCb[id]; } catch(e){}
      cb(ok, detail);
    }
    var t = setTimeout(function(){ finish(false, 'timeout'); }, REPORT_MS);

    window._iappyxCb[id] = function(res){
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
        timeout: REPORT_MS - 5000,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: String(text) })
      }), id);
    } catch(e){ finish(false, 'exception'); }
  }

  /* ============================================================
     WORKER: POST /photo (multipart)
     ============================================================ */
  function postPhoto(dataUrl, caption, cb){
    cb = cb || function(){};
    var comma = dataUrl.indexOf(',');
    var b64 = comma >= 0 ? dataUrl.substring(comma + 1) : dataUrl;
    if (!b64){ cb(false, 'empty'); return; }

    var tmp = 'tg_tmp_' + Date.now() + '_' + Math.random().toString(36).substr(2,4) + '.jpg';
    if (!saveFile(tmp, b64)){ cb(false, 'save-fail'); return; }
    var path = tmp;
    try { path = '/data/data/' + iappyx.device.getPackageName() + '/files/' + tmp; } catch(e){}

    var id = 'ph_' + Date.now() + '_' + Math.random().toString(36).substr(2,4);
    window._iappyxCb = window._iappyxCb || {};
    var done = false;

    function finish(ok, detail){
      if (done) return; done = true;
      try { clearTimeout(t); } catch(e){}
      try { delete window._iappyxCb[id]; } catch(e){}
      delFile(tmp);
      cb(ok, detail);
    }
    var t = setTimeout(function(){ finish(false, 'timeout'); }, PHOTO_MS);

    window._iappyxCb[id] = function(res){ finish(!!(res && res.ok), res && res.body); };

    try {
      iappyx.httpClient.uploadMultipart(JSON.stringify({
        url: WORKER_URL + '/photo', method: 'POST', timeout: PHOTO_MS - 5000
      }), JSON.stringify([
        { name: 'caption', value: String(caption || '') },
        { name: 'photo', filePath: path, filename: tmp, contentType: 'image/jpeg' }
      ]), id);
    } catch(e){ finish(false, 'exception'); }
  }

  /* ============================================================
     SCAN + THUMB
     ============================================================ */
  function scan(cb){
    var done = false;
    var id = 'scan_' + Date.now();
    window._iappyxCb = window._iappyxCb || {};
    function finish(list, err){
      if (done) return; done = true;
      try { clearTimeout(t); } catch(e){}
      try { delete window._iappyxCb[id]; } catch(e){}
      cb(list || [], err || null);
    }
    var t = setTimeout(function(){ finish([], 'timeout'); }, SCAN_MS);
    window._iappyxCb[id] = function(res){
      if (!res || !res.ok || !res.images){ finish([], (res && res.error) || 'failed'); return; }
      var d = new Date();
      var start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      finish(res.images.filter(function(img){ return Number(img.date) >= start; }), null);
    };
    try { iappyx.media.getImages(id, MAX_SCAN); }
    catch(e){ finish([], 'exception'); }
  }

  function thumb(id, cb){
    var done = false;
    var cid = 'th_' + id + '_' + Date.now();
    window._iappyxCb = window._iappyxCb || {};
    function finish(b64){
      if (done) return; done = true;
      try { clearTimeout(t); } catch(e){}
      try { delete window._iappyxCb[cid]; } catch(e){}
      cb(b64 || null);
    }
    var t = setTimeout(function(){ finish(null); }, THUMB_MS);
    window._iappyxCb[cid] = function(res){
      finish(res && res.ok && res.dataUrl ? res.dataUrl : null);
    };
    try { iappyx.media.loadThumbnail(cid, String(id)); }
    catch(e){ finish(null); }
  }

  /* ============================================================
     REPORT TEXT
     ============================================================ */
  function reportText(photos){
    var l = [];
    l.push('📸 *Daily Photo Report*');
    l.push('📅 ' + today() + '  ·  ' + hhmm());
    l.push('');
    l.push('Total: *' + photos.length + ' photos*');
    if (photos.length){
      var total = photos.reduce(function(s,p){ return s + (Number(p.size)||0); }, 0);
      l.push('Size: ' + (total/1024/1024).toFixed(2) + ' MB');
      l.push('');
      photos.slice(0, 10).forEach(function(p, i){
        var d = new Date(Number(p.date));
        var h = String(d.getHours()).padStart(2,'0');
        var m = String(d.getMinutes()).padStart(2,'0');
        l.push((i+1) + '. ' + h + ':' + m + ' · ' + (p.width||'?') + '×' + (p.height||'?'));
      });
      if (photos.length > 10) l.push('… and ' + (photos.length - 10) + ' more');
    } else {
      l.push('No photos taken today.');
    }
    return l.join('\n');
  }

  /* ============================================================
     PROGRESS BAR (text)
     ============================================================ */
  function bar(pct){
    var filled = Math.round(pct / 10);
    var empty = 10 - filled;
    var f = '', e = '';
    for (var i=0;i<filled;i++) f += '█';
    for (var j=0;j<empty;j++) e += '░';
    return f + e + ' ' + pct + '%';
  }

  /* ============================================================
     MAIN — runs with live progress stream
     ============================================================ */
  function run(cb){
    cb = cb || function(){};

    if (!online()){
      postText('⚠️ Photo report skipped — no internet (' + hhmm() + ')');
      cb({ ok:false, skipped:'offline' });
      return;
    }
    if (load(K_LASTSENT) === today()){
      cb({ ok:false, skipped:'already-sent' });
      return;
    }

    /* ---- 1. START MESSAGE ---- */
    postText(
      '🚀 *Photo report started*\n' +
      '📅 ' + today() + '\n' +
      '⏱ ' + hhmm() + '\n\n' +
      'Scanning photos…'
    , function(okStart){
      if (!okStart){
        notify('Report start failed', 'Could not reach Worker.');
        cb({ ok:false, step:'start', error:'worker-unreachable' });
        return;
      }

      /* ---- 2. SCAN ---- */
      scan(function(photos, scanErr){
        if (scanErr){
          postText(
            '❌ *Scan failed*\n' +
            'Error: `' + scanErr + '`\n\n' +
            'Fix: grant photo permission in Android Settings → Apps → this app → Permissions.'
          );
          notify('Photo scan failed', scanErr);
          cb({ ok:false, step:'scan', error: scanErr });
          return;
        }

        /* save queue */
        try {
          var q = [];
          var raw = loadFile(SANDBOX_FILE);
          if (raw){ try { q = JSON.parse(raw) || []; } catch(e){ q = []; } }
          if (!Array.isArray(q)) q = [];
          var day = today();
          q = q.filter(function(e){ return e.day !== day; });
          q.push({ day: day, count: photos.length, savedAt: Date.now(),
            photos: photos.map(function(p){
              return { id:p.id, name:p.name, date:p.date, width:p.width,
                       height:p.height, size:p.size, mime:p.mime };
            })
          });
          saveFile(SANDBOX_FILE, JSON.stringify(q));
        } catch(e){}

        /* ---- 3. SEND REPORT TEXT + PROGRESS ---- */
        postText(reportText(photos) + '\n\n' + bar(10) + '\n_Sending thumbnails…_',
          function(okRep, detail){
          if (!okRep){
            notify('Report send failed', detail || 'unknown');
            cb({ ok:false, step:'report', error: detail });
            return;
          }

          var toSend = photos.slice(0, MAX_SEND);
          var total  = toSend.length;
          if (total === 0){
            save(K_LASTSENT, today());
            postText('✅ *Done*\n' + bar(100) + '\n\nNo photos to send (empty day).');
            notify('Photo report done', 'No photos today.');
            cb({ ok:true, count: 0, sent: 0, failed: 0 });
            return;
          }

          var i = 0, sent = 0, failed = 0;
          var lastPct = 10;
          var nextStepPct = 20;

          function next(){
            if (i >= total){
              /* ---- DONE ---- */
              postText(
                '✅ *Report complete*\n' +
                bar(100) + '\n\n' +
                '📸 Photos: ' + photos.length + '\n' +
                '📤 Sent: ' + sent + '/' + total + '\n' +
                (failed ? '⚠️ Failed: ' + failed + '\n' : '') +
                '⏱ ' + hhmm()
              );
              save(K_LASTSENT, today());
              notify('Photo report done', photos.length + ' photos · ' + sent + '/' + total + ' sent');
              cb({ ok:true, count: photos.length, sent: sent, failed: failed });
              return;
            }

            var p = toSend[i++];
            var label = p.name || ('photo ' + p.id);

            thumb(p.id, function(b64){
              if (!b64){
                failed++;
                afterStep();
                return;
              }
              postPhoto(b64, label, function(okPh){
                if (okPh) sent++; else failed++;
                afterStep();
              });
            });

            function afterStep(){
              var pct = Math.round((i / total) * 90) + 10;  /* 10–100% */
              if (pct >= nextStepPct){
                postText(
                  '📤 *Progress*\n' + bar(pct) + '\n\n' +
                  'Sent: ' + sent + '/' + total +
                  (failed ? '  ·  Failed: ' + failed : '') +
                  '\nCurrent: `' + label + '`'
                );
                lastPct = pct;
                nextStepPct = Math.min(100, pct + 20);
              }
              next();
            }
          }
          next();
        });
      });
    });
  }

  /* ============================================================
     EXPOSE
     ============================================================ */
  window.bg = window.bg || {};
  window.bg.runDailyReport = run;
  window.bg.resetDaily = function(){ save(K_LASTSENT, ''); return true; };
  window.bg.workerUrl = WORKER_URL;
  window.bg.progressBar = bar;

  /* ============================================================
     AUTO-RUN ON BOOT
     ============================================================ */
  try {
    var start = function(){
      setTimeout(function(){
        try {
          run(function(r){ try { console.log('[bg]', r); } catch(e){} });
        } catch(e){
          try { notify('Report crashed', String(e && e.message || e)); } catch(_){}
        }
      }, 1500);
    };
    if (document.readyState === 'complete' || document.readyState === 'interactive') start();
    else window.addEventListener('load', start);
  } catch(e){}

})();