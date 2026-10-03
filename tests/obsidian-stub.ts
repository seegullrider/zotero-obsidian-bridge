class Element {
  children:Element[]=[];
  text='';disabled=false;
  setText(t:string){this.text=t;} empty(){this.children=[];}
  createEl(_tag:string,opts:{text?:string}={}){const e=new Element();e.text=opts.text||'';this.children.push(e);return e;}
  createDiv(opts:{text?:string}={}){return this.createEl('div',opts);}
}
export class Plugin {app:any;manifest={dir:'.obsidian/plugins/zotero-bridge'};saved:any;constructor(_app?:unknown,_manifest?:unknown){}async saveData(data:any){this.saved=structuredClone(data);}}
export class Modal {contentEl=new Element();titleEl=new Element();constructor(public app:any){}open(){(this as any).onOpen?.();}close(){(this as any).onClose?.();}}
export class Notice {constructor(_message:string,_duration?:number){}setMessage(_m:string){}hide(){}}
export class TFile {constructor(public path:string){} }
export class TFolder {constructor(public path:string){} }
export class PluginSettingTab {}
export class Setting {}
export class MarkdownView {}
export const normalizePath=(path:string)=>path.replace(/\\/g,'/');
