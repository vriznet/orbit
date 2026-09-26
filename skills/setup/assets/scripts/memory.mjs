#!/usr/bin/env node
// 옛 기억 검색 — ADR·위키·worklog·대화 글 사본을 한 번에 찾는다. 색인 없이 글자 그대로 찾는다
// (필수 도구는 git·Node뿐, DB 없음). 결정: D-프로젝트-기억-분담(결정 6·8).
//
// 명령:
//   search "<검색어>" [--limit N] [--source adr,wiki,worklog,dialogue] [--json]
//
// 순위: 서로 다른 검색어가 몇 개 맞았는지 → 최근성. 같은 낱말이 여러 번 나오는 긴 글이
// 유리해지지 않게 횟수는 세지 않는다. 결과는 출처별로 ADR → 위키 → worklog → 대화 글 사본
// 순서로 묶고, 출처마다 상위 N개만 넘긴다(토큰 절약은 DB가 아니라 순위와 상한으로).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clip, sharedMemoryDir } from './memory-lib.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = path.join(ROOT, '{{DOCS_DIR}}');
const SOURCES = ['adr', 'wiki', 'worklog', 'dialogue'];
const SOURCE_TITLES = { adr: 'ADR(결정)', wiki: '위키', worklog: 'worklog', dialogue: '대화 글 사본' };
const OUTPUT_LIMIT = 12000;
const SNIPPET_LINES = 3;
const LINE_LIMIT = 220;
const TURN_LIMIT = 900;
const NEIGHBOR_LIMIT = 300;

function terms(query) {
  return [...new Set(String(query || '').toLowerCase().split(/\s+/).filter(Boolean))];
}

function score(text, words) {
  const lower = text.toLowerCase();
  return words.filter((word) => lower.includes(word)).length;
}

// 발췌 줄은 검색어가 많이 맞은 줄부터, 같으면 앞에 나온 줄부터 고른다.
function matchingLines(text, words) {
  return text.split('\n')
    .map((line, index) => ({ line: line.trim(), index, hits: score(line, words) }))
    .filter((item) => item.line && item.hits > 0)
    .sort((a, b) => (b.hits - a.hits) || (a.index - b.index))
    .slice(0, SNIPPET_LINES)
    .sort((a, b) => a.index - b.index)
    .map((item) => clip(item.line, LINE_LIMIT));
}

function listMarkdown(dir, skip = () => false) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdown(full, skip));
    else if (entry.name.endsWith('.md') && !skip(entry.name)) out.push(full);
  }
  return out;
}

function stampFromName(name) {
  const match = name.match(/-(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.md$/);
  return match ? Date.parse(`20${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`) : null;
}

function searchAdr(words) {
  return listMarkdown(path.join(DOCS, 'decisions'), (name) => name === 'README.md').map((file) => {
    const text = fs.readFileSync(file, 'utf8');
    const head = text.split('\n').slice(0, 6).join('\n');
    return {
      source: 'adr',
      score: score(text, words),
      superseded: /대체됨/.test(head),
      time: stampFromName(path.basename(file)) ?? fs.statSync(file).mtimeMs,
      ref: path.relative(ROOT, file),
      title: (text.match(/^#\s+(.+)$/m) || [])[1] || path.basename(file),
      lines: matchingLines(text, words),
    };
  });
}

function searchWiki(words) {
  return listMarkdown(path.join(DOCS, 'wiki'), (name) => name.startsWith('_')).map((file) => {
    const text = fs.readFileSync(file, 'utf8');
    const updated = (text.match(/^updated:\s*"?(\d{4}-\d{2}-\d{2})/m) || [])[1];
    return {
      source: 'wiki',
      score: score(text, words),
      time: updated ? Date.parse(updated) : fs.statSync(file).mtimeMs,
      ref: path.relative(ROOT, file),
      title: (text.match(/^title:\s*"?(.+?)"?\s*$/m) || text.match(/^#\s+(.+)$/m) || [])[1] || path.basename(file),
      lines: matchingLines(text, words),
    };
  });
}

function searchWorklog(words) {
  const file = path.join(DOCS, 'worklog.md');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\n(?=## \[)/)
    .filter((block) => block.startsWith('## ['))
    .map((block, index) => ({
      source: 'worklog',
      score: score(block, words),
      time: index, // 파일 순서가 곧 시간 순서
      ref: (block.match(/^## \[([^\]]+)\]/) || [])[1],
      text: clip(block.trim(), TURN_LIMIT),
    }));
}

function readDialogue() {
  const shared = sharedMemoryDir(ROOT);
  const file = shared ? path.join(shared, 'dialogue.jsonl') : null;
  if (!file || !fs.existsSync(file)) return [];
  const records = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch {}
  }
  return records;
}

function searchDialogue(words) {
  const records = readDialogue();
  const bySession = new Map();
  for (const record of records) {
    if (!bySession.has(record.session)) bySession.set(record.session, []);
    bySession.get(record.session).push(record);
  }
  return records.map((record) => {
    const siblings = bySession.get(record.session);
    const at = siblings.indexOf(record);
    return {
      source: 'dialogue',
      score: score(`${record.user}\n${record.assistant}`, words),
      time: Date.parse(record.at) || 0,
      record,
      before: siblings[at - 1] || null,
      after: siblings[at + 1] || null,
    };
  });
}

const SEARCHERS = { adr: searchAdr, wiki: searchWiki, worklog: searchWorklog, dialogue: searchDialogue };

function rank(items) {
  return items
    .filter((item) => item.score > 0)
    .sort((a, b) => (b.score - a.score) || (Number(Boolean(a.superseded)) - Number(Boolean(b.superseded))) || (b.time - a.time));
}

function dialogueTurn(record, limit) {
  const who = [
    record.user ? `사용자: ${clip(record.user.replace(/\s+/g, ' '), limit)}` : '',
    record.assistant ? `AI: ${clip(record.assistant.replace(/\s+/g, ' '), limit)}` : '',
  ].filter(Boolean);
  return who.join('\n    ');
}

function formatItem(item, total) {
  const mark = `[${item.score}/${total}]`;
  if (item.source === 'adr' || item.source === 'wiki') {
    const flag = item.superseded ? ' (대체됨 — 참고만)' : '';
    return [`- ${mark} ${item.ref} — ${item.title}${flag}`, ...item.lines.map((line) => `    > ${line}`)].join('\n');
  }
  if (item.source === 'worklog') return `- ${mark} worklog [${item.ref}]\n    ${item.text.replace(/\n/g, '\n    ')}`;
  const r = item.record;
  const head = `- ${mark} ${String(r.at || '').slice(0, 16).replace('T', ' ')} · 세션 ${String(r.session || '').slice(0, 8)} · ${path.basename(String(r.worktree || ''))}${r.worklog ? ` · worklog #${r.worklog}` : ''}${r.files?.length ? ` · 바뀐 파일(추정) ${r.files.slice(0, 5).join(', ')}` : ''}`;
  const parts = [head];
  if (item.before) parts.push(`  (앞 턴) ${dialogueTurn(item.before, NEIGHBOR_LIMIT)}`);
  parts.push(`  ▶ ${dialogueTurn(r, TURN_LIMIT)}`);
  if (item.after) parts.push(`  (뒤 턴) ${dialogueTurn(item.after, NEIGHBOR_LIMIT)}`);
  return parts.join('\n');
}

function search(query, { limit = 5, sources = SOURCES, json = false } = {}) {
  const words = terms(query);
  if (!words.length) throw new Error('검색어가 비었습니다.');
  const groups = sources.map((source) => ({ source, items: rank(SEARCHERS[source](words)).slice(0, limit) }));
  if (json) {
    process.stdout.write(`${JSON.stringify({ query, terms: words, groups }, null, 2)}\n`);
    return;
  }
  const out = [`── 기억 검색: "${query}" (출처별 상위 ${limit}, 순위: 맞은 검색어 수 → 최근) ──`];
  let found = 0;
  for (const group of groups) {
    if (!group.items.length) continue;
    found += group.items.length;
    out.push('', `## ${SOURCE_TITLES[group.source]} (${group.items.length}건)`);
    for (const item of group.items) out.push(formatItem(item, words.length));
  }
  if (!found) out.push('', '찾은 것이 없습니다. 낱말을 바꾸거나 줄여 다시 찾아 보세요.');
  let text = out.join('\n');
  if (text.length > OUTPUT_LIMIT) text = `${text.slice(0, OUTPUT_LIMIT - 60)}\n…(출력 상한 ${OUTPUT_LIMIT}자에서 자름 — --limit를 줄이세요)`;
  process.stdout.write(`${text}\n`);
}

function takeOption(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  argv.splice(index, 2);
  return value ?? '';
}

const argv = process.argv.slice(2);
const json = argv.includes('--json');
if (json) argv.splice(argv.indexOf('--json'), 1);
const limitArg = takeOption(argv, '--limit');
const sourceArg = takeOption(argv, '--source');
const [command, ...rest] = argv;
try {
  if (command === 'search') {
    const sources = sourceArg ? sourceArg.split(',').map((s) => s.trim()).filter((s) => SOURCES.includes(s)) : SOURCES;
    if (!sources.length) throw new Error(`--source는 ${SOURCES.join(',')} 가운데서 고릅니다.`);
    const limit = limitArg ? Math.max(1, Math.min(20, Number(limitArg) || 5)) : 5;
    search(rest.join(' '), { limit, sources, json });
  } else {
    process.stderr.write('사용법: memory.mjs search "<검색어>" [--limit N] [--source adr,wiki,worklog,dialogue] [--json]\n');
    process.exit(1);
  }
} catch (error) {
  process.stderr.write(`기억 검색 실패: ${error.message}\n`);
  process.exit(1);
}
