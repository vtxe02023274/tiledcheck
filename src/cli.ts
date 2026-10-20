import { readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { checkFile, RULES, type Diagnostic } from './check.js';

const MAP_EXTENSIONS = new Set(['.tmx', '.tmj']);

const HELP = `usage: tiledcheck [options] <map or folder>...

Checks Tiled maps (.tmx, .tmj) and the tilesets, images and templates they use.
Tileset files (.tsx, .tsj) can be checked on their own. Folders are searched
recursively for maps.

options:
  --json            print diagnostics as JSON
  --no-warnings     only report errors
  --ignore <rule>   skip a rule, can be repeated
  --rules           list the rules
  -h, --help        show this help

exit code 1 when an error is found, 2 on bad usage.`;

function findMaps(path: string, out: string[]): void {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) throw new Error(`${path} does not exist`);
  if (stat.isFile()) {
    out.push(path);
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) findMaps(child, out);
    else if (MAP_EXTENSIONS.has(extname(entry.name).toLowerCase())) out.push(child);
  }
}

export function run(
  argv: string[],
  write: (s: string) => void = (s) => process.stdout.write(s),
): number {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        'no-warnings': { type: 'boolean' },
        ignore: { type: 'string', multiple: true },
        rules: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    write(`${(err as Error).message}\n\n${HELP}\n`);
    return 2;
  }
  const { values, positionals } = args;
  if (values.help) {
    write(`${HELP}\n`);
    return 0;
  }
  if (values.rules) {
    for (const [rule, text] of Object.entries(RULES)) write(`${rule.padEnd(20)} ${text}\n`);
    return 0;
  }
  if (!positionals.length) {
    write(`${HELP}\n`);
    return 2;
  }
  const ignored = new Set(values.ignore ?? []);
  for (const rule of ignored) {
    if (!(rule in RULES)) {
      write(`unknown rule '${rule}', see --rules\n`);
      return 2;
    }
  }

  const files: string[] = [];
  try {
    for (const p of positionals) findMaps(p, files);
  } catch (err) {
    write(`${(err as Error).message}\n`);
    return 2;
  }

  const diagnostics: Diagnostic[] = files
    .flatMap((f) => checkFile(f))
    .filter((d) => !ignored.has(d.rule) && !(values['no-warnings'] && d.severity === 'warning'));

  // The same tileset problem shows up once per map that uses it; report it once.
  const seen = new Set<string>();
  const unique = diagnostics.filter((d) => {
    const key = `${d.file}\0${d.where}\0${d.rule}\0${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const errors = unique.filter((d) => d.severity === 'error').length;
  const warnings = unique.length - errors;

  if (values.json) {
    write(
      `${JSON.stringify({ files: files.length, errors, warnings, diagnostics: unique }, null, 2)}\n`,
    );
  } else {
    for (const d of unique) {
      write(
        `${relative(process.cwd(), d.file) || d.file}: ${d.severity}: ${d.where}: ${d.message} [${d.rule}]\n`,
      );
    }
    const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
    write(
      `${plural(files.length, 'file')} checked, ${plural(errors, 'error')}, ${plural(warnings, 'warning')}\n`,
    );
  }
  return errors ? 1 : 0;
}
