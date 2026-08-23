/** Minimal deterministic ZIP writer using the STORE method (no temp files). */
export function createZip(entries: Array<{ name:string; data:Buffer }>): Buffer {
  const files=entries.map(entry=>({name:safeName(entry.name),data:entry.data,crc:crc32(entry.data)}));
  const local:Buffer[]=[];const central:Buffer[]=[];let offset=0;
  for(const file of files){
    const name=Buffer.from(file.name,'utf8');
    const header=Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x0800,6);header.writeUInt16LE(0,8);
    header.writeUInt16LE(0,10);header.writeUInt16LE(0,12);header.writeUInt32LE(file.crc,14);header.writeUInt32LE(file.data.length,18);header.writeUInt32LE(file.data.length,22);header.writeUInt16LE(name.length,26);
    local.push(header,name,file.data);
    const record=Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50,0);record.writeUInt16LE(20,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x0800,8);record.writeUInt16LE(0,10);
    record.writeUInt16LE(0,12);record.writeUInt16LE(0,14);record.writeUInt32LE(file.crc,16);record.writeUInt32LE(file.data.length,20);record.writeUInt32LE(file.data.length,24);record.writeUInt16LE(name.length,28);record.writeUInt32LE(offset,42);
    central.push(record,name);offset+=header.length+name.length+file.data.length;
  }
  const centralSize=central.reduce((sum,value)=>sum+value.length,0);
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(centralSize,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,...central,end]);
}

function safeName(value:string):string {
  const normalized=value.replace(/\\/g,'/').replace(/^\/+/, '');
  if(!normalized||normalized.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('invalid zip entry name');
  return normalized;
}
function crc32(data:Buffer):number {
  let crc=0xffffffff;
  for(const byte of data){crc^=byte;for(let bit=0;bit<8;bit+=1)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return (crc^0xffffffff)>>>0;
}
