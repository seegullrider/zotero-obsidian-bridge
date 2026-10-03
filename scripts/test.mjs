import {build} from 'esbuild';
import {readdir,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const tests=(await readdir('tests')).filter(n=>n.endsWith('.test.ts')).map(n=>'tests/'+n);
await mkdir('dist-tests',{recursive:true});
await build({entryPoints:tests,outdir:'dist-tests',outExtension:{'.js':'.cjs'},bundle:true,platform:'node',format:'cjs',target:'es2020',alias:{obsidian:'./tests/obsidian-stub.ts'},logLevel:'warning'});
const result=spawnSync(process.execPath,['--test',...(await readdir('dist-tests')).filter(n=>n.endsWith('.test.cjs')).map(n=>'dist-tests/'+n)],{stdio:'inherit'});
process.exit(result.status??1);
