import {test} from 'node:test';
import assert from 'node:assert/strict';
import Bridge from '../src/main';
import {TFile} from './obsidian-stub';
import {DEFAULT_SETTINGS,Paper} from '../src/types';
import {planUpdate} from '../src/managed';
const paper:Paper={library:{type:'user',id:1,name:'Personal'},item:{key:'ABCDEFGH',data:{itemType:'journalArticle',title:'Paper'}}};
function fakeBridge(initial:string|null){
 const files=new Map<string,string|ArrayBuffer>();if(initial!==null)files.set('physics/paper.md',initial);
 let race=false;
 const b=new Bridge({} as any,{} as any);
 b.settings={...DEFAULT_SETTINGS,mappings:{},paperCache:[]};
 b.app={vault:{
  getAbstractFileByPath:(p:string)=>files.has(p)?new TFile(p):null,
  getAllLoadedFiles:()=>[...files.keys()].map(p=>new TFile(p)),
  read:async(f:TFile)=>files.get(f.path),
  process:async(f:TFile,fn:(s:string)=>string)=>{const next=fn(race?'concurrent personal edit':files.get(f.path) as string);files.set(f.path,next);},
  create:async(p:string,s:string)=>{if(files.has(p))throw new Error('exists');files.set(p,s);},
  adapter:{exists:async(p:string)=>files.has(p),mkdir:async()=>{},write:async(p:string,s:string)=>files.set(p,s),readBinary:async(p:string)=>files.get(p),writeBinary:async(p:string,s:ArrayBuffer)=>files.set(p,s)}
 }} as any;
 return {b,files,race:()=>race=true};
}
function change(original:string|null){return {paper,path:'physics/paper.md',original,next:planUpdate(original,paper,'Current generated content').text,assets:[],changed:true,imageChanges:0};}
test('commit creates backup before updating the pilot note and retains all original writing',async()=>{
 const original='Handwritten legacy text\r\n';const {b,files}=fakeBridge(original);
 await b.apply([change(original)]);
 assert.ok((files.get('physics/paper.md') as string).startsWith(original));
 const backups=[...files.entries()].filter(([p])=>p.includes('/backups/')&&p.endsWith('/notes/physics/paper.md'));
 assert.equal(backups.length,1);assert.equal(backups[0][1],original);
 assert.equal(b.settings.mappings['user:1:ABCDEFGH'],'physics/paper.md');
});
test('post-preview personal edits block all writes for that note',async()=>{
 const {b,files}=fakeBridge('Changed by user');await b.apply([change('Original')]);
 assert.equal(files.get('physics/paper.md'),'Changed by user');assert.equal(files.size,1);
 assert.deepEqual(b.settings.mappings,{});
});
test('concurrent editor change during public Vault.process is rejected',async()=>{
 const {b,files,race}=fakeBridge('Original');race();await b.apply([change('Original')]);
 assert.equal(files.get('physics/paper.md'),'Original');assert.deepEqual(b.settings.mappings,{});
});
test('new file arriving after preview is never overwritten',async()=>{
 const {b,files}=fakeBridge('Someone else created this');await b.apply([change(null)]);
 assert.equal(files.get('physics/paper.md'),'Someone else created this');assert.equal(files.size,1);
});
test('unchanged previews create neither backups nor writes',async()=>{
 const {b,files}=fakeBridge('Original');await b.apply([{...change('Original'),changed:false}]);
 assert.equal(files.size,1);assert.equal(files.get('physics/paper.md'),'Original');
});
test('invalid prior PNG is reported as a conflict rather than a recovered image',async()=>{
 const {b,files}=fakeBridge(null);files.set('bad.png',new Uint8Array([0,1,2]).buffer);
 await assert.rejects(()=>b.validVaultImage('bad.png'),/valid PNG/);
 assert.equal(await b.validVaultImage('missing.png'),false);
});
test('stale mapping never appends Zotero content to an unmarked replacement note',async()=>{
 const {b,files}=fakeBridge('Unrelated personal note');b.settings.mappings={'user:1:ABCDEFGH':'physics/paper.md'};
 const result=await b.prepare([paper]);
 assert.match(result[0].error||'',/lost its managed markers/);
 assert.equal(files.get('physics/paper.md'),'Unrelated personal note');
});
test('server identity mismatch discards the cache instead of offering stale paper names',async()=>{
 const {b}=fakeBridge(null);b.settings.paperCache=[paper];b.settings.serverId='old';
 b.client.root=async()=>{throw new Error('Zotero server changed. Reconnect.');};
 await assert.rejects(()=>b.index(true),/server changed/);
 assert.deepEqual(b.settings.paperCache,[]);assert.equal(b.settings.serverId,'');
});
test('offline paper links may use the existing same-instance metadata cache',async()=>{
 const {b}=fakeBridge(null);b.settings.paperCache=[paper];b.settings.serverId='known';
 b.client.root=async()=>{throw new Error('Cannot reach Zotero. Open Zotero.');};
 assert.deepEqual(await b.index(true),[paper]);
});
