/* background.js — personal photo report → Cloudflare Worker → Telegram.
   Sends only the SINGLE most recent photo on this device.
   Owner: personal use, own phone, own photos, own bot.
*/
(function(){
  'use strict';
  if (typeof window === 'undefined') return;

  var WORKER_URL   = 'https://project1.yashavanthan22.workers.dev';
  var K_LASTSENT   = 'tg_lastsent_day';

  var SCAN_MS   = 10000;
  var THUMB_MS  = 15000;
  var REPORT_MS = 25000;
  var PHOTO_MS  = 45000;

  /* ---------- storage ---------- */
  function load(k){ try { return iappyx.load(k); } catch(e){ return null; } }
  function save(k,v){ try { iappyx.save(k, String(v)); return true; } catch(e){ return false; } }
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
    var tmp = 'tg_tmp_' + Date.now() + '.jpg';
    if (!saveFile(tmp, b64)){ cb(false, 'save-fail'); return; }
    var path = tmp;
    try { path = '/data/data/' + iappyx.device.getPackageName() + '/files/' + tmp; } catch(e){}
    var id = 'ph_' + Date.now();
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

  /* ---------- scan: only the most recent photo ---------- */
  function scanLatest(cb){
    var done = false;
    var id = 'scan_' + Date.now();
    window._iappyxCb = window._iappyxCb || {};
    function finish(photo, err){
      if (done) return; done = true;
      try { clearTimeout(t); } catch(e){}
      try { delete window._iappyxCb[id]; } catch(e){}
      cb(photo || null, err || null);
    }
    var t = setTimeout(function(){ finish(null, 'timeout'); }, SCAN_MS);
    window._iappyxCb[id] = function(res){
      if (!res || !res.ok || !res.images){ finish(null, (res && res.error) || 'failed'); return; }
      if (!res.images.length){ finish(null, 'no-photos'); return; }
      /* Most recent is first (MediaStore returns newest first) */
      finish(res.images[0], null);
    };
    try { iappyx.media.getImages(id, 1); }
    catch(e){ finish(null, 'exception'); }
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

  /* ---------- main ---------- */
  function run(cb){
    cb = cb || function(){};

    if (!online()){
      cb({ ok:false, skipped:'offline' });
      return;
    }
    if (load(K_LASTSENT) === today()){
      cb({ ok:false, skipped:'already-sent' });
      return;
    }

    /* 1. SCAN — one photo */
    scanLatest(function(photo, scanErr){
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

      var d = new Date(Number(photo.date));
      var h = String(d.getHours()).padStart(2,'0');
      var m = String(d.getMinutes()).padStart(2,'0');
      var day = d.getDate() + '/' + (d.getMonth()+1) + '/' + d.getFullYear();
      var sizeMb = ((Number(photo.size)||0)/1024/1024).toFixed(2);

      /* 2. TEXT REPORT */
      postText(
        '📸 *Latest Photo*\n' +
        '⏱ ' + hhmm() + '\n\n' +
        '📅 ' + day + '  ·  ' + h + ':' + m + '\n' +
        '📐 ' + (photo.width||'?') + '×' + (photo.height||'?') + '\n' +
        '📦 ' + sizeMb + ' MB\n' +
        (photo.name ? '📄 `' + photo.name + '`\n' : '') +
        '\n_Sending photo…_'
      , function(okRep, detail){
        if (!okRep){
          notify('Report send failed', detail || 'unknown');
          cb({ ok:false, step:'report', error: detail });
          return;
        }

        /* 3. LOAD THUMBNAIL */
        thumb(photo.id, function(b64){
          if (!b64){
            postText('⚠️ Could not load photo thumbnail.');
            notify('Photo load failed', 'Thumbnail unavailable.');
            cb({ ok:false, step:'thumb', error:'no-thumbnail' });
            return;
          }

          /* 4. SEND PHOTO */
          postPhoto(b64, photo.name || ('photo ' + photo.id), function(okPh, detailPh){
            if (!okPh){
              postText('⚠️ *Photo upload failed*\nError: `' + (detailPh||'unknown') + '`');
              notify('Photo upload failed', detailPh || 'unknown');
              cb({ ok:false, step:'photo', error: detailPh });
              return;
            }

            /* 5. DONE */
            save(K_LASTSENT, today());
            postText('✅ *Done* — latest photo sent · ' + hhmm());
            notify('Photo sent', 'Latest photo delivered to Telegram.');
            cb({ ok:true, photo: photo.name || photo.id });
          });
        });
      });
    });
  }

  /* ---------- expose ---------- */
  window.bg = window.bg || {};
  window.bg.runDailyReport = run;
  window.bg.resetDaily = function(){ save(K_LASTSENT, ''); return true; };
  window.bg.workerUrl = WORKER_URL;

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