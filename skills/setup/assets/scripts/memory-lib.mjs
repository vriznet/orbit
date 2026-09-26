// 기억 훅 공용 도구 — Claude Code 세션 기록(jsonl)을 읽고, orbit 상태 폴더 경로를 구한다.
// 외부 의존성 없이 Node 내장 모듈만 쓴다(orbit 필수 도구는 git·Node뿐).
// 결정: D-프로젝트-기억-분담(결정 3·6·7).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export function git(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
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

export function clip(text, limit) {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
