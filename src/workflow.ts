import {createHash} from 'node:crypto';
import {identity, identityKey, Paper} from './types';
export function safeFolder(value: string): string {
  const path=value.replace(/\\/g,'/').replace(/\/+$/,'');
  if (!path || path.startsWith('/') || /[<>:"|?*\[\]#^\x00-\x1f]/.test(path) || path.split('/').some(p=>!p||p==='.'||p==='..'||p.startsWith('.')||/[. ]$/.test(p))) throw new Error('Choose a relative, visible vault folder without reserved filename or link characters.');
  return path;
}
export function notePath(paper: Paper, folder: string, occupied: (path:string)=>boolean): string {
  const cite=(paper.item.data.citationKey||paper.item.key).replace(/[<>:"/\\|?*\x00-\x1f\[\]#^]/g,'_').replace(/[. ]+$/,'').slice(0,130)||paper.item.key;
  const base=`${safeFolder(folder)}/@${cite}.md`;
  if(!occupied(base))return base;
  const alt=`${safeFolder(folder)}/@${cite}--${paper.library.type}-${paper.library.id}-${paper.item.key}.md`;
  if(occupied(alt))throw new Error(`A different note already occupies ${alt}.`);
  return alt;
}
export function checksum(text: string|Uint8Array): string {return createHash('sha256').update(text).digest('hex');}
export function paperLabel(paper: Paper): string {return paper.item.data.title||paper.item.data.citationKey||paper.item.key;}
export function identityLabel(paper: Paper): string {return identityKey(identity(paper));}
export function stripReferenceNumber(text: string): string {return text.trim().replace(/^\[\d+\]\s*/, '').trim();}
export function movedMappings(mappings:Record<string,string>,oldPath:string,newPath:string):Record<string,string> {
  return Object.fromEntries(Object.entries(mappings).map(([key,path])=>[key,path===oldPath?newPath:path.startsWith(oldPath+'/')?newPath+path.slice(oldPath.length):path]));
}
