#!/usr/bin/env node
// 위키 링크 모델 공용 모듈 — wiki-links.mjs(검사기)와 wiki.mjs(CRUD)가 함께 쓴다.
// 여기 있는 함수의 동작을 바꾸면 두 스크립트 모두에 영향을 준다 — 신중히 바꿀 것.
//
// 담당: 노트 로딩(프런트매터 파싱)·카탈로그(이름→노트) 구성·링크 대상 해석·마크다운
// 마스킹(코드블록·HTML 주석 제외)까지, "링크가 어느 노트로 이어지는가"를 정의하는 부분만.
// 검사(diagnostics)·자동 연결(mentions) 같은 wiki-links.mjs 고유 로직은 여기 두지 않는다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DOCS = path.join(ROOT, '{{DOCS_DIR}}');

export const REQUIRED = ['title', 'aliases', 'type', 'status', 'summary', 'created', 'updated', 'sources', 'related'];
export const TYPES = new Set(['concept', 'system', 'experiment', 'reference', 'guide']);
export const STATUSES = new Set(['draft', 'active', 'superseded', 'archived']);

export function slash(p) {
  return p.split(path.sep).join('/');
}

export function listMarkdown(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '..') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out.sort();
}

export function relativeFile(file) {
  return slash(path.relative(DOCS, file));
}

export function noteId(file) {
  return relativeFile(file).replace(/\.md$/i, '');
}

export function isTemplate(file) {
  const rel = relativeFile(file);
  return rel.startsWith('templates/') || rel.includes('/_templates/');
}

export function isKnowledgeNote(file) {
  const rel = relativeFile(file);
  return rel.startsWith('wiki/') && !rel.split('/').pop().startsWith('_') && !isTemplate(file);
}

export function unquote(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
    return v.slice(1, -1);
  return v;
}

export function parseFrontmatter(content) {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return { data: null, endLine: 0 };
  const end = lines.slice(1).findIndex((line) => line.trim() === '---');
  if (end < 0) return { data: null, endLine: 0 };

  const data = {};
  let current = null;
  for (const line of lines.slice(1, end + 1)) {
    const key = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (key) {
      current = key[1];
      const raw = key[2].trim();
      if (raw === '[]' || raw === '') data[current] = [];
      else data[current] = unquote(raw);
      continue;
    }
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && current) {
      if (!Array.isArray(data[current])) data[current] = [];
      data[current].push(unquote(item[1]));
    }
  }
  return { data, endLine: end + 2 };
}

export function firstHeading(content) {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? '';
}

export function loadNote(file) {
  const content = fs.readFileSync(file, 'utf8');
  const frontmatter = parseFrontmatter(content);
  const base = path.basename(file, '.md');
  const title = typeof frontmatter.data?.title === 'string' && frontmatter.data.title
    ? frontmatter.data.title
    : firstHeading(content) || base;
  const aliases = Array.isArray(frontmatter.data?.aliases) ? frontmatter.data.aliases.filter(Boolean) : [];
  return { file, id: noteId(file), base, title, aliases, content, frontmatter };
}

export function key(value) {
  return String(value).normalize('NFC').toLocaleLowerCase('en-US');
}

export function buildCatalog(notes) {
  const direct = new Map();
  const names = new Map();
  for (const note of notes) {
    direct.set(key(note.id), note);
    direct.set(key(note.id + '.md'), note);
    const identifiers = isTemplate(note.file)
      ? [note.base]
      : [note.base, note.title, ...note.aliases];
    for (const name of new Set(identifiers.filter(Boolean))) {
      const k = key(name);
      if (!names.has(k)) names.set(k, []);
      if (!names.get(k).includes(note)) names.get(k).push(note);
    }
  }
  return { notes, direct, names };
}

export function cleanTarget(raw) {
  let target = raw.split('|', 1)[0].trim();
  target = target.split('#', 1)[0].split('^', 1)[0].trim();
  try { target = decodeURIComponent(target); } catch {}
  return slash(target).replace(/^\.\//, '').replace(/^\//, '').replace(/\.md$/i, '');
}

export function resolveTarget(raw, catalog) {
  const target = cleanTarget(raw);
  const exact = catalog.direct.get(key(target));
  if (exact) return { target, matches: [exact] };
  return { target, matches: catalog.names.get(key(target)) ?? [] };
}

export function maskHtml(line, state) {
  const chars = line.split('');
  let i = 0;
  while (i < line.length) {
    if (state.html) {
      const end = line.indexOf('-->', i);
      const stop = end < 0 ? line.length : end + 3;
      for (let j = i; j < stop; j++) chars[j] = ' ';
      if (end < 0) break;
      state.html = false;
      i = stop;
      continue;
    }
    const start = line.indexOf('<!--', i);
    if (start < 0) break;
    for (let j = start; j < line.length; j++) chars[j] = ' ';
    const end = line.indexOf('-->', start + 4);
    if (end < 0) {
      state.html = true;
      break;
    }
    for (let j = start; j < end + 3; j++) chars[j] = ' ';
    i = end + 3;
  }
  return chars.join('');
}

export function maskMarkdown(content) {
  const state = { html: false, fence: null };
  return content.split('\n').map((line) => {
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (state.fence) {
      if (fence && fence[1][0] === state.fence) state.fence = null;
      return ' '.repeat(line.length);
    }
    if (fence) {
      state.fence = fence[1][0];
      return ' '.repeat(line.length);
    }
    return maskHtml(line, state).replace(/(`+)(.*?)\1/g, (m) => ' '.repeat(m.length));
  }).join('\n');
}

export function extractLinks(note, catalog) {
  const masked = maskMarkdown(note.content);
  const links = [];
  const linkedIds = new Set();
  const re = /!?\[\[([^\]\n]+)\]\]/g;
  let match;
  while ((match = re.exec(masked))) {
    const resolved = resolveTarget(match[1], catalog);
    const line = masked.slice(0, match.index).split('\n').length;
    links.push({ raw: match[1], line, ...resolved });
    if (resolved.matches.length === 1) linkedIds.add(resolved.matches[0].id);
  }
  return { links, linkedIds };
}
