#!/usr/bin/env node
// 옛 기억 검색 — ADR·위키·worklog·대화 글 사본을 한 번에 찾는다. 색인 없이 글자 그대로 찾는다
// (필수 도구는 git·Node뿐, DB 없음). 결정: D-프로젝트-기억-분담(결정 6·8).
//
// 명령:
//   search "<검색어>" [--limit N] [--source adr,wiki,worklog,dialogue] [--json]
//   forget "<문구>" [--apply]   /forget 스킬이 부른다. 기본은 미리 보기, --apply면 orbit 사본에서 지운다
//
// 순위: 서로 다른 검색어가 몇 개 맞았는지 → 최근성. 같은 낱말이 여러 번 나오는 긴 글이
// 유리해지지 않게 횟수는 세지 않는다. 결과는 출처별로 ADR → 위키 → worklog → 대화 글 사본
// 순서로 묶고, 출처마다 상위 N개만 넘긴다(토큰 절약은 DB가 아니라 순위와 상한으로).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clip, git, sharedMemoryDir, withLock, writePrivateFile } from './memory-lib.mjs';

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

// ── 잊어 줘(/forget) ────────────────────────────────────────────────────────────
// orbit이 쌓은 사본(대화 글 사본·도구 색인·컴팩션 상태 파일과 요약)에서 문구가 든 기록을 통째로
// 지운다. git이 추적하는 원장은 고치지 않고 파일:줄만 알려 준다(스킬이 사용자 확인 뒤 고친다).
// Claude Code 원본 세션 기록·자동 기억·git 이력은 orbit이 지우지 않는다.
// 결정: D-잊어줘-슬래시명령(D-프로젝트-기억-분담 결정 6의 진화).
const JSONL_STORES = ['dialogue.jsonl', 'tools.jsonl'];

function textFields(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textFields).join('\n');
  if (value && typeof value === 'object') return Object.values(value).map(textFields).join('\n');
  return '';
}

function compactDirs() {
  const common = git(ROOT, ['rev-parse', '--git-common-dir']);
  if (!common) return [];
  const base = path.resolve(ROOT, common);
  const dirs = [path.join(base, 'orbit-state', 'compact')];
  const worktrees = path.join(base, 'worktrees');
  if (fs.existsSync(worktrees)) for (const name of fs.readdirSync(worktrees)) dirs.push(path.join(worktrees, name, 'orbit-state', 'compact'));
  return dirs.filter((dir) => fs.existsSync(dir));
}

// 문서 볼트 전체(추적 여부와 관계없이)와 CLAUDE.md·AGENTS.md의 .md·.json 파일을 훑는다.
function ledgerFiles(dir = DOCS, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) ledgerFiles(full, out);
    else if (/\.(md|json)$/.test(entry.name)) out.push(path.relative(ROOT, full));
  }
  return out;
}

function ledgerHits(needle) {
  const hits = [];
  for (const rel of [...ledgerFiles(), 'CLAUDE.md', 'AGENTS.md']) {
    let text;
    try { text = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
    text.split('\n').forEach((line, index) => {
      if (line.toLowerCase().includes(needle)) hits.push(`${rel}:${index + 1}: ${clip(line.trim(), 160)}`);
    });
  }
  return hits;
}

function forget(phrase, { apply = false } = {}) {
  const trimmed = String(phrase || '').trim();
  if ([...trimmed].length < 2) throw new Error('지울 문구는 두 글자 이상이어야 합니다(너무 짧으면 엉뚱한 기록까지 지웁니다).');
  const needle = trimmed.toLowerCase();
  const shared = sharedMemoryDir(ROOT);
  const report = { phrase: trimmed, apply, stores: [], compact: [], ledgers: ledgerHits(needle) };
  const work = () => {
    for (const name of JSONL_STORES) {
      const file = shared ? path.join(shared, name) : null;
      if (!file || !fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const keep = [];
      const removed = [];
      for (const line of lines) {
        let text = line;
        try { text = textFields(JSON.parse(line)); } catch {}
        (text.toLowerCase().includes(needle) ? removed : keep).push(line);
      }
      report.stores.push({ name, total: lines.length, removed: removed.length });
      if (apply && removed.length) writePrivateFile(file, keep.length ? `${keep.join('\n')}\n` : '');
    }
    for (const dir of compactDirs()) {
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        if (!fs.statSync(file).isFile() || !fs.readFileSync(file, 'utf8').toLowerCase().includes(needle)) continue;
        report.compact.push(path.relative(ROOT, file));
        if (apply) fs.rmSync(file, { force: true });
      }
    }
  };
  if (shared && fs.existsSync(shared)) withLock(path.join(shared, '.lock'), work);
  else work();

  const verb = apply ? '지움' : '지울 대상(미리 보기)';
  const out = [`── 잊어 줘: "${trimmed}" — ${apply ? '적용함' : '미리 보기(아직 아무것도 지우지 않음)'} ──`, '', '## orbit 사본'];
  for (const store of report.stores) out.push(`- ${store.name}: ${store.removed}/${store.total}줄 ${verb}`);
  if (!report.stores.length) out.push('- 사본 없음');
  out.push(`- 컴팩션 상태 파일·요약: ${report.compact.length}개 ${verb}`, ...report.compact.map((file) => `    - ${file}`));
  out.push('', '## 문서 원장(worklog·ADR·위키·할일·CLAUDE.md — 자동으로 고치지 않음, 확인 뒤 현재 파일에서 고친다)');
  out.push(...(report.ledgers.length ? report.ledgers.slice(0, 50).map((hit) => `- ${hit}`) : ['- 없음']));
  if (report.ledgers.length > 50) out.push(`- …외 ${report.ledgers.length - 50}줄`);
  out.push('', '## orbit이 지우지 못하는 곳',
    '- git 이력: 원장을 고쳐도 옛 커밋에는 남는다. 이력까지 지울지는 따로 정한다.',
    '- Claude Code 원본 세션 기록(~/.claude/projects/…의 jsonl)과 자동 기억(MEMORY.md)',
    '- 지금 대화의 문맥: 컴팩션이나 새 세션 전까지는 남아 있다.');
  process.stdout.write(`${out.join('\n')}\n`);
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
const applyFlag = argv.includes('--apply');
if (applyFlag) argv.splice(argv.indexOf('--apply'), 1);
const limitArg = takeOption(argv, '--limit');
const sourceArg = takeOption(argv, '--source');
const [command, ...rest] = argv;
try {
  if (command === 'search') {
    const sources = sourceArg ? sourceArg.split(',').map((s) => s.trim()).filter((s) => SOURCES.includes(s)) : SOURCES;
    if (!sources.length) throw new Error(`--source는 ${SOURCES.join(',')} 가운데서 고릅니다.`);
    const limit = limitArg ? Math.max(1, Math.min(20, Number(limitArg) || 5)) : 5;
    search(rest.join(' '), { limit, sources, json });
  } else if (command === 'forget') {
    forget(rest.join(' '), { apply: applyFlag });
  } else {
    process.stderr.write('사용법: memory.mjs search "<검색어>" [--limit N] [--source adr,wiki,worklog,dialogue] [--json]\n       memory.mjs forget "<문구>" [--apply]\n');
    process.exit(1);
  }
} catch (error) {
  process.stderr.write(`기억 검색 실패: ${error.message}\n`);
  process.exit(1);
}
