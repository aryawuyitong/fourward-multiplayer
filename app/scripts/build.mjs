import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('dist/server', { recursive: true });
await mkdir('dist/.openai', { recursive: true });
const assets = {};
for (const name of ['index.html', 'styles.css', 'client.js']) {
  assets['/' + (name === 'index.html' ? '' : name)] = await readFile(`public/${name}`, 'utf8');
}
await build({
  entryPoints: ['worker/index.js'],
  outfile: 'dist/server/index.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  define: { __PUBLIC_ASSETS__: JSON.stringify(assets) },
});
const manifest = JSON.parse(await readFile('.openai/hosting.json', 'utf8'));
await writeFile('dist/.openai/hosting.json', JSON.stringify(manifest, null, 2) + '\n');
console.log('Built Fourward Worker with embedded, same-origin assets.');
