#!/usr/bin/env node
// ADR에서 시작해 관련 Markdown 문서를 제한된 범위에서 고른다.
// 기본 출력은 서브에이전트가 읽을 문서 목록이며, --bundle일 때만 원문을 함께 출력한다.
//
// 사용:
//   node scripts/wiki-context.mjs D01
//   node scripts/wiki-context.mjs D01 --depth 2 --max-docs 8 --max-chars 24000
//   node scripts/wiki-context.mjs D01 --section "구현 영향" --json
//   node scripts/wiki-context.mjs D01 --bundle

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = path.join(ROOT, '{{DOCS_DIR}}');
const DEFAULTS = { depth: 1, maxDocs: 8, maxChars: 24000, section: null, json: false, bundle: false };
const SECTION_PRIORITY = new Map([
  ['관련 규칙', 100],
  ['관련 결정', 90],
  ['구현 영향', 80],
  ['근거', 70],
  ['속성', 60],
  ['검토한 대안', 50],
  ['검증 조건', 40],
]);

function slash(value) {
  return value.split(path.sep).join('/');
}

function key(value) {
  return String(value).normalize('NFC').toLocaleLowerCase('en-US');
}

function listMarkdown(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out.sort();
}

function relativeFile(file) {
  return slash(path.relative(DOCS, file));
}

function noteId(file) {
  return relativeFile(file).replace(/\.md$/i, '');
}

function isTemplate(file) {
  const rel = relativeFile(file);
  return rel.startsWith('templates/') || rel.includes('/_templates/');
}

function unquote(value) {
  const text = value.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
    return text.slice(1, -1);
  return text;
}

function parseFrontmatter(content) {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.slice(1).findIndex((line) => line.trim() === '---');
  if (end < 0) return null;
  const data = {};
  let current = null;
  for (const line of lines.slice(1, end + 1)) {
    const property = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (property) {
      current = property[1];
      const raw = property[2].trim();
      data[current] = raw === '' || raw === '[]' ? [] : unquote(raw);
      continue;
    }
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && current) {
      if (!Array.isArray(data[current])) data[current] = [];
      data[current].push(unquote(item[1]));
    }
  }
  return data;
}

function firstHeading(content) {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? '';
}

function sectionBody(content, title) {
  const lines = content.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start < 0) return '';
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line)) break;
    if (line.trim()) body.push(line.trim());
  }
  return body.join(' ').replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, '$2').replace(/\s+/g, ' ').trim();
}

function noteSummary(content, frontmatter) {
  if (typeof frontmatter?.summary === 'string' && frontmatter.summary.trim()) return frontmatter.summary.trim();
  const decision = sectionBody(content, '결정');
  if (decision) return decision.slice(0, 300);
  const lines = content.split('\n');
  const paragraph = lines.find((line) => line.trim() && !/^\s*(#|>|-|<!--|---)/.test(line));
  return paragraph?.trim().slice(0, 300) ?? '';
}

function loadNote(file) {
  const content = fs.readFileSync(file, 'utf8');
  const frontmatter = parseFrontmatter(content);
  const base = path.basename(file, '.md');
  const title = typeof frontmatter?.title === 'string' && frontmatter.title
    ? frontmatter.title
    : firstHeading(content) || base;
  const aliases = Array.isArray(frontmatter?.aliases) ? frontmatter.aliases.filter(Boolean) : [];
  return {
    file,
    id: noteId(file),
    base,
    title,
    aliases,
    summary: noteSummary(content, frontmatter),
    content,
    chars: content.length,
  };
}

function buildCatalog(notes) {
  const direct = new Map();
  const names = new Map();
  for (const note of notes) {
    direct.set(key(note.id), note);
    direct.set(key(note.id + '.md'), note);
    const identifiers = isTemplate(note.file) ? [note.base] : [note.base, note.title, ...note.aliases];
    for (const name of new Set(identifiers.filter(Boolean))) {
      const normalized = key(name);
      if (!names.has(normalized)) names.set(normalized, []);
      if (!names.get(normalized).includes(note)) names.get(normalized).push(note);
    }
  }
  return { notes, direct, names };
}

function cleanTarget(raw) {
  let target = raw.split('|', 1)[0].trim();
  target = target.split('#', 1)[0].split('^', 1)[0].trim();
  try { target = decodeURIComponent(target); } catch {}
  return slash(target).replace(/^\.\//, '').replace(/^\//, '').replace(/\.md$/i, '');
}

function resolveTarget(raw, catalog) {
  const target = cleanTarget(raw);
  const direct = catalog.direct.get(key(target));
  if (direct) return { target, matches: [direct] };
  return { target, matches: catalog.names.get(key(target)) ?? [] };
}

function stripHtmlComments(line, state) {
  let output = '';
  let cursor = 0;
  while (cursor < line.length) {
    if (state.html) {
      const end = line.indexOf('-->', cursor);
      if (end < 0) return output;
      state.html = false;
      cursor = end + 3;
      continue;
    }
    const start = line.indexOf('<!--', cursor);
    if (start < 0) return output + line.slice(cursor);
    output += line.slice(cursor, start);
    const end = line.indexOf('-->', start + 4);
    if (end < 0) {
      state.html = true;
      return output;
    }
    cursor = end + 3;
  }
  return output;
}

function extractLinks(note) {
  const links = [];
  const sections = new Set();
  const state = { html: false, fence: null };
  let section = '속성';
  for (const [index, original] of note.content.split('\n').entries()) {
    const fence = original.match(/^\s*(`{3,}|~{3,})/);
    if (state.fence) {
      if (fence && fence[1][0] === state.fence) state.fence = null;
      continue;
    }
    if (fence) {
      state.fence = fence[1][0];
      continue;
    }
    let line = stripHtmlComments(original, state);
    line = line.replace(/(`+)(.*?)\1/g, '');
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      section = heading[1];
      sections.add(section);
    }
    const re = /!?\[\[([^\]\n]+)\]\]/g;
    let match;
    while ((match = re.exec(line))) {
      links.push({ raw: match[1], section, line: index + 1, priority: SECTION_PRIORITY.get(section) ?? 10 });
    }
  }
  return { links, sections };
}

function parsePositive(value, flag, minimum = 1) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) throw new Error(`${flag}에는 ${minimum} 이상의 정수가 필요합니다.`);
  return number;
}

function parseArgs(argv) {
  if (!argv.length) throw new Error('시작할 ADR 번호나 Markdown 경로가 필요합니다.');
  const start = argv[0];
  const options = { ...DEFAULTS };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--depth') options.depth = parsePositive(argv[++i], flag, 0);
    else if (flag === '--max-docs') options.maxDocs = parsePositive(argv[++i], flag);
    else if (flag === '--max-chars') options.maxChars = parsePositive(argv[++i], flag, 1000);
    else if (flag === '--section') options.section = argv[++i] || null;
    else if (flag === '--json') options.json = true;
    else if (flag === '--bundle') options.bundle = true;
    else throw new Error(`알 수 없는 옵션: ${flag}`);
  }
  if (options.depth > 3) throw new Error('--depth는 0~3만 허용합니다.');
  if (options.json && options.bundle) throw new Error('--json과 --bundle은 함께 사용할 수 없습니다.');
  return { start, options };
}

function resolveStart(input, catalog) {
  const possible = path.resolve(ROOT, input);
  if (possible.startsWith(DOCS + path.sep) && fs.existsSync(possible) && fs.statSync(possible).isFile()) {
    const found = catalog.notes.find((note) => note.file === possible);
    if (found) return found;
  }
  const normalized = slash(input).replace(/^{{DOCS_DIR}}\//, '').replace(/\.md$/i, '');
  const direct = catalog.direct.get(key(normalized));
  if (direct) return direct;
  const byName = catalog.names.get(key(normalized)) ?? [];
  if (byName.length === 1) return byName[0];
  if (/^D\d+$/i.test(normalized)) {
    const adr = catalog.notes.filter((note) => note.id.startsWith('decisions/') && new RegExp(`^${normalized}-`, 'i').test(note.base));
    if (adr.length === 1) return adr[0];
    if (adr.length > 1) throw new Error(`ADR 번호가 여러 파일과 일치합니다: ${adr.map((note) => relativeFile(note.file)).join(', ')}`);
  }
  if (byName.length > 1) throw new Error(`시작 문서가 여러 개입니다: ${byName.map((note) => relativeFile(note.file)).join(', ')}`);
  throw new Error(`시작 문서를 찾을 수 없습니다: ${input}`);
}

function compareQueue(a, b) {
  return a.depth - b.depth || b.priority - a.priority || a.note.id.localeCompare(b.note.id, 'ko');
}

function contextManifest(start, catalog, options) {
  if (start.chars > options.maxChars) throw new Error(`시작 문서가 글자 예산보다 큽니다: ${start.chars} > ${options.maxChars}`);
  const selected = [{ note: start, depth: 0, via: null, section: '시작 문서', priority: 1000 }];
  const selectedIds = new Set([start.id]);
  const pending = new Map();
  const omitted = [];
  const warnings = [];
  let totalChars = start.chars;

  function omit(note, reason, via, section, depth) {
    if (selectedIds.has(note.id)) return;
    const queued = pending.get(note.id);
    if (queued && depth !== undefined && queued.depth <= depth) return;
    if (omitted.some((item) => item.path === relativeFile(note.file) && item.reason === reason)) return;
    omitted.push({ id: note.id, path: relativeFile(note.file), reason, via, section });
  }

  function enqueueFrom(parent, parentDepth) {
    const extracted = extractLinks(parent);
    if (parent.id === start.id && options.section && !extracted.sections.has(options.section)) {
      warnings.push({ level: 'error', code: 'section/missing', path: relativeFile(parent.file), message: `섹션을 찾을 수 없습니다: ${options.section}` });
      return;
    }
    for (const link of extracted.links) {
      if (parent.id === start.id && options.section && link.section !== options.section) continue;
      const resolved = resolveTarget(link.raw, catalog);
      if (resolved.matches.length === 0) {
        warnings.push({ level: 'error', code: 'link/missing', path: relativeFile(parent.file), line: link.line, message: `대상을 찾을 수 없습니다: [[${link.raw}]]` });
        continue;
      }
      if (resolved.matches.length > 1) {
        warnings.push({ level: 'error', code: 'link/ambiguous', path: relativeFile(parent.file), line: link.line, message: `대상이 여러 개입니다: [[${link.raw}]]` });
        continue;
      }
      const note = resolved.matches[0];
      if (selectedIds.has(note.id)) continue;
      const depth = parentDepth + 1;
      if (depth > options.depth) {
        omit(note, '깊이 제한', relativeFile(parent.file), link.section, depth);
        continue;
      }
      const item = { note, depth, via: relativeFile(parent.file), section: link.section, priority: link.priority };
      const existing = pending.get(note.id);
      if (!existing || compareQueue(item, existing) < 0) pending.set(note.id, item);
    }
  }

  enqueueFrom(start, 0);
  while (pending.size && selected.length < options.maxDocs) {
    const next = [...pending.values()].sort(compareQueue)[0];
    pending.delete(next.note.id);
    if (selectedIds.has(next.note.id)) continue;
    if (totalChars + next.note.chars > options.maxChars) {
      omit(next.note, '글자 예산', next.via, next.section, next.depth);
      continue;
    }
    selected.push(next);
    selectedIds.add(next.note.id);
    totalChars += next.note.chars;
    if (next.depth < options.depth) enqueueFrom(next.note, next.depth);
  }
  for (const item of pending.values()) omit(item.note, '문서 수 제한', item.via, item.section, item.depth);

  const finalOmitted = omitted
    .filter((item) => !selectedIds.has(item.id))
    .map(({ id: _id, ...item }) => item);
  return { selected, omitted: finalOmitted, warnings, totalChars };
}

function plainManifest(start, options, manifest) {
  const lines = [
    '# ADR 맥락 읽기 목록',
    '',
    `- 시작: ${relativeFile(start.file)}`,
    `- 범위: 깊이 ${options.depth} · 최대 ${options.maxDocs}개 · 최대 ${options.maxChars}자`,
    `- 선택: ${manifest.selected.length}개 · ${manifest.totalChars}자`,
  ];
  if (options.section) lines.push(`- 시작 섹션: ${options.section}`);
  lines.push('', '## 읽을 문서', '');
  for (const [index, item] of manifest.selected.entries()) {
    lines.push(`${index + 1}. ${relativeFile(item.note.file)}`);
    lines.push(`   - 깊이: ${item.depth}`);
    lines.push(`   - 연결: ${item.via ? `${item.via}의 ${item.section}` : '시작 문서'}`);
    lines.push(`   - 크기: ${item.note.chars}자`);
    lines.push(`   - 요약: ${item.note.summary || '요약 없음'}`);
  }
  if (manifest.omitted.length) {
    lines.push('', '## 제외된 문서', '');
    for (const item of manifest.omitted) lines.push(`- ${item.path}: ${item.reason} (${item.via}의 ${item.section})`);
  }
  if (manifest.warnings.length) {
    lines.push('', '## 경고', '');
    for (const item of manifest.warnings) lines.push(`- [${item.code}] ${item.path}${item.line ? `:${item.line}` : ''} ${item.message}`);
  }
  return lines.join('\n') + '\n';
}

function jsonManifest(start, options, manifest) {
  return {
    start: relativeFile(start.file),
    limits: { depth: options.depth, max_docs: options.maxDocs, max_chars: options.maxChars, section: options.section },
    selected_chars: manifest.totalChars,
    documents: manifest.selected.map((item) => ({
      path: relativeFile(item.note.file),
      depth: item.depth,
      via: item.via,
      section: item.section,
      chars: item.note.chars,
      summary: item.note.summary,
    })),
    omitted: manifest.omitted,
    warnings: manifest.warnings,
  };
}

try {
  const { start: input, options } = parseArgs(process.argv.slice(2));
  const notes = listMarkdown(DOCS).map(loadNote);
  const catalog = buildCatalog(notes);
  const start = resolveStart(input, catalog);
  const manifest = contextManifest(start, catalog, options);

  if (options.json) process.stdout.write(JSON.stringify(jsonManifest(start, options, manifest), null, 2) + '\n');
  else {
    process.stdout.write(plainManifest(start, options, manifest));
    if (options.bundle) {
      for (const item of manifest.selected) {
        process.stdout.write(`\n---\n\n## ${relativeFile(item.note.file)}\n\n${item.note.content.trim()}\n`);
      }
    }
  }
  if (manifest.warnings.some((item) => item.level === 'error')) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`wiki-context: ${error.message}\n`);
  process.exitCode = 1;
}
