#!/usr/bin/env node
// 기억 훅 — 컴팩션 전후와 턴 끝에서 orbit이 맡는 기억 일을 한다. 모델을 부르지 않는다.
//   precompact   PreCompact: 마지막 worklog 기록 뒤 구간의 원문 조각을 상태 파일로 저장
// 결정: D-프로젝트-기억-분담(결정 3). 실패해도 컴팩션을 막지 않는다(종료 코드 2를 쓰지 않음).

import fs from 'node:fs';
import path from 'node:path';
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

const MODES = { precompact };

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
