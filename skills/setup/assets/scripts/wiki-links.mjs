#!/usr/bin/env node
// Obsidian 위키 링크 검사기.
// - {{DOCS_DIR}}/ 전체의 [[위키 링크]]가 실제 문서 하나로 이어지는지 검사한다.
// - {{DOCS_DIR}}/wiki/ 지식 노트의 YAML 스키마를 검사한다.
// - 기존 노트의 고유한 제목·별칭과 정확히 일치하는 첫 언급만 자동 연결한다.
//
// 사용:
//   node scripts/wiki-links.mjs check-all
//   node scripts/wiki-links.mjs check [{{DOCS_DIR}}/아래의.md ...]
//   node scripts/wiki-links.mjs fix <{{DOCS_DIR}}/아래의.md ...>

import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, DOCS, REQUIRED, TYPES, STATUSES,
  slash, listMarkdown, relativeFile, noteId, isTemplate, isKnowledgeNote,
  unquote, parseFrontmatter, firstHeading, loadNote, key, buildCatalog,
  cleanTarget, resolveTarget, maskHtml, maskMarkdown, extractLinks,
} from './wiki-lib.mjs';

const GENERATED = new Set(['tasks.md', 'tasks-done.md', 'worklog.md']);
const PARTICLES = [
  '으로부터는', '으로부터', '에서부터는', '에서부터', '에게서는', '에게서',
  '에서는', '에서도', '에서', '으로는', '으로도', '으로', '에게는', '에게도',
  '에게', '까지는', '까지도', '까지', '부터는', '부터도', '부터', '이라는',
  '라고는', '라고', '이며', '이고', '이다', '처럼', '보다', '과는', '와는',
  '과도', '와도', '으로', '로는', '로도', '로', '에는', '에도', '에',
  '은', '는', '이', '가', '을', '를', '의', '과', '와', '도', '만',
];

function isAutoLinkSource(note) {
  return isKnowledgeNote(note.file) || /^decisions\/D\d+-/.test(note.id);
}

function canAutoFix(file) {
  const rel = relativeFile(file);
  return !GENERATED.has(rel) && !isTemplate(file);
}

function diagnostic(level, file, line, code, message) {
  return { level, file: relativeFile(file), line, code, message };
}

function schemaDiagnostics(note) {
  if (!isKnowledgeNote(note.file)) return [];
  const out = [];
  const data = note.frontmatter.data;
  if (!data) return [diagnostic('error', note.file, 1, 'schema/frontmatter', 'YAML 속성이 없습니다.')];

  for (const field of REQUIRED) {
    if (!(field in data)) out.push(diagnostic('error', note.file, 1, 'schema/missing', `필수 속성 ${field}이(가) 없습니다.`));
  }
  for (const field of ['aliases', 'sources', 'related']) {
    if (field in data && !Array.isArray(data[field]))
      out.push(diagnostic('error', note.file, 1, 'schema/list', `${field}은(는) YAML 목록이어야 합니다.`));
  }
  for (const field of ['title', 'summary', 'created', 'updated']) {
    if (field in data && (typeof data[field] !== 'string' || !data[field].trim()))
      out.push(diagnostic('error', note.file, 1, 'schema/value', `${field}에 값이 필요합니다.`));
  }
  if (data.type && !TYPES.has(data.type))
    out.push(diagnostic('error', note.file, 1, 'schema/type', `알 수 없는 type: ${data.type}`));
  if (data.status && !STATUSES.has(data.status))
    out.push(diagnostic('error', note.file, 1, 'schema/status', `알 수 없는 status: ${data.status}`));
  for (const field of ['created', 'updated']) {
    if (data[field] && !/^\d{4}-\d{2}-\d{2}$/.test(data[field]))
      out.push(diagnostic('error', note.file, 1, 'schema/date', `${field}은(는) YYYY-MM-DD 형식이어야 합니다.`));
  }
  const heading = firstHeading(note.content);
  if (data.title && heading && data.title !== heading)
    out.push(diagnostic('error', note.file, 1, 'schema/title', `title과 첫 제목이 다릅니다: ${data.title} / ${heading}`));
  return out;
}

function duplicateDiagnostics(catalog) {
  const out = [];
  for (const [name, notes] of catalog.names) {
    const candidates = notes.filter((note) => !isTemplate(note.file));
    if (candidates.length < 2) continue;
    const files = candidates.map((note) => relativeFile(note.file)).join(', ');
    out.push(diagnostic('error', candidates[0].file, 1, 'name/duplicate', `이름 또는 별칭 "${name}"이(가) 겹칩니다: ${files}`));
  }
  return out;
}

function linkDiagnostics(note, catalog) {
  if (isTemplate(note.file)) return [];
  const out = [];
  for (const link of extractLinks(note, catalog).links) {
    if (!link.target) continue;
    if (link.matches.length === 0)
      out.push(diagnostic('error', note.file, link.line, 'link/missing', `대상을 찾을 수 없습니다: [[${link.raw}]]`));
    else if (link.matches.length > 1) {
      const files = link.matches.map((item) => relativeFile(item.file)).join(', ');
      out.push(diagnostic('error', note.file, link.line, 'link/ambiguous', `대상이 여러 개입니다: [[${link.raw}]] → ${files}`));
    }
  }
  return out;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validBefore(text, index) {
  if (index === 0) return true;
  return !/[\p{L}\p{N}_]/u.test(text[index - 1]);
}

function validAfter(text, index) {
  if (index >= text.length) return true;
  const rest = text.slice(index);
  if (!/^[\p{L}\p{N}_]/u.test(rest)) return true;
  return PARTICLES.some((particle) => rest.startsWith(particle));
}

function candidateMap(note, catalog, linkedIds) {
  const map = new Map();
  for (const target of catalog.notes.filter(isAutoLinkSource)) {
    if (target.id === note.id || linkedIds.has(target.id)) continue;
    const identifiers = [target.base, target.title, ...target.aliases];
    for (const name of new Set(identifiers.filter((value) => value && value.length >= 2))) {
      const matches = catalog.names.get(key(name)) ?? [];
      if (matches.length === 1) map.set(key(name), { name, target });
    }
  }
  return map;
}

const PROTECTED = /!?\[\[[^\]\n]+\]\]|!?\[[^\]\n]*\]\([^)\n]+\)|(`+)[^`\n]*\1|https?:\/\/[^\s<]+/g;

function transformPlain(segment, candidates, linkedIds, apply, found, lineNumber) {
  if (!candidates.size) return segment;
  const choices = [...candidates.values()].sort((a, b) => b.name.length - a.name.length);
  const re = new RegExp(choices.map((item) => escapeRegExp(item.name)).join('|'), 'giu');
  return segment.replace(re, (mention, offset, whole) => {
    const candidate = candidates.get(key(mention));
    if (!candidate || linkedIds.has(candidate.target.id)) return mention;
    if (!validBefore(whole, offset) || !validAfter(whole, offset + mention.length)) return mention;
    linkedIds.add(candidate.target.id);
    found.push({ line: lineNumber, mention, target: candidate.target });
    if (!apply) return mention;
    const label = key(mention) === key(candidate.target.base) ? '' : `|${mention}`;
    return `[[${candidate.target.id}${label}]]`;
  });
}

function transformLine(line, candidates, linkedIds, apply, found, lineNumber) {
  let out = '';
  let cursor = 0;
  PROTECTED.lastIndex = 0;
  let match;
  while ((match = PROTECTED.exec(line))) {
    out += transformPlain(line.slice(cursor, match.index), candidates, linkedIds, apply, found, lineNumber);
    out += match[0];
    cursor = match.index + match[0].length;
  }
  return out + transformPlain(line.slice(cursor), candidates, linkedIds, apply, found, lineNumber);
}

function findOrFixMentions(note, catalog, apply) {
  if (!canAutoFix(note.file)) return { content: note.content, found: [] };
  const { linkedIds } = extractLinks(note, catalog);
  const candidates = candidateMap(note, catalog, linkedIds);
  const found = [];
  const state = { frontmatter: note.content.startsWith('---\n'), fence: null, html: false };
  const lines = note.content.split('\n');
  const result = lines.map((line, index) => {
    const number = index + 1;
    if (state.frontmatter) {
      if (index > 0 && line.trim() === '---') state.frontmatter = false;
      return line;
    }
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (state.fence) {
      if (fence && fence[1][0] === state.fence) state.fence = null;
      return line;
    }
    if (fence) {
      state.fence = fence[1][0];
      return line;
    }
    if (state.html) {
      if (line.includes('-->')) state.html = false;
      return line;
    }
    if (line.includes('<!--') && !line.includes('-->')) {
      state.html = true;
      return line;
    }
    if (/^\s*#/.test(line)) return line;
    return transformLine(line, candidates, linkedIds, apply, found, number);
  });
  return { content: result.join('\n'), found };
}

function mentionDiagnostics(note, catalog) {
  if (isTemplate(note.file) || GENERATED.has(relativeFile(note.file))) return [];
  return findOrFixMentions(note, catalog, false).found.map((item) =>
    diagnostic('warning', note.file, item.line, 'link/unlinked', `"${item.mention}"을(를) [[${item.target.id}]]에 연결할 수 있습니다.`)
  );
}

function resolveFiles(args, allNotes) {
  if (!args.length) return allNotes.filter((note) => !isTemplate(note.file));
  const byFile = new Map(allNotes.map((note) => [path.resolve(note.file), note]));
  return args.map((arg) => {
    const file = path.resolve(ROOT, arg);
    if (!file.startsWith(DOCS + path.sep) || path.extname(file) !== '.md')
      throw new Error(`{{DOCS_DIR}}/ 아래의 Markdown 파일만 지정할 수 있습니다: ${arg}`);
    const note = byFile.get(file);
    if (!note) throw new Error(`파일을 찾을 수 없습니다: ${arg}`);
    return note;
  });
}

function printDiagnostics(items) {
  for (const item of items) {
    const label = item.level === 'error' ? '오류' : '경고';
    process.stdout.write(`${label} ${item.file}:${item.line} [${item.code}] ${item.message}\n`);
  }
}

const [command = '', ...args] = process.argv.slice(2);

try {
  const notes = listMarkdown(DOCS).map(loadNote);
  const catalog = buildCatalog(notes);
  let targets;

  if (command === 'check-all') targets = resolveFiles([], notes);
  else if (command === 'check') targets = resolveFiles(args, notes);
  else if (command === 'fix') {
    if (!args.length) throw new Error('fix에는 수정할 Markdown 파일이 하나 이상 필요합니다.');
    targets = resolveFiles(args, notes);
    let changed = 0;
    for (const note of targets) {
      if (!canAutoFix(note.file)) throw new Error(`자동 수정할 수 없는 파일입니다: ${relativeFile(note.file)}`);
      const fixed = findOrFixMentions(note, catalog, true);
      if (fixed.content !== note.content) {
        fs.writeFileSync(note.file, fixed.content);
        note.content = fixed.content;
        changed += fixed.found.length;
      }
    }
    process.stdout.write(`자동 연결 ${changed}건.\n`);
  } else {
    process.stderr.write('사용법: wiki-links <check-all|check [파일...]|fix 파일...>\n');
    process.exit(1);
  }

  const diagnostics = [
    ...duplicateDiagnostics(catalog),
    ...targets.flatMap((note) => schemaDiagnostics(note)),
    ...targets.flatMap((note) => linkDiagnostics(note, catalog)),
    ...targets.flatMap((note) => mentionDiagnostics(note, catalog)),
  ];
  printDiagnostics(diagnostics);
  const errors = diagnostics.filter((item) => item.level === 'error').length;
  const warnings = diagnostics.length - errors;
  if (!diagnostics.length) process.stdout.write(`위키 검사 통과: ${targets.length}개 문서.\n`);
  else process.stdout.write(`검사 결과: 오류 ${errors}건, 경고 ${warnings}건.\n`);
  process.exitCode = errors ? 1 : 0;
} catch (error) {
  process.stderr.write(`wiki-links: ${error.message}\n`);
  process.exitCode = 1;
}
