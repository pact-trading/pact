#!/usr/bin/env node
// Build docs-site as a static site and deploy it to Vercel (docs.pactagent.app).
//
//   node scripts/docs-deploy.mjs            # export, add agent files, deploy to production
//   node scripts/docs-deploy.mjs --no-deploy  # export and add agent files only
//
// Besides the Mintlify export, the output gets what agents read:
//   /llms.txt        docs-site/llms.txt (hand-written index with agent rules)
//   /llms-full.txt   every page in navigation order, as Markdown
//   /<page>.md       each page as Markdown
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(root, 'docs-site');
const deploy = !process.argv.includes('--no-deploy');
const work = mkdtempSync(join(tmpdir(), 'pact-docs-'));
const out = join(work, 'site');
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

run('npx', ['--yes', 'mint@latest', 'export', '--output', join(work, 'export.zip')], site);
mkdirSync(out);
run('unzip', ['-q', join(work, 'export.zip'), '-d', out]);
for (const f of ['serve.js', 'Start Docs.bat', 'Start Docs.command', 'README.md']) rmSync(join(out, f), { force: true });

const config = JSON.parse(readFileSync(join(site, 'docs.json'), 'utf8'));
const pages = config.navigation.tabs.flatMap(t => t.groups.flatMap(g => g.pages));

// MDX to plain Markdown: frontmatter becomes a heading and summary, Mintlify tags are dropped
// (their text content stays), and root-relative links become absolute.
const base = 'https://docs.pactagent.app';
function toMarkdown(page) {
  const src = readFileSync(join(site, `${page}.mdx`), 'utf8');
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(src);
  const meta = Object.fromEntries((fm?.[1] ?? '').split('\n').map(l => l.split(/:\s(.*)/s)).filter(p => p.length > 1).map(([k, v]) => [k.trim(), v.trim()]));
  let body = fm ? src.slice(fm[0].length) : src;
  // MDX nests content under components with indentation; in Markdown that would turn into code
  // blocks. Dedent each line, and each fence by its own opening indent.
  let fenceIndent = null;
  body = body.split('\n').map(line => {
    const indent = /^\s*/.exec(line)[0].length;
    if (/^\s*```/.test(line)) { fenceIndent = fenceIndent === null ? indent : null; return line.trimStart(); }
    return fenceIndent === null ? line.trimStart() : line.slice(Math.min(fenceIndent, indent));
  }).join('\n');
  const fences = [];
  body = body.replace(/```[\s\S]*?```/g, m => `\u0000${fences.push(m) - 1}\u0000`);
  body = body
    .replace(/<Frame[^>]*>[\s\S]*?<\/Frame>/g, '')
    .replace(/<Card\s+title="([^"]+)"[^>]*href="([^"]+)"[^>]*\/>/g, '- [$1]($2)')
    .replace(/<Card\s+title="([^"]+)"[^>]*href="([^"]+)"[^>]*>\s*([\s\S]*?)\s*<\/Card>/g, (_, t, h, d) => `- [${t}](${h}): ${d.replace(/\s+/g, ' ')}`)
    .replace(/<Step\s+title="([^"]+)"[^>]*>/g, '### $1\n')
    .replace(/<(Note|Tip|Warning|Info)>\s*/g, (_, k) => `> **${k}:** `)
    .replace(/<\/?[A-Z][A-Za-z]*[^>]*>/g, '')
    .replace(/\]\(\/(?!\/)([^)]*)\)/g, (_, p) => `](${base}/${p}${p && !/\.\w+$/.test(p.split('#')[0]) ? '.md' : ''})`)
    .replace(/\n{3,}/g, '\n\n');
  body = body.replace(/\u0000(\d+)\u0000/g, (_, i) => fences[Number(i)]);
  return `# ${meta.title ?? page}\n\n> ${meta.description ?? ''}\n\nSource: ${base}/${page === 'index' ? '' : page}\n\n${body.trim()}\n`;
}

const docs = pages.map(p => [p, toMarkdown(p)]);
for (const [page, md] of docs) {
  mkdirSync(dirname(join(out, `${page}.md`)), { recursive: true });
  writeFileSync(join(out, `${page}.md`), md);
}
const llms = readFileSync(join(site, 'llms.txt'), 'utf8');
writeFileSync(join(out, 'llms.txt'), llms);
writeFileSync(join(out, 'llms-full.txt'), `${llms.split('\n## ')[0].trim()}\n\n${docs.map(([, md]) => md).join('\n---\n\n')}`);

writeFileSync(join(out, 'vercel.json'), JSON.stringify({
  trailingSlash: false,
  headers: [
    { source: '/_mintlify/(assets|export-assets)/(.*)', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
    { source: '/(.*)\\.(md|txt)', headers: [{ key: 'Content-Type', value: 'text/markdown; charset=utf-8' }, { key: 'Access-Control-Allow-Origin', value: '*' }] },
  ],
}, null, 2));

if (deploy) {
  // Link to the existing pact-docs project; VERCEL_ORG_ID / VERCEL_PROJECT_ID override it.
  if (existsSync(join(site, '.vercel'))) cpSync(join(site, '.vercel'), join(out, '.vercel'), { recursive: true });
  run('vercel', ['deploy', '--prod', '--yes'], out);
} else {
  console.log(`Built ${out}`);
}
