#!/usr/bin/env node
// 옛 기억 검색 — ADR·위키·worklog·대화 글 사본을 한 번에 찾는다. 색인 없이 글자 그대로 찾는다
// (필수 도구는 git·Node뿐, DB 없음). 결정: D-프로젝트-기억-분담(결정 6·8).
//
// 명령:
//   search "<검색어>" [--limit N] [--source adr,wiki,worklog,dialogue,tools,raw] [--json]
//     raw = Claude Code 원본 세션 기록(~/.claude/projects/<프로젝트>/<세션>.jsonl)의 사람 입력·AI 글.
//     기본 검색에는 넣지 않는다(느리고, 가려지지 않은 글이다). 사본이 덮지 않는 시기나 사용자 원문이 필요할 때 --source raw로 부른다.
//   show <번호…> [--around]    검색 결과·파일 주입 목록의 번호로 상세를 본다
//   forget "<문구>" [--apply]   forget 스킬이 부른다. 기본은 미리 보기, --apply면 orbit 사본에서 지운다
//
// 순위: 맞은 검색어의 무게 합 → 최근성. 무게는 그 출처에서 드문 낱말일수록 크다(거의 모든 글에
// 나오는 낱말은 0에 가깝다). 같은 낱말이 여러 번 나오는 긴 글이 유리해지지 않게 횟수는 세지 않는다.
// 검색어는 앞뒤 문장부호를 떼고, 한 글자 낱말은 뺀다(글자 맞추기라 '이'·'그'·'안'이 거의 모든 글에 걸린다). 결과는 출처별로 ADR → 위키 → worklog → 대화 글 사본
// 순서로 묶고, 출처마다 상위 N개만 넘긴다(토큰 절약은 DB가 아니라 순위와 상한으로).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { clip, dialogueId, git, isHumanPrompt, isNotification, localTime, readTranscript, sharedMemoryDir, shortSession, textOf, toolsId, withLock, writePrivateFile } from './memory-lib.mjs';
import { redact } from './redact.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = path.join(ROOT, '{{DOCS_DIR}}');
const SOURCES = ['adr', 'wiki', 'worklog', 'dialogue', 'tools']; // 기본으로 찾는 곳
const ALL_SOURCES = [...SOURCES, 'raw']; // raw는 --source로 부를 때만
const SOURCE_TITLES = { adr: 'ADR(결정)', wiki: '위키', worklog: 'worklog', dialogue: '대화 글 사본', tools: '도구 활동', raw: '원본 세션 기록(가려지지 않은 글)' };
const OUTPUT_LIMIT = 12000;
const SNIPPET_LINES = 3;
const LINE_LIMIT = 220;
const TURN_LIMIT = 900;
const SHOW_LIMIT = 12000;

// 앞뒤 문장부호를 떼고 한 글자 낱말을 뺀다. 그러고 남는 것이 없으면(검색어가 모두 한 글자) 뗀 것만 쓴다.
function terms(query) {
  const cleaned = String(query || '').toLowerCase().split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean);
  const long = cleaned.filter((word) => [...word].length >= 2);
  return [...new Set(long.length ? long : cleaned)];
}

function score(text, words) {
  const lower = text.toLowerCase();
  return words.filter((word) => lower.includes(word)).length;
}

// 출처 하나 안에서 낱말마다 무게를 매긴다: 드문 낱말일수록 크고, 거의 모든 글에 나오면 0에 가깝다.
function weigh(items, words) {
  const lowers = items.map((item) => String(item.body ?? '').toLowerCase());
  const total = lowers.length;
  const weights = words.map((word) => Math.log((total + 1) / (lowers.filter((text) => text.includes(word)).length + 0.5)));
  items.forEach((item, index) => {
    item.weight = words.reduce((sum, word, at) => (lowers[index].includes(word) ? sum + Math.max(weights[at], 0.01) : sum), 0);
    delete item.body;
  });
  return items;
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
      body: text,
      // '⚠️ …으로 대체됨'은 전체 대체, '⚠️ …으로 일부 대체됨'만 있으면 여전히 유효한 결정이다.
      superseded: head.split('\n').some((line) => /대체됨/.test(line) && !/일부\s*대체됨/.test(line)),
      partlySuperseded: /일부\s*대체됨/.test(head),
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
      body: text,
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
      body: block,
      time: index, // 파일 순서가 곧 시간 순서
      ref: (block.match(/^## \[([^\]]+)\]/) || [])[1],
      text: clip(block.trim(), TURN_LIMIT),
    }));
}

function readShared(name) {
  const shared = sharedMemoryDir(ROOT);
  const file = shared ? path.join(shared, name) : null;
  if (!file || !fs.existsSync(file)) return [];
  const records = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch {}
  }
  return records;
}

function readDialogue() {
  return readShared('dialogue.jsonl');
}

// 도구 활동: 이름·파일·명령·패턴에서 찾는다. 같은 턴의 여러 줄은 한 결과로 묶는다.
function searchTools(words) {
  const turns = new Map();
  for (const record of readShared('tools.jsonl')) {
    const key = `${record.session}#${record.seq}`;
    if (!turns.has(key)) turns.set(key, { source: 'tools', time: 0, records: [] });
    const turn = turns.get(key);
    turn.records.push(record);
    turn.time = Math.max(turn.time, Date.parse(record.at) || 0);
  }
  return [...turns.values()].map((turn) => {
    const hits = turn.records.filter((r) => score([r.tool, r.file, r.command, r.pattern, r.agent].filter(Boolean).join(' '), words) > 0);
    const text = turn.records.map((r) => [r.tool, r.file, r.command, r.pattern, r.agent].filter(Boolean).join(' ')).join('\n');
    return { ...turn, score: score(text, words), body: text, hits };
  });
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
      body: `${record.user}\n${record.assistant}`,
      time: Date.parse(record.at) || 0,
      record,
      before: siblings[at - 1] || null,
      after: siblings[at + 1] || null,
    };
  });
}

// ── 원본 세션 기록(raw) ──────────────────────────────────────────────────────────
// Claude Code가 남긴 세션 jsonl에서 사람 입력과 AI 글만 뽑아 턴으로 묶는다(도구 출력·서브에이전트 대화는 뺀다).
// 대화 글 사본이 덮지 않는 시기(orbit 설치 전, 다른 컴퓨터에서 가져온 세션의 앞부분)의 원문을 찾는 길이다.
// 사본과 달리 디스크에 가려 둔 글이 아니므로, 보여 줄 때 비밀값을 가린다. Claude Code가 지운 기록은 찾지 못한다.
function claudeProjectDirs() {
  const base = process.env.ORBIT_CLAUDE_PROJECTS_DIR
    || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  const roots = new Set([path.resolve(ROOT)]);
  const listed = git(ROOT, ['worktree', 'list', '--porcelain']) || '';
  for (const line of listed.split('\n')) if (line.startsWith('worktree ')) roots.add(path.resolve(line.slice(9).trim()));
  const dirs = new Set([...roots].map((root) => path.join(base, root.replace(/[^A-Za-z0-9]/g, '-'))));
  // 사본의 책갈피가 기억하는 세션 파일 위치(폴더 이름을 바꿨거나 옮긴 경우)
  const shared = sharedMemoryDir(ROOT);
  try {
    const cursors = JSON.parse(fs.readFileSync(path.join(shared, 'cursors.json'), 'utf8'));
    for (const cursor of Object.values(cursors)) if (cursor?.transcript) dirs.add(path.dirname(cursor.transcript));
  } catch {}
  return [...dirs].filter((dir) => fs.existsSync(dir));
}

function rawSessionFiles() {
  const files = new Map();
  for (const dir of claudeProjectDirs()) {
    for (const name of fs.readdirSync(dir)) if (name.endsWith('.jsonl') && !files.has(name)) files.set(name, path.join(dir, name));
  }
  return [...files.values()];
}

let rawCache = null;
function readRawTurns() {
  if (rawCache) return rawCache;
  const copied = new Map(); // 세션 → 사본에 든 사용자 글(이미 사본에 있는 턴은 raw 결과에서 뺀다)
  const squeeze = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  for (const record of readDialogue()) copied.set(record.session, `${copied.get(record.session) || ''}\n${squeeze(record.user)}`);
  const turns = [];
  for (const file of rawSessionFiles()) {
    const session = path.basename(file, '.jsonl');
    let turn = null;
    readTranscript(file).forEach((entry, index) => {
      if (entry?.isSidechain) return;
      if (isHumanPrompt(entry)) {
        const text = textOf(entry).trim();
        if (isNotification(text)) return;
        if (turn) turns.push(turn);
        turn = { session, line: index + 1, at: entry.timestamp || '', user: text, assistant: [], file };
      } else if (entry?.type === 'assistant' && turn) {
        const text = textOf(entry).trim();
        if (text) turn.assistant.push(text);
      }
    });
    if (turn) turns.push(turn);
  }
  for (const turn of turns) {
    turn.assistant = turn.assistant.join('\n\n');
    turn.inCopy = (copied.get(turn.session) || '').includes(squeeze(turn.user).slice(0, 60));
  }
  rawCache = turns;
  return turns;
}

const rawId = (turn) => `r:${shortSession(turn.session)}:${turn.line}`;

function searchRaw(words) {
  return readRawTurns().filter((turn) => !turn.inCopy).map((turn) => ({
    source: 'raw',
    score: score(`${turn.user}\n${turn.assistant}`, words),
    body: `${turn.user}\n${turn.assistant}`,
    time: Date.parse(turn.at) || 0,
    turn,
  }));
}

const SEARCHERS = { adr: searchAdr, wiki: searchWiki, worklog: searchWorklog, dialogue: searchDialogue, tools: searchTools, raw: searchRaw };

function rank(items) {
  return items
    .filter((item) => item.score > 0)
    .sort((a, b) => (b.weight - a.weight) || (Number(Boolean(a.superseded)) - Number(Boolean(b.superseded))) || (b.time - a.time));
}

// 찾은 범위를 한 줄로: 어디를 찾았고 어디는 안 찾았는지, 사본이 언제부터인지. "없다"가 "찾은 곳에 없다"인지
// "어디에도 없다"인지 읽는 쪽이 가를 수 있게 한다.
function coverage(sources) {
  const day = (at) => (at ? localTime(at).slice(0, 10) : '?');
  const notes = [];
  const dialogue = readDialogue();
  if (sources.includes('dialogue')) {
    notes.push(dialogue.length
      ? `대화 글 사본은 ${day(dialogue[0].at)}부터 ${dialogue.length}턴(그 전 대화와 다른 컴퓨터에서 한 턴은 사본에 없음)`
      : '대화 글 사본은 비어 있음');
  }
  if (sources.includes('raw')) {
    const turns = readRawTurns();
    const times = turns.map((turn) => turn.at).filter(Boolean).sort();
    notes.push(turns.length
      ? `원본 세션 기록은 이 컴퓨터의 세션 ${new Set(turns.map((turn) => turn.session)).size}개, ${day(times[0])}~${day(times[times.length - 1])}, ${turns.length}턴(사본에 이미 든 ${turns.filter((turn) => turn.inCopy).length}턴은 목록에서 뺌)`
      : '원본 세션 기록은 이 컴퓨터에 없음');
  } else {
    notes.push('원본 세션 기록은 찾지 않음(--source raw로 찾는다. Claude Code가 지웠거나 다른 컴퓨터에만 있는 기록은 거기에도 없다)');
  }
  return `찾은 범위: ${sources.map((source) => SOURCE_TITLES[source].replace(/\(.*\)$/, '')).join(' · ')} — ${notes.join(' / ')}`;
}

// 번호 체계: worklog `#N`(요약은 `#a~b`), 대화 사본 `d:<세션 앞 8자>:<턴>`, 도구 색인 `t:<세션 앞 8자>:<턴>`,
// 원본 세션 기록 `r:<세션 앞 8자>:<줄>`,
// ADR·위키는 파일 경로. 검색은 번호 + 한 줄 발췌만 보여 주고, 상세는 `show <번호>`로 본다
// (목록 먼저, 필요한 것만 상세 — 토큰을 아낀다).
const when = (at) => localTime(at);
const oneLine = (text, limit) => clip(String(text || '').replace(/\s+/g, ' ').trim(), limit);

function toolLine(r) {
  return `${r.tool}${r.file ? ` ${r.file}` : ''}${r.command ? ` $ ${clip(r.command, 120)}` : ''}${r.pattern ? ` /${r.pattern}/` : ''}${r.agent ? ` (${r.agent})` : ''}`;
}

function formatItem(item, total) {
  const mark = `[${item.score}/${total}]`;
  if (item.source === 'adr' || item.source === 'wiki') {
    const flag = item.superseded ? ' (대체됨 — 참고만)' : item.partlySuperseded ? ' (일부 대체됨 — 대체한 결정도 확인)' : '';
    const line = item.lines[0] ? `\n    > ${item.lines[0]}` : '';
    return `- ${mark} ${item.ref} — ${oneLine(item.title, 120)}${flag}${line}`;
  }
  if (item.source === 'worklog') {
    const ask = (item.text.match(/^- 물음: (.*)$/m) || [])[1] || item.text.split('\n')[1] || '';
    const date = (item.text.match(/\] (\d{4}-\d{2}-\d{2})/) || [])[1] || '';
    return `- ${mark} #${item.ref.replace(/^(요약 )?#/, '')} · ${date} · ${oneLine(ask, 150)}`;
  }
  if (item.source === 'tools') {
    const first = { ...item.records[0], worklog: item.records.find((r) => r.worklog)?.worklog ?? null };
    const hit = (item.hits[0] || first);
    return `- ${mark} ${toolsId(first)} · ${when(first.at)} · 도구 ${item.records.length}회${first.worklog ? ` · worklog #${first.worklog}` : ''} · ${oneLine(toolLine(hit), 140)}`;
  }
  if (item.source === 'raw') {
    const t = item.turn;
    return `- ${mark} ${rawId(t)} · ${when(t.at)} · 사용자: ${oneLine(redact(t.user), 110)}`;
  }
  const r = item.record;
  return `- ${mark} ${dialogueId(r)} · ${when(r.at)} · ${path.basename(String(r.worktree || ''))}${r.worklog ? ` · worklog #${r.worklog}` : ''} · 사용자: ${oneLine(r.user, 110)}`;
}

function search(query, { limit = 5, sources = SOURCES, json = false } = {}) {
  const words = terms(query);
  if (!words.length) throw new Error('검색어가 비었습니다.');
  const groups = sources.map((source) => ({ source, items: rank(weigh(SEARCHERS[source](words), words)).slice(0, limit) }));
  if (json) {
    process.stdout.write(`${JSON.stringify({ query, terms: words, coverage: coverage(sources), groups }, null, 2)}\n`);
    return;
  }
  const out = [`── 기억 검색: "${query}" (출처별 상위 ${limit}, 순위: 맞은 검색어의 무게 → 최근) ──`];
  let found = 0;
  for (const group of groups) {
    if (!group.items.length) continue;
    found += group.items.length;
    out.push('', `## ${SOURCE_TITLES[group.source]} (${group.items.length}건)`);
    for (const item of group.items) out.push(formatItem(item, words.length));
  }
  if (!found) out.push('', '찾은 것이 없습니다. 낱말을 바꾸거나 줄여 다시 찾아 보세요. 아래 "찾은 범위" 밖에는 있을 수 있습니다.');
  else out.push('', '상세: node scripts/memory.mjs show <번호> [--around] — 번호는 #N(worklog)·d:…(대화 사본)·t:…(도구 활동)·r:…(원본 세션 기록)·파일 경로');
  out.push(coverage(sources));
  let text = out.join('\n');
  if (text.length > OUTPUT_LIMIT) text = `${text.slice(0, OUTPUT_LIMIT - 60)}\n…(출력 상한 ${OUTPUT_LIMIT}자에서 자름 — --limit를 줄이세요)`;
  process.stdout.write(`${text}\n`);
}

// ── show: 번호로 상세 보기 ────────────────────────────────────────────────────────
function showWorklog(ref) {
  const file = path.join(DOCS, 'worklog.md');
  if (!fs.existsSync(file)) return null;
  const header = ref.includes('~') ? `## [요약 #${ref}]` : `## [#${ref}]`;
  const block = fs.readFileSync(file, 'utf8').split(/\n(?=## \[)/).find((b) => b.startsWith(header));
  return block ? block.trim() : null;
}

function formatDialogue(record, label) {
  const meta = [when(record.at), `세션 ${record.session}`, path.basename(String(record.worktree || '')),
    record.worklog ? `worklog #${record.worklog}` : '', record.files?.length ? `바뀐 파일(추정): ${record.files.join(', ')}` : '']
    .filter(Boolean).join(' · ');
  return [`### ${label} ${dialogueId(record)}`, meta, '', `사용자: ${record.user || '(없음)'}`, '', `AI: ${record.assistant || '(없음)'}`].join('\n');
}

function showItem(id, { around = false } = {}) {
  let match = id.match(/^##?(\d+(?:~\d+)?)$/); // 0.2.0 검색 목록의 '##N'도 받는다
  if (match) return showWorklog(match[1]) || `${id}: worklog에 그 항목이 없습니다.`;
  match = id.match(/^r:([^:]+):(\d+)$/);
  if (match) {
    const turns = readRawTurns().filter((t) => t.session.startsWith(match[1]));
    const index = turns.findIndex((t) => String(t.line) === match[2]);
    if (index === -1) return `${id}: 원본 세션 기록에 그 턴이 없습니다(Claude Code가 지웠거나 다른 컴퓨터에 있을 수 있습니다).`;
    const one = (t, label) => [`### ${label} ${rawId(t)}`, `${when(t.at)} · 세션 ${t.session} · 원본 ${t.file} ${t.line}번째 줄${t.inCopy ? ' · 대화 글 사본에도 있음' : ''}`, '',
      `사용자: ${redact(t.user) || '(없음)'}`, '', `AI: ${redact(t.assistant) || '(없음)'}`].join('\n');
    const parts = [];
    if (around && turns[index - 1]) parts.push(one(turns[index - 1], '(앞 턴)'));
    parts.push(one(turns[index], '▶'));
    if (around && turns[index + 1]) parts.push(one(turns[index + 1], '(뒤 턴)'));
    return parts.join('\n\n');
  }
  match = id.match(/^([dt]):([^:]+):(\d+)$/);
  if (match) {
    const [, kind, prefix, seq] = match;
    const records = readShared(kind === 'd' ? 'dialogue.jsonl' : 'tools.jsonl');
    const same = (r) => String(r.session || '').startsWith(prefix);
    if (kind === 't') {
      const turn = records.filter((r) => same(r) && String(r.seq) === seq);
      if (!turn.length) return `${id}: 도구 색인에 그 턴이 없습니다.`;
      const worklog = turn.find((r) => r.worklog)?.worklog;
      return [`### 도구 활동 ${id} · ${when(turn[0].at)}${worklog ? ` · worklog #${worklog}` : ''} · ${turn.length}회`, ...turn.map((r) => `- ${toolLine(r)}`)].join('\n');
    }
    const session = records.filter(same);
    const index = session.findIndex((r) => String(r.seq) === seq);
    if (index === -1) return `${id}: 대화 사본에 그 턴이 없습니다.`;
    const parts = [];
    if (around && session[index - 1]) parts.push(formatDialogue(session[index - 1], '(앞 턴)'));
    parts.push(formatDialogue(session[index], '▶'));
    if (around && session[index + 1]) parts.push(formatDialogue(session[index + 1], '(뒤 턴)'));
    return parts.join('\n\n');
  }
  const file = path.resolve(ROOT, id);
  if (file.startsWith(path.resolve(ROOT)) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    return [`### ${path.relative(ROOT, file)}`, ...lines.slice(0, 300), lines.length > 300 ? `…(앞 300줄만 — 나머지는 Read로)` : ''].join('\n');
  }
  return `${id}: 알 수 없는 번호입니다. #N · d:<세션>:<턴> · t:<세션>:<턴> · r:<세션>:<줄> · 저장소 안 파일 경로를 씁니다.`;
}

function show(ids, options) {
  if (!ids.length) throw new Error('볼 번호가 없습니다.');
  let text = ids.map((id) => showItem(id, options)).join('\n\n---\n\n');
  if (text.length > SHOW_LIMIT) text = `${text.slice(0, SHOW_LIMIT - 60)}\n…(출력 상한 ${SHOW_LIMIT}자에서 자름)`;
  process.stdout.write(`${text}\n`);
}

// ── 잊어 줘(forget 스킬) ────────────────────────────────────────────────────────────
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
const aroundFlag = argv.includes('--around');
if (aroundFlag) argv.splice(argv.indexOf('--around'), 1);
const limitArg = takeOption(argv, '--limit');
const sourceArg = takeOption(argv, '--source');
const [command, ...rest] = argv;
try {
  if (command === 'search') {
    const sources = sourceArg ? sourceArg.split(',').map((s) => s.trim()).filter((s) => ALL_SOURCES.includes(s)) : SOURCES;
    if (!sources.length) throw new Error(`--source는 ${ALL_SOURCES.join(',')} 가운데서 고릅니다.`);
    const limit = limitArg ? Math.max(1, Math.min(20, Number(limitArg) || 5)) : 5;
    search(rest.join(' '), { limit, sources, json });
  } else if (command === 'show') {
    show(rest, { around: aroundFlag });
  } else if (command === 'forget') {
    forget(rest.join(' '), { apply: applyFlag });
  } else {
    process.stderr.write('사용법: memory.mjs search "<검색어>" [--limit N] [--source adr,wiki,worklog,dialogue,tools,raw] [--json]\n       memory.mjs show <번호…> [--around]\n       memory.mjs forget "<문구>" [--apply]\n');
    process.exit(1);
  }
} catch (error) {
  process.stderr.write(`기억 검색 실패: ${error.message}\n`);
  process.exit(1);
}
