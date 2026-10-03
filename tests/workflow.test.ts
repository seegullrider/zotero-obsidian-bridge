import {test} from 'node:test';
import assert from 'node:assert/strict';
import {notePath,safeFolder,stripReferenceNumber,movedMappings} from '../src/workflow';
import {Paper} from '../src/types';
const p:Paper={library:{type:'group',id:42,name:'Example group'},item:{key:'ABCDEFGH',data:{itemType:'journalArticle',citationKey:'author2025'}}};
test('new paths have deterministic library-aware collision handling',()=>{
 assert.equal(notePath(p,'physics/literature',()=>false),'physics/literature/@author2025.md');
 assert.equal(notePath(p,'physics/literature',s=>s.endsWith('/@author2025.md')),'physics/literature/@author2025--group-42-ABCDEFGH.md');
 assert.throws(()=>notePath(p,'physics/literature',()=>true));
});
test('reject traversal and config directory for note folders',()=>{
 for(const p of ['../notes','.obsidian/plugins','C:/notes','/notes','notes//papers','papers/#figures','papers/[figures]','papers/trailing.'])assert.throws(()=>safeFolder(p));
 assert.equal(safeFolder('physics\\literature'),'physics/literature');
});
test('folder moves keep conflicted-note mappings attached without changing unrelated paths',()=>{
 assert.deepEqual(movedMappings({a:'physics/literature/a.md',b:'physics/literature-old/b.md'},'physics/literature','physics/papers'),{a:'physics/papers/a.md',b:'physics/literature-old/b.md'});
 assert.deepEqual(movedMappings({a:'physics/a.md'},'physics/a.md','physics/b.md'),{a:'physics/b.md'});
});
test('strip independent IEEE number only at start',()=>{
 assert.equal(stripReferenceNumber('[1] A reference. [3]'),'A reference. [3]');
 assert.equal(stripReferenceNumber('A [1] reference.'),'A [1] reference.');
});
