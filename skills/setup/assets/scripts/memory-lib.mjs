// 기억 훅 공용 도구 — Claude Code 세션 기록(jsonl)을 읽고, orbit 상태 폴더 경로를 구한다.
// 외부 의존성 없이 Node 내장 모듈만 쓴다(orbit 필수 도구는 git·Node뿐).
// 결정: D-프로젝트-기억-분담(결정 3·6·7).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export function git(root, args, { raw = false } = {}) {
  try {
    const out = execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return raw ? out : out.trim();
  } catch {
    return null;
  }
}

// 커밋되지 않은 변경 목록. -z로 받아 필드 단위로 읽는다(공백·한글 경로, 이름 바꾸기 안전).
// 출력을 trim하면 첫 줄 ' M'의 앞 공백이 사라져 경로 첫 글자가 잘리므로 raw로 받는다.
export function gitStatusEntries(root) {
  const raw = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { raw: true });
  if (!raw) return [];
  const fields = raw.split('\0').filter(Boolean);
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const code = fields[index].slice(0, 2);
    entries.push({ code, path: fields[index].slice(3) });
    if (code[0] === 'R' || code[0] === 'C') index += 1; // 이름 바꾸기는 옛 경로가 한 칸 더 온다
  }
  return entries;
}

// 워크트리별 상태 폴더(`.git/worktrees/<이름>/orbit-state/...` 또는 `.git/orbit-state/...`).
export function worktreeStateDir(root, name) {
  const rel = git(root, ['rev-parse', '--git-path', `orbit-state/${name}`]);
  return rel ? path.resolve(root, rel) : null;
}

// 워크트리끼리 공유하는 폴더(`<git common dir>/orbit-memory`).
export function sharedMemoryDir(root) {
  const rel = git(root, ['rev-parse', '--git-common-dir']);
  return rel ? path.join(path.resolve(root, rel), 'orbit-memory') : null;
}

export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

export function writePrivateFile(file, text) {
  ensurePrivateDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
  try { fs.chmodSync(file, 0o600); } catch {}
}

export function safeName(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180);
}

export function readHookInput() {
  const raw = fs.readFileSync(0, 'utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

// jsonl을 한 줄씩 객체로 돌려준다. 깨진 줄은 건너뛴다(기록 도중 잘린 마지막 줄 등).
export function readTranscript(file) {
  if (!file || !fs.existsSync(file)) return [];
  const entries = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch {}
  }
  return entries;
}

function contentParts(entry) {
  const content = entry?.message?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

export function textOf(entry) {
  return contentParts(entry)
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function toolResultText(part) {
  if (typeof part.content === 'string') return part.content;
  if (Array.isArray(part.content)) return part.content.map((item) => (typeof item?.text === 'string' ? item.text : '')).join('\n');
  return '';
}

// 사람이 친 프롬프트인가. 훅 피드백·스킬 본문 같은 메타 입력, 도구 결과, 중단 표시는 뺀다.
export function isHumanPrompt(entry) {
  if (entry?.type !== 'user' || entry.isMeta || entry.isCompactSummary) return false;
  const parts = contentParts(entry);
  if (parts.some((part) => part?.type === 'tool_result')) return false;
  const text = textOf(entry).trim();
  if (!text || text.startsWith('[Request interrupted')) return false;
  return true;
}

export function isNotification(text) {
  return /^\s*<task-notification>/.test(text);
}

export function toolUses(entry) {
  if (entry?.type !== 'assistant') return [];
  return contentParts(entry).filter((part) => part?.type === 'tool_use');
}

export function toolResults(entry) {
  if (entry?.type !== 'user') return [];
  return contentParts(entry)
    .filter((part) => part?.type === 'tool_result')
    .map((part) => ({ id: part.tool_use_id, text: toolResultText(part), isError: Boolean(part.is_error) }));
}

export function toolFilePath(use) {
  const input = use?.input || {};
  return input.file_path || input.notebook_path || input.path || null;
}

// worklog 기록 명령: 셸 문장의 맨 앞(줄 처음, ;·&&·|| 뒤, cd 뒤)에서 node로 worklog.mjs append를
// 부를 때만 센다. 명령 안의 문자열(테스트 코드·heredoc)에 든 같은 글자는 세지 않는다.
const WORKLOG_APPEND = /(?:^|\n|;|&&|\|\|)\s*node\s+"?[^\s"]*scripts\/worklog\.mjs"?\s+append\b/;

// 마지막 컴팩션 경계와 마지막으로 성공한 worklog 기록의 위치(항목 번호). 없으면 -1.
export function lastMarks(entries) {
  let compact = -1;
  let worklog = -1;
  const appendIds = new Set();
  entries.forEach((entry, index) => {
    if (entry?.type === 'system' && entry.subtype === 'compact_boundary') compact = index;
    for (const use of toolUses(entry)) {
      if (use.name === 'Bash' && WORKLOG_APPEND.test(String(use.input?.command || ''))) appendIds.add(use.id);
    }
    for (const result of toolResults(entry)) {
      // 출력은 파이프로 잘릴 수 있어(예: `| tail -2`) 내용이 아닌 오류 여부로 성공을 가린다.
      if (appendIds.has(result.id) && !result.isError) worklog = index;
    }
  });
  return { compact, worklog };
}

// 백그라운드로 띄운 작업 가운데 완료 알림을 아직 못 받은 것.
export function runningBackgroundTasks(entries) {
  const launched = new Map();
  const finished = new Set();
  const noteFinished = (text) => {
    for (const match of String(text || '').matchAll(/<task-id>([^<]+)<\/task-id>/g)) finished.add(match[1].trim());
  };
  for (const entry of entries) {
    for (const result of toolResults(entry)) {
      const agent = result.text.match(/agentId:\s*([A-Za-z0-9_-]+)/);
      const shell = result.text.match(/running in background with ID:\s*([A-Za-z0-9_-]+)/i);
      const id = agent?.[1] || shell?.[1];
      if (id && !launched.has(id)) launched.set(id, entry.timestamp || '');
    }
    if (entry?.type === 'user') noteFinished(textOf(entry));
    if (entry?.type === 'attachment') noteFinished(entry.attachment?.prompt);
    if (entry?.type === 'queue-operation') noteFinished(entry.content);
  }
  return [...launched.keys()].filter((id) => !finished.has(id));
}

export function lastTodos(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    for (const use of toolUses(entries[index]).reverse()) {
      if (use.name === 'TodoWrite' && Array.isArray(use.input?.todos)) return use.input.todos;
    }
  }
  return null;
}

// 저장은 ISO(UTC) 그대로 두고, 사람이 읽는 곳에서만 이 컴퓨터의 현지 시각 'YYYY-MM-DD HH:MM'으로 보인다.
export function localTime(at, { date = false, offset = false } = {}) {
  const d = at instanceof Date ? at : new Date(String(at || ''));
  if (Number.isNaN(d.getTime())) return String(at || '').slice(0, date ? 10 : 16).replace('T', ' ');
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (date) return day;
  const minutes = -d.getTimezoneOffset();
  const zone = offset ? ` (UTC${minutes < 0 ? '-' : '+'}${pad(Math.trunc(minutes / 60))}:${pad(minutes % 60)})` : '';
  return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}${zone}`;
}

export function clip(text, limit) {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

// 같은 파일을 여러 세션(워크트리)이 함께 고칠 때 쓰는 단순 잠금(mkdir). 오래된 잠금은 치운다.
export function withLock(lockDir, fn, { timeoutMs = 5000, staleMs = 30000 } = {}) {
  const started = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > staleMs) { fs.rmSync(lockDir, { recursive: true, force: true }); continue; }
      } catch {}
      if (Date.now() - started > timeoutMs) throw new Error(`잠금을 얻지 못했습니다: ${lockDir}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try { return fn(); } finally { try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {} }
}

// git 상태 지문: HEAD와, 커밋되지 않은 파일마다 내용 해시(지워진 파일은 'deleted').
// 턴 시작과 끝을 비교해 "이 턴에 바뀐 파일"을 추정한다. Bash로 고친 파일도 잡힌다.
const SNAPSHOT_MAX_FILES = 500;
export function gitSnapshot(root) {
  const head = git(root, ['rev-parse', '--verify', '-q', 'HEAD']) || '';
  const dirty = {};
  const paths = gitStatusEntries(root).map((entry) => entry.path);
  if (paths.length) {
    const existing = [];
    for (const rel of paths.slice(0, SNAPSHOT_MAX_FILES)) {
      if (fs.existsSync(path.join(root, rel)) && fs.statSync(path.join(root, rel)).isFile()) existing.push(rel);
      else dirty[rel] = 'deleted';
    }
    if (existing.length) {
      try {
        const hashes = execFileSync('git', ['hash-object', '--stdin-paths'], { cwd: root, input: existing.join('\n'), encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })
          .trim().split('\n');
        existing.forEach((rel, index) => { dirty[rel] = hashes[index] || 'unknown'; });
      } catch {}
    }
  }
  return { head, dirty };
}

export function changedSince(root, before) {
  if (!before) return [];
  const after = gitSnapshot(root);
  const changed = new Set();
  if (before.head && after.head && before.head !== after.head) {
    const names = git(root, ['diff', '--name-only', before.head, after.head]);
    for (const name of (names || '').split('\n').filter(Boolean)) changed.add(name);
  }
  for (const [rel, hash] of Object.entries(after.dirty)) if (before.dirty?.[rel] !== hash) changed.add(rel);
  return [...changed].sort();
}

// 세션 기록을 offset부터 읽어 완성된 줄만 돌려준다(쓰는 중인 마지막 줄은 다음에).
export function readTranscriptFrom(file, offset) {
  if (!file || !fs.existsSync(file)) return { entries: [], next: offset };
  const size = fs.statSync(file).size;
  if (size < offset) offset = 0; // 파일이 바뀌었으면 처음부터
  if (size === offset) return { entries: [], next: offset };
  const buffer = Buffer.alloc(size - offset);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buffer, 0, buffer.length, offset); } finally { fs.closeSync(fd); }
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline === -1) return { entries: [], next: offset };
  const entries = [];
  for (const line of buffer.subarray(0, lastNewline).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch {}
  }
  return { entries, next: offset + lastNewline + 1 };
}

// 기억 번호: 대화 사본 `d:<세션 앞 8자>:<턴>`, 도구 색인 `t:<세션 앞 8자>:<턴>` (memory.mjs show로 상세).
export const shortSession = (session) => String(session || '').slice(0, 8);
export const dialogueId = (record) => `d:${shortSession(record.session)}:${record.seq}`;
export const toolsId = (record) => `t:${shortSession(record.session)}:${record.seq}`;

// 저장소 기준 상대 경로. 심볼릭 링크를 거친 경로(/var → /private/var, 링크로 연 프로젝트)도 실제
// 경로로 맞춘 뒤 비교한다. 아직 없는 파일(Write로 새로 만듦)은 부모 폴더의 실제 경로로 맞춘다.
// 저장소 밖이면 절대 경로를 돌려준다.
function realOrSelf(file) {
  // 있는 가장 가까운 조상 폴더까지 올라가 실제 경로로 바꾸고, 없는 나머지 이름을 다시 붙인다.
  let current = file;
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...rest.reverse()); } catch {}
    const parent = path.dirname(current);
    if (parent === current) return file;
    rest.push(path.basename(current));
    current = parent;
  }
}

export function repoRelative(root, file) {
  if (!file) return null;
  const abs = realOrSelf(path.resolve(root, file));
  const rel = path.relative(realOrSelf(root), abs);
  return rel.startsWith('..') || path.isAbsolute(rel) ? abs : rel;
}
