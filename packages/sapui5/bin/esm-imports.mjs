import { readdir, readFile, writeFile } from 'node:fs/promises';
// UI5 source module names omit extensions. Native ESM and NodeNext declarations require them.
const directory = new URL('../dist/esm/', import.meta.url);
for (const filename of await readdir(directory)) {
  if (!filename.endsWith('.js') && !filename.endsWith('.d.ts')) continue;
  const file = new URL(filename, directory);
  const source = await readFile(file, 'utf8');
  await writeFile(file, source.replace(/(\bfrom\s+|\bimport\s*)(['"])(\.\/[^'"]+?)\2/g,
    (match, prefix, quote, specifier) => /\.[a-z]+$/i.test(specifier) ? match : `${prefix}${quote}${specifier}.js${quote}`));
}
