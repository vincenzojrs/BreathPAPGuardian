// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
importScripts('vendor/glasgow-reference.js','glasgow.js');
self.onmessage=event=>{
 try{self.postMessage({result:Glasgow.analyzeChannel(event.data.channel)});}
 catch(error){self.postMessage({error:error.message});}
};
