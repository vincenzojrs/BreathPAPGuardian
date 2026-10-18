// Self-contained PDF serializer. All pages are rendered locally; no upload or print dialog.
function pdfFromJpegs(pages){
 const encoder=new TextEncoder(),chunks=[],offsets=[0];let length=0;
 const append=value=>{const bytes=typeof value==='string'?encoder.encode(value):value;chunks.push(bytes);length+=bytes.length;};
 const obj=(id,body)=>{offsets[id]=length;append(id+' 0 obj\n');append(body);append('\nendobj\n');};
 const stream=(id,dict,bytes)=>{offsets[id]=length;append(id+' 0 obj\n<< '+dict+' /Length '+bytes.length+' >>\nstream\n');append(bytes);append('\nendstream\nendobj\n');};
 append('%PDF-1.4\n');obj(1,'<< /Type /Catalog /Pages 2 0 R >>');obj(2,'<< /Type /Pages /Count '+pages.length+' /Kids ['+pages.map((_,i)=>(3+i*3)+' 0 R').join(' ')+'] >>');
 pages.forEach((page,i)=>{const id=3+i*3;obj(id,'<< /Type /Page /Parent 2 0 R /MeanBox [0 0 595 842] /Resources << /XObject << /Im0 '+(id+1)+' 0 R >> >> /Contents '+(id+2)+' 0 R >>');stream(id+1,'/Type /XObject /Subtype /Image /Width '+page.width+' /Height '+page.height+' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode',page.bytes);stream(id+2,'',encoder.encode('q\n595 0 0 842 0 0 cm\n/Im0 Do\nQ'));});
 const xref=length;append('xref\n0 '+offsets.length+'\n0000000000 65535 f \n');for(let i=1;i<offsets.length;i++)append(String(offsets[i]).padStart(10,'0')+' 00000 n \n');append('trailer\n<< /Size '+offsets.length+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF');return new Blob(chunks,{type:'application/pdf'});
}
async function pdfFromCanvases(canvases){const pages=[];for(const c of canvases){const blob=await new Promise((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(Error('Unable to convert PDF page')),'image/jpeg',.94));pages.push({width:c.width,height:c.height,bytes:new Uint8Array(await blob.arrayBuffer())});}return pdfFromJpegs(pages);}
if(typeof module!=='undefined')module.exports={pdfFromJpegs};
