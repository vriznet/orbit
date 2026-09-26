#!/usr/bin/env node
// 기억 훅 — 컴팩션 전후와 턴 끝에서 orbit이 맡는 기억 일을 한다. 모델을 부르지 않는다.
//   precompact       PreCompact: 마지막 worklog 기록 뒤 구간의 원문 조각을 상태 파일로 저장
//   compact-restore  SessionStart(compact): 상태 파일 + worklog 최근 기록(컴팩션 전 기록)을 주입
//   postcompact      PostCompact: 컴팩션 요약을 저장만 한다(측정·점검용, 주입 안 함)
//   turn-start       UserPromptSubmit: 턴 시작 git 상태 지문(바뀐 파일 추정용)
//   stop             Stop: 이번 턴의 사람·AI 글을 가려 대화 글 사본에, 도구 사용(이름·대상 파일·Bash 명령 앞부분)을
//                    도구 색인에 덧붙인다(결정 6·7). 도구 출력은 복사하지 않는다.
//   pre-tool         PreToolUse(Read·Edit·Write): 그 파일을 다룬 과거 턴을 '날짜 · 번호 · 한 줄' 목록으로
//                    넣는다(본문 없음, 상세는 memory.mjs show). 같은 세션에서 파일마다 한 번(컴팩션 뒤 다시).
//                    큰 코드 파일(기본 300줄)을 범위 없이 Read하면 개요와 '필요한 부분만 읽기' 안내도 함께 넣는다(막지 않음).
// 결정: D-프로젝트-기억-분담(결정 3). 실패해도 컴팩션을 막지 않는다(종료 코드 2를 쓰지 않음).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  WRITE_TOOLS, changedSince, clip, ensurePrivateDir, git, gitSnapshot, isHumanPrompt, isNotification, lastMarks,
  lastTodos, readHookInput, readTranscript, readTranscriptFrom, runningBackgroundTasks, safeName, sharedMemoryDir,
  dialogueId, localTime, repoRelative, textOf, toolFilePath, toolUses, toolsId, withLock, worktreeStateDir, writePrivateFile,
} from './memory-lib.mjs';
import { redact, redactPrefix } from './redact.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = path.join(ROOT, '{{DOCS_DIR}}');
const STATE_LIMIT = 8000; // SessionStart 주입 상한(1만 자) 안에 recent와 함께 들어가도록
const PROMPT_LIMIT = 1500;
const MAX_PROMPTS = 6;
const MAX_FILES = 40;

function relative(file) {
  return repoRelative(ROOT, file);
}

export function compactStatePath(sessionId) {
  const dir = worktreeStateDir(ROOT, 'compact');
  return dir ? path.join(dir, `${safeName(sessionId)}.md`) : null;
}

// worklog 훅이 연 채 아직 기록되지 않은 턴의 첫 입력 위치. 세션 기록만 보고 가리는 "마지막
// 기록"은 명령 문자열 속 같은 글자에 속을 수 있어, 이 위치부터는 항상 구간에 넣는다.
function pendingTurnStart(entries, sessionId) {
  const dir = worktreeStateDir(ROOT, 'worklog');
  if (!dir) return Infinity;
  let state;
  try { state = JSON.parse(fs.readFileSync(path.join(dir, `${safeName(sessionId)}.json`), 'utf8')); } catch { return Infinity; }
  const ids = new Set(state?.pending?.promptIds || []);
  if (!ids.size) return Infinity;
  const index = entries.findIndex((entry) => ids.has(entry?.promptId));
  return index === -1 ? Infinity : index;
}

function buildState(input) {
  const entries = readTranscript(input.transcript_path);
  const marks = lastMarks(entries);
  const from = Math.min(Math.max(marks.compact, marks.worklog) + 1, pendingTurnStart(entries, input.session_id));
  const segment = entries.slice(from);

  const prompts = [];
  let notices = 0;
  for (const entry of segment) {
    if (!isHumanPrompt(entry)) continue;
    const text = textOf(entry).trim();
    if (isNotification(text)) notices += 1;
    else prompts.push(clip(text, PROMPT_LIMIT));
  }
  const edited = [];
  for (const entry of segment) {
    for (const use of toolUses(entry)) {
      const file = WRITE_TOOLS.has(use.name) ? relative(toolFilePath(use)) : null;
      if (file && !edited.includes(file)) edited.push(file);
    }
  }
  const status = (git(ROOT, ['status', '--porcelain']) || '').split('\n').filter(Boolean).map((line) => line.slice(3));
  let lastAnswer = '';
  for (let index = segment.length - 1; index >= 0 && !lastAnswer; index -= 1) {
    if (segment[index]?.type === 'assistant') lastAnswer = textOf(segment[index]).trim();
  }
  const todos = lastTodos(entries);
  const running = runningBackgroundTasks(entries);

  const lines = [
    '# 컴팩션 전 상태 (orbit 상태 파일 — 세션 기록에서 기계로 뽑은 원문 조각)',
    `- 시각: ${localTime(new Date(), { offset: true })} · 계기: ${input.trigger || '알 수 없음'}`,
  ];
  if (input.custom_instructions) lines.push(`- /compact 초점 문구: ${clip(input.custom_instructions, 500)}`);
  lines.push('', `## 마지막 worklog 기록 뒤 사용자 입력 (원문, 오래된 순${notices ? ` · 백그라운드 알림 ${notices}건 제외` : ''})`);
  const shown = prompts.slice(-MAX_PROMPTS);
  if (prompts.length > shown.length) lines.push(`- (앞의 ${prompts.length - shown.length}개 생략)`);
  shown.forEach((text, index) => lines.push(`${index + 1}. ${text.replace(/\n/g, '\n   ')}`));
  if (!shown.length) lines.push('- 없음');
  lines.push('', '## 이 구간에서 도구로 고친 파일');
  lines.push(...(edited.length ? edited.slice(0, MAX_FILES).map((file) => `- ${file}`) : ['- 없음']));
  if (status.length) {
    lines.push('', '## 작업 트리에서 아직 커밋되지 않은 변경 (git status — 이 구간 밖의 변경이 섞일 수 있음)');
    lines.push(...status.slice(0, MAX_FILES).map((file) => `- ${file}`));
  }
  if (todos?.length) {
    lines.push('', '## 할일 목록 (마지막 상태)');
    lines.push(...todos.map((todo) => `- [${todo.status === 'completed' ? 'x' : todo.status === 'in_progress' ? '~' : ' '}] ${clip(todo.content || todo.activeForm || '', 200)}`));
  }
  if (running.length) {
    lines.push('', '## 완료 알림을 아직 못 받은 백그라운드 작업');
    lines.push(...running.map((id) => `- ${id}`));
  }
  if (lastAnswer) lines.push('', '## 컴팩션 직전 마지막 답변 (앞부분)', clip(lastAnswer, 1200));

  let text = `${lines.join('\n')}\n`;
  if (text.length > STATE_LIMIT) text = `${text.slice(0, STATE_LIMIT - 40)}\n…(상한 ${STATE_LIMIT}자에서 자름)\n`;
  return text;
}

function precompact(input) {
  const file = compactStatePath(input.session_id);
  if (!file) return;
  // 비밀값은 저장 전에 가린다(완벽하지 않음 — redact.mjs 참고).
  writePrivateFile(file, redact(buildState(input)));
}

const RESTORE_LIMIT = 9500; // 훅 출력 상한 1만 자 안
const RESTORE_STATE_LIMIT = 4500; // 상태 파일 몫. 나머지는 worklog 최근 기록 몫
const STATE_FRESH_MS = 60 * 60 * 1000; // 이보다 오래된 상태 파일은 이번 컴팩션 것이 아니라 보고 넣지 않는다

function recentCompact() {
  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'worklog.mjs'), 'recent', 'claude', '--mode', 'compact'], { cwd: ROOT, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`worklog recent 실패: ${(run.stderr || '').trim()}`);
  return run.stdout.trim();
}

// 앞쪽 블록(오래된 요약·턴)부터 버려 글자 상한에 맞춘다. 머리글 줄은 남긴다.
function fitRecent(text, limit) {
  if (text.length <= limit) return text;
  const [head, ...blocks] = text.split(/\n\n(?=## \[)/);
  while (blocks.length && `${head}\n\n${blocks.join('\n\n')}`.length > limit) blocks.shift();
  return blocks.length ? `${head}\n\n${blocks.join('\n\n')}` : '';
}

function compactRestore(input) {
  // 컴팩션으로 앞선 주입이 요약되어 사라졌으니, 파일별 기억 기록부를 비워 다시 넣게 한다.
  const registry = injectedRegistryPath(input.session_id);
  if (registry) { try { fs.rmSync(registry, { force: true }); } catch {} }
  const parts = [];
  const file = compactStatePath(input.session_id);
  if (file && fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < STATE_FRESH_MS) {
    let state = fs.readFileSync(file, 'utf8').trim();
    if (state.length > RESTORE_STATE_LIMIT) state = `${state.slice(0, RESTORE_STATE_LIMIT - 30)}\n…(상태 파일 일부 생략: ${path.relative(ROOT, file)})`;
    parts.push(state);
  }
  // 측정용 스위치: ORBIT_COMPACT_WORKLOG=off면 컴팩션 직후 worklog를 넣지 않는다(결정 3의 2×2 비교, 조건 C·D).
  // 전역 설정이 아니라 프로젝트 .claude/settings.local.json의 env로 켜고 끈다.
  if ((process.env.ORBIT_COMPACT_WORKLOG || '').toLowerCase() !== 'off') {
    const used = parts.join('\n\n').length;
    const recent = fitRecent(recentCompact(), RESTORE_LIMIT - used - 2);
    if (recent) parts.push(recent);
  }
  if (parts.length) process.stdout.write(`${parts.join('\n\n')}\n`);
}

// 자동 삭제는 하지 않는다(대화 글 사본과 같은 원칙 — 크기가 작고, 지우기는 사용자가 요청할 때만).
function postcompact(input) {
  const summary = String(input.compact_summary || '').trim();
  const dir = worktreeStateDir(ROOT, 'compact');
  if (!summary || !dir) return;
  const prefix = `${safeName(input.session_id)}-summary-`;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writePrivateFile(path.join(dir, `${prefix}${stamp}.md`), `# 컴팩션 요약 (${input.trigger || '알 수 없음'}, ${localTime(new Date(), { offset: true })})\n\n${redact(summary)}\n`);
}

// ── 대화 글 사본 ──────────────────────────────────────────────────────────────
// `<git common dir>/orbit-memory/dialogue.jsonl`: 턴마다 한 줄. 워크트리끼리 공유하고 git이
// 추적하지 않는다(폴더 700·파일 600). Claude Code가 원본 세션 기록을 지워도 남는다.
// 앞으로의 대화만 쌓는다 — 처음 보는 세션은 지금 턴부터. 자동 삭제는 없다(지우기는 "잊어 줘").
const TEXT_LIMIT = 20000;

function snapshotPath(sessionId) {
  const dir = worktreeStateDir(ROOT, 'memory');
  return dir ? path.join(dir, `${safeName(sessionId)}.snapshot.json`) : null;
}

function turnStart(input) {
  if (isNotification(String(input.prompt || ''))) return; // 알림은 사용자 턴이 아니다
  const file = snapshotPath(input.session_id);
  if (file) writePrivateFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...gitSnapshot(ROOT) })}\n`);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function worklogEntry(sessionId) {
  const dir = worktreeStateDir(ROOT, 'worklog');
  const state = dir ? readJson(path.join(dir, `${safeName(sessionId)}.json`)) : null;
  return state && !state.pending && Number.isFinite(state.entry) ? state.entry : null;
}

function appendPrivate(file, records) {
  fs.appendFileSync(file, records.map((record) => `${JSON.stringify(record)}\n`).join(''), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

// 도구 한 번 사용 = 색인 한 줄: 도구 이름, 대상 파일(프로젝트 안이면 상대 경로), Bash 명령 앞부분(가림).
function toolActivity(use, at) {
  const input = use.input || {};
  const file = toolFilePath(use);
  const record = { at: at || new Date().toISOString(), tool: String(use.name || '') };
  if (file) record.file = repoRelative(ROOT, file);
  if (use.name === 'Bash' && input.command) record.command = redactPrefix(String(input.command).replace(/\s+/g, ' '), 200);
  if (input.pattern && (use.name === 'Grep' || use.name === 'Glob')) record.pattern = redactPrefix(String(input.pattern), 120);
  if (use.name === 'Agent' && input.subagent_type) record.agent = String(input.subagent_type);
  return record;
}

const digest = (text) => crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);

// Stop 훅이 막은 멈춤(worklog 기록 강제·발견 칸 알림) 뒤 이어진 응답은 같은 사용자 턴이다.
// 새 줄을 만들지 않고 그 세션의 마지막 기록을 고쳐 쓴다. 드문 경우라 파일 전체를 새로 쓴다(임시 파일 → 이름 바꾸기).
function mergeIntoLast(file, session, seq, update) {
  if (!fs.existsSync(file)) return false;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].trim()) continue;
    let record;
    try { record = JSON.parse(lines[index]); } catch { continue; }
    if (record.session !== session || record.seq !== seq) continue;
    lines[index] = JSON.stringify(update(record));
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, lines.join('\n'), { mode: 0o600 });
    fs.renameSync(temp, file);
    return true;
  }
  return false;
}

function stop(input) {
  const shared = sharedMemoryDir(ROOT);
  if (!shared || !input.transcript_path) return;
  ensurePrivateDir(shared);
  withLock(path.join(shared, '.lock'), () => {
    const cursorsFile = path.join(shared, 'cursors.json');
    const cursors = readJson(cursorsFile) || {};
    const key = safeName(input.session_id);
    const cursor = cursors[key] || null;
    let { entries, next } = readTranscriptFrom(input.transcript_path, cursor?.offset ?? 0);
    if (!cursor) {
      // 처음 보는 세션: 지금 턴(마지막 사람 입력)부터만 담는다.
      let start = entries.length;
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (isHumanPrompt(entries[index]) && !isNotification(textOf(entries[index]))) { start = index; break; }
      }
      entries = entries.slice(start);
    }
    entries = entries.filter((entry) => !entry?.isSidechain);

    const user = [];
    const assistant = [];
    const tools = [];
    const promptIds = new Set();
    let skippedLast = false;
    let notices = 0;
    let stopFeedback = false;
    for (const entry of entries) {
      if (entry?.promptId) promptIds.add(entry.promptId);
      if (entry?.type === 'user' && entry.isMeta && /^Stop hook feedback:/.test(textOf(entry).trim())) stopFeedback = true;
      if (isHumanPrompt(entry)) {
        const text = textOf(entry).trim();
        if (isNotification(text)) notices += 1;
        else user.push(text);
      } else if (entry?.type === 'assistant') {
        for (const use of toolUses(entry)) tools.push(toolActivity(use, entry.timestamp));
        const text = textOf(entry).trim();
        if (!text) continue;
        // 지난번에 last_assistant_message로 먼저 담은 글이면 한 번 건너뛴다.
        if (!skippedLast && cursor?.pendingLast && digest(text) === cursor.pendingLast) { skippedLast = true; continue; }
        assistant.push(text);
      }
    }
    // 마지막 답변이 아직 세션 기록에 안 들어왔으면 Stop 입력으로 먼저 담는다. 이미 담은 답변이면 건너뛴다.
    let pendingLast = null;
    const last = String(input.last_assistant_message || '').trim();
    if (last && !assistant.includes(last) && digest(last) !== cursor?.lastFinal) { assistant.push(last); pendingLast = digest(last); }
    const lastFinal = last && (assistant.includes(last)) ? digest(last) : cursor?.lastFinal || null;

    const session = String(input.session_id || '');
    const entry = worklogEntry(input.session_id);
    const newEntry = entry !== null && entry !== cursor?.lastEntry ? entry : null;
    const files = changedSince(ROOT, readJson(snapshotPath(input.session_id)));
    // 막힌 Stop 뒤 이어진 Stop(stop_hook_active)이고 새 사람 입력이 없으면 직전 기록에 합친다.
    const continuing = (Boolean(input.stop_hook_active) || stopFeedback) && !user.length && cursor?.seq > 0;
    let merged = false;
    if (continuing && (assistant.length || newEntry !== null)) {
      merged = mergeIntoLast(path.join(shared, 'dialogue.jsonl'), session, cursor.seq, (old) => ({
        ...old,
        at: new Date().toISOString(),
        promptIds: [...new Set([...(old.promptIds || []), ...promptIds])],
        assistant: redactPrefix([old.assistant, ...assistant].filter(Boolean).join('\n\n'), TEXT_LIMIT),
        files: [...new Set([...(old.files || []), ...files])],
        worklog: old.worklog ?? newEntry,
      }));
    }
    const seq = continuing && (merged || !assistant.length) ? cursor.seq
      : (cursor?.seq || 0) + (user.length || assistant.length || tools.length ? 1 : 0);
    if (!merged && (user.length || assistant.length)) {
      const record = {
        v: 1,
        at: new Date().toISOString(),
        session: String(input.session_id || ''),
        worktree: ROOT.replace(/\/$/, ''),
        seq,
        promptIds: [...promptIds],
        continued: user.length === 0,
        // 사람 입력 없이 시작한 턴(백그라운드 알림 등)은 빈칸 대신 표시를 남긴다.
        user: user.length ? redactPrefix(user.join('\n\n'), TEXT_LIMIT) : notices ? '(자동 알림)' : '(사용자 입력 없음)',
        assistant: redactPrefix(assistant.join('\n\n'), TEXT_LIMIT),
        files,
        filesEstimated: true,
        worklog: newEntry,
      };
      appendPrivate(path.join(shared, 'dialogue.jsonl'), [record]);
    }
    if (tools.length) {
      const base = { v: 1, session, worktree: ROOT.replace(/\/$/, ''), seq, worklog: newEntry };
      appendPrivate(path.join(shared, 'tools.jsonl'), tools.map((tool) => ({ ...base, ...tool })));
    }
    cursors[key] = {
      offset: next,
      seq,
      lastEntry: entry ?? cursor?.lastEntry ?? null,
      pendingLast: pendingLast || (skippedLast ? null : cursor?.pendingLast || null),
      lastFinal,
      transcript: input.transcript_path,
      updatedAt: new Date().toISOString(),
    };
    writePrivateFile(cursorsFile, `${JSON.stringify(cursors)}\n`);
  });
}

// ── 파일별 기억 주입 ──────────────────────────────────────────────────────────────
// 파일을 읽거나 고치기 직전(PreToolUse), 그 파일을 다룬 과거 턴을 도구 색인에서 AI 없이 찾아
// 목록만 넣는다. additionalContext는 도구 결과 옆에 들어가고 권한 결정은 건드리지 않는다
// (permissionDecision을 쓰지 않는다). 결정: D-프로젝트-기억-분담(결정 7).
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const FILE_MEMORY_TURNS = 3;
const FILE_MEMORY_LIMIT = 1200;

function injectedRegistryPath(sessionId) {
  const dir = worktreeStateDir(ROOT, 'memory');
  return dir ? path.join(dir, `${safeName(sessionId)}.injected.json`) : null;
}

function readJsonl(file) {
  if (!file || !fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function worklogAsks() {
  const asks = new Map();
  try {
    for (const block of fs.readFileSync(path.join(DOCS, 'worklog.md'), 'utf8').split(/\n(?=## \[#)/)) {
      const n = (block.match(/^## \[#(\d+)\]/) || [])[1];
      const ask = (block.match(/^- 물음: (.*)$/m) || [])[1];
      if (n && ask) asks.set(Number(n), ask);
    }
  } catch {}
  return asks;
}

function fileMemory(rel) {
  const shared = sharedMemoryDir(ROOT);
  if (!shared) return '';
  const turns = new Map();
  for (const record of readJsonl(path.join(shared, 'tools.jsonl'))) {
    if (record.file !== rel) continue;
    const key = toolsId(record);
    const turn = turns.get(key) || { record, tools: new Set(), at: record.at };
    if (!turn.record.worklog && record.worklog) turn.record = { ...turn.record, worklog: record.worklog }; // 이어진 Stop에서 붙은 번호
    turn.tools.add(record.tool);
    if (String(record.at) > String(turn.at)) turn.at = record.at;
    turns.set(key, turn);
  }
  if (!turns.size) return '';
  const recent = [...turns.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, FILE_MEMORY_TURNS);
  const asks = worklogAsks();
  const dialogue = new Map(readJsonl(path.join(shared, 'dialogue.jsonl')).map((r) => [dialogueId(r), r]));
  const lines = [`[orbit 기억] ${rel}을(를) 다룬 과거 턴 ${recent.length}개(최근 순, 전체 ${turns.size}):`];
  for (const turn of recent) {
    const r = turn.record;
    const said = r.worklog && asks.get(r.worklog)
      ? asks.get(r.worklog)
      : (dialogue.get(dialogueId(r))?.user || '');
    const ids = [r.worklog ? `#${r.worklog}` : '', dialogue.has(dialogueId(r)) ? dialogueId(r) : '', toolsId(r)].filter(Boolean).join(' ');
    lines.push(`- ${localTime(turn.at, { date: true })} · ${ids} · ${[...turn.tools].join('/')} · ${clip(String(said).replace(/\s+/g, ' ').trim() || '(글 없음)', 110)}`);
  }
  lines.push('상세: node scripts/memory.mjs show <번호>');
  const text = lines.join('\n');
  return text.length > FILE_MEMORY_LIMIT ? `${text.slice(0, FILE_MEMORY_LIMIT - 1)}…` : text;
}

// 큰 코드 파일 읽기 안내 — 결정: D-코드개요-tree-sitter. 기준은 ORBIT_READ_OUTLINE_MIN_LINES(기본 300, 0이면 끔).
const OUTLINE_ENTRIES = 60;
const OUTLINE_LIMIT = 3000;
function outlineMinLines() {
  const value = Number(process.env.ORBIT_READ_OUTLINE_MIN_LINES);
  return process.env.ORBIT_READ_OUTLINE_MIN_LINES !== undefined && process.env.ORBIT_READ_OUTLINE_MIN_LINES !== '' && Number.isFinite(value) && value >= 0 ? value : 300;
}

async function readGuide(input, rel, registry) {
  const minimum = outlineMinLines();
  const tool = input.tool_input || {};
  if (!minimum || input.tool_name !== 'Read' || tool.offset !== undefined || tool.limit !== undefined) return null;
  const code = await import('./code.mjs');
  const lang = code.languageOf(rel);
  if (!lang || ['markdown', 'yaml', 'json'].includes(lang)) return null; // 문서·설정은 통째로 읽는 일이 많다
  const abs = path.resolve(ROOT, rel);
  let lineCount;
  try { lineCount = fs.readFileSync(abs, 'utf8').split('\n').length; } catch { return null; }
  if (lineCount < minimum) return null;
  try {
    const result = await code.outlineOf(abs);
    let outline = code.formatOutline(rel, result, { limit: OUTLINE_ENTRIES });
    if (outline.length > OUTLINE_LIMIT) outline = `${outline.slice(0, OUTLINE_LIMIT - 1)}…`;
    return `[orbit 코드 개요] ${rel}은(는) ${lineCount}줄입니다. 다음부터는 필요한 정의만 읽으세요: \`node scripts/code.mjs unfold ${rel} <이름>\` 또는 Read의 offset/limit.\n${outline}`;
  } catch (error) {
    if (registry.toolsWarned) return null; // 도구가 없다는 안내는 세션에 한 번만
    registry.toolsWarned = true;
    return `[orbit 코드 개요] ${error.message.split('\n')[0]} — 다시 받기: orbit update 또는 install.mjs code-tools`;
  }
}

async function preTool(input) {
  if (!FILE_TOOLS.has(input.tool_name)) return;
  const file = toolFilePath({ input: input.tool_input });
  if (!file) return;
  const rel = repoRelative(ROOT, file);
  const parts = [];

  const registryFile = injectedRegistryPath(input.session_id);
  const registry = (registryFile && readJson(registryFile)) || { files: [] };
  registry.outlined = registry.outlined || [];
  let changed = false;
  if (!registry.files.includes(rel)) {
    const memory = fileMemory(rel);
    if (memory) {
      parts.push(memory);
      registry.files.push(rel);
      changed = true;
    }
  }
  if (!registry.outlined.includes(rel)) {
    const warnedBefore = Boolean(registry.toolsWarned);
    const guide = await readGuide(input, rel, registry);
    if (guide) {
      parts.push(guide);
      if (!guide.includes('다시 받기')) registry.outlined.push(rel);
      changed = true;
    } else if (registry.toolsWarned !== warnedBefore) changed = true;
  }
  if (changed && registryFile) writePrivateFile(registryFile, `${JSON.stringify(registry)}\n`);
  if (!parts.length) return;
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: parts.join('\n\n') } })}\n`);
}

const MODES = { precompact, 'compact-restore': compactRestore, postcompact, 'turn-start': turnStart, stop, 'pre-tool': preTool };

// 직접 실행됐는지는 실제 경로로 가린다. 심볼릭 링크를 거친 경로(/var → /private/var, 링크로 연
// 프로젝트 폴더)로 부르면 문자열이 달라 훅이 아무 일도 안 하고 끝나던 결함을 막는다.
function realPath(file) {
  try { return fs.realpathSync(file); } catch { return path.resolve(file); }
}
const isMain = Boolean(process.argv[1]) && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url));
if (isMain) {
  const mode = process.argv[2];
  if (!MODES[mode]) {
    process.stderr.write(`사용법: memory-hook <${Object.keys(MODES).join('|')}>\n`);
    process.exit(1);
  }
  Promise.resolve()
    .then(() => MODES[mode](readHookInput()))
    .catch((error) => {
      process.stderr.write(`orbit 기억 훅(${mode}) 실패: ${error.message}\n`);
      process.exit(1);
    });
}
