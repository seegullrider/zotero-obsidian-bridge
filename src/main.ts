import {App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, normalizePath} from 'obsidian';
import {ZoteroClient} from './api';
import {resolveAssets} from './assets';
import {parseManaged, planUpdate} from './managed';
import {htmlToMarkdown, paperLink, renderManaged} from './render';
import {Asset, Collection, DEFAULT_SETTINGS, identity, identityKey, Identity, Paper, Settings} from './types';
import {checksum, identityLabel, movedMappings, notePath, paperLabel, safeFolder, stripReferenceNumber} from './workflow';

type Change = {paper:Paper; path:string; original:string|null; next:string; assets:Asset[]; changed:boolean; imageChanges:number; error?:string};

export default class ZoteroBridge extends Plugin {
  settings:Settings={...DEFAULT_SETTINGS};
  client=new ZoteroClient();
  private busy=false;
  private duplicateMappings=new Set<string>();
  async onload() {
    const stored=await this.loadData();
    this.settings={...DEFAULT_SETTINGS,...stored,mappings:{...(stored?.mappings||{})},paperCache:stored?.paperCache||[]};
    this.addSettingTab(new BridgeSettings(this.app,this));
    this.addCommand({id:'import-papers',name:'Import papers',callback:()=>void this.guard(()=>this.importPapers())});
    this.addCommand({id:'refresh-current-paper',name:'Refresh current paper',callback:()=>void this.guard(()=>this.refresh(false))});
    this.addCommand({id:'refresh-connected-papers',name:'Refresh connected papers',callback:()=>void this.guard(()=>this.refresh(true))});
    this.addCommand({id:'insert-paper-link',name:'Insert paper link',editorCallback:(editor)=>void this.guard(()=>this.insert(editor,false))});
    this.addCommand({id:'insert-ieee-reference',name:'Insert IEEE reference',editorCallback:(editor)=>void this.guard(()=>this.insert(editor,true))});
    this.addCommand({id:'audit-connections',name:'Audit connections',callback:()=>void this.guard(()=>this.audit())});
    this.app.workspace.onLayoutReady(()=>void this.guard(()=>this.rebuildMappings()));
    this.registerEvent(this.app.vault.on('rename',(file,oldPath)=>{
      if(file instanceof TFile||file instanceof TFolder){
        const next=movedMappings(this.settings.mappings,oldPath,file.path);
        if(JSON.stringify(next)!==JSON.stringify(this.settings.mappings)){this.settings.mappings=next;void this.saveData(this.settings);}
      }
    }));
  }
  async guard(fn:()=>Promise<void>) {
    if(this.busy){new Notice('Zotero Bridge is already working.');return;}
    this.busy=true;
    try{await fn();}catch(e){new Notice(`Zotero Bridge: ${message(e)}`,12000);console.error('Zotero Bridge',e);}
    finally{this.busy=false;}
  }
  async rebuildMappings() {
    const found:Record<string,string>={}; this.duplicateMappings.clear();
    for(const file of this.app.vault.getMarkdownFiles()){
      const text=await this.app.vault.cachedRead(file);
      if(!text.includes('zotero-bridge:start'))continue;
      try{
        let value:Identity|null=null;
        try{value=parseManaged(text)?.identity||null;}catch{value=conflictedIdentity(text);}
        if(!value)continue;
        const key=identityKey(value);
        if(found[key]&&found[key]!==file.path)this.duplicateMappings.add(key);
        else found[key]=file.path;
      }catch{/* Conflicted blocks remain connected by the previous mapping and are audited. */}
    }
    const next={...this.settings.mappings,...found};
    for(const key of this.duplicateMappings)delete next[key];
    if(JSON.stringify(next)!==JSON.stringify(this.settings.mappings)){this.settings.mappings=next;await this.saveData(this.settings);}
  }
  async index(allowCached=false):Promise<Paper[]> {
    try{
      const root=await this.client.root();
      if(this.settings.serverId&&root.serverId!==this.settings.serverId){this.settings.paperCache=[];new Notice('Zotero database instance changed; rebuilding the paper index.');}
      const libraries=await this.client.libraries();
      const papers:Paper[]=[];
      for(const library of libraries)papers.push(...await this.client.papers(library));
      this.settings.paperCache=papers;this.settings.serverId=root.serverId;
      await this.saveData(this.settings);return papers;
    }catch(e){
      if(/server changed|omitted its identity/i.test(message(e))){this.settings.paperCache=[];this.settings.serverId='';await this.saveData(this.settings);}
      if(allowCached&&this.settings.paperCache.length&&/^(Cannot reach Zotero|Zotero request timed out|Zotero local API is disabled)/.test(message(e))){new Notice('Zotero unavailable. Showing cached paper names; imports and reference formatting still require Zotero.');return this.settings.paperCache;}
      throw e;
    }
  }
  mappedPath(paper:Paper):string|undefined {
    const key=identityLabel(paper);
    if(this.duplicateMappings.has(key))throw new Error(`More than one note is connected to ${paperLabel(paper)}; resolve it in Audit connections.`);
    const path=this.settings.mappings[key];
    if(path&&this.app.vault.getAbstractFileByPath(path) instanceof TFile)return path;
    return undefined;
  }
  async validVaultImage(path:string):Promise<boolean> {
    if(!await this.app.vault.adapter.exists(path))return false;
    const bytes=new Uint8Array(await this.app.vault.adapter.readBinary(path));
    const magic=[137,80,78,71,13,10,26,10];
    if(bytes.length<8||magic.some((n,i)=>bytes[i]!==n))throw new Error(`Imported image is not a valid PNG: ${path}`);
    return true;
  }
  async importPapers() {
    await this.rebuildMappings();
    const papers=await this.index();
    new PaperPicker(this.app,this,papers,true,async chosen=>{
      await this.guard(async()=>this.preview(await this.prepare(chosen)));
    }).open();
  }
  async refresh(all:boolean) {
    await this.rebuildMappings();
    const papers=await this.index();
    let chosen:Paper[];
    const warnings:string[]=[];
    if(all){
      const ids=new Set(Object.keys(this.settings.mappings));
      chosen=papers.filter(p=>ids.has(identityLabel(p)));
      const present=new Set(papers.map(identityLabel));
      for(const [id,path] of Object.entries(this.settings.mappings))if(!present.has(id))warnings.push(`${path}: paper is missing or trashed in Zotero; note preserved.`);
      for(const id of this.duplicateMappings)warnings.push(`${id}: multiple connected notes; skipped.`);
    }else{
      const file=this.app.workspace.getActiveFile();
      if(!file)throw new Error('Open a connected literature note first.');
      const block=parseManaged(await this.app.vault.read(file));
      if(!block)throw new Error('This note has no Zotero Bridge connection. Use Import papers first.');
      chosen=papers.filter(p=>identityLabel(p)===identityKey(block.identity));
      if(!chosen.length)throw new Error('Paper is missing or trashed in Zotero; this note was preserved.');
    }
    this.preview(await this.prepare(chosen),warnings);
  }
  async prepare(papers:Paper[]):Promise<Change[]> {
    const notice=new Notice('Preparing Zotero changes…',0);
    const changes:Change[]=[];
    const occupied=new Set(this.app.vault.getAllLoadedFiles().map(f=>f.path.toLocaleLowerCase()));
    try{
      for(let i=0;i<papers.length;i++){
        const paper=papers[i];notice.setMessage(`Preparing paper ${i+1}/${papers.length}: ${paperLabel(paper)}`);
        let path='';
        try{
          path=this.mappedPath(paper)||notePath(paper,this.settings.noteFolder,p=>occupied.has(p.toLocaleLowerCase()));occupied.add(path.toLocaleLowerCase());
          const file=this.app.vault.getAbstractFileByPath(path);
          if(file&&!(file instanceof TFile))throw new Error('Note path points to a folder.');
          const original=file instanceof TFile?await this.app.vault.read(file):null;
          if(original!==null){const block=parseManaged(original);if(!block)throw new Error('Connected note has lost its managed markers; audit the connection before importing.');if(identityKey(block.identity)!==identityLabel(paper))throw new Error('Note is connected to another paper.');}
          const bundle=await this.client.bundle(paper);
          const assets=await resolveAssets(bundle,this.settings,p=>this.validVaultImage(p));
          const update=planUpdate(original,paper,renderManaged(bundle,assets));
          let imageChanges=0;
          for(const asset of assets)if(asset.bytes){
            if(!await this.app.vault.adapter.exists(asset.path))imageChanges++;
            else if(checksum(new Uint8Array(await this.app.vault.adapter.readBinary(asset.path)))!==checksum(asset.bytes))imageChanges++;
          }
          changes.push({paper,path,original,next:update.text,assets,changed:update.changed||imageChanges>0,imageChanges});
        }catch(e){changes.push({paper,path,original:null,next:'',assets:[],changed:false,imageChanges:0,error:message(e)});}
      }
    }finally{notice.hide();}
    return changes;
  }
  preview(changes:Change[],warnings:string[]=[]) {
    new ChangesModal(this.app,changes,warnings,async()=>{
      await this.guard(()=>this.apply(changes));
    }).open();
  }
  async ensureFolder(path:string) {
    const parts=normalizePath(path).split('/');let cursor='';
    for(const part of parts){
      cursor=cursor?`${cursor}/${part}`:part;
      if(!await this.app.vault.adapter.exists(cursor))await this.app.vault.adapter.mkdir(cursor);
    }
  }
  async apply(changes:Change[]) {
    const checkpoint=new Date().toISOString().replace(/[:.]/g,'-');
    const backupRoot=`${this.manifest.dir}/backups/${checkpoint}`;
    let updated=0,unchanged=0;const issues:string[]=[];
    for(const change of changes){
      if(change.error){issues.push(`${paperLabel(change.paper)}: ${change.error}`);continue;}
      if(!change.changed){unchanged++;continue;}
      try{
        const existing=this.app.vault.getAbstractFileByPath(change.path);
        if(change.original===null&&existing)throw new Error('A note was created at this path after preview; skipped.');
        if(change.original!==null&&(!(existing instanceof TFile)||(await this.app.vault.read(existing))!==change.original))throw new Error('Note changed after preview; skipped.');
        if(change.original!==null){
          const backup=`${backupRoot}/notes/${change.path}`;await this.ensureFolder(backup.substring(0,backup.lastIndexOf('/')));await this.app.vault.adapter.write(backup,change.original);
        }
        for(const asset of change.assets){
          if(asset.status==='missing')continue;
          if(!asset.bytes)continue;
          const bytes=new Uint8Array(asset.bytes).buffer;
          const exists=await this.app.vault.adapter.exists(asset.path);
          if(exists){
            const old=await this.app.vault.adapter.readBinary(asset.path);
            if(checksum(new Uint8Array(old))===checksum(asset.bytes))continue;
            const backup=`${backupRoot}/assets/${asset.path}`;await this.ensureFolder(backup.substring(0,backup.lastIndexOf('/')));await this.app.vault.adapter.writeBinary(backup,old);
          }
          await this.ensureFolder(asset.path.substring(0,asset.path.lastIndexOf('/')));
          await this.app.vault.adapter.writeBinary(asset.path,bytes);
        }
        if(change.next!==change.original){
          if(existing instanceof TFile){
            await this.app.vault.process(existing,current=>{
              if(current!==change.original)throw new Error('Note changed during update; skipped.');
              return change.next;
            });
          }else{
            await this.ensureFolder(change.path.substring(0,change.path.lastIndexOf('/')));
            await this.app.vault.create(change.path,change.next);
          }
        }
        this.settings.mappings[identityLabel(change.paper)]=change.path;updated++;
      }catch(e){issues.push(`${change.path}: ${message(e)}`);}
    }
    await this.saveData(this.settings);
    const missing=changes.flatMap(c=>c.assets.filter(a=>a.status==='missing').map(a=>`${paperLabel(c.paper)} / ${a.annotationKey}: ${a.reason||'image unavailable'}`));
    new ReportModal(this.app,'Import / refresh result',[`${updated} notes updated; ${unchanged} unchanged.`,...issues,...missing,updated?`Backups: ${backupRoot}`:'']).open();
  }
  async insert(editor:Editor,reference:boolean) {
    await this.rebuildMappings();const papers=await this.index(!reference);
    new PaperPicker(this.app,this,papers,false,async chosen=>{
      const paper=chosen[0];if(!paper)return;
      await this.guard(async()=>{
        const text=reference?stripReferenceNumber(htmlToMarkdown(await this.client.reference(paper))):paperLink(paper,this.mappedPath(paper));
        const active=this.app.workspace.getActiveViewOfType(MarkdownView);
        if(!active||active.editor!==editor)throw new Error('The target editor changed. Run the insertion command again.');
        editor.replaceSelection(text);
      });
    }).open();
  }
  async audit() {
    await this.rebuildMappings();const papers=await this.index();
    const present=new Map(papers.map(p=>[identityLabel(p),p]));
    const issues:string[]=[];
    const libraries=Array.from(new Map(papers.map(p=>[`${p.library.type}:${p.library.id}`,p.library])).values());
    const personal=libraries.find(l=>l.type==='user');
    const checked=new Map<string,Promise<import('./types').ZoteroItem|null>>();
    const lookup=(library:Paper['library'],key:string)=>{
      const id=`${library.type}:${library.id}:${key}`;
      if(!checked.has(id))checked.set(id,this.client.lookup(library,key));
      return checked.get(id)!;
    };
    for(const [key,path] of Object.entries(this.settings.mappings)){
      const file=this.app.vault.getAbstractFileByPath(path);
      if(!(file instanceof TFile)){issues.push(`${path}: connected note missing.`);continue;}
      if(!present.has(key))issues.push(`${path}: paper missing or trashed; note preserved.`);
      try{const block=parseManaged(await this.app.vault.read(file));if(!block)issues.push(`${path}: managed section missing.`);else if(identityKey(block.identity)!==key)issues.push(`${path}: identity does not match connection.`);}catch(e){issues.push(`${path}: ${message(e)}`);}
    }
    for(const key of this.duplicateMappings)issues.push(`${key}: multiple notes share this connection.`);
    for(const file of this.app.vault.getMarkdownFiles()){
      const text=await this.app.vault.cachedRead(file);
      if(text.includes('zotero-bridge:start')){try{parseManaged(text);}catch(e){issues.push(`${file.path}: ${message(e)}`);}}
      if(/zotero:\/\/[^\s)]*[?&]page=(?:&|\))/.test(text))issues.push(`${file.path}: legacy PDF link has an empty page value.`);
      if(/file:\/\/\/(?:D|E|F):[^\s)]*zoterostorage/i.test(text))issues.push(`${file.path}: legacy file link uses an old Zotero storage drive; original passage preserved.`);
      for(const match of text.matchAll(/zotero:\/\/(?:select|open-pdf)\/(library|groups\/(\d+))\/items\/([A-Z0-9]{8})(\?[^\s)]*)?/g)){
        const library=match[1]==='library'?personal:libraries.find(l=>l.type==='group'&&l.id===Number(match[2]));
        if(!library){issues.push(`${file.path}: referenced Zotero library is unavailable.`);continue;}
        try{
          if(!await lookup(library,match[3]))issues.push(`${file.path}: Zotero item ${match[3]} is missing.`);
          const annotation=new URLSearchParams(match[4]?.slice(1)||'').get('annotation');
          if(annotation&&/^[A-Z0-9]{8}$/.test(annotation)){
            const item=await lookup(library,annotation);
            if(!item)issues.push(`${file.path}: legacy annotation ${annotation} is missing; original passage preserved.`);
            else if(item.data.parentItem!==match[3])issues.push(`${file.path}: annotation ${annotation} links to the wrong attachment.`);
          }
        }catch(e){issues.push(`${file.path}: source-link check incomplete: ${message(e)}`);}
      }
      for(const match of text.matchAll(/\[\[(@[^\]|#]+)(?:\|[^\]]*)?\]\]/g))if(!this.app.metadataCache.getFirstLinkpathDest(match[1],file.path))issues.push(`${file.path}: unresolved legacy literature link ${match[1]}.`);
    }
    for(const paper of papers){
      const path=this.settings.mappings[identityLabel(paper)];if(!path)continue;
      try{
        const assets=await resolveAssets(await this.client.bundle(paper),this.settings,p=>this.validVaultImage(p));
        for(const asset of assets)if(asset.status==='missing')issues.push(`${path}: image ${asset.annotationKey} unavailable.`);
      }catch(e){issues.push(`${path}: attachment check incomplete: ${message(e)}`);}
    }
    const doiGroups=new Map<string,Paper[]>();
    const titleGroups=new Map<string,Paper[]>();
    for(const paper of papers){const doi=paper.item.data.DOI?.trim().toLowerCase();if(doi){const group=doiGroups.get(doi)||[];group.push(paper);doiGroups.set(doi,group);}}
    for(const paper of papers){const title=paper.item.data.title?.normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ');if(title){const group=titleGroups.get(title)||[];group.push(paper);titleGroups.set(title,group);}}
    for(const [doi,group] of doiGroups)if(group.length>1)issues.push(`Duplicate DOI ${doi}: ${group.map(p=>`${p.library.name}/${p.item.key}`).join(', ')}. No merge performed.`);
    for(const [title,group] of titleGroups)if(group.length>1)issues.push(`Ambiguous title ${title}: ${group.map(p=>`${p.library.name}/${p.item.key}`).join(', ')}. No automatic match performed.`);
    new ReportModal(this.app,'Connection audit',[`${papers.length} papers indexed; ${Object.keys(this.settings.mappings).length} connected notes.`,...new Set(issues),...(!issues.length?['No connection problems found.']:[])]).open();
  }
}

function message(error:unknown):string {return error instanceof Error?error.message:String(error);}
// Recover connection identity even when content has been edited. This is used only
// to keep conflicted notes connected; planUpdate still refuses to overwrite them.
function conflictedIdentity(text:string):Identity|null {
  const matches=[...text.matchAll(/<!-- zotero-bridge:start (\{[^\n]*\}) -->/g)];
  if(matches.length!==1)return null;
  try{
    const header=JSON.parse(matches[0][1]);const id=header.identity;
    return header.version===1&&(id?.type==='user'||id?.type==='group')&&Number.isSafeInteger(id.id)&&id.id>=0&&/^[A-Z0-9]{8}$/.test(id.key)?id:null;
  }catch{return null;}
}
function details(p:Paper):string {
  const authors=(p.item.data.creators||[]).map(c=>c.name||[c.firstName,c.lastName].filter(Boolean).join(' ')).join(', ');
  return [p.library.name,p.item.data.citationKey,p.item.data.date,authors].filter(Boolean).join(' · ');
}

class PaperPicker extends Modal {
  private selected=new Set<string>();private query='';private filter='';private collectionIds:Set<string>|null=null;
  private list!:HTMLElement; private action!:HTMLButtonElement;private collectionRequest=0;
  constructor(app:App,private bridge:ZoteroBridge,private papers:Paper[],private multi:boolean,private choose:(papers:Paper[])=>Promise<void>){super(app);}
  onOpen() {
    this.titleEl.setText(this.multi?'Import papers':'Choose a paper');
    new Setting(this.contentEl).setName('Search papers').addText(t=>t.setPlaceholder('Title, authors, year, citation key…').onChange(v=>{this.query=v.toLocaleLowerCase();this.render();}));
    new Setting(this.contentEl).setName('Collection').addDropdown(d=>{
      d.addOption('','All papers');
      void (async()=>{
        try{
          const libraries=Array.from(new Map(this.papers.map(p=>[`${p.library.type}:${p.library.id}`,p.library])).values());
          const lookup=new Map<string,{library:Paper['library'];key:string}>();
          for(const library of libraries)for(const col of await this.bridge.client.collections(library)){
            const id=`${library.type}:${library.id}:${col.key}`;lookup.set(id,{library,key:col.key});d.addOption(id,`${library.name} / ${col.data.name}`);
          }
          d.onChange(v=>{
            const token=++this.collectionRequest;this.filter=v;this.collectionIds=null;
            if(!v){this.render();return;}
            this.list.setText('Loading collection…');
            const chosen=lookup.get(v);if(!chosen)return;
            void this.bridge.client.collectionPapers(chosen.library,chosen.key).then(items=>{
              if(token!==this.collectionRequest)return;this.collectionIds=new Set(items.map(identityLabel));this.render();
            }).catch(e=>{if(token===this.collectionRequest){this.list.setText(`Collection unavailable: ${message(e)}`);}});
          });
        }catch(e){new Notice(`Collections unavailable: ${message(e)}`);}
      })();
    });
    this.list=this.contentEl.createDiv({cls:'zotero-bridge-list'});
    const actions=this.contentEl.createDiv({cls:'zotero-bridge-actions'});
    if(this.multi){
      const select=actions.createEl('button',{text:'Select visible papers'});select.onclick=()=>{for(const p of this.visible())this.selected.add(identityLabel(p));this.render();};
      const clear=actions.createEl('button',{text:'Clear selection'});clear.onclick=()=>{this.selected.clear();this.render();};
    }
    this.action=actions.createEl('button',{text:this.multi?'Preview import':'Insert',cls:'mod-cta'});
    this.action.onclick=()=>{const chosen=this.papers.filter(p=>this.selected.has(identityLabel(p)));if(chosen.length){this.close();void this.choose(chosen);}};
    const cancel=actions.createEl('button',{text:'Cancel'});cancel.onclick=()=>this.close();this.render();
  }
  private visible():Paper[] {
    if(this.filter&&!this.collectionIds)return [];
    const words=this.query.split(/\s+/).filter(Boolean);
    return this.papers.filter(p=>(!this.collectionIds||this.collectionIds.has(identityLabel(p)))&&words.every(q=>`${paperLabel(p)} ${details(p)}`.toLocaleLowerCase().includes(q)));
  }
  private render(){
    this.list.empty();const visible=this.visible();
    if(!visible.length)this.list.createEl('p',{text:'No matching papers.'});
    for(const paper of visible){
      const row=this.list.createEl('label',{cls:'zotero-bridge-row'});
      const input=row.createEl('input',{type:this.multi?'checkbox':'radio'});input.name='zotero-paper';input.checked=this.selected.has(identityLabel(paper));
      input.onchange=()=>{if(!this.multi)this.selected.clear();if(input.checked)this.selected.add(identityLabel(paper));else this.selected.delete(identityLabel(paper));this.action.disabled=!this.selected.size;if(this.multi)this.action.setText(`Preview import (${this.selected.size})`);};
      const desc=row.createDiv();desc.createDiv({text:paperLabel(paper)});desc.createDiv({text:details(paper),cls:'zotero-bridge-detail'});
    }
    this.action.disabled=!this.selected.size;if(this.multi)this.action.setText(`Preview import (${this.selected.size})`);
  }
  onClose(){this.collectionRequest++;this.contentEl.empty();}
}

class ChangesModal extends Modal {
  constructor(app:App,private changes:Change[],private warnings:string[],private apply:()=>Promise<void>){super(app);}
  onOpen(){
    this.titleEl.setText('Review Zotero changes');
    const changed=this.changes.filter(c=>c.changed&&!c.error);
    this.contentEl.createEl('p',{text:`${changed.length} notes to update; ${this.changes.filter(c=>!c.changed&&!c.error).length} unchanged; ${this.changes.filter(c=>c.error).length} skipped.`});
    this.contentEl.createEl('p',{text:'Only Current Zotero data is refreshed. Your other writing is preserved.'});
    const list=this.contentEl.createDiv({cls:'zotero-bridge-list'});
    for(const warning of this.warnings)list.createEl('p',{text:warning});
    for(const change of this.changes){
      const detail=list.createEl('details');detail.createEl('summary',{text:`${change.error?'Skipped':change.changed?(change.original===null?'Create':'Update'):'Unchanged'}: ${change.path||paperLabel(change.paper)}`});
      if(change.error){detail.createEl('p',{text:change.error});continue;}
      const missing=change.assets.filter(a=>a.status==='missing');
      detail.createEl('p',{text:`${change.imageChanges} images to copy; ${missing.length} unavailable images.`});
      if(change.changed){
        try{const block=parseManaged(change.next);detail.createEl('pre',{text:block?.content||change.next,cls:'zotero-bridge-preview'});}catch{detail.createEl('p',{text:'Preview could not be validated; do not apply.'});}
      }
    }
    const actions=this.contentEl.createDiv({cls:'zotero-bridge-actions'});
    const apply=actions.createEl('button',{text:'Apply reviewed changes',cls:'mod-cta'});apply.disabled=!changed.length;apply.onclick=()=>{this.close();void this.apply();};
    const cancel=actions.createEl('button',{text:'Cancel'});cancel.onclick=()=>this.close();
  }
  onClose(){this.contentEl.empty();}
}

class ReportModal extends Modal {
  constructor(app:App,private title:string,private lines:string[]){super(app);}
  onOpen(){this.titleEl.setText(this.title);this.contentEl.createEl('pre',{text:this.lines.filter(Boolean).join('\n\n'),cls:'zotero-bridge-preview'});const close=this.contentEl.createEl('button',{text:'Close'});close.onclick=()=>this.close();}
  onClose(){this.contentEl.empty();}
}

class BridgeSettings extends PluginSettingTab {
  constructor(app:App,private bridge:ZoteroBridge){super(app,bridge);}
  display(){
    this.containerEl.empty();this.containerEl.createEl('h2',{text:'Zotero Bridge'});
    this.containerEl.createEl('p',{text:'Desktop imports are manual and one-way. Enable Zotero’s local API in Settings → Advanced. Existing notes remain readable without this plugin.'});
    new Setting(this.containerEl).setName('New literature note folder').setDesc('Existing notes keep their current paths.').addText(t=>t.setValue(this.bridge.settings.noteFolder).onChange(v=>{try{this.bridge.settings.noteFolder=safeFolder(v);void this.bridge.saveData(this.bridge.settings);}catch{/* Do not save incomplete input. */}}));
    new Setting(this.containerEl).setName('Imported image folder').addText(t=>t.setValue(this.bridge.settings.assetFolder).onChange(v=>{try{this.bridge.settings.assetFolder=safeFolder(v);void this.bridge.saveData(this.bridge.settings);}catch{/* Do not save incomplete input. */}}));
    new Setting(this.containerEl).setName('Zotero data directory').setDesc('Used only to read cached figure images; metadata comes through the API.').addText(t=>t.setValue(this.bridge.settings.dataDirectory).onChange(v=>{this.bridge.settings.dataDirectory=v;void this.bridge.saveData(this.bridge.settings);}));
    new Setting(this.containerEl).setName('Optional old image-cache directory').setDesc('A read-only fallback for recovered figures. Leave blank after recovery.').addText(t=>t.setValue(this.bridge.settings.legacyCacheDirectory).onChange(v=>{this.bridge.settings.legacyCacheDirectory=v;void this.bridge.saveData(this.bridge.settings);}));
    new Setting(this.containerEl).setName('Connection audit').addButton(b=>b.setButtonText('Run audit').onClick(()=>void this.bridge.guard(()=>this.bridge.audit())));
  }
}
