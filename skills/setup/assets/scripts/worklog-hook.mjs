#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKLOG = path.join(ROOT, 'scripts', 'worklog.mjs');
const WORKLOG_LOG = path.join(ROOT, '{{DOCS_DIR}}', 'worklog.md');
const STALE_STATE_MS = 30 * 24 * 60 * 60 * 1000; // 30일 — 다른 세션의 오래된 상태 파일 기회적 청소
const MAX_ORPHANS = 20; // P02 — 미기록 턴 대기열 상한. 넘치면 가장 오래된 것부터 버린다.
const MAX_MERGED = 20; // 한 턴에 합쳐진 앞 턴 토큰 상한
const MAX_NOTICES = 50; // 쉬는 동안 온 알림 버퍼 상한
const NOTICE_FLUSH_COUNT = 20; // 알림이 이만큼 쌓이면 사용자 턴을 기다리지 않고 한 항목으로 기록
const NOTICE_FLUSH_MS = 10 * 60 * 1000; // 가장 오래된 알림이 이보다 오래되면 종료 훅에서 기록
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30000;
const MAX_DEBUG_DUMPS = 50;

// 백그라운드 작업 완료 알림. Claude Code는 이 알림을 사용자 입력처럼 전달하고 UserPromptSubmit
// 훅도 돌린다. 이때 prompt에는 이 블록만 들어 있다(2026-09-24 입력 덤프로 확인).
const NOTICE_BLOCK = /<task-notification>([\s\S]*?)<\/task-notification>/g;

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    process.stderr.write(`worklog 훅 입력을 읽지 못했습니다: ${error.message}\n`);
    process.exit(1);
  }
}

let cachedStateDirectory = null;
function stateDirectory() {
  if (cachedStateDirectory) return cachedStateDirectory;
  const gitPath = execFileSync('git', ['rev-parse', '--git-path', 'orbit-state/worklog'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  cachedStateDirectory = path.resolve(ROOT, gitPath);
  return cachedStateDirectory;
}

function safeSessionId(input) {
  return String(input.session_id || 'unknown')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 180);
}

function statePath(input) {
  return path.join(stateDirectory(), `${safeSessionId(input)}.json`);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// 상태 파일 잠금. 알림 여러 개가 한꺼번에 도착하면 begin이 겹쳐 돌 수 있어, 읽고-고치고-쓰는
// 사이에 서로의 갱신(특히 방금 연 사용자 턴)을 덮어쓰지 않게 한다. worklog.mjs의
// completeHookTurn도 같은 잠금(`<상태 파일>.lock`, 안에 pid)을 쓴다. 잠금을 끝내 못 얻으면
// 잠금 없이 진행한다 — 훅이 사용자 턴을 막아선 안 된다.
function lockIsStale(lockDir) {
  let mtime;
  try {
    mtime = fs.statSync(lockDir).mtimeMs;
  } catch {
    return false;
  }
  let holderPid = null;
  try { holderPid = Number(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8').trim()); } catch {}
  if (holderPid) {
    try {
      process.kill(holderPid, 0);
      return Date.now() - mtime > 5 * 60 * 1000; // pid 재사용 대비 안전판
    } catch {
      return true;
    }
  }
  return Date.now() - mtime > LOCK_STALE_MS;
}

function withStateLock(input, fn) {
  const lockDir = `${statePath(input)}.lock`;
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const start = Date.now();
  let locked = false;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      try { fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid)); } catch {}
      locked = true;
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') break;
      if (lockIsStale(lockDir)) {
        const reclaimed = `${lockDir}.reclaim-${process.pid}-${Date.now()}`;
        try {
          fs.renameSync(lockDir, reclaimed);
          fs.rmSync(reclaimed, { recursive: true, force: true });
        } catch {}
        continue;
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        process.stderr.write(`worklog 턴 상태 잠금을 얻지 못해 잠금 없이 진행합니다: ${lockDir}\n`);
        break;
      }
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    if (locked) {
      try {
        if (fs.readFileSync(path.join(lockDir, 'pid'), 'utf8').trim() === String(process.pid)) {
          fs.rmSync(lockDir, { recursive: true, force: true });
        }
      } catch {}
    }
  }
}

// 상태 파일이 없으면 exists:false, 있는데 파싱 실패면 error에 담아 호출자가 침묵하지 않고
// 경고할 수 있게 한다(H09 대응 — 손상 상태를 조용히 무시하지 않는다).
function readStateRaw(input) {
  const target = statePath(input);
  if (!fs.existsSync(target)) return { exists: false, state: null, error: null };
  try {
    return { exists: true, state: JSON.parse(fs.readFileSync(target, 'utf8')), error: null };
  } catch (error) {
    return { exists: true, state: null, error };
  }
}

// 상태 파일에는 세션ID·카운터·대기중인 턴(turn/token/startedAt/promptIds/merged)·orphans·
// 쉬는 동안 온 알림 버퍼(notices)만 담는다. 프롬프트 원문은 절대 저장하지 않는다(사용자
// 확정: 완전 제외). prompt_id는 Claude Code가 붙이는 식별자일 뿐 원문이 아니다.
// P04 — 실패 시 임시 파일을 지우고 다시 던진다(정리 없이 던지면 *.tmp 잔재가 남는다).
function writeState(input, state) {
  const destination = statePath(input);
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, destination);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
  try { fs.chmodSync(destination, 0o600); } catch {}
}

// 구스키마(orphans·notices·promptIds·merged 없음)를 빈 값으로 승계한다.
function normalizeState(previous, input) {
  let pending = previous?.pending;
  if (!pending || typeof pending !== 'object' || !pending.token) {
    pending = null;
  } else {
    pending = {
      ...pending,
      promptIds: Array.isArray(pending.promptIds) ? pending.promptIds : [],
      merged: Array.isArray(pending.merged) ? pending.merged : [],
    };
  }
  return {
    sessionId: String(previous?.sessionId || input.session_id || 'unknown'),
    // 구버전 스키마(counter 없음, 최상위 turn만 존재)에서도 카운터가 이어지게 turn을 폴백으로 쓴다.
    counter: Number(previous?.counter ?? previous?.turn) || 0,
    pending,
    orphans: Array.isArray(previous?.orphans) ? previous.orphans : [],
    notices: Array.isArray(previous?.notices) ? previous.notices : [],
    lastPromptId: previous?.lastPromptId ?? null,
    // 마지막으로 기록된 항목과 그 턴의 prompt_id — 대화 사본의 worklog 연결과 '발견' 칸 알림이 쓴다.
    entry: Number.isFinite(Number(previous?.entry)) && previous?.entry !== null ? Number(previous.entry) : null,
    entryPromptIds: Array.isArray(previous?.entryPromptIds) ? previous.entryPromptIds : [],
    foundNudged: previous?.foundNudged ?? null,
  };
}

// P02 — orphans 큐에 항목을 넣는다. 상한(20)을 넘으면 가장 오래된 것부터 버리고 stderr로
// 알린다(조용히 유실시키지 않는다 — 그래도 무한정 쌓이게 두지도 않는다).
function pushOrphan(orphans, entry) {
  const next = [...orphans, entry];
  if (next.length > MAX_ORPHANS) {
    const dropped = next.shift();
    process.stderr.write(`worklog 미기록 턴 대기열이 가득 차(상한 ${MAX_ORPHANS}) 가장 오래된 항목을 버렸습니다: 턴 #${dropped.turn}\n`);
  }
  return next;
}

// 자동 복구 문구 — 원인을 구분해 적는다. 알림 턴과 진행 중 추가 메시지는 더 이상 미기록 턴이
// 되지 않으므로(알림은 턴으로 세지 않고, 추가 메시지는 진행 중인 턴에 합친다) 남는 원인은
// 둘이다: 종료 차단 후에도 기록되지 않은 진짜 누락, 이전 버전 훅이 남긴 대기열 항목.
function orphanAsk(orphan) {
  if (orphan.cause === 'recovery-failed') {
    return `(자동 복구 — 턴 ${orphan.turn} 기록 누락: 종료 훅 자동 복구도 실패했던 턴, 원문 미기록)`;
  }
  return `(자동 복구 — 턴 ${orphan.turn}: 이전 버전 훅이 남긴 미기록 턴 — 알림·추가 메시지로 밀린 턴일 수 있음, 원문 미기록)`;
}

// P02 — 대기열에 쌓인 미기록 턴들을 자동 복구 시도한다. 성공한 항목의 제거는 worklog.mjs의
// completeHookTurn(append가 pending과 불일치하면 orphans에서 토큰을 찾아 지운다)이 상태
// 파일을 다시 읽어 처리하므로, 여기서는 append를 시도만 하고 상태를 직접 고쳐 쓰지 않는다.
// 실패해도 차단하지 않고 다음 orphan으로 계속 진행한다 — 큐는 그대로 유지된다.
// 잠금을 쥔 채로 부르면 안 된다(completeHookTurn이 같은 잠금을 기다린다).
function flushOrphans(sessionId, orphans) {
  for (const orphan of orphans) {
    const result = '종료 훅이 대기열에 보존된 미기록 턴을 최소 항목으로 자동 복구함.';
    spawnSync(process.execPath, [
      WORKLOG,
      'append',
      'claude',
      orphanAsk(orphan),
      result,
      '--session-id',
      sessionId,
      '--turn-token',
      orphan.token,
    ], { cwd: ROOT, encoding: 'utf8' });
  }
}

// 다른 세션의 오래된 상태 파일을 기회적으로 청소한다(best-effort — 실패해도 begin을 막지 않음).
function cleanupOldStateFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_STATE_MS;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const full = path.join(dir, entry.name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
    } catch {}
  }
}

function compact(value, limit = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function appendCommand(sessionId, token) {
  return `node scripts/worklog.mjs append claude "<물음 요약>" "<결과 요약>" --session-id ${JSON.stringify(sessionId)} --turn-token ${JSON.stringify(token)}`;
}

// 손상된 상태 파일을 옆으로 격리한다(N02) — writeState가 그대로 덮어쓰면 무엇이 깨졌는지
// 증거가 사라진다. 격리 자체가 실패해도(권한 등) 진행은 막지 않는다(best-effort).
function isolateCorruptState(input) {
  const target = statePath(input);
  try {
    fs.renameSync(target, `${target}.corrupt-${Date.now()}`);
  } catch {}
}

function tagValue(body, tag) {
  const match = body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1].trim() : '';
}

// 입력이 백그라운드 완료 알림뿐이면 알림 목록을, 아니면 null(사용자 턴)을 돌려준다.
// 판별은 좁게 한다: 알림 블록 밖에 글자가 하나라도 있거나, 블록에 task-id·status가 없으면
// 사용자 턴으로 본다. 판별이 틀리는 쪽은 소음(사용자 턴으로 셈)이지 기록 누락이 아니다.
// 알림 결과에 든 임시 폴더 경로는 파일 이름만 남긴다. 긴 경로가 글자 상한을 먹어 정작
// 내용이 잘리고(설치본 worklog #5), 경로 자체는 곧 사라져 다시 쓸 수 없다.
function shortenTempPaths(text) {
  return String(text || '').replace(/(?:\/private)?\/(?:tmp|var\/folders)\/(?:[^\s`'"<>]*\/)?([^\s`'"<>/]+)/g, '…/$1');
}

// worklog에 실제로 기록된 마지막 턴 번호(없으면 0). 꼬리부터 읽고, 머리글이 없으면 넓혀 읽는다.
function lastLoggedTurn() {
  let size;
  try { size = fs.statSync(WORKLOG_LOG).size; } catch { return 0; }
  for (let bytes = 16384; ; bytes *= 4) {
    const start = Math.max(0, size - bytes);
    let text = '';
    try {
      const fd = fs.openSync(WORKLOG_LOG, 'r');
      try {
        const buffer = Buffer.alloc(size - start);
        fs.readSync(fd, buffer, 0, size - start, start);
        text = buffer.toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch { return 0; }
    let max = 0;
    for (const match of text.matchAll(/^## \[#(\d+)\]/gm)) max = Math.max(max, Number(match[1]));
    if (max || start === 0) return max;
  }
}

function parseNotifications(prompt) {
  if (typeof prompt !== 'string' || !prompt.includes('<task-notification>')) return null;
  const bodies = [...prompt.matchAll(NOTICE_BLOCK)].map((match) => match[1]);
  if (!bodies.length || prompt.replace(NOTICE_BLOCK, '').trim()) return null;
  const notices = [];
  for (const body of bodies) {
    const taskId = tagValue(body, 'task-id');
    const status = tagValue(body, 'status');
    if (!taskId || !status) return null;
    notices.push({
      status: compact(status, 40),
      summary: compact(tagValue(body, 'summary'), 160),
      result: compact(shortenTempPaths(tagValue(body, 'result')), 200),
    });
  }
  return notices;
}

// 쉬는 동안 온 알림들을 worklog 한 항목으로 기록한다. 실패하면 버퍼로 되돌린다.
// 잠금을 쥔 채로 부르면 안 된다.
// 알림이 버퍼에 들어온 뒤 worklog에 새 기록이 생겼으면, 알림을 받은 턴에서 모델이 이미
// 적은 것이다(설치본 worklog #4·#5 이중 기록). 그런 알림은 묶음에서 뺀다.
// 결정: D-프로젝트-기억-분담(결정 4).
function appendNoticeBundle(input, notices) {
  if (!notices?.length) return;
  const current = lastLoggedTurn();
  notices = notices.filter((notice) => !(Number.isFinite(notice.logAt) && current > notice.logAt));
  if (!notices.length) return;
  const count = notices.length;
  const summaries = notices.map((notice) => notice.summary || notice.status);
  const ask = count === 1
    ? `(자동 알림) ${summaries[0]}`
    : `(자동 알림 ${count}건) ${summaries.join(' · ')}`;
  const details = notices.map((notice) => {
    const result = compact(notice.result, count === 1 ? 200 : 80);
    return result ? `${notice.status}: ${result}` : notice.status;
  });
  const result = `사용자 턴 사이에 도착한 백그라운드 작업 알림을 훅이 묶어 기록함 — ${details.join(' / ')}`;
  const appended = spawnSync(process.execPath, [
    WORKLOG,
    'append',
    'claude',
    compact(ask, 400),
    compact(result, 800),
  ], { cwd: ROOT, encoding: 'utf8' });
  if (appended.status === 0) return;
  process.stderr.write(`백그라운드 알림 묶음 기록에 실패해 버퍼로 되돌립니다: ${compact(appended.stderr || appended.error?.message, 200)}\n`);
  try {
    withStateLock(input, () => {
      const { state, error } = readStateRaw(input);
      if (error) return;
      const current = normalizeState(state, input);
      writeState(input, { ...current, notices: [...notices, ...current.notices].slice(-MAX_NOTICES) });
    });
  } catch {}
}

function noticesDue(notices) {
  if (!notices.length) return false;
  if (notices.length >= NOTICE_FLUSH_COUNT) return true;
  const oldest = Date.parse(notices[0].at);
  return Number.isFinite(oldest) && Date.now() - oldest >= NOTICE_FLUSH_MS;
}

// 진단용 입력 덤프 — ORBIT_HOOK_DEBUG=1 이거나 상태 폴더에 `debug` 파일이 있을 때만 남긴다.
// 원문을 저장하지 않는 규칙은 여기서도 지킨다: prompt 등은 태그 이름과 글자 수로 된 뼈대만 남긴다.
function skeleton(text) {
  return String(text ?? '').replace(/<(\/?)([A-Za-z][\w-]*)[^>]*>|[^<]+|</g, (match, slash, name) => (
    name ? `<${slash}${name}>` : `…(${match.length})`
  ));
}

function debugDump(dir, mode, input, classification) {
  try {
    if (!dir) return;
    if (process.env.ORBIT_HOOK_DEBUG !== '1' && !fs.existsSync(path.join(dir, 'debug'))) return;
    const dumpDir = path.join(dir, 'dumps');
    fs.mkdirSync(dumpDir, { recursive: true });
    const copy = { ...input, classification };
    for (const key of ['prompt', 'last_assistant_message']) {
      if (key in copy) copy[key] = skeleton(copy[key]);
    }
    fs.writeFileSync(path.join(dumpDir, `${Date.now()}-${mode}-${process.pid}.json`), `${JSON.stringify(copy, null, 1)}\n`, { mode: 0o600 });
    const files = fs.readdirSync(dumpDir).filter((name) => name.endsWith('.json')).sort();
    for (const name of files.slice(0, Math.max(0, files.length - MAX_DEBUG_DUMPS))) {
      try { fs.rmSync(path.join(dumpDir, name), { force: true }); } catch {}
    }
  } catch {}
}

// 알림 입력: 새 턴을 열지 않고 기록 지시도 내보내지 않는다.
// - 진행 중인 사용자 턴에 끼어든 알림(같은 prompt_id) → 그 턴에 개수만 붙인다(그 턴 기록이 다룬다).
// - 이미 기록을 마친 사용자 턴 안에서 온 알림 → 조용히 넘긴다.
// - 쉬는 동안 온 알림 → 버퍼에 모았다가 다음 사용자 턴 직전에 한 항목으로 기록한다.
function beginNotification(input, state, notices, promptId) {
  const pending = state.pending;
  if (pending && (!promptId || !pending.promptIds.length || pending.promptIds.includes(promptId))) {
    writeState(input, { ...state, pending: { ...pending, notices: (Number(pending.notices) || 0) + notices.length } });
    return {};
  }
  if (promptId && promptId === state.lastPromptId) return {};
  const at = new Date().toISOString();
  const logAt = lastLoggedTurn();
  let buffered = [...state.notices, ...notices.map((notice) => ({ ...notice, at, logAt }))];
  if (buffered.length > MAX_NOTICES) {
    process.stderr.write(`백그라운드 알림 버퍼가 가득 차(상한 ${MAX_NOTICES}) 오래된 알림 ${buffered.length - MAX_NOTICES}건을 버렸습니다.\n`);
    buffered = buffered.slice(-MAX_NOTICES);
  }
  if (buffered.length >= NOTICE_FLUSH_COUNT) {
    writeState(input, { ...state, notices: [] });
    return { flushNotices: buffered };
  }
  writeState(input, { ...state, notices: buffered });
  return {};
}

// 사용자 입력: 턴을 열고 기록을 강제한다.
// - 진행 중인 턴과 같은 prompt_id(작업 중 보낸 추가 메시지, 한 도착분에 begin이 여러 번 도는 경우)
//   → 새 턴을 열지 않고 같은 토큰을 다시 알린다.
// - 앞 턴이 기록되지 않은 채 남아 있으면(중단 뒤 다시 보낸 메시지 등) orphan으로 밀지 않고
//   새 턴에 합친다. 새 턴이 기록되면 합쳐진 앞 턴도 함께 닫힌다. 옛 토큰만으로는 새 턴이
//   닫히지 않는다(H05 — 새 턴의 기록은 새 토큰으로 해야 한다).
function beginUser(input, state, promptId) {
  const plan = {};
  if (state.notices.length) {
    plan.flushNotices = state.notices;
    state = { ...state, notices: [] };
  }
  const previous = state.pending;
  if (previous && promptId && previous.promptIds.includes(promptId)) {
    writeState(input, { ...state, pending: { ...previous, extraInputs: (Number(previous.extraInputs) || 0) + 1 } });
    plan.context = `추가 입력이 진행 중인 사용자 턴(#${previous.turn})에 합쳐졌습니다 — 새 턴으로 세지 않습니다. 이 입력까지 포함해 요약하고, 기록은 아래 명령으로 한 번만 하세요:\n${appendCommand(state.sessionId, previous.token)}\n명령이 성공하기 전에는 최종 답변을 보내지 않습니다.`;
    return plan;
  }

  const counter = state.counter + 1;
  const token = crypto.randomBytes(8).toString('hex');
  let merged = [];
  if (previous) merged = [...previous.merged, { turn: previous.turn, token: previous.token }].slice(-MAX_MERGED);
  const next = {
    ...state,
    sessionId: String(input.session_id || state.sessionId || 'unknown'),
    counter,
    // transcript: 이 세션이 기록 없이 끝났을 때 다음 세션이 끝난 방식을 보는 데 쓴다(원문은 담지 않는다).
    pending: {
      turn: counter, token, startedAt: new Date().toISOString(), promptIds: promptId ? [promptId] : [], merged,
      transcript: input.transcript_path ? String(input.transcript_path) : null,
    },
    lastPromptId: promptId,
  };
  writeState(input, next);
  const mergedNote = previous
    ? `\n앞 턴(#${previous.turn})이 기록되지 않은 채 끝나(중단 등) 이 턴에 합쳤습니다. 두 입력을 함께 요약해 위 명령으로 한 번만 기록하세요.`
    : '';
  plan.context = `이번 사용자 턴(#${counter})은 아직 worklog에 기록되지 않았습니다. 최종 답변 전에 다음 형식으로 실제 물음과 결과를 요약해 실행하세요:\n${appendCommand(next.sessionId, token)}${mergedNote}\n명령이 성공하기 전에는 최종 답변을 보내지 않습니다.`;
  return plan;
}

// ── 기록 없이 끝난 다른 세션의 턴 복구 ───────────────────────────────────────────
// 응답이 안전 분류기 거절·API 오류로 끝나면 Stop 훅이 돌지 않아 그 턴이 기록되지 않는다.
// 같은 세션에서 다음 입력을 보내면 beginUser가 새 턴에 합치지만, 새 세션을 열면 옛 세션 상태
// 파일에 미기록 턴이 남는다. 새 사용자 턴이 시작될 때 같은 워크트리의 다른 세션 상태를 보고,
// 끝난 것이 분명한 턴만 최소 항목으로 기록한다. 거절 자체를 피하거나 되풀이하지 않는다.
const ENDED_REFUSAL_IDLE_MS = 60 * 1000; // 거절·오류로 끝난 기록: 1분 넘게 조용하면
// 그 밖: 세션 기록이 6시간 넘게 조용하면(권한 승인을 기다리는 다른 세션의 턴을 잘못 닫지 않게 길게 둔다.
// 잘못 닫혀도 그 세션이 나중에 옛 토큰으로 기록하면 항목만 하나 더 생긴다.)
const ENDED_IDLE_MS = 6 * 60 * 60 * 1000;
const ENDED_NO_TRANSCRIPT_MS = 6 * 60 * 60 * 1000; // 세션 기록 경로가 없는 옛 상태: 6시간

function transcriptEnding(file) {
  try {
    const stat = fs.statSync(file);
    const size = stat.size;
    const fd = fs.openSync(file, 'r');
    const length = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    fs.closeSync(fd);
    const lines = buffer.toString('utf8').split('\n').filter(Boolean).slice(-40);
    let refusal = false;
    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type === 'assistant' && entry.message?.stop_reason === 'refusal') refusal = true;
      if (entry.type === 'system' && /refusal|api_error/i.test(String(entry.subtype || ''))) refusal = true;
      if (entry.type === 'user' && !entry.isMeta && entry.message?.role === 'user' && typeof entry.message.content === 'string') refusal = false; // 그 뒤 새 입력
    }
    return { idle: Date.now() - stat.mtimeMs, refusal };
  } catch {
    return null;
  }
}

function recoverEndedSessions(input, dir) {
  const self = `${safeSessionId(input)}.json`;
  let names;
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.json') && name !== self); } catch { return []; }
  const recovered = [];
  for (const name of names) {
    let state;
    try { state = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    const pending = state?.pending;
    if (!pending?.token || !state.sessionId) continue;
    const ending = pending.transcript ? transcriptEnding(pending.transcript) : null;
    const ended = ending
      ? (ending.refusal && ending.idle > ENDED_REFUSAL_IDLE_MS) || ending.idle > ENDED_IDLE_MS
      : Date.now() - Date.parse(pending.startedAt || 0) > ENDED_NO_TRANSCRIPT_MS;
    if (!ended) continue;
    const why = ending?.refusal ? '응답이 거절·오류로 끝나' : '기록 전에 세션이 끝나';
    const ask = `(자동 복구 — 세션 ${String(state.sessionId).slice(0, 8)} 턴 #${pending.turn}: ${why} 기록되지 않은 턴${pendingNote(pending)}, 원문 미기록)`;
    const result = `다음 세션이 시작될 때 worklog 훅이 최소 항목으로 복구함. 결과 미기록 — 필요하면 세션 ${state.sessionId}의 기록·대화 사본을 본다.`;
    const run = spawnSync(process.execPath, [WORKLOG, 'append', 'claude', ask, result, '--session-id', state.sessionId, '--turn-token', pending.token], { cwd: ROOT, encoding: 'utf8' });
    const number = (String(run.stdout).match(/기록됨 \[#(\d+)\]/) || [])[1];
    if (run.status === 0 && number) recovered.push(`#${number}(세션 ${String(state.sessionId).slice(0, 8)} 턴 #${pending.turn})`);
  }
  return recovered;
}

function handleBegin(input) {
  let dir;
  try {
    dir = stateDirectory();
    cleanupOldStateFiles(dir);
  } catch {}

  const notices = parseNotifications(input.prompt);
  const promptId = input.prompt_id ? String(input.prompt_id) : null;
  debugDump(dir, 'begin', input, notices ? 'notification' : 'user');

  const plan = withStateLock(input, () => {
    const { state: previous, error: previousError } = readStateRaw(input);
    if (previousError) {
      // stop의 경고와 대칭(F6) — 손상 상태를 침묵 리셋하지 않고 무엇이 깨졌는지 남긴다.
      // exit 코드는 그대로 0으로 두고 새 카운터로 진행한다(훅 버그로 사용자 턴을 막지 않기 위함).
      process.stderr.write(`worklog 턴 상태 파일이 손상되어 새 카운터로 시작합니다(${compact(previousError.message, 200)}). 경로: ${statePath(input)}\n`);
      // 덮어쓰기 전에 격리(N02) — writeState가 뒤에서 같은 경로에 새 상태를 쓴다.
      isolateCorruptState(input);
    }
    const state = normalizeState(previousError ? null : previous, input);
    return notices ? beginNotification(input, state, notices, promptId) : beginUser(input, state, promptId);
  });

  appendNoticeBundle(input, plan.flushNotices);
  // 새 사용자 턴에서만: 다른 세션이 기록 없이 끝낸 턴을 복구하고 이번 안내에 한 줄 알린다.
  if (!notices && dir) {
    const recovered = recoverEndedSessions(input, dir);
    if (recovered.length && plan.context) plan.context += `\n(참고) 기록 없이 끝난 이전 세션의 턴을 최소 항목으로 복구했습니다: ${recovered.join(', ')}.`;
  }
  if (plan.context) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: plan.context,
      },
    }));
  }
}

function pendingNote(pending) {
  const parts = [];
  if (pending.merged?.length) parts.push(`합쳐진 앞 턴 ${pending.merged.map((item) => `#${item.turn}`).join('·')}`);
  if (Number(pending.extraInputs) > 0) parts.push(`추가 입력 ${pending.extraInputs}건`);
  if (Number(pending.notices) > 0) parts.push(`백그라운드 알림 ${pending.notices}건`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

// 종료 판단은 잠금 안에서 하고, worklog.mjs를 부르는 일(자동 복구·알림 기록)은 잠금 밖에서 한다.
// ── '발견' 칸 알림 ───────────────────────────────────────────────────────────────
// 도구를 많이 쓴 턴(기본 10회, ORBIT_FOUND_MIN_TOOLS로 바꿈, 0이면 끔)이 기록은 됐는데 '- 발견:'
// 줄이 없으면 한 번 막고 알린다. 도구마다 AI로 요약하던 claude-mem 관찰자를 빼는 대신, 알아낸
// 것은 메인 Claude가 한 줄 남기게 하는 보완이다. 턴당 한 번(stop_hook_active·foundNudged).
// 결정: D-프로젝트-기억-분담(결정 7).
function foundMinTools() {
  const value = Number(process.env.ORBIT_FOUND_MIN_TOOLS);
  return Number.isFinite(value) && value >= 0 && process.env.ORBIT_FOUND_MIN_TOOLS !== '' ? value : 10;
}

function worklogBlock(entry) {
  try {
    return fs.readFileSync(WORKLOG_LOG, 'utf8').split(/\n(?=## \[)/).find((block) => block.startsWith(`## [#${entry}]`)) || null;
  } catch {
    return null;
  }
}

// 이번 턴의 도구 사용 수: 세션 기록에서 그 턴의 prompt_id가 붙은 도구 결과(tool_result)를 센다.
// (assistant 항목에는 prompt_id가 없고, 도구 결과를 담은 user 항목에는 있다.)
function countTurnTools(transcriptPath, promptIds) {
  if (!transcriptPath || !promptIds.size) return 0;
  let text;
  try { text = fs.readFileSync(transcriptPath, 'utf8'); } catch { return 0; }
  let count = 0;
  for (const line of text.split('\n')) {
    if (!line.includes('"tool_result"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!promptIds.has(entry.promptId) || !Array.isArray(entry.message?.content)) continue;
    count += entry.message.content.filter((part) => part?.type === 'tool_result').length;
  }
  return count;
}

function foundNudge(input, state, promptId) {
  const minimum = foundMinTools();
  if (!minimum || input.stop_hook_active || !promptId) return null;
  const entry = state.entry;
  if (entry === null || !state.entryPromptIds.includes(promptId) || state.foundNudged === entry) return null;
  const block = worklogBlock(entry);
  if (!block || /^- 발견:/m.test(block)) return null;
  const tools = countTurnTools(input.transcript_path, new Set(state.entryPromptIds));
  if (tools < minimum) return null;
  withStateLock(input, () => {
    const { state: current, error } = readStateRaw(input);
    if (!error) writeState(input, { ...normalizeState(current, input), foundNudged: entry });
  });
  return { entry, tools };
}

function decideStop(input, promptId) {
  const { exists, state, error } = readStateRaw(input);
  if (!exists) return { kind: 'none' }; // 이번 세션에 begin이 한 번도 없었다 — 조용히 통과

  let raw = state;
  if (error) {
    // N02a — 상태 파일이 있는데 파싱이 안 되면 더 이상 경고만 내고 통과하지 않는다.
    // 손상 파일을 격리하고, 새 토큰의 pending을 만들어 아래의 정상 차단·복구 경로에
    // 그대로 태운다(무엇이 깨졌는지도 격리 파일로 남는다).
    isolateCorruptState(input);
    raw = {
      sessionId: String(input.session_id || 'unknown'),
      counter: 1,
      pending: { turn: 1, token: crypto.randomBytes(8).toString('hex'), startedAt: new Date().toISOString() },
      orphans: [],
    };
    writeState(input, raw);
  }

  // 구버전 스키마 마이그레이션: 예전 훅은 pending을 불리언으로 썼다(턴 번호는 최상위 turn).
  // 그대로 두면 "턴 #undefined" 차단이 나오므로, 완료 상태로 옮겨 적고 조용히 통과한다.
  // 카운터는 옛 turn 값을 물려받아 다음 begin이 이어서 증가한다.
  if (raw.pending && typeof raw.pending !== 'object') {
    const migrated = { ...normalizeState({ ...raw, pending: null }, input), counter: Number(raw.counter ?? raw.turn) || 0 };
    writeState(input, migrated);
    return { kind: 'idle', state: migrated };
  }

  let working = normalizeState(raw, input);
  let flush = null;
  if (noticesDue(working.notices)) {
    flush = working.notices;
    working = { ...working, notices: [] };
    writeState(input, working);
  }

  // 이미 완료 처리됨 — 파일은 남겨 카운터를 보존한다(리셋 금지). 정상 경로 끝이므로
  // 대기열에 쌓인 미기록 턴이 있으면 자동 복구를 시도한다(P02).
  if (!working.pending) return { kind: 'idle', state: working, flush };

  // 지금 끝나는 턴이 미기록 사용자 턴과 다른 턴이면(쉬는 동안 온 알림으로 시작된 턴 등)
  // 차단하지 않는다. 그 사용자 턴은 다음 사용자 턴에 합쳐져 함께 기록된다.
  if (promptId && working.pending.promptIds.length && !working.pending.promptIds.includes(promptId)) {
    return { kind: 'idle', state: working, flush };
  }
  if (!input.stop_hook_active) return { kind: 'block', state: working, flush };
  return { kind: 'recover', state: working, flush };
}

function handleStop(input) {
  let dir;
  try { dir = stateDirectory(); } catch {}
  debugDump(dir, 'stop', input, null);
  const promptId = input.prompt_id ? String(input.prompt_id) : null;

  const decision = withStateLock(input, () => decideStop(input, promptId));
  if (decision.kind === 'none') return;
  appendNoticeBundle(input, decision.flush);
  const workingState = decision.state;

  if (decision.kind === 'idle') {
    flushOrphans(workingState.sessionId, workingState.orphans);
    const nudge = foundNudge(input, workingState, promptId);
    if (nudge) {
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: `도구를 ${nudge.tools}번 쓴 턴인데 worklog #${nudge.entry}에 '발견'이 없습니다. 이번 턴에 알아낸 것(원인·제약·동작 방식)을 한 줄 남기세요. 없으면 "없음"이라고 적습니다:\nnode scripts/worklog.mjs found claude ${nudge.entry} "<발견>"`,
      }));
    }
    return;
  }

  if (decision.kind === 'block') {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: `이번 사용자 턴(#${workingState.pending.turn})의 worklog가 기록되지 않았습니다${pendingNote(workingState.pending)}. 최종 답변 전에 다음 명령을 실제 요약으로 채워 실행하세요:\n${appendCommand(workingState.sessionId, workingState.pending.token)}`,
    }));
    return;
  }

  // 재진입(stop_hook_active) — 무한 차단을 피하기 위해 최소 항목으로 자동 복구한다.
  // 프롬프트 원문은 어디에도 남기지 않는다(고정 문구만 사용).
  const pending = workingState.pending;
  const ask = `(자동 복구 — 턴 ${pending.turn} 기록 누락: 종료 차단 후에도 기록되지 않음${pendingNote(pending)}, 원문 미기록)`;
  const result = 'Claude가 종료 전 결과 요약을 기록하지 못해 종료 훅이 누락 항목을 자동 생성함.';
  const recovered = spawnSync(process.execPath, [
    WORKLOG,
    'append',
    'claude',
    ask,
    result,
    '--session-id',
    workingState.sessionId,
    '--turn-token',
    pending.token,
  ], { cwd: ROOT, encoding: 'utf8' });

  // N02b — 자동 복구 append가 실제로 성공했을 때만 pending을 지운다("알림≠보장" 대응).
  // 실패하면 pending을 유지하고 실패 횟수를 세어, 2회까지는 다시 차단해 사람이 알아채게
  // 하고, 3회째부터는 무한 차단 대신 orphans 큐로 옮기고 통과한다(P02).
  if (recovered.status === 0) {
    const resolvedState = withStateLock(input, () => {
      const current = normalizeState(readStateRaw(input).state, input);
      const next = current.pending?.token === pending.token ? { ...current, pending: null } : current;
      writeState(input, next);
      return next;
    });
    // 정상 경로 끝 — 이번 턴이 방금 해소됐으니, 큐에 남은 다른 미기록 턴도 함께 흘려본다.
    flushOrphans(resolvedState.sessionId, resolvedState.orphans);
    process.stdout.write(JSON.stringify({
      systemMessage: 'worklog 기록 누락을 종료 훅이 최소 항목으로 자동 복구했습니다. 다음 턴에서 누락 원인을 확인하세요.',
    }));
    return;
  }

  const failures = (Number(pending.recoveryFailures) || 0) + 1;
  const failureDetail = compact(recovered.stderr || recovered.error?.message, 300);

  // 잠금 밖에서 복구를 시도하는 사이 그 턴이 기록됐으면(pending이 바뀌었으면) 되살리지 않는다.
  if (failures <= 2) {
    const failedState = withStateLock(input, () => {
      const current = normalizeState(readStateRaw(input).state, input);
      if (current.pending?.token !== pending.token) return null;
      const next = { ...current, pending: { ...current.pending, recoveryFailures: failures } };
      writeState(input, next);
      return next;
    });
    if (!failedState) return;
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: `worklog 자동 복구가 실패했습니다(시도 ${failures}회): ${failureDetail}\n수동으로 다음 명령을 실행해 기록하세요:\n${appendCommand(failedState.sessionId, failedState.pending.token)}`,
    }));
    return;
  }

  // P02 — 안전성 불변 규칙("반드시 기록")과 무한 차단 금지가 충돌하는 지점. 3회째부터는
  // 더 이상 차단하지 않고, 이 턴을 orphans 큐로 옮겨 보존한 채 통과한다 — 기록 자체를
  // 포기하는 게 아니라, 이후 stop이 정상적으로 끝날 때마다(또는 다음 begin 이후) 자동
  // 복구를 계속 시도하고, 수동 append 명령도 큐를 실제로 비운다(worklog.mjs 쪽 대응).
  const orphanEntry = { turn: pending.turn, token: pending.token, failedAt: new Date().toISOString(), cause: 'recovery-failed' };
  const movedState = withStateLock(input, () => {
    const current = normalizeState(readStateRaw(input).state, input);
    if (current.pending?.token !== pending.token) return null;
    const next = { ...current, pending: null, orphans: pushOrphan(current.orphans, orphanEntry) };
    writeState(input, next);
    return next;
  });
  if (!movedState) return;
  flushOrphans(movedState.sessionId, movedState.orphans);
  process.stdout.write(JSON.stringify({
    systemMessage: `worklog 자동·수동 복구 모두 실패했습니다(시도 ${failures}회) — 미기록 턴 #${orphanEntry.turn}을 대기열에 보존했습니다. 수동 복구:\n${appendCommand(movedState.sessionId, orphanEntry.token)}`,
  }));
}

const input = readInput();
const mode = process.argv[2];

try {
  if (mode === 'begin') handleBegin(input);
  else if (mode === 'stop') handleStop(input);
  else throw new Error('사용법: node scripts/worklog-hook.mjs <begin|stop>');
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
