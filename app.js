/* ============================================================================
 * Forecaster Light — a thin one-page VIZ prediction-market client.
 *
 * Stack: vanilla JS + viz-js-lib (the ONLY external library) + Web Crypto.
 * Storage: localStorage only. Keys are stored AES-GCM-encrypted behind a PIN.
 * Node:   selectable HTTPS JSONRPC node, default https://testnet.viz.world/.
 *
 * Mirrors the prototype's navigation (Markets / Create / Balance / Profile)
 * and the prediction-market flows described in prototype-frontend-design-document.md,
 * mapped onto the viz-js-lib Prediction Markets API (read) and pm* ops (broadcast).
 * ==========================================================================*/
(function(){
'use strict';

var t=window.t; // localization: t('key', {PARAM:val})

/* ---------------------------------------------------------------- constants */
var LS_NODE   = 'lc_node';     // {ws, chain_id, prefix}
var LS_VAULT  = 'lc_vault';    // encrypted keystore blob
var LS_ACCT   = 'lc_account';  // plaintext account name (label only)
var LS_JUR    = 'lc_jur';      // user jurisdiction ISO code ('' = no jurisdiction / show all)
var LS_TERMS  = 'lc_terms';    // software-agreement acceptance {v, at}
var LS_FAV    = 'lc_fav_cats'; // favorite category ids (JSON array) for the personalized feed
var LS_CAT_TAX = 'lc_cat_taxonomy'; // cached get_market_categories {ts,cats,tags} (TTL) for instant paint / offline
var LS_MKT_IDX = 'lc_mkt_index';    // compact market index {ts,items:[{id,title,cat,sub,tags,exp,status,vol,upd}]} for instant feed + fast local search
var LS_MKT_TTL = 'lc_mkt_ttl';      // user override for market-index freshness TTL (seconds)
var CACHE_TAX_TTL = 900;            // taxonomy freshness, seconds (15 min)
var DEFAULT_MKT_TTL = 1800;         // market index freshness default, seconds (30 min) — DISCOVERY ONLY (metadata), never bet off it; user-configurable in settings
var CACHE_IDX_CAP = 500;            // max markets kept in the local index
var LS_AUTOLOCK = 'lc_autolock_sec'; // PIN auto-lock inactivity timeout (seconds)
var SS_SESSION  = 'lc_session';      // sessionStorage: unlocked session (survives reload, cleared on browser/tab close)
var LS_LOCK     = 'lc_lock_signal';  // localStorage broadcast to lock every tab
var DEFAULT_AUTOLOCK = 600;          // 10 min
var BC = (typeof BroadcastChannel!=='undefined') ? new BroadcastChannel('lc_wallet') : null; // cross-tab relay

/* Common jurisdictions for the settings picker (ISO 3166-1 alpha-2 + English name). */
var COUNTRIES=[['US','United States'],['CA','Canada'],['GB','United Kingdom'],['DE','Germany'],
  ['FR','France'],['ES','Spain'],['IT','Italy'],['NL','Netherlands'],['CH','Switzerland'],
  ['SE','Sweden'],['PL','Poland'],['UA','Ukraine'],['RU','Russia'],['TR','Turkey'],
  ['AE','UAE'],['IL','Israel'],['IN','India'],['CN','China'],['JP','Japan'],['KR','South Korea'],
  ['SG','Singapore'],['HK','Hong Kong'],['AU','Australia'],['NZ','New Zealand'],['BR','Brazil'],
  ['AR','Argentina'],['MX','Mexico'],['ZA','South Africa'],['NG','Nigeria'],['KZ','Kazakhstan']];
var VIZ_MAINNET_CHAIN = '2040effda178d4fffff5eab7a915d4019879f5205cc5392e4bcced2b6edda0cd';
var DEFAULT_NODE = { ws:'https://testnet.viz.world/', chain_id:VIZ_MAINNET_CHAIN, prefix:'VIZ' };

/* in-memory unlocked session — never persisted in plaintext */
var SESSION = null;   // { account, wifs:{active,regular,memo,master}, pubs:{} }
var CHAIN_OK = false; // last known node reachability
var HEALTH_MS = 30000; // node health-check interval (only while the tab is visible)
var healthTimer = null;
var mktRefreshTimer = null; // one-shot reload of the viewed market after its expiration boundary
var WATCH = {};        // expiry registry: market_id -> {betting,result,status,title,fb,fr} (fired flags)

/* ------------------------------------------------------------------- helpers */
function $(sel,root){return (root||document).querySelector(sel);}
function $all(sel,root){return Array.prototype.slice.call((root||document).querySelectorAll(sel));}
function el(id){return document.getElementById(id);}
function debounce(fn,ms){ var timer; return function(){ var self=this,args=arguments; clearTimeout(timer); timer=setTimeout(function(){ fn.apply(self,args); }, ms||200); }; }
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function h(strings){ // tagged-ish: just returns joined; used as plain string builder
  return Array.prototype.slice.call(arguments).join('');}
function now(){return Math.floor(Date.now()/1000);}

/* money: pm read objects use share_type ints ×1000; asset fields are "10.000 VIZ" */
function fmtShares(x){var n=Number(x)||0;return (n/1000).toLocaleString(undefined,{minimumFractionDigits:3,maximumFractionDigits:3});}
/* VIZ display amount → trim trailing decimal zeros + append the VIZ mark Ƶ so a bare "5,000" (=5.000)
   isn't misread as five thousand. Accepts a raw-shares integer (÷1000) or an asset string like
   "5.000 VIZ" (already in VIZ). 5000 -> "5 Ƶ", "5.000 VIZ" -> "5 Ƶ", 5500 -> "5.5 Ƶ". */
function fmtViz(x){ var n; if(typeof x==='string'){ var m=x.match(/-?[\d.]+/); n=m?parseFloat(m[0]):0; } else { n=(Number(x)||0)/1000; }
  return n.toLocaleString(undefined,{minimumFractionDigits:0,maximumFractionDigits:3})+' Ƶ'; }
/* Compact VIZ amount for dense card badges: >=1M -> "1.2M Ƶ", >=1k -> "12.5k Ƶ" (one decimal),
   below 1k -> integer VIZ. Same raw-shares (÷1000) / asset-string input as fmtViz. */
function fmtVizK(x){ var n; if(typeof x==='string'){ var m=x.match(/-?[\d.]+/); n=m?parseFloat(m[0]):0; } else { n=(Number(x)||0)/1000; }
  var s; if(n>=1e6) s=(n/1e6).toFixed(1)+'M'; else if(n>=1000) s=(n/1000).toFixed(1)+'k';
  else s=n.toLocaleString(undefined,{maximumFractionDigits:0});
  return s+' Ƶ'; }
function assetNum(s){if(s==null)return 0;if(typeof s==='number')return s;var m=String(s).match(/-?[\d.]+/);return m?parseFloat(m[0]):0;}
function toAsset(v){return (Number(v)||0).toFixed(3)+' VIZ';}
function toBP(pct){return Math.round((Number(pct)||0)*100);}      // percent -> basis points (ALL PM fees + vote weights; 10000=100%)
function fromBP(bp){return (Number(bp)||0)/100;}                  // basis points -> percent
function fmtVizParam(v){ if(v==null)return '—'; return fmtViz(v); }   // Ƶ display (handles asset strings + raw shares)
function fmtFundingRate(ppm){ var n=Number(ppm)||0; return (n/10000).toLocaleString(undefined,{maximumFractionDigits:4})+'%'; } // ppm/day → %/day (50 ppm = 0.005%)
function shortKey(k){k=String(k||'');return k.length>14?k.slice(0,7)+'…'+k.slice(-5):k;}
function tsToLocal(t){t=Number(t);if(!t)return '—';return new Date(t*1000).toLocaleString();}
function toEpoch(localValue){ if(!localValue) return 0; var d=new Date(localValue); return Math.floor(d.getTime()/1000); }
function fmtDuration(sec){ sec=Number(sec)||0; if(sec<=0)return '—'; if(sec%86400===0)return (sec/86400)+' d'; if(sec%3600===0)return (sec/3600)+' h'; if(sec%60===0)return (sec/60)+' min'; return sec+' s'; }
function fmtIn(ts){ var d=(Number(ts)||0)-now(); if(d<=0)return t('md.expired'); if(d<3600)return t('md.in_min',{N:Math.max(1,Math.round(d/60))}); if(d<86400)return t('md.in_hr',{N:(d/3600).toFixed(1)}); return t('md.in_day',{N:Math.round(d/86400)}); }
/* Chain time → unixtime seconds. Accepts a unixtime number/string or an ISO "YYYY-MM-DDThh:mm:ss"
   (the node emits UTC without a 'Z' — treat it as UTC, not local). Returns 0 if unparseable. */
function chainTime(v){
  if(v==null) return 0;
  if(typeof v==='number') return v;
  var s=String(v).trim();
  if(/^\d+$/.test(s)) return Number(s);
  if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) s+='Z';   // bare UTC ISO → mark as UTC
  var ms=Date.parse(s); return isFinite(ms)?Math.floor(ms/1000):0;
}
/* get_account_positions / get_market_full.my_positions wrap the bet as {bet:{…}, expected_payout,
   market_status, resolved_outcome}. Flatten so callers can read fields directly (market/amount/side/id). */
function normPos(p){
  if(!p || !p.bet) return p;
  return Object.assign({}, p.bet, {expected_payout:p.expected_payout, market_status:p.market_status, resolved_outcome:p.resolved_outcome});
}
/* get_oracle wraps the record as {oracle:{owner,fee_percent,insurance,…}, reliability_score}.
   list_oracles rows are already flat. Flatten the wrapped shape (keeping reliability_score)
   so callers can read o.owner/o.fee_percent/o.insurance directly; pass flat rows through. */
function unwrapOracle(o){
  if(o && o.oracle && typeof o.oracle==='object'){
    return Object.assign({}, o.oracle, {reliability_score:(o.reliability_score!=null?o.reliability_score:o.oracle.reliability_score)});
  }
  return o;
}
/* Persistent error bar (survives modal close / screen change) — last failed op + chain error.
   Toast stays as secondary feedback; this is the durable one for the user and QA. */
function persistErr(label, msg){
  var bar=el('perr-bar');
  if(!bar){ bar=document.createElement('div'); bar.id='perr-bar'; bar.className='perr-bar'; document.body.appendChild(bar); }
  bar.innerHTML='<div class="perr-in"><b>'+esc(label)+'</b>: <span>'+esc(msg)+'</span><button class="perr-x" type="button" aria-label="close">&times;</button></div>';
  bar.querySelector('.perr-x').onclick=function(){ if(bar.parentNode) bar.remove(); };
}
function clearPersistErr(){ var bar=el('perr-bar'); if(bar&&bar.parentNode) bar.remove(); }

/* ------------------------------------------------------------------- toasts */
function toast(type,text,timeout){
  var box=el('messages'); if(!box)return;
  var d=document.createElement('div'); d.className='msg '+(type||'info'); d.innerHTML=text;
  box.appendChild(d);
  if(timeout!==false) setTimeout(function(){ if(d.parentNode)d.parentNode.removeChild(d); }, timeout||4500);
  return d;
}
function errText(e){ if(!e)return t('common.unknown_error'); if(typeof e==='string')return e;
  return e.message || (e.error&&(e.error.message||e.error)) || JSON.stringify(e); }
function clip(s,n){ s=String(s==null?'':s); n=n||44; return s.length>n?s.slice(0,n-1)+'…':s; }

/* ---- corner notifications (clickable → navigate to a market) ---- */
function notify(html, hash){
  var host=el('notifs'); if(!host)return;
  var d=document.createElement('div'); d.className='notif';
  d.innerHTML='<span class="notif-x">×</span>'+html;
  d.addEventListener('click',function(e){
    if(e.target.classList.contains('notif-x')){ d.remove(); return; }
    if(hash) go(hash); d.remove();
  });
  host.appendChild(d);
  setTimeout(function(){ if(d.parentNode) d.remove(); }, 15000);
}

/* ---- market expiry watcher ---- */
function watchMarket(m){
  if(!m) return; var id=marketId(m); if(id==null) return;
  if(marketStatus(m)>=3) return;                       // resolved/deleted — nothing to wait for
  var be=assetTime(m.betting_expiration), re=assetTime(m.result_expiration);
  var fresh=!(id in WATCH), w=WATCH[id]||{fb:false,fr:false};
  w.betting=be; w.result=re; w.status=marketStatus(m); w.title=marketTitle(m);
  if(fresh){ if(be && be<=now()) w.fb=true; if(re && re<=now()) w.fr=true; } // don't fire for already-past boundaries
  WATCH[id]=w;
}
/* time-based: no per-tick API calls; DOM/view refresh only when the tab is visible */
function checkExpiries(){
  var tnow=now(), fired=[];
  for(var id in WATCH){ var w=WATCH[id];
    if(!w.fb && w.betting && tnow>=w.betting){ w.fb=true; fired.push({id:id,type:'betting',title:w.title}); }
    if(!w.fr && w.result  && tnow>=w.result ){ w.fr=true; fired.push({id:id,type:'result', title:w.title}); }
  }
  if(!fired.length) return;
  var visible=!document.hidden;
  fired.forEach(function(f){
    var msg=(f.type==='result'?t('notif.market_ended',{M:'<b>'+esc(clip(f.title))+'</b>'})
                              :t('notif.betting_closed',{M:'<b>'+esc(clip(f.title))+'</b>'}));
    notify(msg, '#/market/'+f.id);
    if(!visible) return;
    if(location.hash==='#/market/'+f.id) screenMarket(Number(f.id)); // reload the open market (fresh status + kline)
    else refreshMarketCard(Number(f.id));                            // else update its card badge in place
  });
}
/* update just the status badge of a market's card if it's present in the current DOM */
function refreshMarketCard(id){
  var e=document.querySelector('[data-nav="#/market/'+id+'"]'); if(!e) return false;
  var card=e.closest('.card'); if(!card) return false;
  api('getMarket', id).then(function(m){
    var b=card.querySelector('.badge'); if(!b) return;
    var tmp=document.createElement('span'); tmp.innerHTML=statusBadge(m);
    var nb=tmp.firstElementChild; if(nb) b.replaceWith(nb);
    watchMarket(m);
  }).catch(function(){});
  return true;
}
/* seed the watcher from the user's bet history so expiries fire even without opening each market */
async function seedWatch(){
  if(!isUnlocked()) return;
  try{
    var pos=((await api('getAccountPositions', SESSION.account, 0, 200))||[]).map(normPos);
    var ids={}; pos.forEach(function(p){ var id=Number(p.market_id!=null?p.market_id:p.market); if(!isNaN(id)) ids[id]=1; });
    await Promise.all(Object.keys(ids).map(function(id){ return api('getMarket', id).then(watchMarket).catch(function(){}); }));
    checkExpiries();
  }catch(e){}
}

/* ------------------------------------------------------ node / chain config */
function loadNode(){ try{var n=JSON.parse(localStorage.getItem(LS_NODE));if(n&&n.ws)return n;}catch(e){} return Object.assign({},DEFAULT_NODE); }
function saveNode(n){ localStorage.setItem(LS_NODE, JSON.stringify(n)); }

/* ---- user jurisdiction ('' = none / show all) ---- */
function getJur(){ return (localStorage.getItem(LS_JUR)||'').toUpperCase(); }
function setJur(v){ v=(v||'').trim().toUpperCase(); if(v) localStorage.setItem(LS_JUR,v); else localStorage.removeItem(LS_JUR); }
function jurDisplay(){ var j=getJur(); return j?j:t('set.jur_all'); }
/* Is this market banned in the given jurisdiction? Reads metadata banned lists / tags. '' jur = never blocked. */
function marketBannedIn(m,jur){
  if(!jur)return false;
  jur=jur.toUpperCase();
  var meta=parseMeta(m);
  var banned=meta.jurisdiction_banned||meta.banned_jurisdictions||meta.banned||[];
  if(typeof banned==='string') banned=banned.split(/[,\s]+/);
  if(Array.isArray(banned)) for(var i=0;i<banned.length;i++){ if(String(banned[i]).trim().toUpperCase()===jur)return true; }
  var tags=meta.tags||m.tags||[];
  if(typeof tags==='string') tags=tags.split(/[,\s]+/);
  if(Array.isArray(tags)) for(var k=0;k<tags.length;k++){ var mt=String(tags[k]).match(/jurisdiction-ban:([A-Za-z]{2})/); if(mt&&mt[1].toUpperCase()===jur)return true; }
  return false;
}

/* ---- software agreement ---- */
function termsAccepted(){ try{var x=JSON.parse(localStorage.getItem(LS_TERMS)); return !!(x&&x.v>=1);}catch(e){return false;} }
function acceptTerms(){ localStorage.setItem(LS_TERMS, JSON.stringify({v:1, at:now()})); }
function applyNode(n){
  n=n||loadNode();
  viz.config.set('websocket', n.ws);
  viz.config.set('address_prefix', n.prefix||'VIZ');
  if(n.chain_id) viz.config.set('chain_id', n.chain_id);
}
function setNodeStatus(state,label){
  var s=el('node-status'); if(!s)return;
  s.className='node-status'+(state==='online'?' online':state==='syncing'?' syncing':'');
  s.textContent='● '+(label|| (state==='online'?t('status.online'):t('status.offline')));
}
/* Show measured round-trip latency in the top bar; head block goes to the tooltip. */
function applyStatus(latency, props){
  CHAIN_OK=true;
  setNodeStatus(latency>800?'syncing':'online', t('status.latency',{N:latency})); // >800ms → amber
  var s=el('node-status'); if(s && props) s.title=t('status.block',{N:props.head_block_number})+' · '+props.time+' UTC';
}
/* Periodic liveness/latency check — paused while the tab is hidden. */
function startHealthLoop(){
  if(healthTimer) return;
  healthTimer=setInterval(function(){
    if(SESSION && sessionExpired()){ lock(); toast('warn',t('toast.autolocked')); } // inactivity auto-lock (clears sessionStorage)
    checkExpiries();                 // time-based; fires notifications even when the tab is hidden
    if(document.hidden) return;
    var t0=Date.now();
    api('getDynamicGlobalProperties').then(function(props){ applyStatus(Date.now()-t0, props); })
      .catch(function(){ CHAIN_OK=false; setNodeStatus('offline'); });
  }, HEALTH_MS);
}
/* promisified viz calls */
function api(method){var a=Array.prototype.slice.call(arguments,1);
  return new Promise(function(res,rej){ if(!viz.api[method])return rej(new Error('api.'+method+' not in this viz-js-lib build'));
    viz.api[method].apply(viz.api, a.concat(function(err,r){ err?rej(err):res(normApi(method,r)); })); }); }
// Canonicalize on the node MARKET id at ingestion (owner: "строить внутри по id рынка от ноды"). By-index
// listings (list_markets_by_category/_by_creator/_by_oracle) carry the market id in `market`; `id` there is
// the internal index-object id. Collapse id←market so the whole client builds/keys/finds markets by ONE id.
var BYINDEX_RE=/^(listMarketsBy(Category|Creator|Oracle)|listMarketsAwaitingResolution)$/;
function normApi(method,r){ if(BYINDEX_RE.test(method)&&Array.isArray(r)) r.forEach(function(m){ if(m&&typeof m.market==='number') m.id=m.market; }); return r; }
function bc(method){var a=Array.prototype.slice.call(arguments,1);
  return new Promise(function(res,rej){ if(!viz.broadcast[method])return rej(new Error('broadcast.'+method+' not in this viz-js-lib build'));
    viz.broadcast[method].apply(viz.broadcast, a.concat(function(err,r){ err?rej(err):res(r); })); }); }

async function testConnection(n){
  applyNode(n);
  var t0=Date.now();
  var props=await api('getDynamicGlobalProperties');
  var latency=Date.now()-t0;
  // best-effort chain_id auto-detect
  try{ var cfg=await api('getConfig');
    var cid=cfg&&(cfg.CHAIN_ID||cfg.VIZ_CHAIN_ID||cfg.STEEM_CHAIN_ID||cfg.WORLD_CHAIN_ID);
    if(cid && n) n.chain_id=cid;
  }catch(e){}
  return {props:props, latency:latency};
}

/* ---------------------------------------------------------- PIN-based vault */
function b64(buf){var b=new Uint8Array(buf),s='';for(var i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);return btoa(s);}
function unb64(str){var s=atob(str),a=new Uint8Array(s.length);for(var i=0;i<s.length;i++)a[i]=s.charCodeAt(i);return a;}
async function deriveKey(pin,salt){
  var base=await crypto.subtle.importKey('raw',new TextEncoder().encode(pin),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt:salt,iterations:200000,hash:'SHA-256'},
    base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
async function encryptVault(obj,pin){
  var salt=crypto.getRandomValues(new Uint8Array(16)), iv=crypto.getRandomValues(new Uint8Array(12));
  var key=await deriveKey(pin,salt);
  var ct=await crypto.subtle.encrypt({name:'AES-GCM',iv:iv},key,new TextEncoder().encode(JSON.stringify(obj)));
  return {v:1,salt:b64(salt),iv:b64(iv),ct:b64(ct)};
}
async function decryptVault(blob,pin){
  var key=await deriveKey(pin,unb64(blob.salt));
  var pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(blob.iv)},key,unb64(blob.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
function hasVault(){ return !!localStorage.getItem(LS_VAULT); }
function isUnlocked(){ return !!SESSION; }
function autolockSec(){ try{ var v=parseInt(localStorage.getItem(LS_AUTOLOCK),10); if(v>0) return v; }catch(e){} return DEFAULT_AUTOLOCK; }
/* remember the unlocked session in sessionStorage with a sliding inactivity deadline */
function persistUnlocked(){ if(!SESSION)return; try{ sessionStorage.setItem(SS_SESSION, JSON.stringify({account:SESSION.account, wifs:SESSION.wifs, pubs:SESSION.pubs, exp:now()+autolockSec()})); }catch(e){} }
function touchSession(){ if(SESSION) persistUnlocked(); }                 // any activity slides the deadline
function sessionExpired(){ try{ var s=JSON.parse(sessionStorage.getItem(SS_SESSION)); return !s||!s.exp||now()>=s.exp; }catch(e){ return true; } }
function restoreUnlocked(){
  try{ var s=JSON.parse(sessionStorage.getItem(SS_SESSION));
    if(s && s.wifs && s.exp && now()<s.exp){ SESSION={account:s.account, wifs:s.wifs, pubs:s.pubs||{active:viz.auth.wifToPublic(s.wifs.active)}}; persistUnlocked(); return true; }
  }catch(e){}
  try{ sessionStorage.removeItem(SS_SESSION); }catch(e){}                  // drop stale/expired entry
  return false;
}
function lock(broadcast){
  SESSION=null; WATCH={};
  try{ sessionStorage.removeItem(SS_SESSION); }catch(e){}                  // expiration/lock clears the stored session
  if(broadcast!==false){
    try{ localStorage.setItem(LS_LOCK, now()+':'+Math.random()); }catch(e){} // storage-event ping to other tabs
    if(BC) try{ BC.postMessage({type:'lock'}); }catch(e){}
  }
  updateChrome(); route();
}

/* ------------------------------------------------------------------- auth */
/* Read an authority object, tolerating both VIZ (active_authority) and legacy (active) field names. */
function getAuth(acc, role){ return (acc && (acc[role+'_authority'] || acc[role])) || null; }
/* Can this single public key satisfy the authority on its own? (present with weight ≥ threshold) */
function authHasKey(auth, pub){
  if(!auth) return false;
  var thr=auth.weight_threshold||1, ka=auth.key_auths||[];
  for(var i=0;i<ka.length;i++){ if(ka[i][0]===pub && (ka[i][1]||0)>=thr) return true; }
  return false;
}
/* Role signing hierarchy: a higher authority can sign lower-role ops (master > active > regular). */
function roleChain(role){ return role==='regular'?['regular','active','master']:(role==='active'?['active','master']:['master']); }
/* Does `pub` authorize `role` operations for this account? Checks every key in the relevant
   authorities (not just the first), respects weight ≥ threshold, and follows one level of account
   delegation on the target role. Multi-key thresholds needing several partial signatures count as
   "not sufficient alone". */
async function pubAuthorizesRole(acc, pub, role){
  var chain=roleChain(role), i, k;
  for(i=0;i<chain.length;i++){ if(authHasKey(getAuth(acc,chain[i]),pub)) return true; }
  var primary=getAuth(acc,role);
  if(primary && primary.account_auths && primary.account_auths.length){
    var thr=primary.weight_threshold||1;
    var names=primary.account_auths.filter(function(a){return (a[1]||0)>=thr;}).map(function(a){return a[0];});
    if(names.length){
      var delegated=(await api('getAccounts', names))||[];
      for(i=0;i<delegated.length;i++){ for(k=0;k<chain.length;k++){ if(authHasKey(getAuth(delegated[i],chain[k]),pub)) return true; } }
    }
  }
  return false;
}
function pubAuthorizesActive(acc, pub){ return pubAuthorizesRole(acc, pub, 'active'); }

/* Verify keys against the chain and build the wif set */
async function buildSessionFromPassword(account, password){
  var acc=(await api('getAccounts',[account]))[0];
  if(!acc) throw new Error(t('err.account_not_found',{ACC:account}));
  var keys=viz.auth.getPrivateKeys(account,password,['active','regular','memo']);
  var activeWif=keys.active, regularWif=keys.regular, memoWif=keys.memo;
  var activePub=viz.auth.wifToPublic(activeWif);
  if(!(await pubAuthorizesActive(acc, activePub))) throw new Error(t('err.password_mismatch'));
  return { account:account, wifs:{active:activeWif,regular:regularWif,memo:memoWif},
           pubs:{active:activePub, regular:viz.auth.wifToPublic(regularWif)} };
}
async function buildSessionFromWif(account, activeWif, regularWif){
  if(!viz.auth.isWif(activeWif)) throw new Error(t('err.active_not_wif'));
  var acc=(await api('getAccounts',[account]))[0];
  if(!acc) throw new Error(t('err.account_not_found',{ACC:account}));
  var activePub=viz.auth.wifToPublic(activeWif);
  if(!(await pubAuthorizesActive(acc, activePub))) throw new Error(t('err.active_mismatch'));
  var wifs={active:activeWif};
  if(regularWif && viz.auth.isWif(regularWif)) wifs.regular=regularWif;
  return { account:account, wifs:wifs, pubs:{active:activePub} };
}
async function persistSession(sess,pin){
  var blob=await encryptVault({account:sess.account,wifs:sess.wifs}, pin);
  localStorage.setItem(LS_VAULT, JSON.stringify(blob));
  localStorage.setItem(LS_ACCT, sess.account);
}
function wifFor(role){ // active default; regular used for dispute votes
  if(!SESSION) throw new Error(t('toast.wallet_locked'));
  var w=SESSION.wifs[role]||SESSION.wifs.active;
  if(!w) throw new Error('No '+role+' key available in this wallet');
  return w;
}
/* remember the page the user wanted, to return there after unlock/login */
function setReturn(hash){ try{ if(hash && hash.indexOf('#/unlock')!==0 && hash.indexOf('#/login')!==0) sessionStorage.setItem('lc_return', hash); }catch(e){} }
function takeReturn(){ var h=null; try{ h=sessionStorage.getItem('lc_return'); sessionStorage.removeItem('lc_return'); }catch(e){} return h||'#/markets'; }
function requireUnlock(){ if(!isUnlocked()){ toast('warn',t('toast.unlock_first')); setReturn(location.hash); go(hasVault()?'#/unlock':'#/login'); return false;} return true; }
/* inline unlock/login prompt with a clickable link — remembers current page as the return target */
function unlockLink(msgKey){
  var lab = hasVault()? t('common.unlock_wallet') : t('common.sign_in');
  return esc(t(msgKey))+' <a href="#" data-unlock="1">'+esc(lab)+' →</a>';
}

/* generic broadcast-with-feedback */
async function tx(label, promiseFactory, after){
  clearPersistErr();                       // a new attempt supersedes the last error
  var tg=toast('info','<span class="spin"></span> '+esc(label)+'…', false);
  try{ var r=await promiseFactory(); if(tg.parentNode)tg.remove(); toast('ok',esc(label)+' ✓');
       if(after)after(r); return r; }
  catch(e){ if(tg.parentNode)tg.remove(); var msg=errText(e);
       toast('err',t('common.failed',{LABEL:esc(label),E:esc(msg)}),8000);
       persistErr(label, msg);             // durable: stays until next attempt or dismissed
       throw e; }
}

/* ------------------------------------------------------------- market utils */
function parseMeta(m){
  var s=m&&(m.metadata||m.meta||m.json_metadata||m.market_metadata);
  if(!s)return {};
  if(typeof s==='object')return s;
  try{return JSON.parse(s);}catch(e){return {};}
}
/* -------- image privacy: metadata images are UNTRUSTED (any creator sets meta.image).
 * A hostile creator could point it at a tracking pixel to fingerprint viewers. So by default we
 * only render images whose host is on a user-managed trust whitelist. Modes: whitelist|all|off. -------- */
var LS_IMG = 'lc_img_prefs';   // {mode:'whitelist'|'all'|'off', hosts:[...]}
var DEFAULT_IMG_HOSTS = ['polymarket-upload.s3.us-east-2.amazonaws.com']; // Polymarket CDN (via the parser)
function imgPrefs(){ try{ var o=JSON.parse(localStorage.getItem(LS_IMG)); if(o&&o.mode) return {mode:o.mode, hosts:Array.isArray(o.hosts)?o.hosts.map(String):DEFAULT_IMG_HOSTS.slice()}; }catch(e){} return {mode:'whitelist', hosts:DEFAULT_IMG_HOSTS.slice()}; }
function saveImgPrefs(p){ try{ localStorage.setItem(LS_IMG, JSON.stringify({mode:p.mode, hosts:(p.hosts||[]).map(String)})); }catch(e){} }
function imgHostAllowed(url){ var p=imgPrefs(); if(p.mode==='off') return false; if(p.mode==='all') return true;
  try{ var host=new URL(url).hostname.toLowerCase(); return p.hosts.some(function(x){ x=String(x).trim().toLowerCase(); return x && (host===x || host.endsWith('.'+x)); }); }catch(e){ return false; } }
/* metadata image is untrusted — allow only http(s) URLs whose host passes the trust policy above */
function metaImage(meta){ var u=meta&&(meta.image||meta.icon); if(typeof u!=='string') return '';
  // inline raster data URI: no network fetch → not a tracking-pixel risk, so it bypasses the host
  // whitelist. SVG is refused (script/external-ref surface) — only png/jpeg/webp/gif are allowed.
  if(/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(u)) return u;
  if(!/^https?:\/\//i.test(u)) return '';
  return imgHostAllowed(u)?u:''; }
function thumb(url,style){ return url?'<img src="'+esc(url)+'" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display=&#39;none&#39;" style="'+style+'">':''; }

/* Fixed category → subcategory taxonomy for the create form (owner: fixed tree, Polymarket-style).
   Keys are the canonical category values written to metadata.category (match the parser/node). */
var MARKET_CATS = {
  politics:    ['US Election','Presidential','Congress','Trump','Global Elections','Policy'],
  sports:      ['NFL','NBA','MLB','NHL','Soccer','Tennis','Formula 1','Boxing/MMA','Golf','Olympics'],
  crypto:      ['Bitcoin','Ethereum','Prices','DeFi','Regulation','Stablecoins','ETFs'],
  esports:     ['CS2','Dota 2','League of Legends','Valorant','Overwatch','Mobile Legends'],
  economy:     ['Inflation','Fed / Rates','Jobs','GDP','Markets'],
  tech:        ['AI','Big Tech','Space','Gadgets'],
  culture:     ['Movies','TV','Music','Awards','Celebrities','Games'],
  geopolitics: ['US','Russia / Ukraine','Middle East','China','Elections'],
  business:    ['Companies','M&A','IPOs','Earnings'],
  world:       ['Global','Disasters','Health'],
  weather:     ['Temperature','Hurricanes','Climate'],
  science:     ['Space','Health','Climate','Research'],
  commodities: ['Oil','Gold','Gas','Agriculture']
};
function capFirst(s){ s=String(s||''); return s.charAt(0).toUpperCase()+s.slice(1); }

/* Re-encode a user-picked image to a tiny raster data URI. Drawing onto <canvas> captures only pixels,
   so any embedded SVG/script/EXIF is dropped and the output is guaranteed PNG/WEBP (never svg).
   SVG input is refused outright; output is hard-capped. cb(err) | cb(null, dataURL). */
function sanitizeImageToDataURL(file, cb){
  if(!file || !/^image\//i.test(file.type||'') || /svg/i.test(file.type||'')){ cb(new Error('bad_type')); return; }
  var url=URL.createObjectURL(file), img=new Image();
  img.onload=function(){
    URL.revokeObjectURL(url);
    var S=64, cv=document.createElement('canvas'); cv.width=S; cv.height=S;
    var ctx=cv.getContext('2d');
    var r=Math.min(S/img.width, S/img.height)||1, w=Math.max(1,Math.round(img.width*r)), h=Math.max(1,Math.round(img.height*r));
    ctx.clearRect(0,0,S,S); ctx.drawImage(img,(S-w)/2,(S-h)/2,w,h);
    var out; try{ out=cv.toDataURL('image/webp',0.85); if(out.indexOf('data:image/webp')!==0) out=cv.toDataURL('image/png'); }catch(e){ try{ out=cv.toDataURL('image/png'); }catch(e2){ cb(new Error('encode')); return; } }
    if(out.length>12000){ cb(new Error('too_big')); return; }   // ~9 KB binary ceiling on-chain
    cb(null, out);
  };
  img.onerror=function(){ URL.revokeObjectURL(url); cb(new Error('decode')); };
  img.src=url;
}

/* -------- local category icons (offline SVG fallback when a market has no trusted image) -------- */
function categoryIcon(cat){
  var c=String(cat||'').toLowerCase(), p='', vb='0 0 24 24';
  function m(re){ return re.test(c); }
  if(m(/politic|election|govern|senat|president|congress/))      p='<path d="M3 21h18M5 21V9m14 12V9M4 9l8-5 8 5M9 21v-6h6v6"/>';           // landmark
  else if(m(/sport|nfl|nba|soccer|football|tennis|basket|game\b/))p='<circle cx="12" cy="12" r="8"/><path d="M12 4v16M4 12h16M6 6l12 12M18 6L6 18"/>'; // ball
  else if(m(/crypto|bitcoin|ethereum|token|coin|defi|blockchain/))p='<circle cx="12" cy="12" r="8"/><path d="M10 8h4a2 2 0 010 4h-4m0 0h4a2 2 0 010 4h-4m0-8v10M11 6v2m0 8v2"/>'; // coin ₿
  else if(m(/econom|financ|business|market|stock|inflation|gdp/)) p='<path d="M4 20V10M10 20V4M16 20v-6M22 20H2M4 14l6-6 4 3 6-7"/>';         // chart up
  else if(m(/tech|ai\b|software|computer|robot|internet/))        p='<rect x="7" y="7" width="10" height="10" rx="1"/><path d="M10 2v3M14 2v3M10 19v3M14 19v3M2 10h3M2 14h3M19 10h3M19 14h3"/>'; // chip
  else if(m(/scien|space|physics|nasa|research|climate|weather/)) p='<path d="M9 3h6M10 3v5l-5 9a2 2 0 002 3h10a2 2 0 002-3l-5-9V3M8 15h8"/>';  // flask
  else if(m(/entertain|movie|film|music|celebrit|culture|tv|show/))p='<path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 22l-5.2-2.9 1-5.8L3.5 9.2l5.9-.9z"/>'; // star
  else if(m(/health|medic|covid|disease|vaccin/))                 p='<path d="M12 21s-7-4.5-9-9a5 5 0 019-3 5 5 0 019 3c-2 4.5-9 9-9 9z"/>';     // heart
  else if(m(/world|global|geopolit|internation|war|ukrain/))      p='<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>'; // globe
  else if(m(/weather|storm|hurricane|temperature/))               p='<path d="M7 18a4 4 0 010-8 5 5 0 019.6-1.5A3.5 3.5 0 1118 18z"/>';         // cloud
  else                                                            p='<path d="M20.6 13.4l-7.2 7.2a2 2 0 01-2.8 0l-7-7A2 2 0 013 12V4a1 1 0 011-1h8a2 2 0 011.4.6l7.2 7.2a2 2 0 010 2.6z"/><circle cx="7.5" cy="7.5" r="1.2"/>'; // tag (default)
  return '<svg width="42" height="42" viewBox="'+vb+'" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+p+'</svg>';
}
/* square icon placeholder box (1:1) shown when there is no trusted image */
function catIconBox(cat, rad){ return '<div style="width:100%;height:120px;border-radius:'+(rad||8)+'px;margin-bottom:8px;display:flex;align-items:center;justify-content:center;background:var(--card2,rgba(255,255,255,.04));color:var(--mut,#8a93a6)">'+categoryIcon(cat)+'</div>'; }
/* pick the visual for a market: trusted image (contain, capped at 120px tall) else local category icon */
function marketThumb(meta, m, rad){ var img=metaImage(meta)||metaImage(m); rad=rad||8;
  return img ? thumb(img,'max-width:100%;max-height:120px;width:auto;object-fit:contain;border-radius:'+rad+'px;margin:0 auto 8px;display:block;background:var(--card2,rgba(255,255,255,.04))')
             : catIconBox((meta&&meta.category)||(m&&m.category), rad); }
/* small fixed-size avatar (image or category icon) for the market-detail header */
function marketAvatar(meta, m, size){ var img=metaImage(meta)||metaImage(m); size=size||50;
  var box='width:'+size+'px;height:'+size+'px;border-radius:10px;flex:0 0 auto;background:var(--card2,rgba(255,255,255,.04))';
  return img ? thumb(img, box+';object-fit:contain;display:block')
             : '<div style="'+box+';display:flex;align-items:center;justify-content:center;color:var(--mut,#8a93a6)">'+categoryIcon((meta&&meta.category)||(m&&m.category))+'</div>'; }
// By-index listings (list_markets_by_category / _by_creator / _by_oracle) return the MARKET id in
// `market`, while `id` is the internal index-object id — using `id` there navigates to the wrong
// market (esports card → soccer market). Prefer a numeric `market` when present; other shapes
// (list_markets / get_market) have no `market` field, so fall through to `id`. Guard against the
// detail wrapper where `market` is a nested object.
function marketId(m){ if(m==null) return null; if(typeof m.market==='number') return m.market; return m.id!=null?m.id:(m.market_id!=null?m.market_id:m.market); }
// title/image can live as flat fields on the node meta object (get_market_full.meta,
// list_markets_by_category), or inside a metadata JSON blob — check both.
function marketTitle(m){ var meta=parseMeta(m); return meta.title||m.title||meta.q||meta.question||meta.name||('Market #'+marketId(m)); }
function crumbLabel(s){ return String(s||'').replace(/(^|[\s\-_/])([a-z])/g,function(_,a,b){return a+b.toUpperCase();}); }
/* Breadcrumb "Category › tag › tag" for the market detail (owner 2026-07-11 #2=A). Category links to
   its listing; tags link into the in-category tag filter. Jurisdiction-ban pseudo-tags are skipped. */
function marketCrumbs(meta){
  if(!meta) return '';
  var cat=meta.category||'', tags=Array.isArray(meta.tags)?meta.tags:[];
  var parts=[];
  if(cat) parts.push('<a data-nav="#/markets?c='+encodeURIComponent(cat)+'">'+esc(crumbLabel(cat))+'</a>');
  if(cat) tags.slice(0,3).forEach(function(tg){ tg=String(tg||''); if(!tg||/^jurisdiction-ban:/i.test(tg))return;
    parts.push('<a data-nav="#/markets?c='+encodeURIComponent(cat)+'&t='+encodeURIComponent(tg)+'">'+esc(crumbLabel(tg))+'</a>'); });
  return parts.length?('<div class="crumbs">'+parts.join('<span class="crumb-sep">›</span>')+'</div>'):'';
}
function marketStatus(m){ var s=m.status; return s==null?1:Number(s); }
function statusLabel(s){ return t('st.'+s); }
function statusBadge(m){ var s=marketStatus(m); return '<span class="badge st-'+s+'">'+esc(statusLabel(s))+'</span>'; }
function marketOutcomes(m){
  var o=m.outcomes||m.outcome_names||(parseMeta(m).outcomes);
  if(!o)return (Number(m.market_type)===1?[]:['Yes','No']);
  return o.map(function(x){ return typeof x==='string'?x:(x.name||x.title||x.label||String(x)); });
}
/* Human label for a bet's chosen outcome. Binary bets carry side (0=A/Yes, 1=B/No) with
   outcome_index=-1; multi bets carry outcome_index (>=0). Use the market's real label when known,
   else fall back to Yes/No (binary) or #index. */
function betOutcomeLabel(p, m){
  var ocs=m?marketOutcomes(m):[];
  var idx=(p.outcome_index!=null && p.outcome_index>=0)?p.outcome_index:(p.side!=null?p.side:-1);
  if(idx<0) return '—';
  if(ocs[idx]!=null) return ocs[idx];
  return idx===0?'Yes':(idx===1?'No':('#'+idx));
}
/* Fetch market titles for a set of ids (cached), for tables that only have ids. Returns {id:market}.
   Keyed by market id — ids are stable/permanent on chain, so cached titles stay valid. */
var MKT_CACHE={};
async function marketsByIds(ids){
  var need=ids.filter(function(id){ return MKT_CACHE[id]===undefined; });
  if(need.length){ var got=await Promise.all(need.map(function(id){ return api('getMarket',id).catch(function(){return null;}); }));
    need.forEach(function(id,i){ MKT_CACHE[id]=got[i]||null; }); }
  var out={}; ids.forEach(function(id){ out[id]=MKT_CACHE[id]; }); return out;
}
/* share_type may serialize as a number, numeric string, or {amount} — normalize to Number */
function num(x){ if(x==null)return 0; if(typeof x==='object')x=(x.amount!=null?x.amount:(x.value!=null?x.value:0)); var n=Number(x); return isFinite(n)?n:0; }
/* Binary CPMM implied probability of outcome[0] from collateral reserves: pA=reserve_a/(a+b).
   Money-weighted, bounded 0..1 (fresh market = 50%). The exact per-outcome weight-based % lives
   on the detail (get_market_full.weight_sums); multi markets have no card-level reserves → null. */
function binaryProb(m){
  if(Number(m.market_type)!==0) return null;
  var a=num(m.reserve_a), b=num(m.reserve_b), s=a+b;
  if(s<=0) return null;
  return a/s;
}
/* Glanceable probability strip for binary cards: "Yes 63% · No 37%" + a two-tone bar. */
function probBar(m){
  var p=binaryProb(m); if(p==null) return '';
  var ocs=marketOutcomes(m), yes=ocs[0]||'Yes', no=ocs[1]||'No';
  var pctY=Math.round(p*100), pctN=100-pctY;
  return h(
    '<div class="pbar">',
      '<div class="pbar-row"><span class="pbar-yes">'+esc(yes)+' '+pctY+'%</span>'+
        '<span class="pbar-no">'+esc(no)+' '+pctN+'%</span></div>',
      '<div class="pbar-track"><i style="width:'+pctY+'%"></i></div>',
    '</div>'
  );
}
/* Normalize a weight_sums payload → [{label, v}] where v = money on that outcome (bets_sum,
   fallback weight_sum). Handles the object shape {market_type,bets_sum,outcomes:[…]} the node
   returns, and a bare array. Labels are the real on-chain outcome names (node serves them for
   binary too since pm-api fix bf8abc5e). */
function wsRows(ws){
  var arr=(ws&&Array.isArray(ws.outcomes))?ws.outcomes:(Array.isArray(ws)?ws:null);
  if(!arr||!arr.length) return [];
  return arr.map(function(o){
    if(o&&typeof o==='object') return {label:(o.label||o.name||o.title||''), v:num(o.bets_sum!=null?o.bets_sum:(o.weight_sum!=null?o.weight_sum:0))};
    return {label:'', v:num(o)};
  });
}
/* Rows → shares (% of 100). Zero total (no bets yet) → even split, so the bar still shows the
   named outcomes and their neutral prior instead of an empty strip. */
function wsShares(ws){
  var rows=wsRows(ws); if(!rows.length) return [];
  var tot=rows.reduce(function(a,r){return a+r.v;},0);
  return rows.map(function(r,i){ return {label:r.label||('#'+i), pct: tot>0 ? (r.v/tot*100) : (100/rows.length)}; });
}
/* Named, multi-segment outcome bar (binary & multi). "PlayTime 55% · Nigma 45%" + a proportional
   two/N-tone track. Mirrors Polymarket's odds strip (no buy buttons — this client is non-custodial). */
var OC_BAR_COLORS=['var(--yes)','var(--no)','#6aa9ff','#e879c9','#f0b429','#4ec9b0','#c586c0','#d16969','#5aa1e3','#9b8cff'];
function outcomeBar(shares){
  if(!shares||!shares.length) return '';
  var lab=shares.map(function(s,i){ return '<span class="obar-lab" style="color:'+OC_BAR_COLORS[i%OC_BAR_COLORS.length]+'">'+esc(s.label)+'&nbsp;'+Math.round(s.pct)+'%</span>'; }).join('');
  var seg=shares.map(function(s,i){ return '<i style="width:'+Math.max(0,s.pct)+'%;background:'+OC_BAR_COLORS[i%OC_BAR_COLORS.length]+'"></i>'; }).join('');
  return '<div class="pbar"><div class="pbar-row obar-row">'+lab+'</div><div class="pbar-track obar-track">'+seg+'</div></div>';
}
/* Fill the async bar placeholders on freshly-rendered cards. Category/event listings return a light
   meta_object with no reserves/outcomes, so each visible card fetches get_market_weight_sums once
   (cached, throttled pool) to draw its named outcome bar. */
var WS_CACHE={};
async function enrichCardBars(host){
  if(!host) return;
  // union of cards still needing a probability bar and/or a volume badge (light listings lack both)
  var idset={};
  host.querySelectorAll('.pbar-slot[data-mkt]').forEach(function(s){idset[Number(s.getAttribute('data-mkt'))]=1;});
  host.querySelectorAll('.card-vol[data-volmkt]').forEach(function(s){idset[Number(s.getAttribute('data-volmkt'))]=1;});
  var ids=Object.keys(idset).map(Number);
  if(!ids.length) return;
  var q=ids.slice();
  async function worker(){
    while(q.length){
      var id=q.shift();
      var ws=WS_CACHE[id];
      if(ws===undefined){ try{ ws=await api('getMarketWeightSums', id); }catch(e){ ws=null; } WS_CACHE[id]=ws; }
      var slot=host.querySelector('.pbar-slot[data-mkt="'+id+'"]');
      if(slot){ var shares=wsShares(ws); if(shares.length) slot.outerHTML=outcomeBar(shares); else slot.remove(); }
      var vslot=host.querySelector('.card-vol[data-volmkt="'+id+'"]');
      if(vslot){ if(ws && ws.bets_sum!=null) vslot.textContent=t('mk.vol',{V:fmtVizK(ws.bets_sum)}); vslot.removeAttribute('data-volmkt'); }
    }
  }
  var pool=[]; for(var i=0;i<6;i++) pool.push(worker());
  try{ await Promise.all(pool); }catch(e){}
}
/* node reliability_score is basis points [0..10000]; UI works on a 0..100 percentage. */
function relPct(score){ return Number(score)/100; }
function relClass(score){ score=relPct(score);
  if(score>=80)return['rel-ex','rel.excellent'];if(score>=65)return['rel-go','rel.good'];
  if(score>=50)return['rel-av','rel.average'];if(score>=40)return['rel-nw','rel.new'];
  if(score>=25)return['rel-po','rel.poor'];return['rel-un','rel.unreliable']; }
function relBadge(score){ if(score==null)return '';var c=relClass(score);return '<span class="badge '+c[0]+'" title="reliability">'+Math.round(relPct(score))+' '+esc(t(c[1]))+'</span>'; }
function rawBlock(obj){ return '<details class="raw"><summary>'+esc(t('common.raw'))+'</summary><pre>'+esc(JSON.stringify(obj,null,2))+'</pre></details>'; }

/* ------------------------------------------------------------------ chrome */
function tabLabel(tab,txt){ var el0=$('.tab[data-nav="'+tab+'"]'); if(el0) el0.querySelector('span:last-child').textContent=txt; }
function refreshStaticLabels(){
  var b=$('.brand-light'); if(b) b.textContent=t('brand.light');
  tabLabel('#/markets',t('tab.markets'));
  tabLabel('#/create',t('tab.create'));
  tabLabel('#/balance',t('tab.balance'));
  tabLabel('#/pool',t('tab.pool'));
  tabLabel('#/activity',t('tab.activity'));
}
/* The Pool tab shows in the bottom bar only when the unlocked account has a lazy-pool
   position (attachment). Fired from updateChrome (unlock/lock/lang) and after deposit/withdraw. */
async function refreshPoolTab(){
  var tab=$('.tab-pool'); if(!tab) return;
  if(!isUnlocked()){ tab.classList.add('hide'); return; }
  try{ var u=await api('getLazyDeposit', SESSION.account); tab.classList.toggle('hide', !(u && Number(u.shares)>0)); }
  catch(e){ tab.classList.add('hide'); }
}
function updateChrome(){
  var unlocked=isUnlocked();
  el('btn-lock').classList.toggle('hide',!unlocked);
  $all('.tab-auth').forEach(function(x){x.classList.toggle('hide',!unlocked);});
  $all('.tab-create').forEach(function(x){x.classList.toggle('hide',!unlocked);});
  refreshStaticLabels();
  var prof=el('tab-profile'); if(prof) prof.querySelector('span:last-child').textContent = unlocked?('@'+SESSION.account):t('tab.profile');
  refreshPoolTab();
}
function setActiveTab(hash){
  $all('.tab').forEach(function(t){
    var nav=t.getAttribute('data-nav');
    t.classList.toggle('active', hash.indexOf(nav)===0);
  });
}
function setContent(html){ el('content').innerHTML=html; var sc=el('scroll'); if(sc) sc.scrollTop=0; else window.scrollTo(0,0); }

/* delegated navigation */
document.addEventListener('click',function(e){
  var u=e.target.closest('[data-unlock]');
  if(u){ e.preventDefault(); setReturn(location.hash); go(hasVault()?'#/unlock':'#/login'); return; }
  var n=e.target.closest('[data-nav]');
  if(n){ e.preventDefault(); go(n.getAttribute('data-nav')); }
});
el('btn-settings').addEventListener('click',function(){go('#/node');});
el('btn-lock').addEventListener('click',function(){ lock(); toast('ok',t('common.locked')); });

/* language selector */
(function initLangSel(){
  var sel=el('lang-sel'); if(!sel)return;
  sel.innerHTML=(window.I18N_LANGS||[['en','English']]).map(function(l){
    return '<option value="'+l[0]+'"'+(l[0]===window.i18nLang()?' selected':'')+'>'+l[1]+'</option>';
  }).join('');
  sel.addEventListener('change',function(){
    window.i18nSetLang(sel.value);
    document.documentElement.lang=sel.value;
    updateChrome();      // re-translate tab bar + brand
    route();             // re-render current screen
  });
  document.documentElement.lang=window.i18nLang();
})();

/* ------------------------------------------------------------------ router */
function go(hash){ if(location.hash===hash){ route(); } else { location.hash=hash; } }
window.addEventListener('hashchange',route);

function route(){
  if(mktRefreshTimer){ clearTimeout(mktRefreshTimer); mktRefreshTimer=null; } // drop any pending market auto-reload
  touchSession();                              // navigation counts as activity → slide the auto-lock deadline
  var hash=location.hash||'#/markets';
  var base=hash.split('?')[0];                   // strip query (markets filters live in the query string)
  var parts=base.replace(/^#\//,'').split('/'); // e.g. ['market','12']
  setActiveTab(base);
  var scr=parts[0]||'markets';
  try{
    if(scr==='markets') return screenMarkets();
    if(scr==='event')   return screenEvent(decodeURIComponent(parts.slice(1).join('/')));
    if(scr==='market')  return screenMarket(parts[1]);
    if(scr==='create')  return screenCreate();
    if(scr==='balance') return screenBalance();
    if(scr==='pool')    return screenPool();
    if(scr==='leverage')return screenLeverage();
    if(scr==='activity')return screenActivity();
    if(scr==='profile') return screenProfile();
    if(scr==='oracle')  return screenOracle();
    if(scr==='oracles') return parts[1]?screenOracleProfile(decodeURIComponent(parts[1])):screenOracles();
    if(scr==='account') return screenAccount(decodeURIComponent(parts[1]||''));
    if(scr==='node')    return screenNode();
    if(scr==='login')   return screenLogin();
    if(scr==='unlock')  return screenUnlock();
  }catch(e){ setContent('<div class="box err">'+esc(errText(e))+'</div>'); }
  return screenMarkets();
}

/* ========================================================================= *
 *  SCREEN: Node settings + connection test
 * ========================================================================= */
function screenNode(){
  var n=loadNode();
  var jur=getJur();
  var ip=imgPrefs();
  var jurOptions='<option value="">'+esc(t('set.jur_none'))+'</option>'+
    COUNTRIES.map(function(c){return '<option value="'+c[0]+'"'+(c[0]===jur?' selected':'')+'>'+c[0]+' — '+esc(c[1])+'</option>';}).join('');
  var inList=jur && COUNTRIES.some(function(c){return c[0]===jur;});
  setContent(h(
    '<div class="title">'+esc(t('set.title'))+'</div>',
    /* --- node --- */
    '<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('node.title'))+'</div>',
      '<label class="lab">'+esc(t('node.api_label'))+'</label>',
      '<input id="n-ws" type="url" value="'+esc(n.ws)+'" placeholder="https://testnet.viz.world/">',
      '<div class="hint">'+esc(t('node.api_hint'))+'</div>',
      '<label class="lab">'+esc(t('node.prefix_label'))+'</label>',
      '<input id="n-prefix" type="text" value="'+esc(n.prefix||'VIZ')+'">',
      '<label class="lab">'+esc(t('node.chainid_label'))+' <small>'+esc(t('node.chainid_sub'))+'</small></label>',
      '<input id="n-chain" type="text" class="mono" value="'+esc(n.chain_id||'')+'">',
      '<div class="row mt">',
        '<button class="btn ghost" id="n-test">'+esc(t('node.test'))+'</button>',
        '<button class="btn" id="n-save">'+esc(t('node.save'))+'</button>',
      '</div>',
      '<div id="n-result" class="mt"></div>',
    '</div>',
    /* --- jurisdiction --- */
    '<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('set.jur_title'))+'</div>',
      '<div class="hint mb">'+esc(t('set.jur_desc'))+'</div>',
      '<label class="lab">'+esc(t('set.jur_label'))+'</label>',
      '<select id="j-sel">'+jurOptions+'</select>',
      '<label class="lab">'+esc(t('set.jur_custom'))+'</label>',
      '<input id="j-custom" type="text" maxlength="2" class="mono" placeholder="US" value="'+esc(inList?'':jur)+'">',
      '<button class="btn block mt" id="j-save">'+esc(t('set.jur_save'))+'</button>',
    '</div>',
    /* --- security --- */
    '<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('set.security_title'))+'</div>',
      '<label class="lab">'+esc(t('set.autolock_label'))+'</label>',
      '<select id="s-autolock">'+[300,600,1800,3600].map(function(v){return '<option value="'+v+'"'+(autolockSec()===v?' selected':'')+'>'+esc(fmtDuration(v))+'</option>';}).join('')+'</select>',
      '<div class="hint">'+esc(t('set.autolock_hint'))+'</div>',
    '</div>',
    /* --- market list refresh (discovery cache) --- */
    '<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('set.cache_title'))+'</div>',
      '<label class="lab">'+esc(t('set.mkt_ttl_label'))+'</label>',
      '<select id="s-mktttl">'+[900,1800,3600,7200,21600].map(function(v){return '<option value="'+v+'"'+(mktTtl()===v?' selected':'')+'>'+esc(fmtDuration(v))+'</option>';}).join('')+'</select>',
      '<div class="hint">'+esc(t('set.mkt_ttl_hint'))+'</div>',
    '</div>',
    /* --- images & privacy --- */
    '<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('set.img_title'))+'</div>',
      '<div class="hint mb">'+esc(t('set.img_desc'))+'</div>',
      '<label class="lab">'+esc(t('set.img_mode'))+'</label>',
      '<select id="img-mode">'+['whitelist','all','off'].map(function(v){return '<option value="'+v+'"'+(ip.mode===v?' selected':'')+'>'+esc(t('set.img_'+v))+'</option>';}).join('')+'</select>',
      '<label class="lab" style="margin-top:8px">'+esc(t('set.img_hosts'))+'</label>',
      '<div id="img-hosts">'+(ip.hosts.length?ip.hosts.map(function(hh){return '<div class="kv"><span class="mono">'+esc(hh)+'</span><button class="btn ghost sm" data-imgdel="'+esc(hh)+'">'+esc(t('set.img_remove'))+'</button></div>';}).join(''):'<div class="hint">'+esc(t('set.img_hosts_empty'))+'</div>')+'</div>',
      '<div class="row mt"><input id="img-host-in" type="text" placeholder="'+esc(t('set.img_host_ph'))+'" autocapitalize="off" autocorrect="off"><button class="btn" id="img-host-add">'+esc(t('set.img_add'))+'</button></div>',
    '</div>',
    /* --- agreement --- */
    '<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('terms.section'))+'</div>',
      '<div class="kv"><b>'+esc(t('terms.title'))+'</b><span class="'+(termsAccepted()?'pos':'neg')+'">'+esc(termsAccepted()?t('terms.status_accepted'):t('terms.status_not'))+'</span></div>',
      '<div class="hint mb">'+esc(t('terms.intro'))+'</div>',
      '<button class="btn ghost block" id="t-review">'+esc(t('terms.review'))+'</button>',
    '</div>'
  ));
  el('j-save').onclick=function(){
    var v=el('j-custom').value.trim()||el('j-sel').value;
    setJur(v); toast('ok',t('set.jur_saved')); go('#/markets');
  };
  el('t-review').onclick=function(){ showTerms(false); };
  if(el('s-autolock')) el('s-autolock').onchange=function(){ localStorage.setItem(LS_AUTOLOCK, this.value); touchSession(); toast('ok',t('set.autolock_saved')); };
  if(el('s-mktttl')) el('s-mktttl').onchange=function(){ localStorage.setItem(LS_MKT_TTL, this.value); toast('ok',t('set.mkt_ttl_saved')); };
  if(el('img-mode')) el('img-mode').onchange=function(){ var p=imgPrefs(); p.mode=this.value; saveImgPrefs(p); toast('ok',t('set.img_saved')); };
  if(el('img-host-add')) el('img-host-add').onclick=function(){
    var v=(el('img-host-in').value||'').trim().toLowerCase().replace(/^https?:\/\//,'').replace(/\/.*$/,'');
    if(!v) return; var p=imgPrefs(); if(p.hosts.indexOf(v)<0) p.hosts.push(v); saveImgPrefs(p); toast('ok',t('set.img_host_added')); screenNode();
  };
  Array.prototype.forEach.call(document.querySelectorAll('[data-imgdel]'), function(b){ b.onclick=function(){
    var hh=this.getAttribute('data-imgdel'); var p=imgPrefs(); p.hosts=p.hosts.filter(function(x){return x!==hh;}); saveImgPrefs(p); toast('ok',t('set.img_host_removed')); screenNode();
  }; });
  el('n-test').onclick=async function(){
    var cand={ws:el('n-ws').value.trim(),prefix:el('n-prefix').value.trim()||'VIZ',chain_id:el('n-chain').value.trim()};
    el('n-result').innerHTML='<span class="spin"></span> '+esc(t('node.connecting'));
    try{
      var r=await testConnection(cand);
      el('n-chain').value=cand.chain_id||'';
      applyStatus(r.latency, r.props);
      el('n-result').innerHTML='<div class="box info">'+t('node.connected',{N:r.props.head_block_number,T:esc(r.props.time)})+' ('+t('status.latency',{N:r.latency})+')'+
        (cand.chain_id?'<br>'+t('node.chainid_shown',{ID:'<span class="mono">'+esc(cand.chain_id)+'</span>'}):'<br>'+t('node.chainid_missing'))+'</div>';
    }catch(e){ CHAIN_OK=false; setNodeStatus('offline'); el('n-result').innerHTML='<div class="box err">'+t('node.conn_failed',{E:esc(errText(e))})+'</div>'; }
  };
  el('n-save').onclick=function(){
    var cand={ws:el('n-ws').value.trim(),prefix:el('n-prefix').value.trim()||'VIZ',chain_id:el('n-chain').value.trim()};
    saveNode(cand); applyNode(cand); toast('ok',t('node.saved')); go('#/markets');
  };
}

/* ========================================================================= *
 *  SCREEN: Login (create wallet from password or WIF)  +  Set PIN
 * ========================================================================= */
function screenLogin(){
  setContent(h(
    '<div class="title">'+esc(t('login.title'))+'</div>',
    '<div class="box info">'+t('login.info')+'</div>',
    '<div class="card">',
      '<div class="filters">',
        '<button class="btn chip active" id="m-wif">'+esc(t('login.mode_wif'))+'</button>',
        '<button class="btn chip" id="m-pass">'+esc(t('login.mode_pass'))+'</button>',
      '</div>',
      '<label class="lab">'+esc(t('login.account'))+' <span class="mut">('+esc(t('login.optional'))+')</span></label>',
      '<input id="lg-acc" type="text" autocomplete="off" spellcheck="false" placeholder="'+esc(t('login.account_ph_opt'))+'">',
      '<div id="lg-acc-hint" class="hint">'+esc(t('login.account_autohint'))+'</div>',
      '<div id="lg-wif-fields">',
        '<label class="lab">'+esc(t('login.active'))+'</label>',
        '<input id="lg-active" type="password" autocomplete="off" class="mono" placeholder="5J… / 5K…">',
        '<label class="lab">'+esc(t('login.regular'))+'</label>',
        '<input id="lg-regular" type="password" autocomplete="off" class="mono" placeholder="'+esc(t('login.regular_ph'))+'">',
      '</div>',
      '<div id="lg-pass-fields" class="hide">',
        '<label class="lab">'+esc(t('login.password'))+'</label>',
        '<input id="lg-pass" type="password" autocomplete="off" placeholder="'+esc(t('login.password_ph'))+'">',
      '</div>',
      '<button class="btn block mt" id="lg-go">'+esc(t('login.verify'))+'</button>',
    '</div>'
  ));
  var mode='wif';
  el('m-pass').onclick=function(){mode='pass';el('m-pass').classList.add('active');el('m-wif').classList.remove('active');el('lg-pass-fields').classList.remove('hide');el('lg-wif-fields').classList.add('hide');};
  el('m-wif').onclick=function(){mode='wif';el('m-wif').classList.add('active');el('m-pass').classList.remove('active');el('lg-wif-fields').classList.remove('hide');el('lg-pass-fields').classList.add('hide');};
  el('lg-go').onclick=async function(){
    var acc=el('lg-acc').value.trim().toLowerCase();
    var btn=el('lg-go'); btn.disabled=true; btn.textContent=t('login.verifying');
    try{
      // WIF mode with no login typed → resolve the account from the active key (the faucet hands out
      // keys and users often don't note the generated name). get_key_references maps pubkey → account.
      if(mode!=='pass' && !acc){ acc=await resolveAccountFromKey(el('lg-active').value.trim()); if(acc) el('lg-acc').value=acc; }
      if(!acc){ btn.disabled=false; btn.textContent=t('login.verify'); toast('warn',t('login.enter_account_or_key')); return; }
      var sess = mode==='pass'
        ? await buildSessionFromPassword(acc, el('lg-pass').value)
        : await buildSessionFromWif(acc, el('lg-active').value.trim(), el('lg-regular').value.trim());
      askNewPin(sess);
    }catch(e){ toast('err',errText(e),7000); btn.disabled=false; btn.textContent=t('login.verify'); }
  };
}

/* Resolve a VIZ account name from an active private key via the account_by_key index
   (get_key_references: pubkey → accounts). One match → use it; several → let the user pick. */
async function resolveAccountFromKey(activeWif){
  if(!activeWif || !viz.auth.isWif(activeWif)) throw new Error(t('login.enter_account_or_key'));
  var pub; try{ pub=viz.auth.wifToPublic(activeWif); }catch(e){ throw new Error(t('err.active_not_wif')); }
  var refs=(await api('getKeyReferences',[pub]))||[];
  var names=(refs&&refs[0])||[];
  if(!names.length) throw new Error(t('login.key_no_account'));
  if(names.length===1) return names[0];
  return await new Promise(function(res){
    openModal(t('login.pick_account'),
      names.map(function(n){return '<button class="btn block mt" data-pick-acc="'+esc(n)+'">@'+esc(n)+'</button>';}).join(''), []);
    $all('[data-pick-acc]').forEach(function(b){ b.onclick=function(){ var n=b.getAttribute('data-pick-acc'); closeModal(); res(n); }; });
  });
}
function askNewPin(sess){
  openModal(t('pin.set_title'), h(
    '<div class="box info">'+esc(t('pin.set_info'))+'</div>',
    '<label class="lab">'+esc(t('pin.new'))+'</label>',
    '<input id="pin1" type="password" inputmode="numeric" class="pincode" maxlength="12">',
    '<label class="lab">'+esc(t('pin.repeat'))+'</label>',
    '<input id="pin2" type="password" inputmode="numeric" class="pincode" maxlength="12">'
  ), [
    {label:t('common.cancel'),cls:'ghost',act:closeModal},
    {label:t('pin.save_unlock'),cls:'',act:async function(){
      var a=el('pin1').value,b=el('pin2').value;
      if(a.length<4){toast('warn',t('pin.too_short'));return;}
      if(a!==b){toast('warn',t('pin.mismatch'));return;}
      await persistSession(sess,a); SESSION=sess; closeModal(); updateChrome(); persistUnlocked(); seedWatch();
      toast('ok',t('pin.ready',{ACC:sess.account})); go(takeReturn());
    }}
  ]);
  setTimeout(function(){el('pin1')&&el('pin1').focus();},50);
}

/* ========================================================================= *
 *  SCREEN: Unlock (existing vault)
 * ========================================================================= */
function screenUnlock(){
  if(!hasVault())return go('#/login');
  var name=localStorage.getItem(LS_ACCT)||'';
  setContent(h(
    '<div class="title">'+esc(t('pin.unlock_title'))+'</div>',
    '<div class="card center">',
      '<div class="subtitle">@'+esc(name)+'</div>',
      '<label class="lab">'+esc(t('pin.enter'))+'</label>',
      '<input id="uk-pin" type="password" inputmode="numeric" class="pincode" maxlength="12">',
      '<button class="btn block mt" id="uk-go">'+esc(t('pin.unlock'))+'</button>',
      '<div class="mt"><a id="uk-forget" class="mut">'+esc(t('pin.forget'))+'</a></div>',
    '</div>'
  ));
  setTimeout(function(){el('uk-pin').focus();},50);
  el('uk-pin').addEventListener('keydown',function(e){if(e.key==='Enter')el('uk-go').click();});
  el('uk-go').onclick=async function(){
    try{
      var blob=JSON.parse(localStorage.getItem(LS_VAULT));
      var data=await decryptVault(blob, el('uk-pin').value);
      SESSION={account:data.account,wifs:data.wifs,pubs:{active:viz.auth.wifToPublic(data.wifs.active)}};
      updateChrome(); persistUnlocked(); seedWatch(); toast('ok',t('common.unlocked')); go(takeReturn());
    }catch(e){ toast('err',t('pin.wrong')); }
  };
  el('uk-forget').onclick=function(){
    if(!confirm(t('pin.forget_confirm')))return;
    localStorage.removeItem(LS_VAULT); localStorage.removeItem(LS_ACCT); SESSION=null; updateChrome(); go('#/login');
  };
}

/* ========================================================================= *
 *  SCREEN: Markets list + filters
 * ========================================================================= */
var mkFilter={status:1, showRisky:false, category:'', view:'hot', q:'', tag:'', sort:'newest'}; // status default 1=active (UX: land on markets you can bet on); view: hot | all | feed | popular; q = local search; tag = in-category tag filter; sort: newest | volume | expiration (category/tag browse, native node sort)
var lastBrowseHash='#/markets';   // remembers the last markets browse (filters/tag) so "back to markets" returns there
var MK_PAGE=50, mkShownLimit=MK_PAGE; // paginated views (category / all-status) grow this on "load more"
var TAG_DEEP=1000;                    // deep category window when a tag is active (client-side tag filter)
var POPULAR_PER_CAT=12;               // "Popular" fetches this many volume-top markets per category, then merges
/* Load-more state: the full sorted/filtered candidate list is cached so "load more" APPENDS the next
   page in place (no re-fetch, no wiping the list / flicker). server!=null → the fetched window may be
   partial (server-paginated), so once the cache runs out we pull the next server page and append. */
var mkMore=null;
/* Fetch the next server page for the CURRENT filter (only the server-paginated shapes: a category
   with no tag, or a single-status All view). Returns [] for cache-complete shapes. */
async function fetchMarketsNextPage(from){
  var jur=getJur();
  if(mkFilter.category!==''){
    if(mkFilter.tag) return []; // tag view is fully cached client-side
    var r=(await api('listMarketsByCategory', mkFilter.category, from, MK_PAGE, jur||'', '', '', mkFilter.sort||'newest'))||[];
    if(mkFilter.view==='all' && mkFilter.status!==-1) r=r.filter(function(m){return marketStatus(m)===mkFilter.status;});
    return r;
  }
  if(mkFilter.view==='all' && mkFilter.status!=null && mkFilter.status!==-1){
    return (await api('listMarkets', mkFilter.status, from, MK_PAGE, !!mkFilter.showRisky, 'newest'))||[];
  }
  return [];
}
/* Append the next page of cards without disturbing what's already on screen. Dedupes against the DOM
   by data-market (owner's suggestion) so overlapping server pages never double-render a card. */
async function appendMoreMarkets(){
  var host=el('mk-list'); if(!host||!mkMore) return;
  var btn=el('mk-more-btn'); var wrap=btn?btn.closest('.mt'):null;
  if(btn){ btn.disabled=true; btn.textContent=t('common.loading'); }
  var jur=getJur(), batch=[];
  // 1) serve from the cached full list
  if(mkMore.cursor<mkMore.all.length){
    batch=mkMore.all.slice(mkMore.cursor, mkMore.cursor+MK_PAGE);
    mkMore.cursor+=batch.length;
  }
  // 2) cache exhausted but the server window was partial → pull the next page and grow the cache
  else if(mkMore.server){
    try{
      var more=await fetchMarketsNextPage(mkMore.serverFrom);
      mkMore.serverFrom+=(more?more.length:0);
      if(!more||more.length<MK_PAGE) mkMore.server=false;      // short/empty page → no more upstream
      if(jur) more=(more||[]).filter(function(m){return !marketBannedIn(m,jur);});
      var have={}; mkMore.all.forEach(function(m){var id=marketId(m); if(id!=null)have[id]=1;});
      more=(more||[]).filter(function(m){var id=marketId(m); return id!=null && !have[id];});
      mkMore.all=mkMore.all.concat(more);
      batch=mkMore.all.slice(mkMore.cursor, mkMore.cursor+MK_PAGE);
      mkMore.cursor+=batch.length;
    }catch(e){ mkMore.server=false; }
  }
  // dedup against what's already rendered, then insert before the button
  batch=batch.filter(function(m){ var id=marketId(m); return id!=null && !host.querySelector('.card[data-market="'+id+'"]'); });
  if(batch.length){
    var htmlStr=batch.map(marketCard).join('');
    if(wrap) wrap.insertAdjacentHTML('beforebegin', htmlStr); else host.insertAdjacentHTML('beforeend', htmlStr);
    enrichCardBars(host);   // only the freshly-added cards still have .pbar-slot placeholders
  }
  var remaining=(mkMore.cursor<mkMore.all.length)||mkMore.server;
  if(!remaining){ if(wrap) wrap.remove(); }
  else if(btn){ btn.disabled=false; btn.textContent=t('common.load_more'); }
}
/* Moneyline / "who wins" markets first — the most representative market of a matchup, so they don't
   sit buried under dozens of prop markets (Total Kills, First Blood, …). Stable for equal keys. */
var MONEYLINE_RE=/\bwinner\b|moneyline|\bto win\b|match result|match winner/i;
function moneylineFirst(list){ return list.slice().sort(function(a,b){ return (MONEYLINE_RE.test(marketTitle(b))?1:0)-(MONEYLINE_RE.test(marketTitle(a))?1:0); }); }
/* Raw JSON-RPC to the configured node — for methods the vendored viz.min.js doesn't expose yet. */
function rawNodeCall(apiName, method, params){
  return fetch(loadNode().ws, {method:'POST', headers:{'content-type':'application/json'},
    body:JSON.stringify({id:1, jsonrpc:'2.0', method:'call', params:[apiName, method, params||[]]})})
    .then(function(r){ return r.json(); })
    .then(function(j){ if(j&&j.error) throw new Error((j.error&&j.error.message)||'rpc error'); return j?j.result:null; });
}
/* Authoritative per-category tag counts (get_category_tag_counts, node pm-branch). Cached per category.
   Returns {tagLower: count} or null if the node predates the method (then chips keep the page-window
   count). This makes the tag-chip number STABLE — the same whether or not the tag is selected
   (before this, it was counted from the loaded page → jumped, e.g. "1" then "540"). */
var CAT_TAG_COUNTS={};
function ensureCatTagCounts(cat){
  if(CAT_TAG_COUNTS[cat]!==undefined) return Promise.resolve(CAT_TAG_COUNTS[cat]);
  return rawNodeCall('prediction_market_api','get_category_tag_counts',[cat]).then(function(res){
    var arr=(res&&res.hot_tags)||[], map={};
    arr.forEach(function(x){ if(x&&x.tag!=null) map[String(x.tag).toLowerCase()]=Number(x.count)||0; });
    CAT_TAG_COUNTS[cat]=map; return map;
  }).catch(function(){ CAT_TAG_COUNTS[cat]=null; return null; });
}
/* Patch rendered tag-chip pills with authoritative counts once they arrive (no-op on old nodes). */
function patchTagCounts(host){
  if(!host || mkFilter.category==='') return;
  ensureCatTagCounts(mkFilter.category).then(function(map){
    if(!map) return;
    Array.prototype.forEach.call(host.querySelectorAll('.chip-n[data-tagn]'), function(sp){
      var n=map[sp.getAttribute('data-tagn')]; if(n!=null) sp.textContent=n;
    });
  }).catch(function(){});
}
// tags too broad to be useful as an in-category filter (the category itself, umbrella labels, source noise)
var GENERIC_TAGS={sports:1,games:1,esports:1,gaming:1,all:1,crypto:1,politics:1,news:1,culture:1,business:1,economy:1,tech:1,science:1,world:1,other:1,general:1};
/* Tags actually present on the loaded category's markets, ranked by frequency, rendered as clickable
   chips so users can drill into a category (e.g. esports → Valorant / LoL / CS2). Only within a category. */
function catTagBar(list){
  if(mkFilter.category==='') return '';
  var counts={}, order=[], catLow=String(mkFilter.category).toLowerCase();
  list.forEach(function(m){ var tg=parseMeta(m).tags||m.tags||[]; if(typeof tg==='string') tg=tg.split(/[,;]+/);
    (tg||[]).forEach(function(raw){ var s=String(raw).trim(); if(s.length<2) return;
      if(/jurisdiction-ban:/i.test(s)||/^rewards\b/i.test(s)||/deprec/i.test(s)) return;  // internal / source-config noise
      if(/^[\d.,\s]+$/.test(s)) return;                                 // reward-config number fragments ("4.5","50","100")
      var low=s.toLowerCase(); if(low===catLow||GENERIC_TAGS[low]) return;
      if(!counts[low]){ counts[low]={label:s,n:0}; order.push(low); } counts[low].n++;
    });
  });
  order.sort(function(a,b){ return counts[b].n-counts[a].n; });
  var top=order.slice(0,14);
  if(!top.length && !mkFilter.tag) return '';
  var chips='<button class="btn chip'+(!mkFilter.tag?' active':'')+'" data-tagf="">'+esc(t('mk.all_tags'))+'</button>';
  // count shown in a separate rounded pill (data-tagn → patched with the node's authoritative
  // per-category count so it's stable, not tied to the currently-loaded page).
  top.forEach(function(low){ chips+='<button class="btn chip'+(mkFilter.tag===low?' active':'')+'" data-tagf="'+esc(low)+'">'+esc(counts[low].label)+'<span class="chip-n" data-tagn="'+esc(low)+'">'+counts[low].n+'</span></button>'; });
  return '<div class="filters tagbar">'+chips+'</div>';
}
function marketHasTag(m,low){ var tg=parseMeta(m).tags||m.tags||[]; if(typeof tg==='string') tg=tg.split(/[,;]+/);
  return (tg||[]).some(function(x){ return String(x).trim().toLowerCase()===low; }); }
/* Markets browse state lives in the URL hash query so category/tag selections are deep-linkable &
   shareable (owner request). #/markets?v=hot&c=<catId>&t=<tag>&s=<status>&q=<search>. Only non-default
   keys are emitted; category/tag only make sense in the browsable views (hot/all). */
function marketsHash(){
  var browse=(mkFilter.view==='hot'||mkFilter.view==='all'), p=[];
  if(mkFilter.view && mkFilter.view!=='hot') p.push('v='+encodeURIComponent(mkFilter.view));
  if(browse && mkFilter.category!=='') p.push('c='+encodeURIComponent(mkFilter.category));
  if(browse && mkFilter.category!=='' && mkFilter.tag) p.push('t='+encodeURIComponent(mkFilter.tag));
  if(browse && mkFilter.category!=='' && mkFilter.sort && mkFilter.sort!=='newest') p.push('o='+encodeURIComponent(mkFilter.sort)); // sort only applies to category/tag browse; newest=default → clean URL
  if(mkFilter.view==='all' && mkFilter.status!==1) p.push('s='+encodeURIComponent(mkFilter.status)); // 1=active is default → clean URL; s=-1 encodes "All"
  if(mkFilter.q) p.push('q='+encodeURIComponent(mkFilter.q));
  return '#/markets'+(p.length?'?'+p.join('&'):'');
}
function parseMarketsHash(){                       // hash is the source of truth for the markets screen
  var h=location.hash||'', qi=h.indexOf('?'), g={};
  if(qi>=0) h.slice(qi+1).split('&').forEach(function(kv){ var i=kv.indexOf('='); g[i<0?kv:kv.slice(0,i)]=i<0?'':decodeURIComponent(kv.slice(i+1)); });
  mkFilter.view=g.v||'hot';
  mkFilter.category=g.c||'';
  mkFilter.tag=g.t||'';
  mkFilter.sort=(g.o==='volume'||g.o==='expiration')?g.o:'newest';
  mkFilter.status=(g.s!=null&&g.s!=='')?Number(g.s):1;
  mkFilter.q=g.q||'';
}
var actTab='history';           // current Activity sub-tab
var actSeq=0;                    // monotonic render token — a late async render only writes if still current
var ACT={loaded:false};          // per-visit cache of the user's positions/markets/disputes
var histState={from:-1,done:false}; // account-history pagination cursor (from=-1 → newest)
var catCache=null;               // category list (from node get_market_categories.categories), cached per session
var catHotTags=[];               // hot_tags from get_market_categories, cached per session

/* favorite categories (personalized feed) */
function getFavCats(){ try{var a=JSON.parse(localStorage.getItem(LS_FAV)); return Array.isArray(a)?a.map(String):[];}catch(e){return [];} }
function setFavCats(a){ localStorage.setItem(LS_FAV, JSON.stringify((a||[]).map(String))); }
function catId(c){ return c.id!=null?c.id:(c.category!=null?c.category:c); }
function catName(c){
  var id=catId(c), k='cat.'+id, lab=t(k);
  // t() returns the key itself when missing → fall back to node-provided name/id
  if(lab && lab!==k) return lab;
  return c.name||c.title||id;
}
/* -------- localStorage cache (DISCOVERY ONLY — never bet/act off cached data) -------- */
function cacheGet(key,ttl){ try{ var o=JSON.parse(localStorage.getItem(key)); if(o&&o.ts&&(now()-o.ts)<=ttl) return o; return o?Object.assign(o,{_stale:true}):null; }catch(e){ return null; } }
function cacheSet(key,obj){ try{ obj.ts=now(); localStorage.setItem(key, JSON.stringify(obj)); }catch(e){} }
/* Built-in fallback taxonomy — used only on first paint / offline when the node call fails and no cache. */
var FALLBACK_CATS=['Politics','Sports','Crypto','Economy','Tech','Culture','World','Science'].map(function(c){return {category:c};});

/* Fetch live taxonomy, normalizing the node shape {categories,hot_tags}; cache to LS; fallback if all fails.
   fresh=true forces a network refresh (used for stale-while-revalidate). */
async function ensureCategories(fresh){
  if(catCache && !fresh) return catCache;
  var c=cacheGet(LS_CAT_TAX, CACHE_TAX_TTL);
  if(c && !c._stale && !fresh){ catCache=c.cats||[]; catHotTags=c.tags||[]; return catCache; } // fresh cache → use, skip network
  try{
    var res=await api('getMarketCategories');
    var cats=(res&&res.categories)?res.categories:(Array.isArray(res)?res:[]);
    var tags=(res&&res.hot_tags)?res.hot_tags:[];
    catCache=cats; catHotTags=tags; cacheSet(LS_CAT_TAX,{cats:cats,tags:tags});
  }catch(e){
    if(c){ catCache=c.cats||[]; catHotTags=c.tags||[]; }              // network failed → last known cache (even stale)
    else { catCache=catCache||FALLBACK_CATS; catHotTags=catHotTags||[]; } // nothing at all → preset
  }
  return catCache;
}

/* Compact market index in LS: instant paint of the discovery feed + fast local search over known markets. */
function idxRow(m){ return {id:marketId(m), title:marketTitle(m), cat:(parseMeta(m).category||''), sub:(parseMeta(m).subcategory||''),
  tags:(parseMeta(m).tags||m.tags||''), exp:assetTime(m.betting_expiration)||0, status:marketStatus(m), vol:volOf(m), upd:now()}; }
/* Compact market index in LS, keyed by market id. Ids are stable/permanent on chain, so an id always maps to
   the same market; mutable fields (status/vol/exp) self-refresh via the index TTL (default 30 min, user-set).
   This is discovery/metadata only — a market runs for weeks, and its details/prices are always fetched fresh
   on the market screen — so a long TTL is safe and cuts network use. */
function mktTtl(){ try{ var v=parseInt(localStorage.getItem(LS_MKT_TTL),10); if(v>0) return v; }catch(e){} return DEFAULT_MKT_TTL; }
/* Drop entries whose betting window has closed — even within TTL, an expired market must never be shown as
   live in the discovery feed/search. exp==0 (unknown) is kept. */
function indexFresh(items){ var tn=now(); return (items||[]).filter(function(r){ return !r.exp || r.exp>tn; }); }
function indexGet(){
  var o=cacheGet(LS_MKT_IDX, mktTtl()); if(!o) return null;
  var all=o.items||[], items=indexFresh(all);
  if(items.length!==all.length){ try{ localStorage.setItem(LS_MKT_IDX, JSON.stringify({ts:o.ts, items:items})); }catch(e){} } // clean expired from storage, keep original ts
  return {items:items, stale:!!o._stale, ts:o.ts};
}
/* Merge fresh markets into the index by id, drop resolved/expired, cap size (newest-first). */
function indexPut(list){
  var m={}; var prev=indexGet(); if(prev) prev.items.forEach(function(r){ m[r.id]=r; });
  (list||[]).forEach(function(mk){ var r=idxRow(mk); if(r.id!=null) m[r.id]=r; });
  var items=indexFresh(Object.keys(m).map(function(k){return m[k];}).filter(function(r){ return r.status<3; })) // active & betting still open only
    .sort(function(a,b){ return b.id-a.id; }).slice(0, CACHE_IDX_CAP);
  cacheSet(LS_MKT_IDX,{items:items});
  return items;
}
function viewChip(v,label){ return '<button class="btn chip'+(mkFilter.view===v?' active':'')+'" data-view="'+v+'">'+esc(label)+'</button>'; }
function sortChip(s,label){ return '<button class="btn chip'+((mkFilter.sort||'newest')===s?' active':'')+'" data-sort="'+s+'">'+esc(label)+'</button>'; }
/* Sort chips for category/tag browse — the node sorts natively (newest | volume desc | ending soon). */
function sortBar(){ if(mkFilter.category==='') return ''; return '<div class="filters" id="mk-sort">'+
  sortChip('newest',t('mk.sort_newest'))+sortChip('volume',t('mk.sort_volume'))+sortChip('expiration',t('mk.sort_ending'))+'</div>'; }

async function screenMarkets(){
  parseMarketsHash();                               // restore browse state (view/category/tag/status/q) from the URL
  lastBrowseHash=location.hash||'#/markets';        // so "← back to markets" from a market/event returns to THIS filtered view
  mkShownLimit=MK_PAGE;                             // reset pagination window on any filter/nav change
  var views='<div class="filters" id="mk-views">'+
    viewChip('hot',t('mk.view_hot'))+viewChip('all',t('mk.view_all'))+viewChip('feed',t('mk.view_feed'))+viewChip('popular',t('mk.view_popular'))+
    '<button class="btn chip" id="mk-fav-edit">'+esc(t('mk.edit_favorites'))+'</button></div>';
  var withCats=(mkFilter.view==='hot'||mkFilter.view==='all'); // hot & all support category browsing + local search
  var filters='';
  if(withCats){
    filters+='<input id="mk-q" type="search" placeholder="'+esc(t('mk.search_ph'))+'" value="'+esc(mkFilter.q||'')+'" style="margin-bottom:8px;width:100%">';
  }
  if(mkFilter.view==='hot'){
    filters+='<div class="hint">'+esc(t('mk.hot_hint'))+'</div><div class="filters" id="mk-cats"></div>';
  } else if(mkFilter.view==='all'){
    filters+='<div class="filters" id="mk-status">'+chip('1',t('mk.f_active'),mkFilter.status)+
      chip('3',t('mk.f_resolved'),mkFilter.status)+chip('2',t('mk.f_closed'),mkFilter.status)+chip('-1',t('mk.f_all'),mkFilter.status)+'</div>'+
      '<div class="filters" id="mk-cats"></div>'+
      '<label class="lab" style="margin-top:0"><input type="checkbox" id="mk-risky" '+(mkFilter.showRisky?'checked':'')+'> '+esc(t('mk.show_risky'))+'</label>';
  } else if(mkFilter.view==='feed'){
    filters+='<div class="hint">'+esc(t('mk.feed_hint'))+'</div>';
  } else if(mkFilter.view==='popular'){
    filters+='<div class="hint">'+esc(t('mk.popular_hint'))+'</div>';
  }
  if(withCats) filters+=sortBar();   // native newest/volume/ending-soon sort — only while browsing a section/tag
  filters+='<div class="hint"><span data-nav="#/node" style="cursor:pointer">'+esc(t('mk.jur_hint',{J:jurDisplay()}))+'</span></div>';
  setContent('<div class="title">'+esc(t('mk.title'))+'</div>'+views+filters+
    '<div id="mk-list" class="mt"><div class="empty"><span class="spin"></span> '+esc(t('common.loading'))+'</div></div>');

  $('#mk-views').addEventListener('click',function(e){
    if(e.target.closest('#mk-fav-edit')){ openFavModal(); return; }
    var c=e.target.closest('[data-view]'); if(!c)return; mkFilter.view=c.getAttribute('data-view'); mkFilter.q=''; mkFilter.tag=''; go(marketsHash());
  });
  if(withCats){
    var qbox=el('mk-q');
    if(qbox) qbox.addEventListener('input', debounce(function(){ mkFilter.q=qbox.value.trim(); mkShownLimit=MK_PAGE; try{history.replaceState(null,'',marketsHash());}catch(e){} loadMarketList(); }, 200)); // quiet hash update keeps input focus
    if(mkFilter.view==='all'){
      $('#mk-status').addEventListener('click',function(e){var c=e.target.closest('[data-v]');if(!c)return;mkFilter.status=Number(c.getAttribute('data-v'));mkFilter.tag='';go(marketsHash());});
      el('mk-risky').onchange=function(){mkFilter.showRisky=this.checked;loadMarketList();};
    }
    var sortHost=el('mk-sort'); // present only while a category is selected
    if(sortHost) sortHost.addEventListener('click',function(e){var c=e.target.closest('[data-sort]');if(!c)return;mkFilter.sort=c.getAttribute('data-sort');go(marketsHash());});
    var renderCats=function(cats){
      var host=$('#mk-cats'); if(!host||!cats||!cats.length)return;
      host.innerHTML=chip('',t('mk.all_cats'),mkFilter.category)+cats.map(function(c){
        return chip(String(catId(c)),(c.icon?c.icon+' ':'')+catName(c),mkFilter.category);
      }).join('');
      host.onclick=function(e){var c=e.target.closest('[data-v]');if(!c)return;mkFilter.category=c.getAttribute('data-v');mkFilter.tag='';mkFilter.sort='newest';go(marketsHash());}; // fresh section → default (newest) order (onclick = idempotent on re-render)
    };
    ensureCategories().then(function(cats){
      renderCats(cats);
      // stale-while-revalidate: the taxonomy shifts as markets get indexed/pruned (a category can be
      // temporarily absent right after a node reseed, then reappear once its markets re-index). The
      // 15-min cache alone would hide the change until it expires, so always refresh from the node in
      // the background and re-render if the category set changed — self-heals without a hard refresh.
      var before=(cats||[]).map(function(c){return catId(c);}).join(',');
      ensureCategories(true).then(function(fresh){
        if(fresh && fresh.map(function(c){return catId(c);}).join(',')!==before) renderCats(fresh);
      }).catch(function(){});
    });
  }
  loadMarketList();
}
function chip(v,label,cur){ return '<button class="btn chip'+((''+cur)===(''+v)?' active':'')+'" data-v="'+esc(v)+'">'+esc(label)+'</button>'; }
async function openFavModal(){
  var cats=await ensureCategories(), fav=getFavCats();
  var body='<div class="hint mb">'+esc(t('mk.fav_desc'))+'</div>'+
    (cats.length?cats.map(function(c){var id=String(catId(c));
      return '<label class="lab"><input type="checkbox" class="fav-cb" value="'+esc(id)+'"'+(fav.indexOf(id)>=0?' checked':'')+'> '+(c.icon?c.icon+' ':'')+esc(catName(c))+'</label>';
    }).join(''):'<div class="mut">'+esc(t('mk.none'))+'</div>');
  openModal(t('mk.fav_title'), body, [
    {label:t('common.cancel'),cls:'ghost',act:closeModal},
    {label:t('mk.fav_save'),cls:'',act:function(){
      var sel=$all('.fav-cb').filter(function(x){return x.checked;}).map(function(x){return x.value;});
      setFavCats(sel); closeModal(); toast('ok',t('mk.fav_saved'));
      if(mkFilter.view==='feed') loadMarketList();
    }}
  ]);
}

async function loadMarketList(){
  var host=el('mk-list'); if(!host)return;
  var jur=getJur(), list;
  // Fast local search over the cached index (known markets) — instant, offline-friendly. DISCOVERY only.
  if(mkFilter.q){
    var q=mkFilter.q.toLowerCase(), idx=indexGet();
    var hits=((idx&&idx.items)||[]).filter(function(r){
      return (r.title&&r.title.toLowerCase().indexOf(q)>=0)||(String(r.tags||'').toLowerCase().indexOf(q)>=0)||(String(r.cat||'').toLowerCase().indexOf(q)>=0);
    });
    host.innerHTML=hits.length?hits.map(indexCard).join(''):'<div class="empty">'+esc(t('mk.search_none'))+'</div>';
    return;
  }
  // Discovery feed: stale-while-revalidate — instant paint from cached index, then refresh live below.
  if(mkFilter.view==='hot' && mkFilter.category===''){
    var cx=indexGet();
    host.innerHTML=(cx&&cx.items.length)?cx.items.slice(0,60).map(indexCard).join('')
      :'<div class="empty"><span class="spin"></span> '+esc(t('common.loading'))+'</div>';
  } else {
    host.innerHTML='<div class="empty"><span class="spin"></span> '+esc(t('common.loading'))+'</div>';
  }
  try{
    if(mkFilter.view==='hot'){
      // "New & relevant first" — client-side blend (option A): active, non-expired markets ranked by recency×activity.
      if(mkFilter.category!==''){
        // Tag filter runs SERVER-SIDE (node tag param is case-insensitive since pm-api b8f426db) —
        // returns the whole tagged set (winner/props included), not just those in a newest-N window.
        list=(await api('listMarketsByCategory', mkFilter.category, 0, (mkFilter.tag?TAG_DEEP:mkShownLimit), jur||'', '', mkFilter.tag||'', mkFilter.sort||'newest'))||[];
      } else {
        list=(await api('listMarkets', 1, 0, 100, !!mkFilter.showRisky, 'newest'))||[]; // newest active window, then blended by rankHot
        list=list.filter(function(m){ var e=assetTime(m.betting_expiration); return marketStatus(m)===1 && (!e||e>now()); }); // active & still bettable
        list=rankHot(list);
      }
    } else if(mkFilter.view==='feed'){
      var favs=getFavCats();
      if(!favs.length){
        host.innerHTML='<div class="empty">'+esc(t('mk.feed_empty'))+'<div class="mt"><button class="btn small" id="mk-feed-pick">'+esc(t('mk.feed_pick'))+'</button></div></div>';
        el('mk-feed-pick').onclick=openFavModal; return;
      }
      var parts=await Promise.all(favs.map(function(cat){ return api('listMarketsByCategory', cat, 0, 30, jur||'', '', '', 'newest').catch(function(){return [];}); }));
      list=dedupeMarkets([].concat.apply([], parts));
      list.sort(function(a,b){ return marketId(b)-marketId(a); }); // newest first (higher id = newer)
    } else if(mkFilter.view==='popular'){
      // popularity = tokens locked by bettors → highest-volume markets first. The node has NO global
      // volume sort (list_markets does newest/oldest only); the old approach sorted just the newest-100
      // window, which on a freshly-seeded chain is ALL zero-volume (fresh markets, no bets) → empty.
      // Fix: aggregate each category's volume-sorted top (server-side `volume` sort) and merge. If rows
      // carry `.volume` (newer node) we sort globally by it; otherwise interleave by per-category rank so
      // the biggest market of every section surfaces at the top. Real volumes fill async via enrichCardBars.
      var pcats=(await ensureCategories())||[];
      var per=await Promise.all(pcats.map(function(c){
        return api('listMarketsByCategory', String(catId(c)), 0, POPULAR_PER_CAT, jur||'', '', '', 'volume').then(function(r){return r||[];}).catch(function(){return [];});
      }));
      var haveVol=per.some(function(rows){ return rows.some(function(m){ return m && m.volume!=null; }); });
      if(haveVol){
        list=dedupeMarkets([].concat.apply([], per));
        list.sort(function(a,b){ return (volOf(b)-volOf(a)) || (marketId(b)-marketId(a)); });
      } else {
        var merged=[], mx=Math.max.apply(null,[0].concat(per.map(function(p){return p.length;})));
        for(var ri=0;ri<mx;ri++) per.forEach(function(rows){ if(rows[ri]) merged.push(rows[ri]); }); // round-robin by rank
        list=dedupeMarkets(merged);
      }
    } else {
      if(mkFilter.category!==''){
        list=await api('listMarketsByCategory', mkFilter.category, 0, (mkFilter.tag?TAG_DEEP:mkShownLimit), jur||'', '', mkFilter.tag||'', mkFilter.sort||'newest');
      } else if(mkFilter.status===-1){
        // node list_markets keys on an EXACT status; -1 is not "all" → aggregate real statuses
        var STS=[1,2,3,0]; // active, closed, resolved, waiting
        var parts=await Promise.all(STS.map(function(s){ return api('listMarkets', s, 0, mkShownLimit, !!mkFilter.showRisky, 'newest').catch(function(){return [];}); }));
        list=dedupeMarkets([].concat.apply([], parts));
        list.sort(function(a,b){ return marketId(b)-marketId(a); }); // newest first
      } else {
        list=await api('listMarkets', mkFilter.status, 0, mkShownLimit, !!mkFilter.showRisky, 'newest');
      }
      list=list||[];
      // Keep the node's order when the user picked an explicit category sort (volume/expiration);
      // otherwise normalize to newest-first (higher id = newer) — covers single-status path too.
      var explicitSort=(mkFilter.category!=='' && mkFilter.sort && mkFilter.sort!=='newest');
      if(!explicitSort) list.sort(function(a,b){ return marketId(b)-marketId(a); });
      if(mkFilter.category!=='' && mkFilter.status!==-1) list=list.filter(function(m){return marketStatus(m)===mkFilter.status;});
    }
    // Paginated views (category browse, or All-view single status) fetch `mkShownLimit` rows; a full
    // page means the node likely has more → offer "load more" (grows the window, refetches from 0).
    var paginated=(mkFilter.category!=='')||(mkFilter.view==='all'&&mkFilter.status!==-1);
    var rawLen=list.length;                                          // fetched count, before jur/tag filtering
    if(jur) list=list.filter(function(m){return !marketBannedIn(m,jur);}); // '' jur = show all
    try{ if(mkFilter.view==='hot'||mkFilter.view==='all'||mkFilter.view==='popular') indexPut(list); }catch(e){} // refresh discovery cache (never used for betting)
    if(!list.length){ host.innerHTML='<div class="empty">'+esc(t('mk.none'))+'</div>'; return; }
    var bar=catTagBar(list);                                          // in-category tag chips (from full category list)
    var shownAll=mkFilter.tag ? list.filter(function(m){return marketHasTag(m,mkFilter.tag);}) : list;
    // Float "who wins" markets above props — but only for the default newest order; an explicit
    // volume/expiration sort is the user's chosen order and must be preserved verbatim.
    if((mkFilter.category!==''||mkFilter.tag) && (mkFilter.sort||'newest')==='newest') shownAll=moneylineFirst(shownAll);
    // Cache the full candidate list; render the first page. "Load more" appends the rest in place
    // (appendMoreMarkets) — no re-fetch, no wiping the list. server=true → the fetched window may be
    // partial (server-paginated, no tag), so the cache can be grown page-by-page from the node.
    var serverMore=paginated && !mkFilter.tag && rawLen>=mkShownLimit;
    mkMore={ all:shownAll, cursor:0, server:serverMore, serverFrom:rawLen };
    var firstPage=shownAll.slice(0, MK_PAGE); mkMore.cursor=firstPage.length;
    var hasMore=(mkMore.cursor<shownAll.length)||serverMore;
    var more=hasMore ? '<div class="mt" style="text-align:center"><button class="btn" id="mk-more-btn">'+esc(t('common.load_more'))+'</button></div>' : '';
    host.innerHTML=bar+(firstPage.length?firstPage.map(marketCard).join(''):'<div class="empty">'+esc(t('mk.none_tag'))+'</div>')+more;
    enrichCardBars(host);                                            // async-fill named outcome bars for the rendered cards
    patchTagCounts(host);                                            // replace page-window tag counts with authoritative per-category counts
    Array.prototype.forEach.call(host.querySelectorAll('[data-tagf]'), function(b){       // wire tag chips (idempotent per render)
      b.onclick=function(){ mkFilter.tag=b.getAttribute('data-tagf')||''; go(marketsHash()); };
    });
    var moreBtn=el('mk-more-btn'); if(moreBtn) moreBtn.onclick=appendMoreMarkets;
  }catch(e){ host.innerHTML='<div class="box err">'+esc(t('mk.load_failed',{E:errText(e)}))+'</div>'; }
}
/* "New & relevant" blend: normalize recency (market id) and activity (log volume), weight 0.55/0.45. */
function rankHot(list){
  if(!list||!list.length) return list||[];
  var maxId=1,maxV=0;
  list.forEach(function(m){ var id=marketId(m)||0; if(id>maxId)maxId=id; var v=Math.log(1+volOf(m)); if(v>maxV)maxV=v; });
  function score(m){ var id=(marketId(m)||0)/maxId, v=maxV?Math.log(1+volOf(m))/maxV:0; return 0.55*id+0.45*v; }
  return list.slice().sort(function(a,b){ return score(b)-score(a); });
}
/* Compact card for cached-index rows (instant paint / search results). Opening re-fetches live data. */
function indexCard(r){
  return '<div class="card click card-dense" data-nav="#/market/'+r.id+'">'
    +'<div class="card-q">'+esc(r.title||('Market #'+r.id))+'</div>'
    +'<div class="mut" style="font-size:12px">'+(r.cat?esc(r.cat)+' · ':'')+esc(statusLabel(r.status))+'</div></div>';
}
function dedupeMarkets(arr){ var seen={},out=[]; arr.forEach(function(m){var id=marketId(m); if(id!=null&&!seen[id]){seen[id]=1;out.push(m);}}); return out; }
function volOf(m){ return Number(m.volume!=null?m.volume:(m.total_volume!=null?m.total_volume:(m.bets_sum!=null?m.bets_sum:(m.total_bets||0))))||0; }
function marketCard(m){
  var id=marketId(m), ocs=marketOutcomes(m), meta=parseMeta(m);
  var vol=m.volume!=null?m.volume:(m.total_volume!=null?m.total_volume:(m.bets_sum!=null?m.bets_sum:null)); // bets_sum present on full market_card rows; meta_object (category) rows lack it → async slot
  var risky=(m.risk_score!=null && m.risk_score<50)||m.under_collateralized;
  return h(
    '<div class="card click" data-market="'+id+'" data-nav="#/market/'+id+'">',   // data-market → dedup on load-more
      marketThumb(meta, m, 8),   // trusted image (1:1 contain) or local category icon
      // event_title (readable parent-event label, e.g. "Dota 2: A vs B") — surfaces the matchup so a
      // secondary market ("Total Kills … Game 2") isn't a mystery. By-category listings expose it at the
      // row's top level (meta_object field); market_card/get_market nest it under metadata.
      ((m.event_title||meta.event_title)?'<div class="mut" style="font-size:12px">'+esc(m.event_title||meta.event_title)+'</div>':''),
      '<div class="card-q">'+esc(marketTitle(m))+'</div>',
      // reserves-based strip when the row already carries them; otherwise an async slot filled by
      // enrichCardBars() via get_market_weight_sums (light listings have no reserves/outcomes).
      (probBar(m)||'<div class="pbar-slot" data-mkt="'+id+'"></div>'),
      '<div class="card-meta">',
        statusBadge(m),
        '<span>'+(Number(m.market_type)===1?esc(t('mk.multi',{N:ocs.length})):esc(t('mk.binary')))+'</span>',
        (m.oracle?'<span>'+esc(t('mk.oracle',{O:m.oracle}))+'</span>':''),
        (risky?'<span class="badge risk">'+esc(t('mk.risky'))+'</span>':''),
        (meta.jurisdiction?'<span>🌐 '+esc(meta.jurisdiction)+'</span>':''),
        // volume, muted, pushed to the far right (margin-left:auto). Inline when the row carries it;
        // otherwise an async slot filled by enrichCardBars from get_market_weight_sums.bets_sum.
        (vol!=null?'<span class="card-vol">'+esc(t('mk.vol',{V:fmtVizK(vol)}))+'</span>'
                  :'<span class="card-vol" data-volmkt="'+id+'"></span>'),
      '</div>',
    '</div>'
  );
}

/* ========================================================================= *
 *  SCREEN: Event — sibling markets sharing one real-world event (a match/game)
 *  Uses the node's list_markets_by_event (indexed metadata.event key); each child
 *  is a normal market card. Discovery/navigation only — never bet off this list.
 * ========================================================================= */
async function screenEvent(key){
  if(!key){ return screenMarkets(); }
  setContent('<div class="empty"><span class="spin"></span> '+esc(t('common.loading'))+'</div>');
  var list;
  try{ list=await api('listMarketsByEvent', key, 0, 200); }
  catch(e){ setContent('<div class="row"><a class="mut" data-nav="'+esc(lastBrowseHash)+'">'+esc(t('common.back_markets'))+'</a></div>'+
      '<div class="box err">'+esc(errText(e))+'</div>'); return; }
  list=(list||[]).filter(Boolean);
  // Prefer the readable event label (e.g. "Dota 2: A vs B") from any child; fall back to the generic title.
  var evLabel=''; for(var i=0;i<list.length;i++){ var em=parseMeta(list[i]); var et=(em&&em.event_title)||list[i].event_title; if(et){ evLabel=et; break; } }
  var head='<div class="row"><a class="mut" data-nav="'+esc(lastBrowseHash)+'">'+esc(t('common.back_markets'))+'</a></div>'+
    '<div class="title" style="margin:6px 0">'+esc(evLabel||t('ev.title'))+'</div>'+
    '<div class="card-meta mb"><span class="mono">'+esc(key)+'</span>'+
    (list.length?'<span>'+esc(t('ev.count',{N:list.length}))+'</span>':'')+'</div>';
  if(!list.length){ setContent(head+'<div class="box">'+esc(t('ev.empty'))+'</div>'); return; }
  // Moneyline/winner markets float to the top — most representative of the matchup.
  var ML=/winner|moneyline|to win\b/i;
  list.sort(function(a,b){ return (ML.test(marketTitle(b))?1:0)-(ML.test(marketTitle(a))?1:0); });
  setContent(head+list.map(marketCard).join(''));
  enrichCardBars(el('content'));                                     // named outcome bars per sibling market
}

/* ========================================================================= *
 *  SCREEN: Market detail (info + bet + cancel + liquidity + oracle + dispute)
 * ========================================================================= */
async function screenMarket(id){
  id=Number(id);
  setContent('<div class="empty"><span class="spin"></span> '+esc(t('md.loading',{ID:id}))+'</div>');
  var full, dispute=null;
  try{ full=await api('getMarketFull', id, SESSION?SESSION.account:''); }
  catch(e){ try{ full=await api('getMarket', id); }catch(e2){ setContent('<div class="box err">'+esc(errText(e2))+'</div>');return; } }
  try{ dispute=await api('getDispute', id); }catch(e){}
  // merge the node meta object (full.meta: title/image/category/…) over any metadata blob
  var m=full.market||full; var meta=Object.assign({}, parseMeta(m), full.meta||{});
  // Real outcome labels live in full.outcomes (pm_outcome objects), NOT on the market object — attach
  // them so the page shows the true labels ("Over 2.5 / Under 2.5", candidate names, …) instead of the
  // Yes/No fallback. Every consumer here reads them via marketOutcomes(m) → m.outcome_names.
  if(Array.isArray(full.outcomes) && full.outcomes.length){
    m.outcome_names=full.outcomes.slice().sort(function(a,b){return (Number(a.outcome_index)||0)-(Number(b.outcome_index)||0);}).map(function(o){return o.label||o.name||o.title||String(o);});
  }
  var ocs=marketOutcomes(m);
  var status=marketStatus(m); var isMulti=Number(m.market_type)===1;
  var mine=full.account||full.positions||full.bets; // best-effort account section
  var isOracle=SESSION && m.oracle===SESSION.account;
  var risky=(m.risk_score!=null && Number(m.risk_score)<50)||!!m.under_collateralized;
  var instantDisabled=(meta.allow_instant_bet===false)||(m.allow_instant_bet===false);

  var html='';
  html+='<div class="row"><a class="mut" data-nav="'+esc(lastBrowseHash)+'">'+esc(t('common.back_markets'))+'</a></div>';
  html+=marketCrumbs(meta);
  html+='<div style="display:flex;align-items:center;gap:10px;margin-top:6px">'+
        marketAvatar(meta, m, 50)+
        '<div class="title" style="margin:0">'+esc(meta.title||marketTitle(m))+'</div></div>';
  html+='<div class="card-meta mb">'+statusBadge(m)+
        '<span>'+(isMulti?esc(t('md.onix_multi')):esc(t('md.onix_binary')))+'</span>'+
        (m.oracle?'<span><a data-nav="#/oracles/'+encodeURIComponent(m.oracle)+'">'+esc(t('md.oracle',{O:m.oracle}))+'</a></span>':'')+
        (m.creator?'<span>'+esc(t('md.by',{C:m.creator}))+'</span>':'')+
        (meta.event?'<span><a data-nav="#/event/'+encodeURIComponent(meta.event)+'">'+esc(meta.event_title?meta.event_title+' ↗':t('md.event'))+'</a></span>':'')+'</div>';

  html+='<div id="oracle-info" class="mb"></div>';

  if(getJur() && marketBannedIn(m,getJur())) html+='<div class="box warn">'+esc(t('md.jur_blocked',{J:getJur()}))+'</div>';

  // pending market: oracle acceptance deadline. accept_deadline=0 (epoch/1970) means "n/a"
  // (self-oracle / auto-accept markets active at creation) — only meaningful while status==0.
  if(status===0){ var _ad=assetTime(m.accept_deadline);
    if(_ad>0) html+='<div class="box '+(_ad>now()?'warn':'err')+'">'+esc(t('md.accept_by',{T:tsToLocal(_ad), IN:fmtIn(_ad)}))+'</div>'; }

  if(meta.description) html+='<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('md.rules'))+'</div>'+esc(meta.description)+'</div>';

  // Outcomes + implied prices (best-effort)
  html+='<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('md.outcomes'))+'</div>';
  var prices=outcomePrices(full, ocs.length, isMulti);
  ocs.forEach(function(name,i){
    var pct=prices[i]!=null?prices[i]:null;
    var cls=(!isMulti && i===0)?'yes':(!isMulti?'no':'');
    html+='<div class="oc"><div class="oc-row"><span class="oc-name">'+esc(name)+'</span><span>'+(pct!=null?(pct*100).toFixed(1)+'%':'—')+'</span></div>'+
          '<div class="oc-bar"><div class="oc-fill '+cls+'" style="width:'+(pct!=null?Math.max(2,pct*100):0)+'%"></div></div></div>';
  });
  html+='</div>';

  // Outcome-ratio chart (from get_market_kline)
  html+='<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('md.chart_title'))+'</div>'+
    '<div id="kline-box"><div class="empty"><span class="spin"></span> '+esc(t('common.loading'))+'</div></div></div>';

  // Key params
  html+='<div class="card">'+
    kv(t('md.status'),statusLabel(status))+
    (m.winning_outcome!=null&&status===3?kv(t('md.result'), ocs[m.winning_outcome]!=null?ocs[m.winning_outcome]:('outcome '+m.winning_outcome)):'')+
    (m.betting_expiration?kv(t('md.betting_until'), tsToLocal(assetTime(m.betting_expiration))):'')+
    (m.result_expiration?kv(t('md.result_deadline'), tsToLocal(assetTime(m.result_expiration))):'')+
    (m.volume!=null?kv(t('md.volume'), fmtViz(m.volume)):'')+
    (meta.jurisdiction?kv(t('md.jurisdiction'), meta.jurisdiction):'')+
    '<div id="mkt-lazy-alloc"></div>'+   // getMarketLazyAllocation
    (meta.rules_url||m.url?('<div class="kv"><b>'+esc(t(meta.description?'md.source':'md.rules'))+'</b><a href="'+esc(meta.rules_url||m.url)+'" target="_blank">'+esc(t('md.open_ext'))+'</a></div>'):'')+
    rawBlock(full)+
  '</div>';

  // Recent bets (getMarketBets) — transparency into the order flow
  html+='<div class="card"><details class="raw"><summary>'+esc(t('md.recent_bets'))+'</summary><div id="mkt-bets"><span class="spin"></span> '+esc(t('common.loading'))+'</div></details></div>';

  // Betting form (active only)
  if(status===1){
    html+='<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('md.place_bet'))+'</div>';
    html+='<div class="box warn">'+esc(t('risk.not_fixed_odds'))+'</div>';
    if(!isUnlocked()) html+='<div class="box info">'+unlockLink('md.unlock_to_bet')+'</div>';
    if(risky) html+='<div class="box err">'+esc(t('bet.risk_warning'))+'</div>';
    if(instantDisabled) html+='<div class="box warn">'+esc(t('md.instant_disabled'))+'</div>';
    html+='<div class="field"><label class="lab">'+esc(t('md.outcome'))+'</label><select id="bt-oc">'+
      ocs.map(function(n,i){return '<option value="'+i+'">'+esc(n)+'</option>';}).join('')+'</select></div>';
    html+='<div class="field"><label class="lab">'+esc(t('common.amount_viz'))+'</label><input id="bt-amt" type="number" step="0.001" min="0.001" placeholder="10.000"></div>';
    html+='<div class="hint">'+esc(t('bet.slippage_note'))+'</div>';
    html+='<div class="field"><label class="lab">'+esc(t('md.min_tokens'))+'</label><input id="bt-min" type="number" step="1" min="0" value="0"></div>';
    html+='<label class="lab"><input type="checkbox" id="bt-batch"'+(instantDisabled?' checked':'')+'> '+esc(t('md.batch'))+'</label><div class="hint">'+esc(t('bet.batch_hint'))+'</div>';
    if(!isMulti) html+='<label class="lab"><input type="checkbox" id="bt-hidden"> '+esc(t('md.hidden'))+'</label><div class="hint">'+esc(t('bet.hidden_hint'))+'</div>';
    if(risky) html+='<label class="lab"><input type="checkbox" id="bt-risk"> '+esc(t('bet.risk_confirm'))+'</label>';
    html+='<div class="box info" style="margin-top:8px">'+esc(t('bet.parimutuel_note'))+'</div>';
    html+='<button class="btn ok block mt" id="bt-go">'+esc(t('md.place_bet_btn'))+'</button></div>';
  }

  // Liquidity (add + withdraw own positions)
  if(status===0||status===1||status===2){
    html+='<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('md.liquidity'))+'</div>'+
      '<div class="box warn">'+esc(t('lq.risk_notice'))+'</div>';
    if(status===0||status===1){
      html+='<div class="field"><label class="lab">'+esc(t('md.add_liq'))+'</label><input id="lq-amt" type="number" step="0.001" min="0.001" placeholder="50.000"></div>'+
      '<button class="btn ghost" id="lq-go">'+esc(t('md.add_liq_btn'))+'</button>'+
      (isMulti?'<div class="hint">'+esc(t('md.multi_lmsr'))+'</div>':'');
    }
    html+='<div class="section-title">'+esc(t('lq.mine_title'))+'</div><div id="lq-mine">'+
      (isUnlocked()?'<span class="spin"></span> '+esc(t('common.loading')):'<div class="mut">'+unlockLink('md.unlock_view')+'</div>')+'</div>';
    html+='</div>';
  }

  // Leverage (open / manage borrowed positions) — high-risk, chain-gated
  if(status===0||status===1){
    html+='<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('lev.title'))+'</div>'+
      '<div id="lev-box"><span class="spin"></span> '+esc(t('common.loading'))+'</div></div>';
  }

  // My positions on this market
  html+='<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('md.my_positions'))+'</div><div id="mine-box">'+
        (isUnlocked()?'<span class="spin"></span> '+esc(t('common.loading')):'<div class="mut">'+unlockLink('md.unlock_view')+'</div>')+'</div></div>';

  // Oracle actions
  if(isOracle){
    html+='<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('md.oracle_actions'))+'</div>';
    if(status===0) html+='<button class="btn ghost" id="or-accept">'+esc(t('md.accept'))+'</button> <button class="btn ghost" id="or-reject">'+esc(t('md.reject'))+'</button>';
    if(status===1||status===2){
      html+='<div class="field"><label class="lab">'+esc(t('md.resolve_win'))+'</label><select id="or-win">'+
        ocs.map(function(n,i){return '<option value="'+i+'">'+esc(n)+'</option>';}).join('')+'</select></div>'+
        '<div class="field"><label class="lab">'+esc(t('md.decision_url'))+'</label><input id="or-url" type="url" placeholder="https://…"></div>'+
        '<div class="field"><label class="lab">'+esc(t('common.reason'))+'</label><input id="or-reason" type="text"></div>'+
        '<button class="btn ok" id="or-resolve">'+esc(t('md.resolve'))+'</button> <button class="btn bad" id="or-nc">'+esc(t('md.no_contest'))+'</button>';
    }
    html+='</div>';
  }

  // Dispute section — render only when a dispute is active OR the user can actually file one
  // (owner: no dead "Open dispute" on markets where it isn't possible)
  var dCanOpen=canOpenDispute(m,dispute,status,await pmProps());
  var dHtml=disputeBlock(id,m,ocs,dispute,dCanOpen);
  if(dHtml) html+='<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('md.dispute_gov'))+'</div>'+dHtml+'</div>';

  setContent(html);
  wireMarket(id,m,ocs,isMulti);
  if(m.oracle) loadOracleHint(m.oracle, m.volume!=null?Number(m.volume)/1000:0);
  loadKline(id, ocs, isMulti);
  if(isUnlocked()) loadMyPositions(id, m);
  if(isUnlocked()) loadMyLiquidity(id, status);
  if(status===0||status===1) loadLeverage(id, ocs, isMulti);
  if(dispute&&(dispute.id!=null||dispute.disputer||dispute.status!=null)) loadDisputeVotes(id, ocs);
  loadMarketBets(id, ocs, isMulti);
  loadMarketLazyAlloc(id);
  scheduleMarketRefresh(id, m);
}
/* getMarketBets(id,from,limit) — recent bets on this market */
async function loadMarketBets(id, ocs, isMulti){
  var box=el('mkt-bets'); if(!box)return;
  try{
    var bets=await api('getMarketBets', id, 0, 50);
    bets=Array.isArray(bets)?bets:((bets&&bets.bets)||[]);
    if(!bets.length){ box.innerHTML='<div class="mut">'+esc(t('md.no_bets'))+'</div>'; return; }
    var rows=bets.map(function(b){
      var who=b.bettor||b.account||'';
      // binary bets carry side (0=A/Yes, 1=B/No) with outcome_index=-1; multi carry outcome_index (>=0).
      // Map to the market's real label instead of showing a raw "#-1".
      var idx=(b.outcome_index!=null && b.outcome_index>=0)?b.outcome_index:(b.side!=null?b.side:-1);
      var oc=(idx>=0 && ocs[idx]!=null)?ocs[idx]:(idx>=0?('#'+idx):'—');
      // account → its public card (bets, results, balance) — we're on a public chain
      var whoCell=who?'<a data-nav="#/account/'+encodeURIComponent(who)+'">'+esc(who)+'</a>':'';
      var ts=b.created_time||b.timestamp||b.time;
      return '<tr><td>'+whoCell+'</td><td>'+esc(oc)+'</td>'+
        '<td>'+fmtViz(b.amount||b.stake||0)+'</td><td>'+esc(ts?tsToLocal(assetTime(ts)):'')+'</td></tr>';
    }).join('');
    box.innerHTML='<table class="tbl"><tr><th>'+esc(t('md.bet_who'))+'</th><th>'+esc(t('act.col_outcome'))+'</th><th>'+esc(t('act.col_amount'))+'</th><th>'+esc(t('bal.col_time'))+'</th></tr>'+rows+'</table>';
  }catch(e){ box.innerHTML='<div class="mut">'+esc(t('md.no_bets'))+'</div>'; }
}
/* getMarketLazyAllocation(id) — how much lazy-pool liquidity backs this market */
async function loadMarketLazyAlloc(id){
  var box=el('mkt-lazy-alloc'); if(!box)return;
  try{
    var a=await api('getMarketLazyAllocation', id);
    var amt=a&&(a.allocated!=null?a.allocated:(a.amount!=null?a.amount:a.allocation));
    if(amt==null||Number(amt)<=0){ box.innerHTML=''; return; }
    box.innerHTML=kv(t('md.lazy_alloc'), fmtViz(amt));
  }catch(e){ box.innerHTML=''; }
}
/* Reload the viewed market a few seconds after its next expiration boundary, so status
   (active → closed → resolvable/disputable) updates live without a manual refresh. */
function scheduleMarketRefresh(id, m){
  if(mktRefreshTimer){ clearTimeout(mktRefreshTimer); mktRefreshTimer=null; }
  watchMarket(m);   // keep the expiry registry current for the market being viewed
  var st=marketStatus(m), b=[];
  if(st===0){ var ad=assetTime(m.accept_deadline); if(ad>now()) b.push(ad); }     // oracle-acceptance window
  if(st<=1){ var be=assetTime(m.betting_expiration); if(be>now()) b.push(be); }   // betting closes
  if(st<=2){ var re=assetTime(m.result_expiration);  if(re>now()) b.push(re); }   // result deadline
  if(!b.length) return;
  var delay=(Math.min.apply(null,b)-now()+3)*1000;   // +3s cushion past the boundary
  if(delay<1000) delay=1000;
  if(delay>1800000) return;                          // don't hold a timer >30 min; it reschedules on next view
  mktRefreshTimer=setTimeout(function(){ if(location.hash==='#/market/'+id) screenMarket(id); }, delay);
}
/* Oracle reliability badge + adapted hint (new / low / underfunded) on the market detail. */
async function loadOracleHint(owner, marketVolViz){
  var box=el('oracle-info'); if(!box)return;
  try{
    var o=unwrapOracle(await api('getOracle', owner)); if(!o){box.innerHTML='';return;}
    var score=o.reliability_score!=null?o.reliability_score:o.score;
    var resolved=Number(o.markets_resolved!=null?o.markets_resolved:(o.resolved||0));
    var ins=assetNum(o.insurance!=null?o.insurance:o.insurance_fund);
    var isNew=(score==null)||resolved<5||o.is_new===true;
    var hint='', cls='info';
    if(isNew){ hint=t('md.oracle_hint_new'); cls='info'; }
    else if(relPct(score)<40){ hint=t('md.oracle_hint_low'); cls='warn'; }
    else if(ins>0 && marketVolViz>0 && ins<marketVolViz){ hint=t('md.oracle_hint_underfunded'); cls='warn'; }
    box.innerHTML=(score!=null?'<div class="mb">'+relBadge(score)+'</div>':'')+(hint?'<div class="box '+cls+'">'+esc(hint)+'</div>':'');
  }catch(e){ box.innerHTML=''; }
}
/* --- Outcome-ratio chart from get_market_kline (event-sampled parimutuel weights) ---
   Optional Chart.js renderer (single UMD file, loaded in index.html); built-in SVG fallback. */
var KLINE_YES='#2fa84f', KLINE_NO='#e04545';
var KLINE_PALETTE=['#4a90d9','#e08a00','#9b59b6','#16a085','#e67e22','#2c3e50','#c0392b','#27ae60','#8e44ad','#2980b9'];
function outColor(i,n,isMulti){ if(!isMulti && n<=2) return i===0?KLINE_YES:KLINE_NO; return KLINE_PALETTE[i%KLINE_PALETTE.length]; }
function hexA(hex,a){ var h=hex.replace('#',''); return 'rgba('+parseInt(h.substr(0,2),16)+','+parseInt(h.substr(2,2),16)+','+parseInt(h.substr(4,2),16)+','+a+')'; }
async function fetchKline(marketId){
  var all=[], pages=0;
  for(var from=0; pages<3; from+=1000, pages++){        // cap 3 pages (≤3000 newest points)
    var page=await api('getMarketKline', marketId, from, 1000); page=page||[];
    if(!page.length) break;
    all=page.concat(all);                                // pages step into the past → prepend older (result old→new)
    if(page.length<1000) break;
  }
  return all;
}
/* transform raw kline → {pts:[{t,total,reason,p[],cum[]}], n}; drops pre-first-bet zeros; downsamples */
function klineSeries(raw, ocs){
  var pts=raw.map(function(k){ return {t:Number(k.timestamp)||0, total:Number(k.bets_sum)||0, w:(k.weights||[]).map(Number), reason:Number(k.reason)}; });
  var s=0; while(s<pts.length && !(pts[s].total>0)) s++;   // drop leading points before the first bet (bets_sum==0)
  pts=pts.slice(s);
  if(pts.length>800){ var stride=Math.ceil(pts.length/800), ds=[]; for(var j=0;j<pts.length;j+=stride) ds.push(pts[j]); if(ds.length && ds[ds.length-1]!==pts[pts.length-1]) ds.push(pts[pts.length-1]); pts=ds; }
  var n=ocs.length; pts.forEach(function(p){ if(p.w.length>n) n=p.w.length; }); if(n<1) n=1;
  pts.forEach(function(p){ var cum=[0]; for(var i=0;i<n;i++){ var pi=p.total>0?((p.w[i]||0)/p.total):0; cum.push(cum[i]+pi); } p.cum=cum; p.p=[]; for(var i2=0;i2<n;i2++) p.p.push(cum[i2+1]-cum[i2]); });
  return {pts:pts, n:n};
}
async function loadKline(marketId, ocs, isMulti){
  var box=el('kline-box'); if(!box)return;
  try{
    var series=klineSeries(await fetchKline(marketId), ocs);
    if(!series.pts.length){ box.innerHTML='<div class="mut">'+esc(t('md.chart_empty'))+'</div>'; return; }
    if(window.Chart) renderKlineChart(box, series, ocs, isMulti);      // optional lib
    else box.innerHTML=renderKlineSvg(series, ocs, isMulti);           // built-in fallback
  }catch(e){ box.innerHTML='<div class="mut">'+esc(t('md.chart_empty'))+'</div>'; } // non-consensus plugin index; absence is fine
}
/* shared volume (bets_sum) mini step line */
function volumeSvg(series){
  var pts=series.pts, last=pts[pts.length-1], W=600,PADL=2,PADR=2, plotW=W-PADL-PADR;
  var tMin=pts[0].t, tMax=Math.max(pts[pts.length-1].t, now()); if(tMax<=tMin) tMax=tMin+1;
  var xOf=function(tt){ return PADL+(tt-tMin)/(tMax-tMin)*plotW; }, xR=xOf(tMax);
  var maxT=0; pts.forEach(function(p){ if(p.total>maxT) maxT=p.total; });
  var vh=44, vplotH=vh-6, vy=function(v){ return 4+(1-(maxT>0?v/maxT:0))*vplotH; };
  var va=[]; for(var vj=0;vj<pts.length;vj++){ var vx=xOf(pts[vj].t); if(vj>0) va.push([vx,vy(pts[vj-1].total)]); va.push([vx,vy(pts[vj].total)]); } va.push([xR,vy(last.total)]);
  return '<div class="hint" style="margin-top:6px">'+esc(t('md.chart_volume'))+': <b>'+fmtViz(last.total)+'</b></div>'+
    '<svg viewBox="0 0 '+W+' '+vh+'" style="width:100%;height:auto;display:block"><polyline points="'+
    va.map(function(p){return p[0].toFixed(1)+','+p[1].toFixed(1);}).join(' ')+'" fill="none" stroke="#4a90d9" stroke-width="1.5"/></svg>';
}
/* Optional: Chart.js stacked-area renderer; falls back to SVG on any error */
function renderKlineChart(box, series, ocs, isMulti){
  try{
    var pts=series.pts, n=series.n, last=pts[pts.length-1], nowSec=now();
    box.innerHTML='<div style="position:relative;height:210px"><canvas></canvas></div>'+volumeSvg(series);
    var ds=[];
    for(var i=0;i<n;i++){ var col=outColor(i,n,isMulti);
      var data=pts.map(function(p){ return {x:p.t, y:+(p.p[i]*100).toFixed(4)}; }); data.push({x:nowSec, y:+(last.p[i]*100).toFixed(4)}); // extend to now
      ds.push({label:ocs[i]||('#'+i), data:data, borderColor:col, backgroundColor:hexA(col,0.85), fill:true, stepped:'after', pointRadius:0, borderWidth:1, tension:0});
    }
    new window.Chart(box.querySelector('canvas'), {
      type:'line', data:{datasets:ds},
      options:{ animation:false, responsive:true, maintainAspectRatio:false, interaction:{mode:'index',intersect:false},
        plugins:{ legend:{position:'bottom', labels:{boxWidth:10, boxHeight:10}},
          tooltip:{callbacks:{ title:function(it){ return new Date(it[0].parsed.x*1000).toLocaleString(); }, label:function(c){ return c.dataset.label+': '+c.parsed.y.toFixed(1)+'%'; } }} },
        scales:{ x:{type:'linear', ticks:{maxTicksLimit:4, callback:function(v){ return new Date(v*1000).toLocaleDateString(); }}},
          y:{stacked:true, min:0, max:100, ticks:{stepSize:25, callback:function(v){ return v+'%'; }}} } }
    });
  }catch(e){ box.innerHTML=renderKlineSvg(series, ocs, isMulti); }
}
/* Built-in inline-SVG stacked-area renderer (no dependency) */
function renderKlineSvg(series, ocs, isMulti){
  var pts=series.pts, n=series.n;
  var W=600,H=180,PADT=6,PADB=16,PADL=2,PADR=2, plotW=W-PADL-PADR, plotH=H-PADT-PADB;
  var tMin=pts[0].t, tMax=Math.max(pts[pts.length-1].t, now()); if(tMax<=tMin) tMax=tMin+1;
  var xOf=function(tt){ return PADL+(tt-tMin)/(tMax-tMin)*plotW; }, yOf=function(f){ return PADT+(1-f)*plotH; }, xR=xOf(tMax);
  function stepPts(yAt){ var a=[]; for(var j=0;j<pts.length;j++){ var x=xOf(pts[j].t); if(j>0) a.push([x,yAt(j-1)]); a.push([x,yAt(j)]); } a.push([xR,yAt(pts.length-1)]); return a; }
  var svg='<svg viewBox="0 0 '+W+' '+H+'" style="width:100%;height:auto;display:block">';
  [0.25,0.5,0.75].forEach(function(g){ var y=yOf(g).toFixed(1); svg+='<line x1="'+PADL+'" y1="'+y+'" x2="'+(W-PADR)+'" y2="'+y+'" stroke="#e5e7eb" stroke-width="1"/>'; });
  for(var i=0;i<n;i++){ (function(i){
    var up=stepPts(function(j){return yOf(pts[j].cum[i+1]);}), lo=stepPts(function(j){return yOf(pts[j].cum[i]);});
    var poly=up.concat(lo.reverse()).map(function(pt){return pt[0].toFixed(1)+','+pt[1].toFixed(1);}).join(' ');
    svg+='<polygon points="'+poly+'" fill="'+outColor(i,n,isMulti)+'" fill-opacity="0.88"/>';
  })(i); }
  var hasEv=false;
  pts.forEach(function(p){ if(p.reason===2||p.reason===4||p.reason===5){ hasEv=true; svg+='<circle cx="'+xOf(p.t).toFixed(1)+'" cy="'+(H-PADB+3)+'" r="1.8" fill="#e08a00"/>'; } });
  svg+='</svg>';
  var d0=new Date(tMin*1000).toLocaleDateString(), d1=new Date(tMax*1000).toLocaleDateString();
  var axis='<div class="row" style="justify-content:space-between"><small class="mut">'+esc(d0)+'</small><small class="mut">'+esc(d1)+'</small></div>';
  var last=pts[pts.length-1], legend='<div class="row mt" style="gap:10px">';
  for(var li=0;li<n;li++){ legend+='<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:'+outColor(li,n,isMulti)+';vertical-align:-1px"></span> '+esc(ocs[li]||('#'+li))+' <b>'+(last.p[li]*100).toFixed(1)+'%</b></span>'; }
  legend+='</div>'+(hasEv?'<div class="hint">◦ '+esc(t('md.chart_events'))+'</div>':'');
  return svg+axis+legend+volumeSvg(series);
}

function assetTime(v){ // betting_expiration may be ISO string or epoch
  if(v==null)return 0; if(typeof v==='number')return v;
  var ms=Date.parse(v); return isNaN(ms)?Number(v)||0:Math.floor(ms/1000);
}
function outcomePrices(full,n,isMulti){
  var m=full.market||full;
  // 1) binary: implied probability from CPMM collateral reserves (market price; 50/50 when fresh)
  if(!isMulti){
    var a=num(m.reserve_a), b=num(m.reserve_b), s=a+b;
    if(s>0) return [a/s, b/s];
  }
  // 2) weight_sums.outcomes → share by money bet per outcome (bets_sum, fallback weight_sum)
  var rows=wsRows(full.weight_sums||full.weights);
  if(rows.length===n){ var tot=rows.reduce(function(a2,r){return a2+r.v;},0); if(tot>0) return rows.map(function(r){return r.v/tot;}); }
  // 3) full.outcomes (pm_outcome objects) as a last resort
  if(Array.isArray(full.outcomes)&&full.outcomes.length===n){
    var v2=full.outcomes.map(function(o){return num(o.bets_sum!=null?o.bets_sum:o.weight_sum);});
    var t3=v2.reduce(function(a3,b3){return a3+b3;},0); if(t3>0) return v2.map(function(v){return v/t3;});
  }
  return []; // unknown -> caller shows "—"
}
function kv(k,v){return '<div class="kv"><b>'+esc(k)+'</b><span>'+esc(v)+'</span></div>';}

/* Whether a pm_dispute_create is possible for this market right now (see pm_evaluator rules): market
   RESOLVED (status 3), payout still PENDING (payout_status 1), no dispute filed yet, and within the
   grace window after result_expiration. Gated on MARKET STATE, not the viewer — any account with the
   dispute fee may dispute (bettor/participant status is NOT required); the create action itself
   prompts for login when signing. Returning false hides the whole dispute card. */
function canOpenDispute(m,dispute,status,props){
  if(dispute&&(dispute.id!=null||dispute.disputer||dispute.status!=null)) return false; // already filed
  if(status!==3) return false;                                                   // only resolved markets
  if(m.payout_status!=null && Number(m.payout_status)!==1) return false;          // payout must be pending
  var grace=(props&&props.pm_dispute_grace_sec!=null)?Number(props.pm_dispute_grace_sec):null;
  var rexp=assetTime(m.result_expiration);
  if(grace!=null && rexp && now()>rexp+grace) return false;                       // grace window passed
  return true;
}
function disputeBlock(id,m,ocs,dispute,canOpen){
  var out='';
  if(dispute&&(dispute.id!=null||dispute.disputer||dispute.status!=null)){
    out+='<div class="box warn">'+esc(t('dp.open'))+(dispute.disputer?esc(t('dp.by',{D:dispute.disputer})):'')+
      (dispute.proposed_outcome!=null?esc(t('dp.claims',{O:ocs[dispute.proposed_outcome]||('outcome '+dispute.proposed_outcome)})):'')+
      (dispute.reason?'<br>“'+esc(dispute.reason)+'”':'')+
      (dispute.oracle_response?'<br><b>'+esc(t('dp.oracle_response'))+'</b> '+esc(dispute.oracle_response):'')+'</div>';
    out+='<div id="dp-votes" class="mt"></div>';   // getDisputeVotes tally
    out+=rawBlock(dispute);
    // vote / resolve / respond
    out+='<div class="row">'+
      '<button class="btn ghost small" id="dv-vote">'+esc(t('dp.dao_vote'))+'</button>'+
      '<button class="btn ghost small" id="dv-resolve">'+esc(t('dp.resolver'))+'</button>'+
      (SESSION&&m.oracle===SESSION.account?'<button class="btn ghost small" id="dv-respond">'+esc(t('dp.oracle_respond'))+'</button>':'')+
    '</div>';
  } else {
    if(!canOpen) return '';                       // no dispute and can't file one → caller hides the whole card
    out+='<div class="mut mb">'+esc(t('dp.no_dispute'))+'</div>';
    out+='<button class="btn ghost small" id="dv-create">'+esc(t('dp.create_title'))+'</button>';
  }
  return out;
}
/* getDisputeVotes(id) — DAO vote tally (weighted %) for an open dispute */
async function loadDisputeVotes(id, ocs){
  var box=el('dp-votes'); if(!box)return;
  try{
    var votes=await api('getDisputeVotes', id);
    var list=Array.isArray(votes)?votes:(votes&&votes.votes)||[];
    if(!list.length){ box.innerHTML='<div class="hint">'+esc(t('dp.no_votes'))+'</div>'; return; }
    var tally={}, total=0;
    list.forEach(function(v){ var oc=(v.outcome!=null?v.outcome:(v.proposed_outcome!=null?v.proposed_outcome:v.vote));
      var w=Number(v.weight!=null?v.weight:(v.percent!=null?v.percent:1))||0; oc=String(oc); tally[oc]=(tally[oc]||0)+w; total+=w; });
    var label=function(oc){ oc=Number(oc); return oc<0?t('dp.uphold'):(ocs[oc]!=null?ocs[oc]:('outcome '+oc)); };
    var rows=Object.keys(tally).map(function(oc){ var pct=total>0?(tally[oc]/total*100):0;
      return '<div class="oc"><div class="oc-row"><span class="oc-name">'+esc(label(oc))+'</span><span>'+pct.toFixed(1)+'%</span></div>'+
        '<div class="oc-bar"><div class="oc-fill" style="width:'+Math.max(2,pct)+'%"></div></div></div>'; }).join('');
    box.innerHTML='<div class="section-title">'+esc(t('dp.votes_title',{N:list.length}))+'</div>'+rows;
  }catch(e){ box.innerHTML=''; } // getDisputeVotes returns default when absent; ignore
}

function wireMarket(id,m,ocs,isMulti){
  var risky=(m.risk_score!=null && Number(m.risk_score)<50)||!!m.under_collateralized;
  // place bet
  var go=el('bt-go');
  if(go) go.onclick=function(){
    if(!requireUnlock())return;
    if(risky && el('bt-risk') && !el('bt-risk').checked){ toast('warn',t('bet.risk_must_confirm')); return; }
    var i=Number(el('bt-oc').value), amt=el('bt-amt').value, min=Number(el('bt-min').value)||0;
    if(!(assetNum(amt)>0)){toast('warn',t('common.enter_amount'));return;}
    var side=isMulti?-1:(i===0?0:1), oc=isMulti?i:-1;
    var mode=el('bt-batch')&&el('bt-batch').checked?1:0;
    var hidden=el('bt-hidden')&&el('bt-hidden').checked;
    if(hidden) return placeHiddenBet(id,side,oc,amt,min);
    tx(t('txn.place_bet'), function(){return bc('pmPlaceBet', wifFor('active'), SESSION.account, id, side, oc, toAsset(amt), min, mode, []);},
       function(){ setTimeout(function(){screenMarket(id);},1200); });
  };
  // add liquidity
  var lq=el('lq-go');
  if(lq) lq.onclick=function(){
    if(!requireUnlock())return;
    var amt=el('lq-amt').value; if(!(assetNum(amt)>0)){toast('warn',t('common.enter_amount'));return;}
    tx(t('txn.add_liq'), function(){return bc('pmAddLiquidity', wifFor('active'), SESSION.account, id, toAsset(amt), []);},
       function(){setTimeout(function(){screenMarket(id);},1200);});
  };
  // oracle
  if(el('or-accept')) el('or-accept').onclick=function(){ if(!requireUnlock())return; tx(t('txn.accept'),function(){return bc('pmOracleAcceptMarket',wifFor('active'),SESSION.account,id,true,0,'0.000 VIZ',[]);},function(){setTimeout(function(){screenMarket(id);},1200);});};
  if(el('or-reject')) el('or-reject').onclick=function(){ if(!requireUnlock())return; tx(t('txn.reject'),function(){return bc('pmOracleAcceptMarket',wifFor('active'),SESSION.account,id,false,0,'0.000 VIZ',[]);},function(){setTimeout(function(){screenMarket(id);},1200);});};
  if(el('or-resolve')) el('or-resolve').onclick=function(){ if(!requireUnlock())return;
    tx(t('txn.resolve'),function(){return bc('pmResolveMarket',wifFor('active'),SESSION.account,id,Number(el('or-win').value),el('or-url').value||'',el('or-reason').value||'',[]);},function(){setTimeout(function(){screenMarket(id);},1500);});};
  if(el('or-nc')) el('or-nc').onclick=function(){ if(!requireUnlock())return; if(!confirm(t('md.nc_confirm')))return;
    tx(t('txn.no_contest'),function(){return bc('pmNoContest',wifFor('active'),SESSION.account,id,el('or-reason')?el('or-reason').value||'no contest':'no contest',[]);},function(){setTimeout(function(){screenMarket(id);},1500);});};
  // dispute
  if(el('dv-create')) el('dv-create').onclick=function(){disputeCreate(id,ocs);};
  if(el('dv-vote'))   el('dv-vote').onclick=function(){disputeVote(id,ocs);};
  if(el('dv-resolve'))el('dv-resolve').onclick=function(){disputeResolve(id,ocs,m);};
  if(el('dv-respond'))el('dv-respond').onclick=function(){disputeRespond(id);};
}

function placeHiddenBet(id,side,oc,amt,min){
  if(!requireUnlock())return;
  var salt=Array.from(crypto.getRandomValues(new Uint8Array(16))).map(function(b){return b.toString(16).padStart(2,'0');}).join('');
  var commitment=viz.formatter.predictionMarketCommitment(id, SESSION.account, side, oc, toAsset(amt), min, salt);
  // stash the reveal so it survives reload
  var pend=JSON.parse(localStorage.getItem('lc_reveal')||'[]');
  tx(t('txn.commit'), function(){return bc('pmCommitBet', wifFor('active'), SESSION.account, id, commitment, toAsset(amt), 2000, []);},
    function(r){
      pend.push({market:id,side:side,oc:oc,amount:toAsset(amt),min:min,salt:salt,ts:now()});
      localStorage.setItem('lc_reveal',JSON.stringify(pend));
      toast('info',t('md.committed_note'),7000);
      setTimeout(function(){screenMarket(id);},1200);
    });
}
async function loadMyPositions(id, mkt){
  var box=el('mine-box'); if(!box)return;
  try{
    var all=((await api('getAccountPositions', SESSION.account, 0, 200))||[]).map(normPos);
    var mine=all.filter(function(p){return Number(p.market_id!=null?p.market_id:p.market)===Number(id);});
    if(!mine.length){ box.innerHTML='<div class="mut">'+esc(t('md.no_positions'))+'</div>'; return; }
    var ocs=mkt?marketOutcomes(mkt):[];
    var rows=mine.map(function(p){
      var bid=p.id!=null?p.id:p.bet_id;
      var shares=Number(p.tokens||p.shares||0);
      // binary bets carry side (0/1) with outcome_index=-1; multi carry outcome_index (>=0)
      var idx=(p.outcome_index!=null && p.outcome_index>=0)?p.outcome_index:(p.side!=null?p.side:-1);
      var oc=(idx>=0 && ocs[idx]!=null)?ocs[idx]:(idx>=0?('#'+idx):'—');
      return '<tr><td>'+esc(oc)+'</td>'+
        '<td>'+fmtViz(p.amount||p.stake)+'</td>'+
        '<td>'+fmtShares(shares)+'</td>'+
        '<td><button class="btn small" data-xfer="'+bid+'" data-sh="'+shares+'">'+esc(t('md.col_transfer'))+'</button> '+
        '<button class="btn small bad" data-cancel="'+bid+'">'+esc(t('md.col_cancel'))+'</button></td></tr>';
    }).join('');
    box.innerHTML='<table class="tbl"><tr><th>'+esc(t('md.col_outcome'))+'</th><th>'+esc(t('md.col_amount'))+'</th><th>'+esc(t('md.col_tokens'))+'</th><th></th></tr>'+rows+'</table>';
    $all('[data-cancel]',box).forEach(function(b){ b.onclick=function(){
      if(!confirm(t('bet.cancel_note')))return;
      var bid=Number(b.getAttribute('data-cancel'));
      tx(t('txn.cancel_bet'),function(){return bc('pmCancelBet',wifFor('active'),SESSION.account,bid,0,[]);},function(){setTimeout(function(){screenMarket(id);},1200);});
    };});
    $all('[data-xfer]',box).forEach(function(b){ b.onclick=function(){
      transferPosition(id, Number(b.getAttribute('data-xfer')), Number(b.getAttribute('data-sh'))||0);
    };});
  }catch(e){ box.innerHTML='<div class="box err">'+esc(errText(e))+'</div>'; }
}

/* pm_transfer_position — hand a position (by bet_id, in shares) to another account */
function transferPosition(marketId, betId, haveShares){
  if(!requireUnlock())return;
  openModal(t('xfer.title'), h(
    '<div class="hint mb">'+esc(t('xfer.desc',{ID:betId}))+'</div>',
    '<label class="lab">'+esc(t('common.to'))+'</label><input id="xf-to" type="text" autocomplete="off" spellcheck="false" placeholder="account">',
    '<label class="lab">'+esc(t('xfer.shares'))+'</label><input id="xf-sh" type="number" step="0.001" min="0.001" value="'+fmtShares(haveShares).replace(/[^\d.]/g,'')+'">',
    '<div class="hint">'+esc(t('pool.you_have',{S:fmtShares(haveShares)}))+'</div>',
    '<label class="lab">'+esc(t('common.memo'))+'</label><input id="xf-memo" type="text">'
  ),[{label:t('common.cancel'),cls:'ghost',act:closeModal},{label:t('xfer.send'),cls:'',act:function(){
    var to=el('xf-to').value.trim().toLowerCase();
    var amount=Math.round((Number(el('xf-sh').value)||0)*1000); // display shares → raw ×1000
    var memo=el('xf-memo').value||'';
    if(!to||!(amount>0)){ toast('warn',t('xfer.fill')); return; }
    closeModal();
    tx(t('txn.transfer_position'),function(){return bc('pmTransferPosition',wifFor('active'),SESSION.account,betId,to,amount,memo,[]);},
      function(){setTimeout(function(){screenMarket(marketId);},1200);});
  }}]);
}

/* pm_withdraw_liquidity — my LP positions on this market + partial/full withdraw */
async function loadMyLiquidity(id, status){
  var box=el('lq-mine'); if(!box)return;
  try{
    var all=await api('getMarketLiquidity', id, 0, 1000);
    var mine=(all||[]).filter(function(l){ return (l.provider||l.owner||l.account)===SESSION.account; });
    if(!mine.length){ box.innerHTML='<div class="mut">'+esc(t('lq.none_mine'))+'</div>'; return; }
    var rows=mine.map(function(l){
      var lid=l.id!=null?l.id:(l.liquidity_id!=null?l.liquidity_id:l.liquidity);
      var amt=l.amount!=null?l.amount:(l.balance!=null?l.balance:l.shares);
      // amt is already raw (fmtShares divides by 1000); pass it through as raw — do NOT ×1000 again
      return '<tr><td>#'+esc(lid)+'</td><td>'+fmtViz(amt)+'</td>'+
        '<td><button class="btn small" data-wl="'+esc(lid)+'" data-amt="'+esc(Number(amt)||0)+'">'+esc(t('lq.withdraw'))+'</button></td></tr>';
    }).join('');
    box.innerHTML='<table class="tbl"><tr><th>'+esc(t('lq.col_id'))+'</th><th>'+esc(t('lq.col_amount'))+'</th><th></th></tr>'+rows+'</table>';
    $all('[data-wl]',box).forEach(function(b){ b.onclick=function(){
      withdrawLiquidity(id, b.getAttribute('data-wl'), Number(b.getAttribute('data-amt'))||0);
    };});
  }catch(e){ box.innerHTML='<div class="mut">'+esc(t('lq.none_mine'))+'</div>'; } // plugin/HF may be inactive
}
function withdrawLiquidity(marketId, liquidityId, haveRaw){
  if(!requireUnlock())return;
  openModal(t('lq.withdraw_title'), h(
    '<div class="box warn">'+esc(t('lq.risk_notice'))+'</div>',
    '<label class="lab">'+esc(t('common.amount_viz'))+'</label>',
    '<input id="wl-amt" type="number" step="0.001" min="0.001" value="'+(haveRaw/1000).toFixed(3)+'">',
    '<div class="hint">'+esc(t('pool.you_have',{S:fmtViz(haveRaw)}))+'</div>'
  ),[{label:t('common.cancel'),cls:'ghost',act:closeModal},{label:t('lq.withdraw'),cls:'',act:function(){
    var amt=el('wl-amt').value; if(!(assetNum(amt)>0)){ toast('warn',t('common.enter_amount')); return; }
    closeModal();
    tx(t('txn.withdraw_liq'),function(){return bc('pmWithdrawLiquidity',wifFor('active'),SESSION.account,Number(liquidityId),toAsset(amt),[]);},
      function(){setTimeout(function(){screenMarket(marketId);},1300);});
  }}]);
}

/* Leverage is a chain-gated feature (median-voted `pm_leverage_enabled`). Cache the flag so entry
   points can be hidden while it's off — when validators flip it on, the UI reappears with no redeploy.
   Fail-open: hide only when the chain explicitly says false. */
var _pmPropsCache=null;
async function pmProps(){ if(_pmPropsCache)return _pmPropsCache; try{ _pmPropsCache=(await api('getPmChainProperties'))||{}; return _pmPropsCache; }catch(e){ return {}; } }
function leverageOff(p){ return !!(p && p.pm_leverage_enabled===false); }

/* ---- Leverage: open + list my positions + close/convert (all high-risk) ---- */
async function loadLeverage(id, ocs, isMulti){
  var box=el('lev-box'); if(!box)return;
  var props=await pmProps();
  if(leverageOff(props)){ var card=box.closest('.card'); if(card) card.remove(); return; } // chain-off → hide the whole card
  var html='<div class="box err">'+esc(t('lev.risk_notice'))+'</div>'+
    '<div class="hint">'+esc(t('lev.funding_note',{R:fmtFundingRate(props.pm_leverage_funding_rate_ppm_per_day)}))+'</div>';
  if(isUnlocked()){
    html+='<div class="field"><label class="lab">'+esc(t('md.outcome'))+'</label><select id="lv-oc">'+
      ocs.map(function(n,i){return '<option value="'+i+'">'+esc(n)+'</option>';}).join('')+'</select></div>'+
      '<div class="row"><div class="grow"><label class="lab">'+esc(t('lev.collateral'))+'</label><input id="lv-col" type="number" step="0.001" min="0.001" placeholder="10.000"></div>'+
      '<div class="grow"><label class="lab">'+esc(t('lev.loan'))+'</label><input id="lv-loan" type="number" step="0.001" min="0" placeholder="20.000"></div></div>'+
      '<div class="row"><div class="grow"><label class="lab">'+esc(t('lev.min_tokens'))+'</label><input id="lv-min" type="number" step="1" min="0" value="0"></div>'+
      '<div class="grow"><label class="lab">'+esc(t('lev.max_slippage'))+'</label><input id="lv-slip" type="number" step="0.1" min="0" value="5"></div></div>'+
      '<div class="row mt"><button class="btn ghost" id="lv-quote">'+esc(t('lev.quote_btn'))+'</button>'+
      '<button class="btn ok" id="lv-open">'+esc(t('lev.open_btn'))+'</button></div>'+
      '<div id="lv-quote-out" class="hint"></div>';
  } else {
    html+='<div class="box info">'+unlockLink('lev.unlock')+'</div>';
  }
  html+='<div class="section-title">'+esc(t('lev.mine_title'))+'</div><div id="lev-mine">'+
    (isUnlocked()?'<span class="spin"></span>':'<div class="mut">'+unlockLink('md.unlock_view')+'</div>')+'</div>';
  box.innerHTML=html;

  if(el('lv-quote')) el('lv-quote').onclick=async function(){
    var out=el('lv-quote-out'); out.textContent=t('common.loading');
    try{ var q=await api('getLeverageQuote', id, Number(el('lv-oc').value), toAsset(el('lv-col').value||'0'));
      out.innerHTML=esc(t('lev.quote_result',{T:fmtShares(q&&(q.tokens!=null?q.tokens:q.expected_tokens)||0)}));
    }catch(e){ out.innerHTML='<span class="neg">'+esc(errText(e))+'</span>'; }
  };
  if(el('lv-open')) el('lv-open').onclick=function(){
    if(!requireUnlock())return;
    var oc=Number(el('lv-oc').value), col=el('lv-col').value, loan=el('lv-loan').value||'0';
    var minT=Number(el('lv-min').value)||0, slip=toBP(el('lv-slip').value);
    if(!(assetNum(col)>0)){ toast('warn',t('lev.need_collateral')); return; }
    if(!confirm(t('lev.open_confirm'))) return;
    tx(t('txn.leverage_open'),function(){return bc('pmLeverageOpen',wifFor('active'),SESSION.account,id,oc,toAsset(col),toAsset(loan),minT,slip,[]);},
      function(){setTimeout(function(){screenMarket(id);},1300);});
  };
  if(isUnlocked()) loadMyLeverage(id, ocs);
}
async function loadMyLeverage(id, ocs){
  var box=el('lev-mine'); if(!box)return;
  try{
    var all=await api('getAccountLeveragePositions', SESSION.account, 0, 1000);
    var mine=(all||[]).filter(function(p){ return Number(p.market_id!=null?p.market_id:p.market)===Number(id); });
    if(!mine.length){ box.innerHTML='<div class="mut">'+esc(t('lev.none_mine'))+'</div>'; return; }
    var rows=mine.map(function(p){
      var pid=p.id!=null?p.id:p.position_id;
      var oc=ocs[p.outcome_index]!=null?ocs[p.outcome_index]:('#'+p.outcome_index);
      return '<tr><td>#'+esc(pid)+'</td><td>'+esc(oc)+'</td><td>'+fmtViz(p.collateral||0)+'</td><td>'+fmtViz(p.loan||0)+'</td><td>'+fmtViz(p.funding_paid||0)+'</td>'+
        '<td><button class="btn small" data-lc="'+esc(pid)+'">'+esc(t('lev.close'))+'</button> '+
        '<button class="btn small ghost" data-lcv="'+esc(pid)+'">'+esc(t('lev.convert'))+'</button></td></tr>';
    }).join('');
    box.innerHTML='<table class="tbl"><tr><th>'+esc(t('lev.col_id'))+'</th><th>'+esc(t('act.col_outcome'))+'</th><th>'+esc(t('lev.col_collateral'))+'</th><th>'+esc(t('lev.col_loan'))+'</th><th>'+esc(t('lev.col_funding'))+'</th><th></th></tr>'+rows+'</table>';
    $all('[data-lc]',box).forEach(function(b){ b.onclick=function(){ leverageClose(id, b.getAttribute('data-lc')); }; });
    $all('[data-lcv]',box).forEach(function(b){ b.onclick=function(){ leverageConvert(id, b.getAttribute('data-lcv')); }; });
  }catch(e){ box.innerHTML='<div class="mut">'+esc(t('lev.none_mine'))+'</div>'; }
}
function leverageClose(marketId, positionId, reload){
  if(!requireUnlock())return;
  var after=reload||function(){screenMarket(marketId);};
  openModal(t('lev.close_title'), h(
    '<div id="lc-preview" class="box info">'+esc(t('common.loading'))+'</div>',
    '<label class="lab">'+esc(t('lev.min_return'))+'</label><input id="lc-min" type="number" step="1" min="0" value="0">',
    '<div class="hint">'+esc(t('lev.min_return_hint'))+'</div>'
  ),[{label:t('common.cancel'),cls:'ghost',act:closeModal},{label:t('lev.close'),cls:'',act:function(){
    var minR=Number(el('lc-min').value)||0; closeModal();
    tx(t('txn.leverage_close'),function(){return bc('pmLeverageClose',wifFor('active'),SESSION.account,Number(positionId),minR,[]);},
      function(){setTimeout(after,1300);});
  }}]);
  api('getLeverageClosePreview', Number(positionId)).then(function(p){ var b=el('lc-preview'); if(!b)return;
    b.innerHTML=esc(t('lev.close_preview',{V:fmtViz(p&&(p.return_value!=null?p.return_value:p.bettor_received)||0)}));
  }).catch(function(){ var b=el('lc-preview'); if(b) b.innerHTML=esc(t('lev.preview_na')); });
}
function leverageConvert(marketId, positionId, reload){
  if(!requireUnlock())return;
  var after=reload||function(){screenMarket(marketId);};
  openModal(t('lev.convert_title'), h(
    '<div class="box info">'+esc(t('lev.convert_desc'))+'</div>',
    '<div id="lcv-preview" class="hint">'+esc(t('common.loading'))+'</div>',
    '<label class="lab">'+esc(t('lev.profit_cost'))+'</label><input id="lcv-cost" type="number" step="0.1" min="0" value="0">'
  ),[{label:t('common.cancel'),cls:'ghost',act:closeModal},{label:t('lev.convert'),cls:'',act:function(){
    var cost=toBP(el('lcv-cost').value); closeModal();
    tx(t('txn.leverage_convert'),function(){return bc('pmLeverageConvert',wifFor('active'),SESSION.account,Number(positionId),cost,[]);},
      function(){setTimeout(after,1300);});
  }}]);
  api('getLeverageConvertPreview', Number(positionId)).then(function(p){ var b=el('lcv-preview'); if(!b)return;
    b.innerHTML=esc(t('lev.convert_preview',{V:fmtShares(p&&(p.tokens!=null?p.tokens:p.expected_tokens)||0)}));
  }).catch(function(){ var b=el('lcv-preview'); if(b) b.innerHTML=esc(t('lev.preview_na')); });
}

/* ========================================================================= *
 *  SCREEN: Leverage — all my leveraged positions across markets
 * ========================================================================= */
async function screenLeverage(){
  if(!requireUnlock())return;
  setContent('<div class="title">'+esc(t('lev.screen_title'))+'</div>'+
    (leverageOff(await pmProps())?'<div class="box info">'+esc(t('lev.disabled'))+'</div>':'')+  // chain-off banner (still lets you view/close existing positions)
    '<div class="box err">'+esc(t('lev.risk_notice'))+'</div>'+
    '<div id="lev-all"><div class="empty"><span class="spin"></span> '+esc(t('common.loading'))+'</div></div>');
  try{
    var list=await api('getAccountLeveragePositions', SESSION.account, 0, 1000);
    list=list||[];
    if(!list.length){ el('lev-all').innerHTML='<div class="empty">'+esc(t('lev.none_all'))+'</div>'; return; }
    // group by market for readable outcome labels; fetch each market once
    var ids={}; list.forEach(function(p){ var mid=Number(p.market_id!=null?p.market_id:p.market); if(!isNaN(mid)) ids[mid]=1; });
    var mkts={};
    await Promise.all(Object.keys(ids).map(function(mid){ return api('getMarket', Number(mid)).then(function(m){ mkts[mid]=m; }).catch(function(){}); }));
    var rows=list.map(function(p){
      var mid=Number(p.market_id!=null?p.market_id:p.market);
      var ocs=mkts[mid]?marketOutcomes(mkts[mid]):[];
      var oc=ocs[p.outcome_index]!=null?ocs[p.outcome_index]:('#'+p.outcome_index);
      var pid=p.id!=null?p.id:p.position_id;
      return '<tr><td><a data-nav="#/market/'+mid+'">#'+mid+'</a></td><td>'+esc(oc)+'</td>'+
        '<td>'+fmtViz(p.collateral||0)+'</td><td>'+fmtViz(p.loan||0)+'</td><td>'+fmtViz(p.funding_paid||0)+'</td>'+
        '<td><button class="btn small" data-lc="'+esc(pid)+'" data-m="'+mid+'">'+esc(t('lev.close'))+'</button> '+
        '<button class="btn small ghost" data-lcv="'+esc(pid)+'" data-m="'+mid+'">'+esc(t('lev.convert'))+'</button></td></tr>';
    }).join('');
    el('lev-all').innerHTML='<div class="card"><table class="tbl"><tr><th>'+esc(t('pf.col_market'))+'</th><th>'+esc(t('act.col_outcome'))+'</th>'+
      '<th>'+esc(t('lev.col_collateral'))+'</th><th>'+esc(t('lev.col_loan'))+'</th><th>'+esc(t('lev.col_funding'))+'</th><th></th></tr>'+rows+'</table></div>';
    $all('[data-lc]',el('lev-all')).forEach(function(b){ b.onclick=function(){ leverageClose(Number(b.getAttribute('data-m')), b.getAttribute('data-lc'), screenLeverage); }; });
    $all('[data-lcv]',el('lev-all')).forEach(function(b){ b.onclick=function(){ leverageConvert(Number(b.getAttribute('data-m')), b.getAttribute('data-lcv'), screenLeverage); }; });
  }catch(e){ el('lev-all').innerHTML='<div class="box err">'+esc(errText(e))+'</div>'; }
}

/* dispute modals */
function disputeCreate(id,ocs){
  if(!requireUnlock())return;
  openModal(t('dp.create_title'), h(
    '<label class="lab">'+esc(t('dp.proposed'))+'</label><select id="d-oc"><option value="-1">'+esc(t('dp.void_nc'))+'</option>'+
      ocs.map(function(n,i){return '<option value="'+i+'">'+esc(n)+'</option>';}).join('')+'</select>',
    '<label class="lab">'+esc(t('dp.reason_ev'))+'</label><textarea id="d-reason" placeholder="'+esc(t('dp.reason_ph'))+'"></textarea>'
  ),[{label:t('common.cancel'),cls:'ghost',act:closeModal},{label:t('common.submit'),cls:'',act:function(){
    var oc=Number(el('d-oc').value), reason=el('d-reason').value;
    closeModal(); tx(t('txn.open_dispute'),function(){return bc('pmDisputeCreate',wifFor('active'),SESSION.account,id,oc,reason,[]);},function(){setTimeout(function(){screenMarket(id);},1500);});
  }}]);
}
function disputeVote(id,ocs){
  if(!requireUnlock())return;
  if(!SESSION.wifs.regular){toast('warn',t('dp.vote_regular_warn'));}
  openModal(t('dp.vote_title'), h(
    '<label class="lab">'+esc(t('dp.vote_outcome'))+'</label><select id="v-oc"><option value="-1">'+esc(t('dp.uphold'))+'</option>'+
      ocs.map(function(n,i){return '<option value="'+i+'">'+esc(n)+'</option>';}).join('')+'</select>',
    '<label class="lab">'+esc(t('dp.vote_weight'))+'</label><input id="v-pct" type="number" min="0" max="100" value="100">'
  ),[{label:t('common.cancel'),cls:'ghost',act:closeModal},{label:t('dp.vote'),cls:'',act:function(){
    var oc=Number(el('v-oc').value), pct=toBP(el('v-pct').value);
    closeModal(); tx(t('txn.dispute_vote'),function(){return bc('pmDisputeVote',wifFor('regular'),SESSION.account,id,oc,pct,[]);},function(){setTimeout(function(){screenMarket(id);},1500);});
  }}]);
}
function disputeResolve(id,ocs,m){
  if(!requireUnlock())return;
  openModal(t('dp.resolve_title'), h(
    '<label class="lab">'+esc(t('dp.correct'))+'</label><select id="r-oc"><option value="-1">'+esc(t('dp.void'))+'</option>'+
      ocs.map(function(n,i){return '<option value="'+i+'">'+esc(n)+'</option>';}).join('')+'</select>',
    '<label class="lab">'+esc(t('dp.penalty'))+'</label><input id="r-pen" type="number" step="0.001" min="0" value="0">',
    '<label class="lab"><input type="checkbox" id="r-bano"> '+esc(t('dp.ban_oracle'))+'</label>',
    '<label class="lab"><input type="checkbox" id="r-banc"> '+esc(t('dp.ban_creator'))+'</label>'
  ),[{label:t('common.cancel'),cls:'ghost',act:closeModal},{label:t('md.resolve'),cls:'',act:function(){
    var oc=Number(el('r-oc').value), pen=toAsset(el('r-pen').value);
    var bano=el('r-bano').checked, banc=el('r-banc').checked;
    closeModal(); tx(t('txn.resolve_dispute'),function(){return bc('pmDisputeResolve',wifFor('active'),SESSION.account,id,oc,pen,bano,0,banc,0,[]);},function(){setTimeout(function(){screenMarket(id);},1500);});
  }}]);
}
function disputeRespond(id){
  if(!requireUnlock())return;
  openModal(t('dp.respond_title'), '<label class="lab">'+esc(t('dp.rebuttal'))+'</label><textarea id="or-resp"></textarea>',
  [{label:t('common.cancel'),cls:'ghost',act:closeModal},{label:t('dp.post'),cls:'',act:function(){
    var txt=el('or-resp').value; closeModal();
    tx(t('txn.oracle_response'),function(){return bc('pmDisputeOracleRespond',wifFor('active'),SESSION.account,id,txt,[]);},function(){setTimeout(function(){screenMarket(id);},1500);});
  }}]);
}

/* ========================================================================= *
 *  SCREEN: Create market
 * ========================================================================= */
function screenCreate(){
  if(!requireUnlock())return;
  setContent(h(
    '<div class="title">'+esc(t('cr.title'))+'</div>',
    '<div class="card">',
      '<label class="lab">'+esc(t('cr.type'))+'</label><select id="c-type"><option value="0">'+esc(t('cr.type_binary'))+'</option><option value="1">'+esc(t('cr.type_multi'))+'</option></select>',
      '<div id="c-bin"><label class="lab">'+esc(t('cr.question'))+'</label><input id="c-q" type="text" placeholder="'+esc(t('cr.question_ph'))+'"></div>',
      '<div id="c-multi" class="hide"><label class="lab">'+esc(t('cr.outcomes'))+'</label><textarea id="c-outs" placeholder="Option A\nOption B\nOption C"></textarea></div>',
      // --- metadata mini-constructor (mirrors Polymarket meta: description/category/subcategory/tags/image/source) ---
      '<div class="section-title">'+esc(t('cr.meta'))+'</div>',
      '<label class="lab">'+esc(t('cr.description'))+'</label><textarea id="c-desc" placeholder="'+esc(t('cr.description_ph'))+'"></textarea>',
      '<div class="row">',
        '<div class="grow"><label class="lab">'+esc(t('cr.category'))+' *</label><select id="c-cat"><option value="">'+esc(t('cr.category_pick'))+'</option>'+
          Object.keys(MARKET_CATS).map(function(k){return '<option value="'+esc(k)+'">'+esc(capFirst(k))+'</option>';}).join('')+'</select></div>',
        '<div class="grow"><label class="lab">'+esc(t('cr.subcategory'))+'</label><select id="c-subcat"><option value="">—</option></select></div>',
      '</div>',
      '<label class="lab">'+esc(t('cr.tags'))+'</label><input id="c-tags" type="text" placeholder="'+esc(t('cr.tags_ph'))+'">',
      '<label class="lab">'+esc(t('cr.image'))+'</label>',
      '<div class="row"><input id="c-img" class="grow" type="url" placeholder="https://… '+esc(t('cr.image_or'))+'"><input id="c-img-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none"><button type="button" class="btn ghost" id="c-img-embed" style="white-space:nowrap">'+esc(t('cr.image_embed'))+'</button></div>',
      '<div class="hint">'+esc(t('cr.image_hint'))+'</div>',
      '<div id="c-img-prev"></div>',
      '<label class="lab">'+esc(t('cr.source_url'))+'</label><input id="c-src" type="url" placeholder="https://…">',
      '<label class="lab">'+esc(t('cr.oracle'))+'</label>',
      '<div class="row"><input id="c-oracle" class="grow" type="text" autocomplete="off" spellcheck="false" placeholder="'+esc(t('cr.oracle_ph'))+'"><button class="btn ghost" id="c-oracle-browse" style="white-space:nowrap">'+esc(t('cr.browse_oracles'))+'</button><button class="btn ghost" id="c-oracle-load" style="white-space:nowrap">'+esc(t('cr.load_terms'))+'</button></div>',
      '<div id="c-oracle-info" class="hint"></div>',
      '<label class="lab">'+esc(t('cr.liq'))+'</label><input id="c-liq" type="number" step="0.001" min="100.000" value="100.000">',
      '<label class="lab">'+esc(t('cr.creation_fee'))+'</label><input id="c-creation-fee" type="text" disabled value="…">',
      '<div class="hint">'+esc(t('cr.creation_fee_hint'))+'</div>',
      '<div id="c-fees"></div>',
      '<label class="lab">'+esc(t('cr.rules_url'))+'</label><input id="c-url" type="url" placeholder="https://…">',
      '<div class="row">',
        '<div class="grow"><label class="lab">'+esc(t('cr.betting_closes'))+'</label><input id="c-bexp" type="datetime-local"></div>',
        '<div class="grow"><label class="lab">'+esc(t('cr.result_deadline'))+'</label><input id="c-rexp" type="datetime-local"></div>',
      '</div>',
      '<div class="row">',
        '<div class="grow"><label class="lab">'+esc(t('cr.creator_fee'))+'</label><input id="c-cfee" type="number" step="0.1" min="0" value="1"></div>',
        '<div class="grow"><label class="lab">'+esc(t('cr.oracle_fee'))+'</label><input id="c-ofee" type="number" step="0.1" min="0" value="1"></div>',
        '<div class="grow"><label class="lab">'+esc(t('cr.lp_fee'))+'</label><input id="c-lfee" type="number" step="0.1" min="0" value="2"></div>',
      '</div>',
      '<div class="hint" id="c-fee-caps"></div>',
      '<div class="hint" id="c-lp-warn" style="color:var(--warn)"></div>',
      '<label class="lab">'+esc(t('cr.jurisdiction'))+'</label><input id="c-jur" type="text" placeholder="US, GB…">',
      '<fieldset><legend>'+esc(t('cr.flags'))+'</legend>',
        '<label class="lab"><input type="checkbox" id="c-early" checked> &mdash; '+esc(t('cr.early'))+'</label>',
        '<label class="lab"><input type="checkbox" id="c-cancel" checked> &mdash; '+esc(t('cr.cancel'))+'</label>',
        '<label class="lab"><input type="checkbox" id="c-batch" checked> &mdash; '+esc(t('cr.batch'))+'</label>',
        '<label class="lab"><input type="checkbox" id="c-instant" checked> &mdash; '+esc(t('cr.instant'))+'</label>',
      '</fieldset>',
      '<div class="box info">'+esc(t('cr.info_note'))+'</div>',
      '<button class="btn ok block mt" id="c-go">'+esc(t('cr.create'))+'</button>',
    '</div>'
  ));
  el('c-type').onchange=function(){var multi=this.value==='1';el('c-multi').classList.toggle('hide',!multi);el('c-bin').classList.toggle('hide',multi);};

  // --- metadata constructor wiring ---
  var embeddedImg='';                                   // sanitized base64 data URI, if the user embedded one
  function imgPreview(src){ el('c-img-prev').innerHTML = src ? '<img src="'+esc(src)+'" style="width:50px;height:50px;object-fit:contain;border-radius:8px;margin-top:6px;background:var(--card2,rgba(255,255,255,.04))">' : ''; }
  if(el('c-cat')) el('c-cat').onchange=function(){
    var subs=MARKET_CATS[this.value]||[];
    el('c-subcat').innerHTML='<option value="">—</option>'+subs.map(function(s){return '<option value="'+esc(s)+'">'+esc(s)+'</option>';}).join('');
  };
  if(el('c-img-embed')) el('c-img-embed').onclick=function(){ el('c-img-file').click(); };
  if(el('c-img-file')) el('c-img-file').onchange=function(){
    var f=this.files&&this.files[0]; if(!f)return;
    sanitizeImageToDataURL(f, function(err,dataUrl){
      if(err){ toast('warn', t(err.message==='too_big'?'cr.image_too_big':'cr.image_bad')); return; }
      embeddedImg=dataUrl; if(el('c-img')) el('c-img').value=''; imgPreview(dataUrl);   // embedded wins over URL
    });
  };
  if(el('c-img')) el('c-img').oninput=function(){ embeddedImg=''; imgPreview(this.value.trim()); };  // typing a URL clears the embed
  // paste an image straight from the clipboard (ctrl+v) — sanitize like a picked file
  if(el('c-img')) el('c-img').addEventListener('paste', function(e){
    var items=(e.clipboardData&&e.clipboardData.items)||[];
    for(var i=0;i<items.length;i++){
      if(items[i].type && items[i].type.indexOf('image/')===0){
        var f=items[i].getAsFile();
        if(f){ e.preventDefault(); sanitizeImageToDataURL(f, function(err,dataUrl){
          if(err){ toast('warn', t(err.message==='too_big'?'cr.image_too_big':'cr.image_bad')); return; }
          embeddedImg=dataUrl; if(el('c-img')) el('c-img').value=''; imgPreview(dataUrl); }); }
        return;                                          // handled an image → don't also paste text
      }
    }                                                    // no image in clipboard → let the URL paste through
  });

  // --- draft persistence: the oracle browser is a route change (#/oracles) that rebuilds this form on
  // return, wiping typed fields. Stash the draft before leaving and restore (one-shot) on re-entry. ---
  var DRAFT_VALS=['c-type','c-q','c-outs','c-desc','c-cat','c-subcat','c-tags','c-img','c-src','c-oracle','c-liq','c-cfee','c-ofee','c-lfee','c-bexp','c-rexp','c-jur'];
  var DRAFT_CHK=['c-early','c-cancel','c-batch','c-instant'];
  function saveCreateDraft(){ try{ var d={v:{},c:{},img:embeddedImg};
    DRAFT_VALS.forEach(function(id){ var e=el(id); if(e) d.v[id]=e.value; });
    DRAFT_CHK.forEach(function(id){ var e=el(id); if(e) d.c[id]=e.checked; });
    sessionStorage.setItem('lc_create_draft', JSON.stringify(d)); }catch(e){} }
  function restoreCreateDraft(){ try{ var raw=sessionStorage.getItem('lc_create_draft'); if(!raw)return;
    sessionStorage.removeItem('lc_create_draft');                          // one-shot: consume on restore
    var d=JSON.parse(raw); if(!d)return;
    if(d.v['c-type']!=null && el('c-type')){ el('c-type').value=d.v['c-type']; el('c-type').onchange(); }
    if(d.v['c-cat']!=null && el('c-cat')){ el('c-cat').value=d.v['c-cat']; el('c-cat').onchange(); }  // repopulate subcats first
    DRAFT_VALS.forEach(function(id){ if(id==='c-type'||id==='c-cat')return; var e=el(id); if(e && d.v[id]!=null) e.value=d.v[id]; });
    DRAFT_CHK.forEach(function(id){ var e=el(id); if(e && d.c && d.c[id]!=null) e.checked=d.c[id]; });
    if(d.img){ embeddedImg=d.img; imgPreview(d.img); }
  }catch(e){} }
  function clearCreateDraft(){ try{ sessionStorage.removeItem('lc_create_draft'); }catch(e){} }
  restoreCreateDraft();

  if(el('c-oracle-browse')) el('c-oracle-browse').onclick=function(){ saveCreateDraft(); go('#/oracles'); };
  // prefill oracle picked from the leaderboard (#/oracles → "use")
  try{ var picked=sessionStorage.getItem('lc_pick_oracle'); if(picked){ sessionStorage.removeItem('lc_pick_oracle');
    if(el('c-oracle')){ el('c-oracle').value=picked; if(el('c-oracle-load')) el('c-oracle-load').click(); } } }catch(e){}
  // surface the live network fees/limits from chain properties
  var lazyMinPct=null;
  function checkLpFee(){ var w=el('c-lp-warn'); if(!w||lazyMinPct==null)return; var v=Number(el('c-lfee').value)||0; w.innerHTML=(v<lazyMinPct)?esc(t('cr.lazy_warn',{MIN:lazyMinPct})):''; }
  if(el('c-lfee')) el('c-lfee').oninput=checkLpFee;
  api('getPmChainProperties').then(function(p){
    p=p||{};
    if(el('c-creation-fee')) el('c-creation-fee').value=fmtVizParam(p.pm_market_creation_fee);
    if(p.pm_min_liquidity!=null){ var minL=(Number(p.pm_min_liquidity)/1000); var li=el('c-liq'); // enforce live chain minimum
      if(li){ li.min=minL.toFixed(3); if((Number(li.value)||0)<minL) li.value=minL.toFixed(3); } }
    var maxTotal=p.pm_max_total_fee_percent, maxOracle=p.pm_max_oracle_fee_percent;
    var box=el('c-fees'); if(box){
      var rows=kv(t('cr.creation_fee'), fmtVizParam(p.pm_market_creation_fee));
      if(p.pm_min_liquidity!=null) rows+=kv(t('cr.min_liquidity'), fmtVizParam(p.pm_min_liquidity));
      if(p.pm_oracle_accept_window_sec!=null) rows+=kv(t('cr.accept_window'), fmtDuration(p.pm_oracle_accept_window_sec));
      if(maxTotal!=null) rows+=kv(t('cr.max_total_fee'), fromBP(maxTotal)+'%');
      if(maxOracle!=null) rows+=kv(t('cr.max_oracle_fee'), fromBP(maxOracle)+'%');
      if(p.pm_lazy_min_liquidity_fee_percent!=null){ lazyMinPct=fromBP(p.pm_lazy_min_liquidity_fee_percent); rows+=kv(t('cr.lazy_min_fee'), lazyMinPct+'%'); }
      if(p.pm_oracle_penalty_percent!=null) rows+=kv(t('cr.oracle_miss_penalty'), fromBP(p.pm_oracle_penalty_percent)+'%');
      box.className='box info'; box.style.fontSize='12.5px'; box.innerHTML=rows;   // style only once we have content
    }
    var caps=el('c-fee-caps'); if(caps && maxTotal!=null && maxOracle!=null) caps.innerHTML=esc(t('cr.fee_caps',{TOTAL:fromBP(maxTotal), ORACLE:fromBP(maxOracle)}));
    checkLpFee();
  }).catch(function(e){
    if(el('c-creation-fee')) el('c-creation-fee').value='—';
    var box=el('c-fees'); if(box){ box.className='box err'; box.style.fontSize='12.5px'; box.innerHTML=esc(t('cr.fees_unavailable')); }
  });
  // Oracle "load terms": validate the account, fill its advertised fee, mark the input green/red.
  var oracleFixedFee='0.000 VIZ';
  if(el('c-oracle')) el('c-oracle').oninput=function(){ this.style.borderColor=''; if(el('c-oracle-info'))el('c-oracle-info').innerHTML=''; oracleFixedFee='0.000 VIZ'; };
  if(el('c-oracle-load')) el('c-oracle-load').onclick=async function(){
    var acc=el('c-oracle').value.trim().toLowerCase(), info=el('c-oracle-info');
    if(!acc){ toast('warn',t('cr.enter_oracle')); return; }
    info.innerHTML='<span class="spin"></span>';
    try{
      var o=unwrapOracle(await api('getOracle', acc));
      if(o && (o.owner||o.fee_percent!=null||o.insurance)){
        el('c-oracle').style.borderColor='var(--ok)';
        var feePct=fromBP(o.fee_percent||0);
        if(el('c-ofee')) el('c-ofee').value=feePct;
        if(o.fixed_fee!=null) oracleFixedFee=(typeof o.fixed_fee==='string')?o.fixed_fee:toAsset(Number(o.fixed_fee)/1000);
        var score=o.reliability_score!=null?o.reliability_score:o.score;
        info.innerHTML='<span class="pos">✓ '+esc(t('cr.oracle_loaded'))+'</span> · '+esc(t('pf.fee_pct'))+' '+feePct+'%'+
          (assetNum(oracleFixedFee)>0?' · +'+esc(oracleFixedFee):'')+
          (o.insurance!=null?' · '+esc(t('pf.insurance'))+' '+esc(fmtVizParam(o.insurance)):'')+
          (score!=null?' '+relBadge(score):'')+
          ((o.rules_url||o.rules)?' · <a href="'+esc(o.rules_url||o.rules)+'" target="_blank">'+esc(t('md.rules'))+'</a>':'');
      } else {
        el('c-oracle').style.borderColor='var(--bad)'; info.innerHTML='<span class="neg">'+esc(t('cr.oracle_not_found'))+'</span>';
      }
    }catch(e){ el('c-oracle').style.borderColor='var(--bad)'; info.innerHTML='<span class="neg">'+esc(t('cr.oracle_not_found'))+'</span>'; }
  };
  el('c-go').onclick=function(){
    var type=Number(el('c-type').value);
    var outcomes = type===1
      ? el('c-outs').value.split('\n').map(function(s){return s.trim();}).filter(Boolean)
      : ['Yes','No'];
    if(type===1 && (outcomes.length<2||outcomes.length>10)){toast('warn',t('cr.provide_outcomes'));return;}
    var oracle=el('c-oracle').value.trim().toLowerCase();
    if(!oracle){toast('warn',t('cr.oracle_required'));return;}
    var minLiq=Number(el('c-liq').min)||0;                        // live chain minimum (set from props)
    if((Number(el('c-liq').value)||0)<minLiq){ toast('warn',t('cr.min_liquidity')+': '+minLiq.toFixed(3)+' VIZ'); return; }
    var category=(el('c-cat')&&el('c-cat').value)||'';
    if(!category){ toast('warn',t('cr.category_required')); return; }        // owner: category is mandatory
    var meta={ title: type===1?(el('c-q').value||t('cr.multi_default_title')):el('c-q').value, outcomes:outcomes, category:category };
    var subcat=(el('c-subcat')&&el('c-subcat').value)||''; if(subcat) meta.subcategory=subcat;
    var desc=(el('c-desc')&&el('c-desc').value.trim())||''; if(desc) meta.description=desc;
    var tags=(el('c-tags')&&el('c-tags').value||'').split(',').map(function(s){return s.trim();}).filter(Boolean); if(tags.length) meta.tags=tags;
    var img=embeddedImg || ((el('c-img')&&el('c-img').value.trim())||''); if(img) meta.image=img;   // embedded base64 wins over URL
    var src=(el('c-src')&&el('c-src').value.trim())||''; if(src) meta.source_url=src;
    var jur=el('c-jur').value.trim(); if(jur)meta.jurisdiction=jur;
    var args=[
      wifFor('active'), SESSION.account, oracle, type, outcomes, el('c-url').value||'',
      toBP(el('c-ofee').value), oracleFixedFee, toBP(el('c-cfee').value), toBP(el('c-lfee').value),
      toAsset(el('c-liq').value), type===1?1000:0,
      toEpoch(el('c-bexp').value), toEpoch(el('c-rexp').value),
      1, 10, 0,
      el('c-early').checked, el('c-cancel').checked, el('c-batch').checked, el('c-instant').checked,
      0, 0, '', 0, JSON.stringify(meta), []
    ];
    tx(t('txn.create_market'), function(){return bc.apply(null,['pmCreateMarket'].concat(args));}, function(r){ clearCreateDraft(); toast('ok',t('cr.submitted')); go('#/markets'); });
  };
}

/* ========================================================================= *
 *  SCREEN: Balance / wallet
 * ========================================================================= */
async function screenBalance(){
  if(!requireUnlock())return;
  setContent('<div class="title">'+esc(t('bal.title'))+'</div><div id="bal-box"><div class="empty"><span class="spin"></span> '+esc(t('common.loading'))+'</div></div>');
  try{
    var acc=(await api('getAccounts',[SESSION.account]))[0];
    var energy=acc.energy;
    var html='<div class="card">'+
      kv(t('bal.account'),'@'+SESSION.account)+
      kv(t('bal.liquid'), fmtViz(acc.balance))+
      (acc.vesting_shares?kv(t('bal.shares'), esc(acc.vesting_shares)):'')+
      (energy!=null?kv(t('bal.energy'), (energy/100).toFixed(2)+'%'):'')+
    '</div>';
    html+='<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('bal.transfer'))+'</div>'+
      '<label class="lab">'+esc(t('common.to'))+'</label><input id="tr-to" type="text" placeholder="account">'+
      '<label class="lab">'+esc(t('common.amount_viz'))+'</label><input id="tr-amt" type="number" step="0.001" min="0.001">'+
      '<label class="lab">'+esc(t('common.memo'))+'</label><input id="tr-memo" type="text">'+
      '<button class="btn block mt" id="tr-go">'+esc(t('bal.send'))+'</button></div>';
    html+='<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('bal.lazy_pool'))+'</div>'+
      '<div class="hint mb">'+esc(t('pool.lead'))+'</div>'+
      '<button class="btn block" data-nav="#/pool">'+esc(t('pool.open_btn'))+'</button></div>';
    if(!leverageOff(await pmProps()))                             // hide leverage entry while chain-disabled
      html+='<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('lev.screen_title'))+'</div>'+
        '<div class="hint mb">'+esc(t('lev.lead'))+'</div>'+
        '<button class="btn block" data-nav="#/leverage">'+esc(t('lev.open_screen_btn'))+'</button></div>';
    html+='<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('bal.recent'))+'</div><div id="hist-box"><span class="spin"></span></div><div id="hist-more" class="center mt"></div></div>';
    el('bal-box').innerHTML=html;

    el('tr-go').onclick=function(){
      var to=el('tr-to').value.trim().toLowerCase(), amt=el('tr-amt').value, memo=el('tr-memo').value||'';
      if(!to||!(assetNum(amt)>0)){toast('warn',t('bal.fill_recipient'));return;}
      tx(t('txn.transfer'),function(){return bc('transfer',wifFor('active'),SESSION.account,to,toAsset(amt),memo);},function(){setTimeout(screenBalance,1200);});
    };
    histState={from:-1,done:false}; loadHistory();
  }catch(e){ el('bal-box').innerHTML='<div class="box err">'+esc(errText(e))+'</div>'; }
}
function histRow(entry){
  var op=entry[1]&&entry[1].op, type=op?op[0]:'?', data=op?op[1]:{};
  var ts=entry[1]&&entry[1].timestamp;
  var amt=data.amount||data.refunded_liquidity||'';                 // pm_market_expired → refunded_liquidity
  var detail=amt||data.memo||(data.market_id!=null?('mkt '+data.market_id):'');
  return '<tr><td>'+esc(ts||'')+'</td><td>'+esc(type)+'</td><td>'+esc(amt||detail||'')+'</td></tr>';
}
function histRenderMore(){
  var mb=el('hist-more'); if(!mb)return;
  if(histState.done){ mb.innerHTML=''; return; }
  mb.innerHTML='<button class="btn ghost small" id="hist-more-btn">'+esc(t('common.load_more'))+'</button>';
  el('hist-more-btn').onclick=loadHistory;
}
/* Paginated account history: from=-1 loads the newest page; each "load more" steps older. */
async function loadHistory(){
  var box=el('hist-box'); if(!box)return;
  var btn=el('hist-more-btn'); if(btn){ btn.disabled=true; btn.textContent=t('common.loading'); }
  try{
    var from=histState.from, limit=(from<0?30:Math.min(30, from+1));
    if(from>=0 && limit<=0){ histState.done=true; histRenderMore(); return; }
    var hist=(await api('getAccountHistory', SESSION.account, from, limit))||[]; // ascending by seq (old→new)
    var tbody=el('hist-tbody');
    if(!tbody){
      box.innerHTML='<table class="tbl" id="hist-tbl"><thead><tr><th>'+esc(t('bal.col_time'))+'</th><th>'+esc(t('bal.col_op'))+'</th><th>'+esc(t('bal.col_detail'))+'</th></tr></thead><tbody id="hist-tbody"></tbody></table>';
      tbody=el('hist-tbody');
    }
    if(!hist.length){ if(!tbody.children.length) box.innerHTML='<div class="mut">'+esc(t('bal.no_history'))+'</div>'; histState.done=true; histRenderMore(); return; }
    var smallest=hist[0][0];                                   // lowest seq in this page
    tbody.insertAdjacentHTML('beforeend', hist.slice().reverse().map(histRow).join('')); // newest-first within the page
    histState.from=smallest-1; histState.done=(smallest<=0);
    histRenderMore();
  }catch(e){ if(!el('hist-tbody')) box.innerHTML='<div class="box err">'+esc(errText(e))+'</div>'; else histRenderMore(); }
}

/* ========================================================================= *
 *  SCREEN: Liquidity (lazy) pool  (MasterChef reward-accumulator model)
 *  Field names & formulas confirmed by the node plugin author.
 * ========================================================================= */
async function screenPool(){
  setContent('<div class="title">'+esc(t('pool.title'))+'</div><div class="subtitle">'+esc(t('pool.lead'))+'</div>'+
    '<div id="pool-box"><div class="empty"><span class="spin"></span> '+esc(t('common.loading'))+'</div></div>');
  var pool=null,user=null,props=null,walletFree=0;
  try{ pool=await api('getLazyPool'); }catch(e){}
  if(isUnlocked()){
    try{ user=await api('getLazyDeposit', SESSION.account); }catch(e){}
    try{ var acc=(await api('getAccounts',[SESSION.account]))[0]; walletFree=parseFloat(acc&&acc.balance)||0; }catch(e){}
  }
  try{ props=await api('getPmChainProperties'); }catch(e){}

  var num=function(v){ return v==null?0:(Number(v)||0); };
  // get_lazy_pool — exact plugin fields
  var free=num(pool&&pool.free_balance), allocated=num(pool&&pool.allocated_balance), earned=num(pool&&pool.earned_balance);
  var totalShares=num(pool&&pool.total_shares), rewardPerShare=num(pool&&pool.reward_per_share), leverageUsed=num(pool&&pool.leverage_fund_used);
  var totalValue=free+allocated; // full pool value = free + deployed (NOT just free)
  // get_pm_chain_properties
  var penBP=(props&&props.pm_lazy_emergency_penalty_percent!=null)?Number(props.pm_lazy_emergency_penalty_percent):5000; // bps, default 50%
  var lockSec=(props&&props.pm_lazy_lock_sec!=null)?Number(props.pm_lazy_lock_sec):604800; // default 7 days
  var poolEnabled=!(props&&props.pm_lazy_pool_enabled===false);

  var locked=false, hasPos=false, myShares=0;
  var html='';
  if(!poolEnabled) html+='<div class="box err">'+esc(t('pool.disabled'))+'</div>';
  // how it works
  html+='<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('pool.how_title'))+'</div>'+
    '<ul class="terms-list">'+['how_1','how_2','how_3','how_4','how_5'].map(function(k){return '<li>'+t('pool.'+k)+'</li>';}).join('')+'</ul></div>';
  // pool state
  html+='<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('pool.state_title'))+'</div>'+
    kv(t('pool.total_value'), fmtViz(totalValue))+
    kv(t('pool.free'), fmtViz(free))+
    kv(t('pool.allocated'), fmtViz(allocated))+
    (leverageUsed>0?kv(t('pool.leverage_used'), fmtViz(leverageUsed)):'')+
    kv(t('pool.earned'), fmtViz(earned))+
    kv(t('pool.total_shares'), fmtShares(totalShares))+
    kv(t('pool.lock_period'), Math.round(lockSec/86400)+' d')+
    (pool?rawBlock(pool):'')+'</div>';

  // your position + withdrawal estimate
  html+='<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('pool.your_title'))+'</div>';
  if(!isUnlocked()){
    html+='<div class="box info">'+unlockLink('pool.unlock_to_act')+'</div>';
  } else if(!user || !(num(user.shares)>0)){
    html+='<div class="mut">'+esc(t('pool.no_position'))+'</div>';
  } else {
    hasPos=true;
    var uShares=num(user.shares); myShares=uShares;
    var principal=num(user.principal), pending=num(user.pending_rewards), unlockTime=chainTime(user.unlock_time);
    // MasterChef: accrued = live unsettled + carried pending; value = principal + accrued
    var live=(user.reward_snapshot!=null)?(rewardPerShare-num(user.reward_snapshot))*uShares/1e9:0;
    var accrued=Math.max(0,live)+pending;
    var value=principal+accrued;
    locked=unlockTime>0 && now()<unlockTime;
    var availableNow=locked?0:value;                 // planned withdrawal blocked while locked
    var penalty=locked?accrued*(penBP/10000):0;      // penalty on rewards only, never principal
    var emergencyOut=value-penalty;

    html+=kv(t('pool.your_shares'), fmtShares(uShares))+
      kv(t('pool.your_principal'), fmtViz(principal))+
      kv(t('pool.accrued'), fmtViz(accrued))+
      kv(t('pool.your_value'), fmtViz(value))+
      '<div class="kv"><b>'+esc(t('pool.status'))+'</b><span class="'+(locked?'neg':'pos')+'">'+
        esc(locked?t('pool.status_locked',{T:tsToLocal(unlockTime)}):t('pool.status_unlocked'))+'</span></div>'+
      rawBlock(user);

    html+='<div class="section-title">'+esc(t('pool.calc_title'))+'</div>';
    html+='<div class="box info">'+t('pool.calc_now',{V:fmtViz(availableNow)})+'<br>'+t('pool.calc_total',{V:fmtViz(value)});
    if(locked) html+='<br>'+t('pool.calc_emergency',{V:fmtViz(emergencyOut),P:fmtViz(penalty)});
    html+='</div><div class="hint">'+esc(t('pool.calc_note'))+'</div>';
  }
  html+='</div>';

  // actions
  if(isUnlocked()){
    html+='<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('pool.deposit_title'))+'</div>'+
      '<label class="lab">'+esc(t('pool.deposit_amount'))+'</label><input id="p-dep-amt" type="number" step="0.001" min="0.001" placeholder="100.000">'+
      '<div class="hint" id="p-dep-avail" style="cursor:pointer">'+esc(t('pool.available',{V:fmtViz(walletFree)}))+'</div>'+
      '<button class="btn ok block mt" id="p-dep">'+esc(t('pool.deposit_btn'))+'</button></div>';
    html+='<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('pool.withdraw_title'))+'</div>'+
      '<div class="box info">'+esc(t('pool.locked_hint'))+'</div>';
    if(hasPos && !locked){ // unlocked → planned withdrawal, partial allowed (0 = all)
      html+='<label class="lab">'+esc(t('pool.withdraw_shares'))+'</label>'+
        '<input id="p-wd-sh" type="number" step="0.001" min="0" value="0">'+
        '<div class="hint">'+esc(t('pool.you_have',{S:fmtShares(myShares)}))+'</div>'+
        '<button class="btn block mt" id="p-wd">'+esc(t('pool.withdraw_btn'))+'</button>';
    } else if(hasPos && locked){ // locked → only emergency (full exit, penalty on rewards)
      html+='<button class="btn bad block" id="p-em">'+esc(t('pool.emergency_btn'))+'</button>';
    }
    html+='</div>';
  }

  el('pool-box').innerHTML=html;

  if(el('p-dep-avail')) el('p-dep-avail').onclick=function(){ if(walletFree>0) el('p-dep-amt').value=walletFree.toFixed(3); };
  if(el('p-dep')) el('p-dep').onclick=function(){ var a=el('p-dep-amt').value; if(!(assetNum(a)>0)){toast('warn',t('common.enter_amount'));return;}
    if(assetNum(a)>walletFree){toast('warn',t('pool.available',{V:fmtViz(walletFree)}));return;}
    tx(t('txn.lazy_deposit'),function(){return bc('pmLazyDeposit',wifFor('active'),SESSION.account,toAsset(a),[]);},function(){refreshPoolTab();setTimeout(screenPool,1300);}); };
  if(el('p-wd')) el('p-wd').onclick=function(){ var sh=Math.max(0,Math.round((Number(el('p-wd-sh').value)||0)*1000)); // display shares → raw ×1000; 0 = all
    tx(t('txn.lazy_withdraw'),function(){return bc('pmLazyWithdraw',wifFor('active'),SESSION.account,sh,false,[]);},function(){refreshPoolTab();setTimeout(screenPool,1300);}); };
  if(el('p-em')) el('p-em').onclick=function(){ if(!confirm(t('pool.emergency_confirm')))return;
    tx(t('txn.emergency_withdraw'),function(){return bc('pmLazyWithdraw',wifFor('active'),SESSION.account,0,true,[]);},function(){refreshPoolTab();setTimeout(screenPool,1300);}); };
}

/* ========================================================================= *
 *  SCREEN: Activity — trades, active markets, disputable, my disputes, all disputes
 * ========================================================================= */
function daoMode(m){ var r=m&&(m.dispute_resolver); return !r || r==='' || r==='null' || r==='@'; }
function disputeOpen(d){
  if(!d) return false;
  if(d.id==null && !d.disputer && d.status==null && d.proposed_outcome==null) return false; // empty struct
  if(d.resolved===true || d.finalized===true || d.status===2 || d.status===3) return false;  // already decided
  return true;
}
async function ensureMy(){
  if(ACT.loaded) return;
  ACT.positions = ((await api('getAccountPositions', SESSION.account, 0, 300)) || []).map(normPos);
  var idset={}; ACT.positions.forEach(function(p){ var id=Number(p.market_id!=null?p.market_id:p.market); if(!isNaN(id)) idset[id]=1; });
  ACT.ids = Object.keys(idset).map(Number);
  ACT.markets={}; ACT.disputes={};
  await Promise.all(ACT.ids.map(function(id){ return api('getMarket', id).then(function(m){ACT.markets[id]=m;}).catch(function(){}); }));
  await Promise.all(ACT.ids.map(function(id){ return api('getDispute', id).then(function(d){ACT.disputes[id]=d;}).catch(function(){}); }));
  ACT.loaded=true;
}
function actMarketCard(m, badgeHtml, btnLabel){
  var id=marketId(m);
  return '<div class="card"><div class="card-q"><a data-nav="#/market/'+id+'">'+esc(marketTitle(m))+'</a></div>'+
    '<div class="card-meta">'+statusBadge(m)+
      '<span>'+(Number(m.market_type)===1?esc(t('mk.multi',{N:marketOutcomes(m).length})):esc(t('mk.binary')))+'</span>'+
      (m.oracle?'<span>'+esc(t('mk.oracle',{O:m.oracle}))+'</span>':'')+
      (badgeHtml||'')+
    '</div>'+
    (btnLabel?'<button class="btn small mt" data-nav="#/market/'+id+'">'+esc(btnLabel)+'</button>':'')+
  '</div>';
}
function disputeCard(m,d,mine){
  var dao=daoMode(m);
  var badge='<span class="badge '+(dao?'st-3':'st-0')+'">'+(dao?esc(t('act.dao_badge')):esc(t('act.resolver_badge',{R:m.dispute_resolver})))+'</span>'+
    (d&&d.disputer?'<span>'+esc(t('act.by',{D:d.disputer}))+'</span>':'')+
    (mine?'<span class="badge st-1">'+esc(t('act.mine'))+'</span>':'');
  var card=actMarketCard(m, badge, t('act.participate'));
  if(d&&d.reason) card=card.replace('</div><button', '</div><div class="hint">“'+esc(d.reason)+'”</div><button');
  return card;
}
async function screenActivity(){
  ACT={loaded:false};
  var subs=[['history',t('act.tab_history')],['active',t('act.tab_active')],['disputable',t('act.tab_disputable')],
            ['mydisputes',t('act.tab_mydisputes')],['alldisputes',t('act.tab_alldisputes')]];
  setContent('<div class="title">'+esc(t('act.title'))+'</div>'+
    '<div class="filters" id="act-tabs">'+subs.map(function(s){return '<button class="btn chip'+(actTab===s[0]?' active':'')+'" data-at="'+s[0]+'">'+esc(s[1])+'</button>';}).join('')+'</div>'+
    '<div id="act-list"><div class="empty"><span class="spin"></span> '+esc(t('common.loading'))+'</div></div>');
  $('#act-tabs').addEventListener('click',function(e){ var c=e.target.closest('[data-at]'); if(!c)return;
    actTab=c.getAttribute('data-at');
    $all('#act-tabs .chip').forEach(function(x){x.classList.toggle('active',x.getAttribute('data-at')===actTab);});
    renderActTab(); });
  renderActTab();
}
async function renderActTab(){
  var box=el('act-list'); if(!box)return;
  var seq=++actSeq;                            // this render's token; a later tab switch bumps actSeq
  box.innerHTML='<div class="empty"><span class="spin"></span> '+esc(t('common.loading'))+'</div>';
  try{
    if(actTab==='alldisputes') return renderAllDisputes(box,seq);
    if(!isUnlocked()){ box.innerHTML='<div class="box info">'+unlockLink('act.unlock')+'</div>'; return; }
    await ensureMy();
    if(seq!==actSeq) return;                    // tab changed while loading → don't clobber the new tab
    if(actTab==='history')    return renderActHistory(box);
    if(actTab==='active')     return renderActActive(box);
    if(actTab==='disputable') return renderActDisputable(box);
    if(actTab==='mydisputes') return renderActMyDisputes(box);
  }catch(e){ if(seq===actSeq) box.innerHTML='<div class="box err">'+esc(errText(e))+'</div>'; }
}
function renderActHistory(box){
  if(!ACT.positions.length){ box.innerHTML='<div class="empty">'+esc(t('act.none_history'))+'</div>'; return; }
  var rows=ACT.positions.map(function(p){
    var id=Number(p.market_id!=null?p.market_id:p.market);
    var m=ACT.markets[id];
    var title=m?marketTitle(m):('#'+id);
    // outcome: multi bets carry outcome_index (>=0); binary bets carry side (0=A/Yes, 1=B/No),
    // with outcome_index=-1. Map to the market's real label instead of showing a raw "-1".
    var ocs=m?marketOutcomes(m):[];
    var idx=(p.outcome_index!=null && p.outcome_index>=0)?p.outcome_index:(p.side!=null?p.side:-1);
    var oc=(idx>=0 && ocs[idx]!=null)?ocs[idx]:(idx>=0?('#'+idx):'—');
    var stt=m?statusLabel(marketStatus(m)):'';
    return '<tr><td><a data-nav="#/market/'+id+'">'+esc(title)+'</a> <span class="mut">#'+id+'</span></td>'+
      '<td>'+esc(oc)+'</td><td>'+fmtViz(p.amount||p.stake||0)+'</td><td>'+esc(stt)+'</td></tr>';
  }).join('');
  box.innerHTML='<table class="tbl"><tr><th>'+esc(t('act.col_market'))+'</th><th>'+esc(t('act.col_outcome'))+'</th><th>'+esc(t('act.col_amount'))+'</th><th>'+esc(t('act.col_status'))+'</th></tr>'+rows+'</table>';
}
function renderActActive(box){
  var ms=ACT.ids.map(function(id){return ACT.markets[id];}).filter(function(m){return m && marketStatus(m)===1;});
  if(!ms.length){ box.innerHTML='<div class="empty">'+esc(t('act.none_active'))+'</div>'; return; }
  box.innerHTML=ms.map(marketCard).join('');
  enrichCardBars(box);
}
function renderActDisputable(box){
  var ms=ACT.ids.map(function(id){return ACT.markets[id];}).filter(function(m){
    return m && marketStatus(m)===3 && !disputeOpen(ACT.disputes[marketId(m)]); });
  if(!ms.length){ box.innerHTML='<div class="empty">'+esc(t('act.none_disputable'))+'</div>'; return; }
  box.innerHTML='<div class="hint mb">'+esc(t('act.disputable_hint'))+'</div>'+ms.map(function(m){return actMarketCard(m,'',t('act.open_dispute'));}).join('');
}
function renderActMyDisputes(box){
  var items=ACT.ids.map(function(id){return {m:ACT.markets[id], d:ACT.disputes[id]};}).filter(function(x){return x.m && disputeOpen(x.d);});
  if(!items.length){ box.innerHTML='<div class="empty">'+esc(t('act.none_mydisputes'))+'</div>'; return; }
  box.innerHTML='<div class="hint mb">'+esc(t('act.mydisputes_hint'))+'</div>'+items.map(function(x){return disputeCard(x.m,x.d,true);}).join('');
}
async function renderAllDisputes(box,seq){
  if(seq==null) seq=actSeq;
  box.innerHTML='<div class="hint mb">'+esc(t('act.alldisputes_hint'))+'</div><div class="empty"><span class="spin"></span> '+esc(t('act.scanning'))+'</div>';
  var mine={};
  if(isUnlocked()){ try{ await ensureMy(); ACT.ids.forEach(function(id){mine[id]=1;}); }catch(e){} }
  var markets=[], statuses=[3,2];
  for(var si=0; si<statuses.length; si++){ try{ var l=await api('listMarkets', statuses[si], 0, 40, true, 'newest'); (l||[]).forEach(function(m){markets.push(m);}); }catch(e){} }
  var seen={}, uniq=[]; markets.forEach(function(m){ var id=marketId(m); if(id!=null && !seen[id]){ seen[id]=1; uniq.push(m); } });
  var checked=await Promise.all(uniq.map(function(m){ return api('getDispute', marketId(m)).then(function(d){return {m:m,d:d};}).catch(function(){return null;}); }));
  if(seq!==actSeq) return;                     // user switched tabs during the scan → don't overwrite
  var open=checked.filter(function(r){ return r && disputeOpen(r.d); });
  var head='<div class="hint mb">'+esc(t('act.alldisputes_hint'))+'</div>';
  if(!open.length){ box.innerHTML=head+'<div class="empty">'+esc(t('act.none_alldisputes'))+'</div><div class="hint mt">'+esc(t('act.scan_note'))+'</div>'; return; }
  box.innerHTML=head+open.map(function(r){return disputeCard(r.m,r.d,!!mine[marketId(r.m)]);}).join('')+'<div class="hint mt">'+esc(t('act.scan_note'))+'</div>';
}

/* ========================================================================= *
 *  SCREEN: Profile
 * ========================================================================= */
async function screenProfile(){
  if(!isUnlocked()){
    setContent(h('<div class="title">'+esc(t('tab.profile'))+'</div>',
      '<div class="card center"><div class="subtitle">'+esc(t('pf.not_signed'))+'</div>',
      '<button class="btn block" data-unlock="1">'+esc(hasVault()?t('common.unlock_wallet'):t('common.sign_in'))+'</button>',
      '</div>',
      '<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('common.node'))+'</div><div class="kv"><b>'+esc(t('common.api'))+'</b><span class="mono">'+esc(loadNode().ws)+'</span></div><button class="btn ghost small mt" data-nav="#/node">'+esc(t('common.change_node'))+'</button></div>'
    ));
    return;
  }
  setContent('<div class="title">@'+esc(SESSION.account)+'</div><div id="pf-box"><div class="empty"><span class="spin"></span> '+esc(t('common.loading'))+'</div></div>');
  var oracle=null; try{ oracle=unwrapOracle(await api('getOracle', SESSION.account)); }catch(e){}
  var html='';
  html+='<div class="card">'+
    kv(t('bal.account'),'@'+SESSION.account)+
    kv(t('pf.active_pubkey'), shortKey(SESSION.pubs.active))+
    '<div class="kv"><b>'+esc(t('pf.regular_key'))+'</b><span>'+
      (SESSION.wifs.regular
        ? '<span class="pos">'+esc(t('pf.regular_loaded'))+'</span>'
        : '<span class="neg">'+esc(t('pf.regular_not'))+'</span> · <a id="pf-add-regular">'+esc(t('pf.add_regular'))+'</a>')+
    '</span></div>'+
    '<button class="btn ghost small mt" id="pf-lock">'+esc(t('common.lock_wallet'))+'</button>'+
  '</div>';

  // Oracle panel
  html+='<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('pf.oracle'))+'</div>';
  if(oracle&&(oracle.owner||oracle.fee_percent!=null||oracle.insurance)){
    var score=oracle.reliability_score!=null?oracle.reliability_score:oracle.score;
    html+='<div class="mb">'+esc(t('pf.registered_oracle'))+' '+(score!=null?relBadge(score):'')+'</div>'+
      kv(t('pf.fee_pct'), fromBP(oracle.fee_percent||0)+'%')+
      (oracle.fixed_fee?kv(t('pf.fixed_fee'), oracle.fixed_fee):'')+
      (oracle.insurance?kv(t('pf.insurance'), oracle.insurance):'')+
      kv(t('pf.resolved'), oracle.markets_resolved!=null?oracle.markets_resolved:(oracle.resolved||0))+
      kv(t('pf.disputes_lost'), oracle.disputes_lost||0)+
      '<div class="row mt"><button class="btn ghost small" id="or-update">'+esc(t('pf.update_settings'))+'</button>'+
      '<button class="btn ghost small" id="or-ins">'+esc(t('pf.deposit_insurance'))+'</button>'+
      '<button class="btn ghost small" id="or-pending">'+esc(t('pf.my_pending'))+'</button></div>'+
      rawBlock(oracle);
  } else {
    html+='<div class="mut mb">'+esc(t('pf.not_oracle'))+'</div><button class="btn ghost small" id="or-reg">'+esc(t('pf.register_oracle'))+'</button>';
  }
  html+='</div>';

  // pending reveals (commit-reveal)
  var pend=JSON.parse(localStorage.getItem('lc_reveal')||'[]').filter(function(p){return p.market;});
  if(pend.length){
    html+='<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('pf.pending_reveals'))+'</div>'+
      pend.map(function(p,idx){return '<div class="kv"><b>#'+p.market+'</b><button class="btn small" data-reveal="'+idx+'">'+esc(t('pf.reveal'))+'</button></div>';}).join('')+'</div>';
  }

  // my positions
  html+='<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('pf.my_positions'))+'</div>'+
    '<div class="mb"><a class="mut" data-nav="#/activity">'+esc(t('act.title'))+' →</a></div>'+
    '<div id="pf-pos"><span class="spin"></span></div></div>';

  html+='<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('common.node'))+'</div><div class="kv"><b>'+esc(t('common.api'))+'</b><span class="mono">'+esc(loadNode().ws)+'</span></div><button class="btn ghost small mt" data-nav="#/node">'+esc(t('common.change_node'))+'</button></div>';

  el('pf-box').innerHTML=html;
  el('pf-lock').onclick=function(){lock();toast('ok',t('common.locked'));};
  if(el('pf-add-regular')) el('pf-add-regular').onclick=addRegularKey;
  if(el('or-reg')) el('or-reg').onclick=oracleRegisterModal;
  if(el('or-update')) el('or-update').onclick=function(){oracleUpdateModal(oracle);};
  if(el('or-ins')) el('or-ins').onclick=function(){oracleInsuranceModal();};
  if(el('or-pending')) el('or-pending').onclick=function(){go('#/oracle');};
  $all('[data-reveal]').forEach(function(b){b.onclick=function(){revealPending(Number(b.getAttribute('data-reveal')));};});
  // positions (preview): show market titles, readable outcome and Ƶ amounts. Titles fetched + cached.
  api('getAccountPositions',SESSION.account,0,100).then(async function(list){
    list=(list||[]).map(normPos); var box=el('pf-pos'); if(!box)return;
    if(!list.length){box.innerHTML='<div class="mut">'+esc(t('common.none'))+'</div>';return;}
    var PREVIEW=20, shown=list.slice(0,PREVIEW);
    var ids=shown.map(function(p){ return Number(p.market_id!=null?p.market_id:p.market); });
    var mkts={}; try{ mkts=await marketsByIds(ids); }catch(e){}
    if(!el('pf-pos'))return;                                   // screen changed while awaiting
    var rows=shown.map(function(p){
      var mid=Number(p.market_id!=null?p.market_id:p.market), m=mkts[mid];
      var title=m?marketTitle(m):('#'+mid);
      return '<tr><td><a data-nav="#/market/'+mid+'">'+esc(title)+'</a> <span class="mut">#'+mid+'</span></td>'+
        '<td>'+esc(betOutcomeLabel(p,m))+'</td><td>'+fmtViz(p.amount||p.stake)+'</td></tr>';
    }).join('');
    var more=list.length>PREVIEW?'<div class="hint">'+esc(t('pf.more_positions',{N:list.length-PREVIEW}))+'</div>':'';
    box.innerHTML='<table class="tbl"><tr><th>'+esc(t('pf.col_market'))+'</th><th>'+esc(t('pf.col_outcome'))+'</th><th>'+esc(t('pf.col_amount'))+'</th></tr>'+rows+'</table>'+more;
  }).catch(function(e){var box=el('pf-pos');if(box)box.innerHTML='<div class="box err">'+esc(errText(e))+'</div>';});
}
function revealPending(idx){
  var pend=JSON.parse(localStorage.getItem('lc_reveal')||'[]'); var p=pend[idx]; if(!p)return;
  // needs commit_id — fetch from account's commits is chain-specific; ask user
  openModal(t('pf.reveal_title'), '<label class="lab">'+esc(t('pf.commit_id'))+'</label><input id="rv-cid" type="number"><div class="hint">'+esc(t('pf.reveal_hint',{ID:p.market}))+'</div>',
  [{label:t('common.cancel'),cls:'ghost',act:closeModal},{label:t('pf.reveal'),cls:'',act:function(){
    var cid=Number(el('rv-cid').value); closeModal();
    tx(t('txn.reveal'),function(){return bc('pmRevealBet',wifFor('active'),SESSION.account,cid,p.side,p.oc,p.amount,p.salt,p.min,[]);},function(){
      pend.splice(idx,1); localStorage.setItem('lc_reveal',JSON.stringify(pend)); setTimeout(screenProfile,1200);
    });
  }}]);
}
/* Add/complete the regular key after signing in without it — reuses the login key logic. */
function addRegularKey(){
  if(!requireUnlock())return;
  openModal(t('pf.add_regular_title'), h(
    '<div class="box info">'+esc(t('pf.add_regular_desc'))+'</div>',
    '<label class="lab">'+esc(t('login.regular'))+'</label><input id="ar-wif" type="password" autocomplete="off" class="mono" placeholder="5J…">',
    '<label class="lab">'+esc(t('pf.or_master'))+'</label><input id="ar-pass" type="password" autocomplete="off" placeholder="P5K…">',
    '<label class="lab">'+esc(t('pin.enter'))+'</label><input id="ar-pin" type="password" inputmode="numeric" class="pincode" maxlength="12">'
  ), [
    {label:t('common.cancel'),cls:'ghost',act:closeModal},
    {label:t('pf.add_regular'),cls:'',act:async function(){
      try{
        var wif=el('ar-wif').value.trim(), pass=el('ar-pass').value, pin=el('ar-pin').value, regWif;
        if(wif){ if(!viz.auth.isWif(wif)) throw new Error(t('err.active_not_wif')); regWif=wif; }
        else if(pass){ regWif=viz.auth.getPrivateKeys(SESSION.account, pass, ['regular']).regular; }
        else { toast('warn',t('pf.add_regular_need')); return; }
        var pub=viz.auth.wifToPublic(regWif);
        var acc=(await api('getAccounts',[SESSION.account]))[0];
        if(!acc) throw new Error(t('err.account_not_found',{ACC:SESSION.account}));
        if(!(await pubAuthorizesRole(acc, pub, 'regular'))) throw new Error(t('err.regular_mismatch'));
        // verify the PIN against the stored vault, then re-encrypt with the added key
        try{ await decryptVault(JSON.parse(localStorage.getItem(LS_VAULT)), pin); }
        catch(e){ toast('err',t('pin.wrong')); return; }
        SESSION.wifs.regular=regWif; SESSION.pubs.regular=pub;
        await persistSession(SESSION, pin); persistUnlocked();          // refresh the remembered session with the new key
        closeModal(); toast('ok',t('pf.regular_added')); screenProfile();
      }catch(e){ toast('err',errText(e),6000); }
    }}
  ]);
}
async function oracleRegisterModal(){
  var props={}; try{ props=(await api('getPmChainProperties'))||{}; }catch(e){}
  var minIns=(props.pm_min_oracle_insurance!=null)?(Number(props.pm_min_oracle_insurance)/1000):5000; // live chain minimum
  openModal(t('pf.reg_title'), h(
    '<label class="lab">'+esc(t('pf.insurance_deposit'))+'</label><input id="o-ins" type="number" step="0.001" min="'+minIns.toFixed(3)+'" value="'+minIns.toFixed(3)+'">',
    '<label class="lab">'+esc(t('pf.fee_pct'))+'</label><input id="o-fee" type="number" step="0.1" min="0" value="1">',
    '<label class="lab">'+esc(t('pf.rules_url'))+'</label><input id="o-url" type="url" placeholder="https://…">',
    '<div class="box info">'+esc(t('pf.auto_desc'))+'</div>',
    '<label class="lab"><input type="checkbox" id="o-auto"> '+esc(t('pf.auto_accept'))+'</label>',
    '<label class="lab">'+esc(t('pf.auto_creator'))+'</label><input id="o-acr" type="text" autocomplete="off" spellcheck="false" placeholder="'+esc(t('pf.account_opt'))+'">',
    '<label class="lab">'+esc(t('pf.auto_resolver'))+'</label><input id="o-ars" type="text" autocomplete="off" spellcheck="false" placeholder="'+esc(t('pf.account_opt'))+'">'
  ),[{label:t('common.cancel'),cls:'ghost',act:closeModal},{label:t('pf.register'),cls:'',act:function(){
    if((Number(el('o-ins').value)||0)<minIns){ toast('warn',t('pf.insurance_deposit')+' ≥ '+minIns.toFixed(3)+' VIZ'); return; } // keep modal open on invalid
    var ins=toAsset(el('o-ins').value), fee=toBP(el('o-fee').value), url=el('o-url').value||'';
    var acr=el('o-acr').value.trim().toLowerCase(), ars=el('o-ars').value.trim().toLowerCase(), auto=el('o-auto').checked;
    closeModal(); tx(t('txn.register_oracle'),function(){return bc('pmOracleRegister',wifFor('active'),SESSION.account,ins,fee,'0.000 VIZ',url,acr,ars,auto,[]);},function(){setTimeout(screenProfile,1500);});
  }}]);
}
function oracleUpdateModal(cur){
  cur=cur||{};
  openModal(t('pf.update_title'), h(
    '<label class="lab">'+esc(t('pf.insurance_delta'))+'</label><input id="o-ins" type="number" step="0.001" value="0">',
    '<label class="lab">'+esc(t('pf.fee_keep'))+'</label><input id="o-fee" type="number" step="0.1" placeholder="'+esc(t('pf.keep'))+'">',
    '<label class="lab">'+esc(t('pf.rules_keep'))+'</label><input id="o-url" type="url" placeholder="'+esc(t('pf.keep'))+'">',
    '<div class="box info">'+esc(t('pf.auto_desc'))+'</div>',
    '<label class="lab">'+esc(t('pf.auto_accept'))+'</label><select id="o-auto"><option value="">'+esc(t('pf.opt_keep'))+'</option><option value="1">'+esc(t('pf.opt_on'))+'</option><option value="0">'+esc(t('pf.opt_off'))+'</option></select>',
    '<label class="lab">'+esc(t('pf.auto_creator'))+'</label><input id="o-acr" type="text" autocomplete="off" spellcheck="false" value="'+esc(cur.auto_accept_creator||'')+'" placeholder="'+esc(t('pf.account_keep'))+'">',
    '<label class="lab">'+esc(t('pf.auto_resolver'))+'</label><input id="o-ars" type="text" autocomplete="off" spellcheck="false" value="'+esc(cur.auto_accept_resolver||'')+'" placeholder="'+esc(t('pf.account_keep'))+'">'
  ),[{label:t('common.cancel'),cls:'ghost',act:closeModal},{label:t('pf.update'),cls:'',act:function(){
    var insD=el('o-ins').value?assetNum(el('o-ins').value):0;
    var fee=el('o-fee').value===''?null:toBP(el('o-fee').value);
    var url=el('o-url').value||null;
    var av=el('o-auto').value, auto=(av===''?null:av==='1');            // — keep — / On / Off
    var acr=el('o-acr').value.trim().toLowerCase(); acr=acr===''?null:acr;   // blank = keep
    var ars=el('o-ars').value.trim().toLowerCase(); ars=ars===''?null:ars;
    closeModal(); tx(t('txn.update_oracle'),function(){return bc('pmOracleUpdate',wifFor('active'),SESSION.account,toAsset(insD),fee,null,url,acr,ars,auto,[]);},function(){setTimeout(screenProfile,1500);});
  }}]);
}
function oracleInsuranceModal(){
  openModal(t('pf.deposit_ins_title'), '<label class="lab">'+esc(t('common.amount_viz'))+'</label><input id="o-ins" type="number" step="0.001" min="0.001" value="10.000">',
  [{label:t('common.cancel'),cls:'ghost',act:closeModal},{label:t('pf.deposit'),cls:'',act:function(){
    var a=el('o-ins').value; closeModal();
    tx(t('txn.deposit_insurance'),function(){return bc('pmOracleUpdate',wifFor('active'),SESSION.account,toAsset(a),null,null,null,null,null,null,[]);},function(){setTimeout(screenProfile,1500);});
  }}]);
}

/* ========================================================================= *
 *  SCREEN: Oracle — pending / assigned markets
 * ========================================================================= */
async function screenOracle(){
  if(!requireUnlock())return;
  setContent('<div class="title">'+esc(t('or.title'))+'</div>'+
    '<div class="card"><div class="section-title" style="margin-top:0">'+esc(t('unban.title'))+'</div>'+
      '<div class="hint mb">'+esc(t('unban.desc'))+'</div>'+
      '<div class="row"><input id="ub-acc" class="grow" type="text" autocomplete="off" spellcheck="false" placeholder="account">'+
        '<button class="btn ghost" id="ub-check" style="white-space:nowrap">'+esc(t('unban.check'))+'</button></div>'+
      '<div id="ub-status" class="hint"></div>'+
      '<label class="lab"><input type="checkbox" id="ub-oracle" checked> '+esc(t('unban.oracle'))+'</label>'+
      '<label class="lab"><input type="checkbox" id="ub-creator"> '+esc(t('unban.creator'))+'</label>'+
      '<button class="btn block mt" id="ub-go">'+esc(t('unban.submit'))+'</button>'+
    '</div>'+
    '<div class="section-title">'+esc(t('or.assigned'))+'</div>'+
    '<div id="or-list"><div class="empty"><span class="spin"></span> '+esc(t('common.loading'))+'</div></div>');
  if(el('ub-check')) el('ub-check').onclick=async function(){
    var acc=el('ub-acc').value.trim().toLowerCase(), s=el('ub-status');
    if(!acc){ toast('warn',t('unban.enter_acc')); return; }
    s.innerHTML='<span class="spin"></span>';
    try{ var b=await api('getCreatorBan', acc);
      var banned=b&&(b.banned===true||b.until!=null||b.ban_expiration!=null||b.expiration!=null);
      s.innerHTML=banned?'<span class="neg">'+esc(t('unban.is_banned',{T:tsToLocal(assetTime(b.until||b.ban_expiration||b.expiration))}))+'</span>'
                        :'<span class="pos">'+esc(t('unban.not_banned'))+'</span>';
    }catch(e){ s.innerHTML='<span class="mut">'+esc(t('unban.status_na'))+'</span>'; }
  };
  if(el('ub-go')) el('ub-go').onclick=function(){
    var target=el('ub-acc').value.trim().toLowerCase();
    var uo=el('ub-oracle').checked, uc=el('ub-creator').checked;
    if(!target){ toast('warn',t('unban.enter_acc')); return; }
    if(!uo&&!uc){ toast('warn',t('unban.pick_one')); return; }
    tx(t('txn.unban'),function(){return bc('pmUnban',wifFor('active'),SESSION.account,target,uo,uc,[]);},
      function(){ toast('ok',t('unban.done')); });
  };
  try{
    // Preferred path: the dedicated node query list_markets_awaiting_resolution (viz-js-lib ≥0.13.5 +
    // a node exposing the API) returns exactly the markets needing THIS oracle's result — active
    // markets whose betting window has closed but that aren't resolved yet — with no client-side
    // full-scan. Fall back to paging the oracle's whole set on older nodes that lack the method
    // (e.g. testnet before the plugin upgrade), keeping the console working either way.
    var awaiting=null;
    try{
      awaiting=await api('listMarketsAwaitingResolution', SESSION.account, 0, 1000);
      if(!el('or-list')) return;                                   // navigated away
      if(!Array.isArray(awaiting)) awaiting=null;
    }catch(e0){ awaiting=null; }                                   // node lacks the method → scan fallback
    if(awaiting===null){
      var PAGE=1000, all=[], from=0, guard=0;
      while(guard++<30){
        var chunk=await api('listMarketsByOracle', SESSION.account, from, PAGE);
        if(!el('or-list')) return;                                 // navigated away mid-scan
        chunk=chunk||[]; all=all.concat(chunk); from+=PAGE;
        if(all.length>PAGE) el('or-list').innerHTML='<div class="empty"><span class="spin"></span> '+esc(t('or.scanning',{N:all.length}))+'</div>';
        if(chunk.length<PAGE) break;
      }
      // status 2 = betting closed → awaiting; a status-1 market whose betting window already elapsed
      // also awaits resolution (node lags the flip to 2). Those are the ones the oracle must act on.
      var nowT=now();
      awaiting=all.filter(function(m){ var st=marketStatus(m), be=assetTime(m.betting_expiration); return st===2 || (st===1 && be && be<=nowT); });
    }
    awaiting=(awaiting||[]).slice();
    awaiting.sort(function(a,b){ return (assetTime(a.result_expiration)||0)-(assetTime(b.result_expiration)||0); }); // soonest deadline first
    var CAP=300, html='';
    if(awaiting.length){
      html+='<div class="section-title">'+esc(t('or.awaiting',{N:awaiting.length}))+'</div>'+
            '<div class="hint mb">'+esc(t('or.awaiting_hint'))+'</div>'+
            awaiting.slice(0,CAP).map(marketCard).join('');
      if(awaiting.length>CAP) html+='<div class="hint mb">'+esc(t('or.more',{N:awaiting.length-CAP}))+'</div>';
    } else {
      html+='<div class="box info mb">'+esc(t('or.none_awaiting'))+'</div>';
    }
    el('or-list').innerHTML=html;
  }catch(e){ el('or-list').innerHTML='<div class="box err">'+esc(errText(e))+'</div>'; }
}

/* ========================================================================= *
 *  SCREEN: Oracles — leaderboard (listOracles), pick one for market creation
 * ========================================================================= */
/* One oracle card on the leaderboard; the @owner title links to the full profile. */
function oracleCard(o){
  var owner=o.owner||o.account||o.name||'';
  var resolved=o.markets_resolved!=null?o.markets_resolved:(o.resolved||0);
  var s=o.reliability_score!=null?o.reliability_score:o.score;
  return '<div class="card" data-owner="'+esc(owner)+'"><div class="card-q"><a data-nav="#/oracles/'+encodeURIComponent(owner)+'">@'+esc(owner)+'</a> '+(s!=null?relBadge(s):'')+'</div>'+
    '<div class="card-meta">'+
      '<span>'+esc(t('pf.fee_pct'))+' '+fromBP(o.fee_percent||0)+'%</span>'+
      (o.fixed_fee!=null&&assetNum(o.fixed_fee)>0?'<span>+'+esc(typeof o.fixed_fee==='string'?o.fixed_fee:toAsset(assetNum(o.fixed_fee)))+'</span>':'')+
      (o.insurance!=null?'<span>'+esc(t('pf.insurance'))+' '+esc(fmtVizParam(o.insurance))+'</span>':'')+
      '<span>'+esc(t('ors.resolved',{N:resolved}))+'</span>'+
      (o.disputes_lost?'<span class="badge risk">'+esc(t('ors.disputes_lost',{N:o.disputes_lost}))+'</span>':'')+
    '</div>'+
    ((o.rules_url||o.rules)?'<div class="hint"><a href="'+esc(o.rules_url||o.rules)+'" target="_blank">'+esc(t('md.rules'))+'</a></div>':'')+
    '<button class="btn small mt" data-pick="'+esc(owner)+'">'+esc(t('ors.use'))+'</button></div>';
}

/* Oracle leaderboard. Card title @owner links through to the per-oracle profile. */
async function screenOracles(){
  setContent('<div class="title">'+esc(t('ors.title'))+'</div>'+
    '<div class="hint mb">'+esc(t('ors.lead'))+'</div>'+
    '<div id="ors-list"><div class="empty"><span class="spin"></span> '+esc(t('common.loading'))+'</div></div>');
  try{
    var list=await api('listOracles', 0, 200);
    list=list||[];
    var score=function(o){ var s=o.reliability_score!=null?o.reliability_score:o.score; return s==null?-1:Number(s); };
    list.sort(function(a,b){ return score(b)-score(a); });
    if(!list.length){ el('ors-list').innerHTML='<div class="empty">'+esc(t('ors.none'))+'</div>'; return; }
    el('ors-list').innerHTML=list.map(function(o){ return oracleCard(o); }).join('');
    $all('[data-pick]',el('ors-list')).forEach(function(b){ b.onclick=function(){
      try{ sessionStorage.setItem('lc_pick_oracle', b.getAttribute('data-pick')); }catch(e){}
      go('#/create');
    };});
  }catch(e){ el('ors-list').innerHTML='<div class="box err">'+esc(errText(e))+'</div>'; }
}

/* Per-oracle profile: full reputation scoring breakdown + description + recent markets by status.
   Reached via a market's "oracle:" link (#/oracles/<owner>) or an @owner link on the leaderboard. */
async function screenOracleProfile(owner){
  setContent('<div class="row"><a class="mut" data-nav="#/oracles">'+esc(t('orp.back'))+'</a></div>'+
    '<div id="orp-head" class="title" style="margin-top:6px">@'+esc(owner)+'</div>'+
    '<div id="orp-body"><div class="empty"><span class="spin"></span> '+esc(t('common.loading'))+'</div></div>');
  try{
    var o=unwrapOracle(await api('getOracle', owner));
    if(!o){ el('orp-body').innerHTML='<div class="empty">'+esc(t('orp.not_oracle'))+'</div>'; return; }
    var score=o.reliability_score!=null?o.reliability_score:o.score;
    el('orp-head').innerHTML='@'+esc(owner)+' '+(score!=null?relBadge(score):'');

    var kv=function(label,val){ return '<div class="kv"><span class="mut">'+esc(label)+'</span><b>'+esc(String(val))+'</b></div>'; };
    var dur=function(s){ s=Number(s)||0; if(!s)return '—'; var h=Math.floor(s/3600),mn=Math.floor((s%3600)/60); return h?h+'h '+mn+'m':mn+'m'; };
    var banned=o.banned_until&&assetTime(o.banned_until)>now();

    var body='<div class="card">'+
      '<div class="section-title" style="margin-top:0">'+esc(t('orp.scoring'))+'</div>'+
      kv(t('orp.reliability'), score!=null?Math.round(relPct(score))+' / 100':'—')+
      kv(t('pf.fee_pct'), fromBP(o.fee_percent||0)+'%')+
      (o.fixed_fee!=null&&assetNum(o.fixed_fee)>0?kv(t('pf.fixed_fee'), fmtVizParam(o.fixed_fee)):'')+
      kv(t('pf.insurance'), fmtVizParam(o.insurance))+
      kv(t('orp.accepted'), o.markets_accepted||0)+
      kv(t('orp.resolved'), o.markets_resolved||0)+
      kv(t('orp.no_contest'), o.no_contest_count||0)+
      kv(t('orp.missed'), o.missed_count||0)+
      kv(t('orp.disputes'), (o.disputes_received||0)+' · '+(o.disputes_won||0)+t('orp.won_s')+' / '+(o.disputes_lost||0)+t('orp.lost_s'))+
      kv(t('orp.resp_missed'), o.dispute_responses_missed||0)+
      kv(t('orp.vol_resolved'), fmtVizParam(o.total_volume_resolved))+
      kv(t('orp.insurance_slashed'), fmtVizParam(o.total_insurance_slashed))+
      kv(t('orp.avg_res_time'), dur(o.avg_resolution_time))+
      kv(t('orp.penalty'), o.penalty_stamps||0)+
      kv(t('orp.bans'), o.bans_received||0)+
      kv(t('orp.active_since'), tsToLocal(assetTime(o.active_since)))+
      kv(t('orp.last_active'), tsToLocal(assetTime(o.last_active_time)))+
      (banned?'<div class="box err mt">'+esc(t('orp.banned_until',{T:tsToLocal(assetTime(o.banned_until))}))+'</div>':'')+
      ((o.rules_url||o.rules)?'<div class="hint mt"><a href="'+esc(o.rules_url||o.rules)+'" target="_blank">'+esc(t('orp.rules'))+'</a></div>':'')+
    '</div>'+
    '<div class="section-title">'+esc(t('orp.recent'))+'</div>'+
    '<div id="orp-mk"><div class="empty"><span class="spin"></span> '+esc(t('common.loading'))+'</div></div>';
    el('orp-body').innerHTML=body;

    // Markets feed — NEWEST-first. list_markets_by_oracle pages ascending from market id 0, so to show
    // the latest markets first (and walk deeper into history on "load more") we fetch the oracle's set
    // once — fast even for thousands: the node streams 1000/page (~1s for 8k markets) — sort it
    // id-descending, then reveal 100 at a time from memory. The scoring card above already carries the
    // lifetime counts, so this stays a flat feed. (A server-side newest-first page would drop even the
    // one-time fetch; worth adding node-side later if oracles grow much past ~10k live markets.)
    (function(){
      var PAGE=100, all=null, shown=0;
      function cardHtml(x){ var id=marketId(x);
        return '<div class="card click card-dense" data-nav="#/market/'+id+'">'+
          '<div class="card-q">'+esc(marketTitle(x))+'</div>'+
          '<div class="mut" style="font-size:12px">'+statusBadge(x)+'</div></div>';
      }
      function renderMore(){
        var slice=all.slice(shown, shown+PAGE); shown+=slice.length;
        el('orp-mk-list').insertAdjacentHTML('beforeend', slice.map(cardHtml).join(''));
        if(shown>=all.length){ el('orp-mk-more').innerHTML=''; }
        else { el('orp-mk-more').innerHTML='<button class="btn" id="orp-more-btn">'+esc(t('orp.load_more'))+'</button>'; el('orp-more-btn').onclick=renderMore; }
      }
      async function fetchAll(){
        var acc=[], from=0, guard=0, seen={};
        while(guard++<50){
          var chunk=(await api('listMarketsByOracle', owner, from, 1000))||[];
          if(!el('orp-mk')) return null;                              // navigated away mid-fetch
          chunk.forEach(function(x){ var id=marketId(x); if(id!=null && !seen[id]){ seen[id]=1; acc.push(x); } });
          from+=1000;
          if(chunk.length<1000) break;
        }
        acc.sort(function(a,b){ return marketId(b)-marketId(a); });   // newest (highest id) first → "load more" digs older
        return acc;
      }
      (async function(){
        try{
          all=await fetchAll();
          if(all===null || !el('orp-mk')) return;                     // navigated away
          if(!all.length){ el('orp-mk').innerHTML='<div class="empty">'+esc(t('orp.no_markets'))+'</div>'; return; }
          el('orp-mk').innerHTML='<div id="orp-mk-list"></div><div id="orp-mk-more" class="mt"></div>';
          renderMore();
        }catch(e2){ if(el('orp-mk')) el('orp-mk').innerHTML='<div class="box err">'+esc(t('orp.markets_error'))+'</div>'; }
      })();
    })();
  }catch(e){ el('orp-body').innerHTML='<div class="box err">'+esc(errText(e))+'</div>'; }
}

/* Public account card: balance + this account's bets/results across markets.
   Reached from any bettor name in a market's "recent bets" — public chain, anyone can inspect. */
async function screenAccount(name){
  name=String(name||'').trim().toLowerCase();
  if(!name){ go('#/markets'); return; }
  setContent('<div class="row"><a class="mut" data-nav="'+esc(lastBrowseHash)+'">'+esc(t('common.back_markets'))+'</a></div>'+
    '<div class="title" style="margin-top:6px">@'+esc(name)+'</div>'+
    '<div class="hint mb">'+esc(t('acc.public_note'))+'</div>'+
    '<div id="acc-bal"><div class="empty"><span class="spin"></span> '+esc(t('common.loading'))+'</div></div>'+
    '<div class="section-title">'+esc(t('acc.bets'))+'</div>'+
    '<div id="acc-bets"><div class="empty"><span class="spin"></span> '+esc(t('common.loading'))+'</div></div>');
  // balance
  try{
    var acc=(await api('getAccounts',[name]))[0];
    if(!acc){ el('acc-bal').innerHTML='<div class="box err">'+esc(t('acc.not_found'))+'</div>'; el('acc-bets').innerHTML=''; return; }
    var energy=acc.energy;
    el('acc-bal').innerHTML='<div class="card">'+
      kv(t('bal.liquid'), fmtViz(acc.balance))+
      (acc.vesting_shares?kv(t('bal.shares'), acc.vesting_shares):'')+
      (energy!=null?kv(t('bal.energy'), (energy/100).toFixed(2)+'%'):'')+
      (acc.created?kv(t('acc.created'), tsToLocal(assetTime(acc.created))):'')+
    '</div>';
  }catch(e){ el('acc-bal').innerHTML='<div class="box err">'+esc(errText(e))+'</div>'; }
  // bets / positions across markets
  try{
    var all=((await api('getAccountPositions', name, 0, 100))||[]).map(normPos);
    var box=el('acc-bets'); if(!box)return;
    if(!all.length){ box.innerHTML='<div class="empty">'+esc(t('acc.no_bets'))+'</div>'; return; }
    var ids=all.map(function(p){ return Number(p.market_id!=null?p.market_id:p.market); });
    var mkts={}; try{ mkts=await marketsByIds(ids); }catch(e){}
    if(!el('acc-bets'))return;                                   // screen changed while awaiting
    var rows=all.map(function(p){
      var mid=Number(p.market_id!=null?p.market_id:p.market), m=mkts[mid];
      var title=m?marketTitle(m):('#'+mid);
      var st=(p.market_status!=null?p.market_status:(m?marketStatus(m):1));
      var res=esc(statusLabel(st));
      if(assetNum(p.expected_payout)>0) res+=' <span class="ok">'+fmtViz(p.expected_payout)+'</span>';
      return '<tr><td><a data-nav="#/market/'+mid+'">'+esc(title)+'</a> <span class="mut">#'+mid+'</span></td>'+
        '<td>'+esc(betOutcomeLabel(p,m))+'</td><td>'+fmtViz(p.amount||p.stake)+'</td><td>'+res+'</td></tr>';
    }).join('');
    box.innerHTML='<table class="tbl"><tr><th>'+esc(t('pf.col_market'))+'</th><th>'+esc(t('pf.col_outcome'))+'</th><th>'+esc(t('pf.col_amount'))+'</th><th>'+esc(t('act.col_status'))+'</th></tr>'+rows+'</table>';
  }catch(e){ var b2=el('acc-bets'); if(b2)b2.innerHTML='<div class="box err">'+esc(errText(e))+'</div>'; }
}

/* ------------------------------------------------------------------- modal */
function openModal(title, bodyHtml, actions){
  var host=el('modal-host');
  host.innerHTML='<div class="overlay"><div class="modal"><h3>'+esc(title)+'</h3><div class="modal-body">'+bodyHtml+'</div>'+
    '<div class="modal-actions">'+ (actions||[]).map(function(a,i){return '<button class="btn '+(a.cls||'')+' grow" data-a="'+i+'">'+esc(a.label)+'</button>';}).join('') +'</div></div></div>';
  var ovl=host.querySelector('.overlay');
  ovl.addEventListener('click',function(e){ if(e.target===ovl) closeModal(); });
  (actions||[]).forEach(function(a,i){ host.querySelector('[data-a="'+i+'"]').onclick=a.act; });
}
function closeModal(){ el('modal-host').innerHTML=''; }

/* Software agreement — blocking gate on first run, or reviewable from settings. */
function showTerms(blocking){
  var accepted=termsAccepted();
  var body='<div class="box info">'+esc(t('terms.intro'))+'</div>'+
    '<ul class="terms-list">'+['b1','b2','b3','b4','b5'].map(function(k){return '<li>'+esc(t('terms.'+k))+'</li>';}).join('')+'</ul>'+
    (accepted?'':'<label class="lab"><input type="checkbox" id="tm-cb"> '+esc(t('terms.agree'))+'</label>');
  var actions='';
  if(accepted && !blocking){ actions='<button class="btn block" data-tm="close">'+esc(t('terms.close'))+'</button>'; }
  else if(!blocking){ actions='<button class="btn ghost grow" data-tm="close">'+esc(t('terms.close'))+'</button><button class="btn grow" data-tm="agree">'+esc(t('terms.agree_btn'))+'</button>'; }
  else { actions='<button class="btn block" data-tm="agree">'+esc(t('terms.agree_btn'))+'</button>'; }
  el('modal-host').innerHTML='<div class="overlay" id="tm-ovl"><div class="modal"><h3>'+esc(t('terms.title'))+'</h3>'+
    '<div class="modal-body">'+body+'</div><div class="modal-actions">'+actions+'</div></div></div>';
  var host=el('modal-host');
  var closeBtn=host.querySelector('[data-tm="close"]'); if(closeBtn) closeBtn.onclick=closeModal;
  var agreeBtn=host.querySelector('[data-tm="agree"]');
  if(agreeBtn) agreeBtn.onclick=function(){
    if(!accepted){ var cb=el('tm-cb'); if(!cb||!cb.checked){ toast('warn',t('terms.must_accept')); return; } }
    acceptTerms(); closeModal(); toast('ok',t('terms.status_accepted'));
    if(blocking){ updateChrome(); route(); }
  };
  if(!blocking){ var ovl=el('tm-ovl'); ovl.addEventListener('click',function(e){ if(e.target===ovl) closeModal(); }); }
}

/* ========================================================================= *
 *  Boot
 * ========================================================================= */
function bootFailed(msg){
  document.getElementById('content').innerHTML='<div class="box err">'+esc(msg)+'</div>'+
    '<div class="box info">'+t('boot.viz_hint')+'</div>';
}
/* cross-tab: react to a lock from any other tab, and relay the unlocked session to new tabs */
window.addEventListener('storage', function(e){ if(e.key===LS_LOCK && SESSION){ lock(false); } });
if(BC) BC.onmessage=function(ev){
  var m=ev.data||{};
  if(m.type==='lock'){ if(SESSION) lock(false); }
  else if(m.type==='req'){ if(SESSION) try{ BC.postMessage({type:'session', data:{account:SESSION.account, wifs:SESSION.wifs, pubs:SESSION.pubs}}); }catch(e){} }
  else if(m.type==='session' && m.data && !SESSION){ SESSION={account:m.data.account, wifs:m.data.wifs, pubs:m.data.pubs}; persistUnlocked(); updateChrome(); seedWatch(); route(); }
};

/* PWA: register the offline app-shell service worker (secure contexts only) */
if('serviceWorker' in navigator && location.protocol!=='file:'){
  window.addEventListener('load', function(){ navigator.serviceWorker.register('sw.js').catch(function(){}); });
}

async function boot(){
  if(typeof viz==='undefined'){ return bootFailed(t('boot.viz_missing')); }
  try{ Object.keys(localStorage).forEach(function(k){ if(k.indexOf(LS_MKT_IDX+'::')===0) localStorage.removeItem(k); }); }catch(e){}  // drop orphaned v20 chain-scoped index keys (reverted to plain id-keyed)
  applyNode();
  restoreUnlocked();                                          // this tab's remembered session (survives reload)
  if(!isUnlocked() && BC && hasVault()){                      // ask other open tabs to share their unlock
    try{ BC.postMessage({type:'req'}); }catch(e){}
    await new Promise(function(r){ setTimeout(r, 350); });    // brief wait for a reply (handled in BC.onmessage)
  }
  updateChrome();
  if(hasVault() && !isUnlocked() && (!location.hash||location.hash==='#/'||location.hash==='#/profile')){
    if(location.hash==='#/profile') setReturn('#/profile');   // come back to profile after unlock
    location.hash='#/unlock';
  }
  route();
  if(!termsAccepted()) showTerms(true); // first-run blocking agreement gate
  // background connectivity check + periodic health loop
  try{ var r=await testConnection(loadNode()); applyStatus(r.latency, r.props); }
  catch(e){ CHAIN_OK=false; setNodeStatus('offline'); toast('warn',t('toast.node_offline'),6000); }
  startHealthLoop();
  if(isUnlocked()) seedWatch();
}
boot();

})();
