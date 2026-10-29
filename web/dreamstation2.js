// SPDX-License-Identifier: GPL-3.0-only
// Adapted from OSCAR PRDS2File and SleepLib/crypto.cpp, revision
// d16e40388d7b4dcbfc97afef85df43c520a03ccb.
// Copyright (c) 2021-2024 The OSCAR Team. See THIRD_PARTY_NOTICES.md.
(function(root){
'use strict';
// OSCAR's published COMMON_KEY decrypted using its published OSCAR_KEY (AES-256 ECB).
// This is a format constant, not a user password. Fixtures independently derive it.
const COMMON='71849644a728112b015b6203cfb5c56951db5f18e3f49436fa4a0beb75658742';
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const join=(a,b)=>{const out=new Uint8Array(a.length+b.length);out.set(a);out.set(b,a.length);return out;};
function header(buffer){
 const b=new Uint8Array(buffer.buffer||buffer,buffer.byteOffset||0,buffer.byteLength),view=new DataView(b.buffer,b.byteOffset,b.byteLength);let p=0;
 const word=()=>{if(p+2>b.length)throw Error('Truncated DreamStation 2 header');const n=view.getUint16(p,true);p+=2;return n;};
 const field=size=>{const n=word();if(n!==size||p+n>b.length)throw Error('Invalid DreamStation 2 header field');const v=b.slice(p,p+n);p+=n;return v;};
 if(word()!==13||word()!==1||word()!==1)throw Error('Unsupported DreamStation 2 encryption header');
 const guid=field(36),iv=field(12),salt=field(16);
 if(word()!==0||word()!==1)throw Error('Unsupported DreamStation 2 key envelope');
 field(32);field(16); // Device import key; export key below grants patient access.
 const exportKey=field(32),exportTag=field(16),payloadTag=field(16);
 if(p!==202||p>=b.length)throw Error('Truncated DreamStation 2 payload');
 return {guid,iv,salt,exportKey,exportTag,payloadTag,payload:b.subarray(p)};
}
function createDecoder(){
 const cache=new Map();
 async function decrypt(buffer){
  const subtle=globalThis.crypto?.subtle;if(!subtle)throw Error('DreamStation 2 requires Web Crypto. Open the app on localhost in a modern browser.');
  const h=header(buffer),id=hex(join(join(h.iv,h.salt),join(h.exportKey,h.exportTag)));
  let key=cache.get(id);
  if(!key){
   key=(async()=>{
    const common=Uint8Array.from(COMMON.match(/../g),x=>parseInt(x,16));
    const password=await subtle.importKey('raw',common,'PBKDF2',false,['deriveKey']);
    const wrapping=await subtle.deriveKey({name:'PBKDF2',salt:h.salt,iterations:10000,hash:'SHA-256'},password,{name:'AES-GCM',length:256},false,['decrypt']);
    let raw;try{raw=await subtle.decrypt({name:'AES-GCM',iv:h.iv,tagLength:128},wrapping,join(h.exportKey,h.exportTag));}catch{throw Error('DreamStation 2 export-key authentication failed');}
    if(raw.byteLength!==32)throw Error('Invalid DreamStation 2 payload key');
    return subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);
   })();cache.set(id,key);if(cache.size>128)cache.delete(cache.keys().next().value);
  }
  let payload;
  try{payload=await subtle.decrypt({name:'AES-GCM',iv:h.iv,tagLength:128},await key,join(h.payload,h.payloadTag));}
  catch(e){if(e.message?.includes('export-key'))throw e;throw Error('DreamStation 2 payload authentication failed (damaged or incomplete file)');}
  return payload;
 }
 return {decrypt};
}
const api={header,createDecoder};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.DreamStation2=api;
})(globalThis);
