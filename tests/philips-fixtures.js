// Synthetic data only: no patient identifiers or recordings.
const start=Date.UTC(2024,0,1,22)/1000;
function crc(bytes){let c=0xffffffff;for(const b of bytes)for(const v of [0,0,0,b]){c^=v<<24;for(let i=0;i<8;i++)c=c&0x80000000?(c<<1)^0x04c11db7:c<<1;}return c>>>0;}
function chunk(ext,records=[],opts={}){
 const data=ext===5?Buffer.from(opts.samples||[-128,-1,0,1,127,5,6,7,8,9]):Buffer.from(records.flatMap(([code,values])=>[code,...values]));
 const sizes=[...new Map(records.map(([code,values])=>[code,values.length]))];
 const header=Buffer.alloc(ext===5?25:17+sizes.length*2);header[0]=3;header.writeUInt16LE(header.length+data.length+4,1);header[3]=ext===5?1:0;header[5]=6;header[6]=ext;header.writeUInt32LE(opts.id??42,7);header.writeUInt32LE(opts.start??start,11);
 if(ext===5){header.writeUInt16LE(data.length/5,15);header[17]=1;header[18]=1;header[20]=5;header[22]=8;}
 else{header[15]=sizes.length;sizes.forEach(([code,size],i)=>{header[16+2*i]=code;header[17+2*i]=size;});}
 header[header.length-1]=header.subarray(0,-1).reduce((a,b)=>(a+b)&255,0);
 const tail=Buffer.alloc(4);tail.writeUInt32LE(crc(data));return Buffer.concat([header,data,tail]);
}
const le=n=>[n&255,n>>>8];
function summary(opts={}){return chunk(1,[[0,[1]],[1,[0,1,0,10,1,90,44,1,20,45,1,40,46,1,144,48,1,2]],[3,[...le(opts.on??10),0,0]],[4,le(opts.use??120)],[2,[...le(5),0,0,0,0,0,0,0]]],opts);}
function eventFile(opts={}){return chunk(2,[[1,[0,0,90]],[6,[30,0,7]],[7,[20,0,5]],[20,[10,0,3]],[15,[20,0,4,0,2]],[17,[40,0,25,3,80]]],opts);}
const props='CF=4\nSN=SYNTHETIC-DEVICE\nMN=500X150\nDFV=3\nF=0\nFV=6\nSV=TEST\n';
function file(name,data,path=name){const f=new Blob([data]);f.name=name;f._path=path;return f;}
module.exports={chunk,summary,eventFile,start,le,props,file};
