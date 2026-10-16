#!/usr/bin/env node
// git 지킴이 훅 — 사용자가 말하기 전에는 푸시하지 않게 막는다.
//
//   turn-start  (UserPromptSubmit) 이번 사용자 입력이 푸시·커밋을 시켰는지 적어 둔다
//   pre-tool    (PreToolUse, Bash) 시키지 않은 턴의 git push를 거절한다.
//               일지만 담은 커밋을 허용하는 변수(ORBIT_ALLOW_WORKLOG_ONLY_COMMIT)도
//               사용자가 커밋을 시킨 턴에만 쓰게 한다.
//
// 일지만 담은 커밋 자체는 .githooks/pre-commit이 막는다(Codex와 스크립트의 커밋도 같이 걸린다).
// 이 훅이 스스로 고장 나면 막지 않고 지나간다(exit 0) — 훅 버그로 작업을 세우지 않기 위함.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ALLOW_ENV = 'ORBIT_ALLOW_WORKLOG_ONLY_COMMIT';
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function stateDirectory() {
  const gitPath = execFileSync('git', ['rev-parse', '--git-path', 'orbit-state/git-guard'], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  return path.resolve(ROOT, gitPath);
}

function statePath(input) {
  const id = String(input.session_id || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180);
  return path.join(stateDirectory(), `${id}.json`);
}

function readState(input) {
  try { return JSON.parse(fs.readFileSync(statePath(input), 'utf8')); } catch { return {}; }
}

function cleanup(dir) {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (now - fs.statSync(file).mtimeMs > STALE_MS) fs.unlinkSync(file);
    }
  } catch {}
}

// 사용자가 직접 쓰지 않은 글은 뺀다: 붙여 넣은 글, 시스템이 끼운 글.
function ownWords(prompt) {
  return String(prompt || '')
    .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, ' ')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ');
}

// 사용자 입력이 아닌 것: 백그라운드 작업 알림, 다른 세션이 보낸 글. 이런 입력은 허락을 주지도 거두지도 않는다.
function notFromUser(prompt) {
  const text = String(prompt || '');
  const rest = text
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .replace(/<cross-session-message[\s\S]*?<\/cross-session-message>/g, '')
    .replace(/^\s*Another Claude session sent a message:?/i, '')
    .trim();
  return text.trim() !== '' && rest === '';
}

// 낱말이 '시키는 꼴'로 쓰였는지 본다. "푸시해", "푸시하고", "푸시까지", "커밋 부탁"은 시킨 것이고,
// "푸시하지 마", "푸시해라고 하기 전에는", "푸시도 마찬가지야"는 아니다.
// 애매하면 시키지 않은 쪽으로 본다 — 막혀도 사용자가 한 번 더 말하면 풀린다.
const TAIL = String.raw`(?:\s*(?:도|까지|를|을|만|좀|바로|지금))*\s*(?:해|하고|하자|하라|하면\s*돼|한\s*(?:다음|뒤|후)|부탁|진행|ㄱ|고고|가자|같이|까지|go\b|it\b|now\b|please\b|to\b|origin\b|$)`;
const NEGATED = /^[^\n.!?]{0,14}?(?:하지\s*(?:마|말|않)|해라고|하라고|말고|금지|없이|안\s*(?:해|하)|못\s*하|전에는|전까지)/;
const UPLOAD = /(?:깃허브|github|원격|remote|origin)\s*(?:에|으로|로)?\s*(?:올려|올리고|올리자)/i;

function asked(text, words) {
  const pattern = new RegExp(`(?:${words})${TAIL}`, 'gim');
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const word = new RegExp(`^(?:${words})`, 'i').exec(match[0])[0];
    const after = text.slice(match.index + word.length, match.index + word.length + 24);
    if (!NEGATED.test(after)) return true;
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  return false;
}

// 일지만 담은 커밋 허용 변수는 사용자가 '일지(기록)'를 커밋하라고 한 턴에만 쓴다. 그냥 "커밋해"는 아니다 —
// r1에서 에이전트가 "테스트 돌리고 커밋"마다 일지만 담은 커밋을 만들며 이 변수를 60번 붙였다.
const WORKLOG_WORDS = /(?:일지|작업\s*기록|worklog)/i;

export function judgePrompt(prompt) {
  const text = ownWords(prompt);
  const commit = asked(text, '커밋|\\bcommit');
  return {
    push: asked(text, '푸시|푸쉬|\\bpush') || UPLOAD.test(text),
    commit,
    worklogCommit: commit && WORKLOG_WORDS.test(text),
  };
}

// 따옴표 안의 글(커밋 메시지, 다른 프로그램에 넘기는 글)은 명령으로 보지 않는다.
function stripQuoted(command) {
  return String(command || '')
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

// heredoc 본문(<<'EOF' … EOF)은 명령이 아니라 파일에 쓰는 글이다 — 그 안의 변수 이름은 세지 않는다.
export function stripHeredocs(command) {
  const lines = String(command || '').split('\n');
  const out = [];
  let end = null;
  for (const line of lines) {
    if (end !== null) { if (line.replace(/^\t+/, '') === end) end = null; continue; }
    out.push(line);
    const match = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(line);
    if (match) end = match[2];
  }
  return out.join('\n');
}

// 허용 변수를 실제로 붙여 실행하는지: 명령 첫머리의 환경 대입(VAR=1 cmd, env VAR=1 cmd, export VAR=1)일 때만 센다.
export function usesAllowEnv(command) {
  const text = stripQuoted(stripHeredocs(command));
  return new RegExp(`(?:^|[;&|(\\n\`]|\\benv|\\bexport)\\s*(?:[A-Za-z_]\\w*=\\S*\\s+)*${ALLOW_ENV}=`, 'm').test(text);
}

// 다른 저장소를 가리키는 명령(git -C <경로>, cd <경로> 뒤의 git)은 이 저장소의 허락과 상관없다.
export function targetsOtherRepo(command, root = ROOT) {
  const text = stripHeredocs(command);
  const paths = [];
  for (const match of text.matchAll(/(?:\bgit\s+(?:-c\s+\S+\s+)*-C\s+|(?:^|[;&|(]\s*)cd\s+)(['"]?)([^'"\s;&|)]+)\1/gm)) paths.push(match[2]);
  if (!paths.length) return false;
  const base = path.resolve(root);
  return paths.every((p) => {
    const resolved = path.resolve(base, p.replace(/^~(?=\/|$)/, process.env.HOME || '~'));
    return resolved !== base && !resolved.startsWith(`${base}${path.sep}`);
  });
}

export function isPush(command) {
  // git 바로 뒤의 옵션(-c 값, -C 경로, --옵션)만 건너뛰고 하위 명령이 push인지 본다(git stash push는 아니다).
  return /(?:^|[\s;&|(`])git(?:\s+(?:-[cC]\s+\S+|--?[\w-]+(?:=\S*)?))*\s+push(?:\s|$|[;&|)`])/m.test(stripQuoted(stripHeredocs(command)));
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
}

function handleTurnStart(input) {
  if (notFromUser(input.prompt)) return;
  const dir = stateDirectory();
  fs.mkdirSync(dir, { recursive: true });
  cleanup(dir);
  const flags = judgePrompt(input.prompt);
  const file = statePath(input);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ ...flags, at: new Date().toISOString() }));
  fs.renameSync(temporary, file);
}

function handlePreTool(input) {
  if (input.tool_name !== 'Bash') return;
  const command = String(input.tool_input?.command || '');
  const push = isPush(command);
  // 변수를 실제로 값과 함께 넘길 때만 본다. 따옴표 안의 글(일지·커밋 메시지)에 이름이 나오는 것은 세지 않는다.
  const override = usesAllowEnv(command) && !targetsOtherRepo(command);
  if (!push && !override) return;
  const state = readState(input);
  if (push && !state.push) {
    deny('사용자가 이번 요청에서 푸시를 시키지 않았습니다. 푸시하지 않습니다. 푸시가 필요하면 답변에서 그 까닭을 알리고, 사용자가 "푸시해"라고 말한 턴에 실행하세요. 이 거절을 돌아가는 다른 방법(스크립트, 다른 도구)을 쓰지 않습니다.');
    return;
  }
  if (override && !state.worklogCommit) {
    deny(`사용자가 이번 요청에서 일지(기록)를 커밋하라고 하지 않았습니다. ${ALLOW_ENV}는 그렇게 말한 턴에만 씁니다. 커밋하라고 했는데 바뀐 것이 일지뿐이면 커밋하지 말고 "바꾼 코드가 없어 커밋할 것이 없다(일지는 다음 작업 커밋에 함께 싣는다)"고 답하세요.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  try {
    const input = readInput();
    if (mode === 'turn-start') handleTurnStart(input);
    else if (mode === 'pre-tool') handlePreTool(input);
    else process.stderr.write('사용법: node scripts/git-guard.mjs <turn-start|pre-tool>\n');
  } catch (error) {
    process.stderr.write(`git 지킴이 훅이 실패해 막지 않고 지나갑니다: ${error.message}\n`);
  }
  process.exit(0);
}
