#!/usr/bin/env node
// 기억 훅 — 컴팩션 전후와 턴 끝에서 orbit이 맡는 기억 일을 한다. 모델을 부르지 않는다.
//   precompact       PreCompact: 마지막 worklog 기록 뒤 구간의 원문 조각을 상태 파일로 저장
//   compact-restore  SessionStart(compact): 상태 파일 + worklog 최근 기록(컴팩션 전 기록)을 주입
//   postcompact      PostCompact: 컴팩션 요약을 저장만 한다(측정·점검용, 주입 안 함)
// 결정: D-프로젝트-기억-분담(결정 3). 실패해도 컴팩션을 막지 않는다(종료 코드 2를 쓰지 않음).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  WRITE_TOOLS, clip, git, isHumanPrompt, isNotification, lastMarks, lastTodos, readHookInput,
  readTranscript, runningBackgroundTasks, safeName, textOf, toolFilePath, toolUses, worktreeStateDir,
  writePrivateFile,
} from './memory-lib.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STATE_LIMIT = 8000; // SessionStart 주입 상한(1만 자) 안에 recent와 함께 들어가도록
const PROMPT_LIMIT = 1500;
const MAX_PROMPTS = 6;
const MAX_FILES = 40;

function relative(file) {
  if (!file) return null;
  const abs = path.resolve(ROOT, file);
  const rel = path.relative(ROOT, abs);
  return rel.startsWith('..') ? abs : rel;
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
    `- 시각: ${new Date().toISOString()} · 계기: ${input.trigger || '알 수 없음'}`,
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
  writePrivateFile(file, buildState(input));
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
  const parts = [];
  const file = compactStatePath(input.session_id);
  if (file && fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < STATE_FRESH_MS) {
    let state = fs.readFileSync(file, 'utf8').trim();
    if (state.length > RESTORE_STATE_LIMIT) state = `${state.slice(0, RESTORE_STATE_LIMIT - 30)}\n…(상태 파일 일부 생략: ${path.relative(ROOT, file)})`;
    parts.push(state);
  }
  const used = parts.join('\n\n').length;
  const recent = fitRecent(recentCompact(), RESTORE_LIMIT - used - 2);
  if (recent) parts.push(recent);
  if (parts.length) process.stdout.write(`${parts.join('\n\n')}\n`);
}

// 자동 삭제는 하지 않는다(대화 글 사본과 같은 원칙 — 크기가 작고, 지우기는 사용자가 요청할 때만).
function postcompact(input) {
  const summary = String(input.compact_summary || '').trim();
  const dir = worktreeStateDir(ROOT, 'compact');
  if (!summary || !dir) return;
  const prefix = `${safeName(input.session_id)}-summary-`;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writePrivateFile(path.join(dir, `${prefix}${stamp}.md`), `# 컴팩션 요약 (${input.trigger || '알 수 없음'}, ${new Date().toISOString()})\n\n${summary}\n`);
}

const MODES = { precompact, 'compact-restore': compactRestore, postcompact };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const mode = process.argv[2];
  if (!MODES[mode]) {
    process.stderr.write(`사용법: memory-hook <${Object.keys(MODES).join('|')}>\n`);
    process.exit(1);
  }
  try {
    MODES[mode](readHookInput());
  } catch (error) {
    process.stderr.write(`orbit 기억 훅(${mode}) 실패: ${error.message}\n`);
    process.exit(1);
  }
}
