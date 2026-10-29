// Synthetic envelopes built independently with Node/OpenSSL, not the browser decoder.
const crypto=require('node:crypto');
const oscarKey=Buffer.alloc(32);oscarKey.write('Patient access to their own data');
const decipher=crypto.createDecipheriv('aes-256-ecb',oscarKey,null);decipher.setAutoPadding(false);
const common=Buffer.concat([decipher.update(Buffer.from('75b3a2124a65af9754d8c1f3e52eb6f0232057697e380ec94adc4645b6925a98','hex')),decipher.final()]);
function encrypt(key,iv,plain){const c=crypto.createCipheriv('aes-256-gcm',key,iv);return [Buffer.concat([c.update(plain),c.final()]),c.getAuthTag()];}
function envelope(plain,seed=1){
 const salt=Buffer.alloc(16,seed),iv=Buffer.alloc(12,seed+1),payloadKey=Buffer.alloc(32,seed+2);
 const wrap=crypto.pbkdf2Sync(common,salt,10000,32,'sha256'),[exportKey,exportTag]=encrypt(wrap,iv,payloadKey),[payload,tag]=encrypt(payloadKey,iv,Buffer.from(plain));
 const word=n=>{const b=Buffer.alloc(2);b.writeUInt16LE(n);return b;};const field=b=>Buffer.concat([word(b.length),b]);
 const header=Buffer.concat([word(13),word(1),word(1),field(Buffer.from('00000000-0000-0000-0000-000000000000')),field(iv),field(salt),word(0),word(1),field(Buffer.alloc(32)),field(Buffer.alloc(16)),field(exportKey),field(exportTag),field(tag)]);
 if(header.length!==202)throw Error('Bad fixture');return Buffer.concat([header,payload]);
}
module.exports={envelope};
