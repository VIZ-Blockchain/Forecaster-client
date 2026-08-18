/* ton-lite.js — minimal TON cell/BOC builder for the in-app swap (#/swap).
 * Dependency-free vanilla JS; loads lazily next to tonconnect-ui.min.js and only
 * builds internal-message BODY cells for TON Connect sendTransaction:
 * TEP-74 jetton transfer, StonFi v2 swap, pTON v2.1 ton_transfer, text comment.
 * Runs both in the browser (window.TONLITE) and in Node (module.exports) so the
 * exact shipped file is byte-verified against @ton/core (.secrets/ton-lite-verify.mjs).
 * BOC output: single root, no index, crc32c on — same as @ton/core toBoc defaults. */
(function(){
'use strict';

/* ---- bit builder / cell ---- */
function Builder(){ this.bits=[]; this.refs=[]; }
Builder.prototype.storeBit=function(b){ if(this.bits.length>=1023) throw new Error('cell overflow'); this.bits.push(b?1:0); return this; };
Builder.prototype.storeUint=function(v,len){
  v=BigInt(v);
  if(v<0n||v>=(1n<<BigInt(len))) throw new Error('uint out of range');
  for(var i=len-1;i>=0;i--) this.storeBit((v>>BigInt(i))&1n?1:0);
  return this;
};
Builder.prototype.storeCoins=function(v){
  v=BigInt(v);
  if(v<0n) throw new Error('coins negative');
  if(v===0n) return this.storeUint(0,4);
  var bytes=0,t=v; while(t>0n){bytes++; t>>=8n;}
  if(bytes>15) throw new Error('coins too large');
  return this.storeUint(bytes,4).storeUint(v,bytes*8);
};
/* MsgAddress: null → addr_none$00; {wc, hash(Uint8Array32)} → addr_std$10 anycast:0 wc:int8 hash:256 */
Builder.prototype.storeAddress=function(a){
  if(!a) return this.storeUint(0,2);
  this.storeUint(2,2).storeBit(0).storeUint(a.wc&0xff,8);
  for(var i=0;i<32;i++) this.storeUint(a.hash[i],8);
  return this;
};
Builder.prototype.storeBytes=function(u8){ for(var i=0;i<u8.length;i++) this.storeUint(u8[i],8); return this; };
/* Short text tail only (fits current cell) — enough for a VIZ account comment. */
Builder.prototype.storeStringTail=function(s){
  var u8=utf8(s);
  if(this.bits.length+u8.length*8>1023) throw new Error('string too long for one cell');
  return this.storeBytes(u8);
};
Builder.prototype.storeRef=function(c){ if(this.refs.length>=4) throw new Error('too many refs'); this.refs.push(c); return this; };
Builder.prototype.storeMaybeRef=function(c){ return c?this.storeBit(1).storeRef(c):this.storeBit(0); };
Builder.prototype.endCell=function(){ return {bits:this.bits.slice(), refs:this.refs.slice()}; };
function beginCell(){ return new Builder(); }

/* ---- BOC serialization (no idx, crc32c) ---- */
function cellDataBytes(c){
  var b=c.bits.slice();
  if(b.length%8){ b.push(1); while(b.length%8) b.push(0); }  // completion tag
  var out=new Uint8Array(b.length/8);
  for(var i=0;i<out.length;i++){ var v=0; for(var k=0;k<8;k++) v=(v<<1)|b[i*8+k]; out[i]=v; }
  return out;
}
function cellToBoc(root){
  var cells=[];                                   // DFS pre-order → parent index < child index
  (function walk(c){ cells.push(c); c.refs.forEach(walk); })(root);
  var idx=new Map(); cells.forEach(function(c,i){ idx.set(c,i); });
  var bodies=cells.map(function(c){
    var data=cellDataBytes(c);
    var d1=c.refs.length, d2=Math.floor(c.bits.length/8)+Math.ceil(c.bits.length/8);
    var refs=c.refs.map(function(r){ return idx.get(r); });
    return {d1:d1,d2:d2,data:data,refs:refs};
  });
  var s=1; while(cells.length>=Math.pow(256,s)) s++;                  // bytes per cell index
  var tot=0; bodies.forEach(function(b){ tot+=2+b.data.length+b.refs.length*s; });
  var off=1; while(tot>=Math.pow(256,off)) off++;                     // bytes for tot_cells_size
  var out=[];
  [0xb5,0xee,0x9c,0x72].forEach(function(x){out.push(x);});
  out.push(0x40|s);                                                   // has_idx=0 crc32c=1 cache=0 flags=0 size=s
  out.push(off);
  pushInt(out,cells.length,s); pushInt(out,1,s); pushInt(out,0,s);    // cells, roots, absent
  pushInt(out,tot,off);
  pushInt(out,0,s);                                                   // root list: [0]
  bodies.forEach(function(b){
    out.push(b.d1); out.push(b.d2);
    for(var i=0;i<b.data.length;i++) out.push(b.data[i]);
    b.refs.forEach(function(r){ pushInt(out,r,s); });
  });
  var u8=new Uint8Array(out), crc=crc32c(u8);
  var full=new Uint8Array(u8.length+4); full.set(u8);
  full[u8.length]=crc&0xff; full[u8.length+1]=(crc>>>8)&0xff; full[u8.length+2]=(crc>>>16)&0xff; full[u8.length+3]=(crc>>>24)&0xff;
  return full;
}
function pushInt(arr,v,bytes){ for(var i=bytes-1;i>=0;i--) arr.push((v>>>(8*i))&0xff); }
function cellToBocBase64(root){ return b64enc(cellToBoc(root)); }
function crc32c(u8){
  var crc=0xFFFFFFFF>>>0;
  for(var i=0;i<u8.length;i++){ crc=(crc^u8[i])>>>0; for(var k=0;k<8;k++) crc=((crc>>>1)^(0x82F63B78&(-(crc&1))))>>>0; }
  return (crc^0xFFFFFFFF)>>>0;
}

/* ---- addresses ---- */
function crc16(u8){                                                   // CRC-16/XMODEM
  var crc=0;
  for(var i=0;i<u8.length;i++){ crc^=u8[i]<<8;
    for(var k=0;k<8;k++) crc=crc&0x8000?((crc<<1)^0x1021)&0xffff:(crc<<1)&0xffff; }
  return crc;
}
/* friendly EQ…/UQ… or raw "0:hex64" → {wc, hash} */
function parseAddress(s){
  s=String(s).trim();
  var m=s.match(/^(-?\d+):([0-9a-fA-F]{64})$/);
  if(m){ return {wc:parseInt(m[1],10), hash:hexToU8(m[2])}; }
  if(!/^[A-Za-z0-9_+/-]{48}$/.test(s)) throw new Error('bad address');
  var u8=b64dec(s.replace(/-/g,'+').replace(/_/g,'/'));
  if(u8.length!==36) throw new Error('bad address');
  if(crc16(u8.subarray(0,34))!==((u8[34]<<8)|u8[35])) throw new Error('address checksum');
  var wc=u8[1]; if(wc>127) wc-=256;
  return {wc:wc, hash:u8.slice(2,34)};
}
function toFriendly(a,opts){
  opts=opts||{};
  var tag=(opts.bounceable===false?0x51:0x11)|(opts.testnet?0x80:0);
  var u8=new Uint8Array(36); u8[0]=tag; u8[1]=a.wc&0xff; u8.set(a.hash,2);
  var c=crc16(u8.subarray(0,34)); u8[34]=c>>8; u8[35]=c&0xff;
  return b64enc(u8).replace(/\+/g,'-').replace(/\//g,'_');
}

/* ---- high-level bodies ---- */
function commentCell(text){ return beginCell().storeUint(0,32).storeStringTail(text).endCell(); }
/* TEP-74 transfer: peg-out (forwardPayload=comment) and DEX leg (forwardPayload=swap body) */
function jettonTransferBody(o){
  return beginCell()
    .storeUint(0x0f8a7ea5,32)
    .storeUint(o.queryId||0,64)
    .storeCoins(o.amount)
    .storeAddress(parseAddress(o.destination))
    .storeAddress(parseAddress(o.response))
    .storeMaybeRef(null)
    .storeCoins(o.forwardTon||0)
    .storeMaybeRef(o.forwardPayload||null)                            // Either-in-ref (bit1+ref), inline unused
    .endCell();
}
/* StonFi Router v2.1/v2.2 swap forward-payload */
function stonfiSwapBody(o){
  return beginCell()
    .storeUint(0x6664de2a,32)
    .storeAddress(parseAddress(o.askJettonWallet))
    .storeAddress(parseAddress(o.refund))
    .storeAddress(parseAddress(o.excesses||o.refund))
    .storeUint(o.deadline,64)
    .storeRef(beginCell()
      .storeCoins(o.minAsk)
      .storeAddress(parseAddress(o.receiver||o.refund))
      .storeCoins(0).storeMaybeRef(null)                              // dex custom payload: none
      .storeCoins(0).storeMaybeRef(null)                              // refund payload: none
      .storeUint(0,16).storeAddress(null)                             // referral: 0 bps, addr_none
      .endCell())
    .endCell();
}
/* pTON v2.1 ton_transfer (TON→jetton swap): value must add gas on top of amount */
function ptonTransferBody(o){
  return beginCell()
    .storeUint(0x01f3835d,32)
    .storeUint(o.queryId||0,64)
    .storeCoins(o.amount)
    .storeAddress(parseAddress(o.refund))
    .storeMaybeRef(o.forwardPayload||null)
    .endCell();
}

/* ---- bytes/base64/utf8 (browser + node) ---- */
function utf8(s){ if(typeof TextEncoder!=='undefined') return new TextEncoder().encode(s);
  return new Uint8Array(Buffer.from(s,'utf8')); }
function b64enc(u8){ if(typeof Buffer!=='undefined') return Buffer.from(u8).toString('base64');
  var bin=''; for(var i=0;i<u8.length;i++) bin+=String.fromCharCode(u8[i]); return btoa(bin); }
function b64dec(s){ if(typeof Buffer!=='undefined') return new Uint8Array(Buffer.from(s,'base64'));
  var bin=atob(s), u8=new Uint8Array(bin.length); for(var i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i); return u8; }
function hexToU8(h){ var u8=new Uint8Array(h.length/2); for(var i=0;i<u8.length;i++) u8[i]=parseInt(h.substr(i*2,2),16); return u8; }

var TONLITE={beginCell:beginCell, cellToBoc:cellToBoc, cellToBocBase64:cellToBocBase64,
  parseAddress:parseAddress, toFriendly:toFriendly,
  commentCell:commentCell, jettonTransferBody:jettonTransferBody,
  stonfiSwapBody:stonfiSwapBody, ptonTransferBody:ptonTransferBody};
if(typeof module!=='undefined'&&module.exports) module.exports=TONLITE;
if(typeof window!=='undefined') window.TONLITE=TONLITE;
})();
