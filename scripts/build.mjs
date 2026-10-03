import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('dist',{recursive:true});
await build({entryPoints:['src/main.ts'],outfile:'dist/main.js',bundle:true,format:'cjs',platform:'node',target:'es2020',external:['obsidian','electron'],sourcemap:false,minify:false,logLevel:'info'});
await build({entryPoints:['src/core.ts'],outfile:'dist/bridge-core.cjs',bundle:true,format:'cjs',platform:'node',target:'es2020',logLevel:'info'});
await copyFile('manifest.json','dist/manifest.json');
await copyFile('styles.css','dist/styles.css');
