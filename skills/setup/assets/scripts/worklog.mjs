#!/usr/bin/env node
// 작업 일지 엔진 — Claude와 Codex가 턴제로 협업할 때 서로의 맥락을 잇는다.
// 둘은 대화 맥락을 공유하지 못하므로, 각자의 "왜"를 이 파일에 남겨 이어붙인다.
//
// 저장 위치:
//   {{DOCS_DIR}}/worklog.md          사람과 기계가 함께 읽는 기록 (덧붙이기만)
//   {{DOCS_DIR}}/worklog-state.json  책갈피(각자 마지막 읽은 지점)와 카운터
//
// 명령:
//   append <작성자> "<물음>" "<결과>"   이번 턴을 기록하고, 그 작성자의 책갈피를 최신으로 옮긴다
//   append ... --session-id <ID> --turn-token <TOKEN>  Claude 훅의 이번 턴 미기록 상태를 완료한다
//   append ... --session-id <ID> --turn-id <N>          위와 동일하되 구버전 훅과의 호환용(토큰 없을 때)
//   append ... --commit "<커밋메시지>"  기록 직후 git add -A + 커밋까지 한 번에 (순서 실수 방지)
//   summary <작성자> "<요약>"           최근 턴들을 하나로 묶어 요약한다 (3턴마다)
//   catchup <작성자>                    책갈피 이후 밀린 내용을 보여주고 책갈피를 옮긴다 (없으면 조용)
//   recent <작성자> [--mode compact]     최근 턴 8개와 그 앞 구간 요약들을 보여준다 (읽기 전용)
//
// 안전 원칙: 책갈피는 "덜 옮기면 다시 읽기(무해)" 쪽으로만 실수하게. 앞질러 건너뛰지 않는다.
// --commit: worklog를 별도 커밋으로 뒤에 미루지 말고, 작업 커밋에 함께 태우기 위한 것.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOG = path.join(ROOT, '{{DOCS_DIR}}', 'worklog.md');
const STATE = path.join(ROOT, '{{DOCS_DIR}}', 'worklog-state.json');
const WHO = ['claude', 'codex'];

// 동시 실행(파일 잠금)과 손상 파일 감지에 쓰는 최소 헬퍼. 외부 의존성 없이 fs만 쓴다.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
// 시간만으로 "오래됐다 = 죽었다"고 판단하면, 시스템이 바빠 보유 프로세스가 잠깐 스케줄을
// 못 받는 것뿐인데도 잠금을 빼앗아 두 프로세스가 동시에 쓰게 되는 사고가 난다(실측: 100개
// 동시 add 부하에서 재현). 그래서 잠금 보유자의 pid가 실제로 살아 있는지부터 확인하고,
// 죽었을 때만 즉시 회수한다. pid를 못 읽을 때만(생성 중 등) 시간 기준으로 판단한다.
function isLockStale(lockDir, pidFile, staleMs) {
  let mtime;
  try {
    mtime = fs.statSync(lockDir).mtimeMs;
  } catch {
    return false; // 확인하는 사이 보유자가 이미 잠금을 풀었다 — 다음 루프의 mkdirSync가 알아서 성공한다
  }
  let holderPid = null;
  try { holderPid = Number(fs.readFileSync(pidFile, 'utf8').trim()); } catch {}
  if (holderPid) {
    let alive = true;
    try { process.kill(holderPid, 0); } catch { alive = false; }
    if (alive) return Date.now() - mtime > 5 * 60 * 1000; // pid 재사용 대비 안전판(5분)
    return true;
  }
  return Date.now() - mtime > staleMs;
}
// staleMs는 pid 파일을 아예 못 읽을 때만 쓰는 최후 수단 기준이다(정상 경로는 pid
// 생존 여부로 즉시 판단). 실사용은 Claude·Codex 2~3개 동시 실행 정도라 넉넉히 잡는다.
// fatal=false면 시간 초과 때 종료하지 않고 null을 돌려준다(호출자가 잠금 없이 진행).
function acquireLock(target, timeoutMs = 15000, staleMs = 30000, fatal = true) {
  const lockDir = `${target}.lock`;
  const pidFile = path.join(lockDir, 'pid');
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      try { fs.writeFileSync(pidFile, String(process.pid)); } catch {}
      return lockDir;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (isLockStale(lockDir, pidFile, staleMs)) {
        // rmSync를 바로 쓰면 "오래됐다"고 판단한 두 대기자가 동시에 지우다 경쟁할 수 있다.
        // rename은 원자적이라 한쪽만 성공한다 — 그 쪽만 이어서 임시 이름을 지운다.
        const reclaimed = `${lockDir}.reclaim-${process.pid}-${Date.now()}`;
        try {
          fs.renameSync(lockDir, reclaimed);
        } catch {
          continue; // 다른 프로세스가 먼저 회수했다(ENOENT 등) — 루프를 돌아 mkdirSync부터 다시
        }
        try { fs.rmSync(reclaimed, { recursive: true, force: true }); } catch {}
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        if (!fatal) return null;
        console.error(`잠금을 얻지 못했습니다(다른 프로세스가 worklog를 쓰는 중) — 잠시 후 다시 시도하세요: ${lockDir}`);
        process.exit(1);
      }
      sleepSync(30);
    }
  }
}
// N07 — 삭제 전에 잠금 안의 pid가 자기 것인지 확인한다. 5분 안전판 회수 뒤 원소유자가
// 뒤늦게 자기 finally 블록에서 releaseLock을 부르면, 그 사이 다른 프로세스가 같은 경로에
// 새로 잡은 잠금을 지워버릴 수 있었다(회수 피해 창). pid가 다르거나 읽지 못하면 아예
// 건드리지 않는다 — "확실히 내 것일 때만 지운다" 쪽으로 안전하게 후퇴한다.
function releaseLock(lockDir) {
  const pidFile = path.join(lockDir, 'pid');
  let holderPid;
  try {
    holderPid = fs.readFileSync(pidFile, 'utf8').trim();
  } catch {
    return; // 소유 확인 불가 — 남의 것일 수 있으니 건드리지 않는다
  }
  if (holderPid !== String(process.pid)) return; // 남의 잠금 — 건드리지 않는다
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
}
function withLock(target, fn, { timeoutMs = 15000, fatal = true } = {}) {
  const lockDir = acquireLock(target, timeoutMs, 30000, fatal);
  try {
    return fn();
  } finally {
    if (lockDir) releaseLock(lockDir);
  }
}
// P04 — 실패 시 임시 파일을 지우고 다시 던진다(정리 없이 던지면 *.tmp 잔재가 남는다).
function atomicWriteFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
}

function loadState() {
  if (!fs.existsSync(STATE)) return { next: 1, lastSummarized: 0, bookmarks: { claude: 0, codex: 0 } };
  const raw = fs.readFileSync(STATE, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    const backup = `${STATE}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(STATE, backup); } catch {}
    console.error(`${STATE} 파싱 실패 — 손상된 파일을 ${backup}로 복사해 뒀습니다. 직접 복구한 뒤 다시 시도하세요.\n${error.message}`);
    process.exit(1);
  }
}
function saveState(s) {
  atomicWriteFile(STATE, JSON.stringify(s, null, 2) + '\n');
}
function ensureLog() {
  if (fs.existsSync(LOG)) return;
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.writeFileSync(
    LOG,
    '# 작업 일지 (Claude ↔ Codex 협업 기록)\n\n' +
      '> 규칙은 CLAUDE.md / AGENTS.md "협업" 절 참고. 덧붙이기만 한다(위 기록 수정·삭제 금지).\n' +
      '> 모든 턴을 [#N]으로 남기고, 3턴마다 [요약]으로 묶는다. 상대 기록에 이견이 있으면 새 항목으로 남긴다.\n\n'
  );
}
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// 백틱 코드 표시 밖의 <, > 만 HTML 엔티티로 바꾼다. 옵시디언은 맨몸 <무언가>를 HTML
// 태그로 해석해 그 뒤 서식을 통째로 삼킨다(2026-08-07 발견). 백틱 안(코드)은 그대로 둬야
// &lt; 가 문자 그대로 보이지 않는다. 백틱으로 쪼개 짝수 인덱스(밖)만 치환한다.
function escapeAnglesOutsideCode(text) {
  const parts = String(text).split('`');
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  return parts.join('`');
}
// 물음·결과에 줄바꿈이 섞여 들어오면 "\n## [#"류 패턴으로 가짜 턴 머리글이 생길 수 있다.
// 줄바꿈을 공백으로 접어 로그 한 항목이 항상 한 덩어리로 남게 한다. 이어서 꺾쇠도 무해화한다.
function sanitizeLogText(value) {
  return escapeAnglesOutsideCode(String(value ?? '').replace(/\r\n|\r|\n/g, ' '));
}

// 로그 마지막 tailBytes만 읽어 실제로 기록된 최대 턴 번호를 찾는다. 상태 파일이
// append 이후 저장 전에 죽는 등(H10)으로 s.next가 로그보다 뒤처졌을 때 자가 복구용.
// 고정 크기(8KB)만 보면 그 항목 하나가 8KB보다 커서(예: 긴 결과 요약) 꼬리 안에 완전한
// 헤더가 하나도 안 남는 경우 복구가 실패한다(N06). 그래서 헤더를 하나도 못 찾았고
// 아직 파일 시작에도 닿지 않았으면 tailBytes를 4배씩 늘려 파일 전체까지 재시도한다.
function maxTurnNumberInTail(logFile, tailBytes = 8192) {
  let size;
  try {
    size = fs.statSync(logFile).size;
  } catch {
    return null;
  }
  let bytes = tailBytes;
  for (;;) {
    let text;
    try {
      const fd = fs.openSync(logFile, 'r');
      try {
        const start = Math.max(0, size - bytes);
        const length = size - start;
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, start);
        text = buffer.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
    let max = null;
    const re = /^## \[#(\d+)\]/gm;
    let m;
    while ((m = re.exec(text))) {
      const num = Number(m[1]);
      if (max === null || num > max) max = num;
    }
    if (max !== null || bytes >= size) return max; // 찾았거나 이미 파일 전체를 다 봤다
    bytes *= 4;
  }
}

function append(agent, ask, result) {
  ensureLog();
  return withLock(STATE, () => {
    const s = loadState();
    const maxLogged = maxTurnNumberInTail(LOG);
    // 자가 복구: next를 로그의 실제 최대 번호+1로 맞춘다. 뒤처진 경우(H10, append 후 저장
    // 전 죽음)뿐 아니라 앞선 경우(병렬 워크트리 병합으로 state가 브랜치판이 되어 next가
    // 로그보다 큰 경우)도 교정한다 — 앞서면 결번이 생기므로. 정상 동작에선 이미 최대+1이라 무변화.
    if (maxLogged !== null) s.next = maxLogged + 1;
    const n = s.next;
    fs.appendFileSync(
      LOG,
      `## [#${n}] ${today()} · ${agent} · with:user\n- 물음: ${sanitizeLogText(ask)}\n- 결과: ${sanitizeLogText(result)}\n\n`
    );
    s.next = n + 1;
    s.bookmarks[agent] = n; // 자기가 쓴 것은 읽은 것으로 본다
    saveState(s);
    const since = n - s.lastSummarized; // 마지막 요약 이후 쌓인 턴 수
    process.stdout.write(
      since >= 3 ? `기록됨 [#${n}]. 이제 최근 ${since}턴을 요약할 때입니다.\n` : `기록됨 [#${n}].\n`
    );
    return n;
  });
}

// 세션ID+토큰(신규) 또는 세션ID+턴번호(구버전 호환)로 대기중인 훅 턴을 완료 처리한다.
// 토큰이 있으면 토큰이 우선 — 매 턴 새 토큰이 발급되므로 옛 토큰 재사용으로 완료 처리되는
// 사고(H05)를 막는다. 토큰 없이 turn-id만 오면(구버전 훅) pending.turn과 비교한다.
// 상태 파일은 worklog-hook.mjs와 같은 잠금(`<상태 파일>.lock`)을 잡고 고친다 — 알림이 몰릴 때
// begin과 겹쳐도 서로의 갱신을 덮어쓰지 않게 한다. 잠금을 못 얻으면 잠금 없이 진행한다.
function completeHookTurn(sessionId, turnToken, turnId, entry) {
  if (!sessionId || (!turnToken && !turnId)) return;

  let stateDir;
  try {
    const gitPath = execFileSync('git', ['rev-parse', '--git-path', 'orbit-state/worklog'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    stateDir = path.resolve(ROOT, gitPath);
  } catch {
    return;
  }

  const safeSession = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180);
  const statePath = path.join(stateDir, `${safeSession}.json`);
  if (!fs.existsSync(statePath)) return;
  withLock(statePath, () => completeHookTurnLocked(stateDir, statePath, turnToken, turnId, entry), { timeoutMs: 5000, fatal: false });
}

function completeHookTurnLocked(stateDir, statePath, turnToken, turnId, entry) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return;
  }

  const pendingMatches = Boolean(
    state.pending && typeof state.pending === 'object'
      && (turnToken ? state.pending.token === turnToken : String(state.pending.turn) === String(turnId))
  );
  if (pendingMatches) {
    // 이 턴에 합쳐진 앞 턴(merged)들도 함께 닫힌다 — 새 턴의 기록이 그 입력까지 요약한다.
    writeCompletedHookState(stateDir, statePath, { ...state, pending: null, entry });
    return;
  }

  // 합쳐진 앞 턴의 옛 토큰으로 기록했으면 그 항목만 지운다. 현재 턴은 열린 채로 둔다(H05).
  const merged = state.pending && typeof state.pending === 'object' && Array.isArray(state.pending.merged)
    ? state.pending.merged
    : [];
  if (turnToken && merged.some((item) => item && item.token === turnToken)) {
    const pending = { ...state.pending, merged: merged.filter((item) => !item || item.token !== turnToken) };
    writeCompletedHookState(stateDir, statePath, { ...state, pending });
    return;
  }

  // P02 — pending과 불일치해도(또는 pending이 없어도) 포기하지 않는다. 3회 실패로 orphans
  // 큐에 옮겨진 턴이거나, begin이 이전 pending을 orphans로 옮긴 경우 토큰이 거기 있을 수
  // 있다 — 여기서 찾아 지워야 수동 복구 명령("appendCommand" 안내문)이 실제로 큐를 비운다.
  if (turnToken && Array.isArray(state.orphans)) {
    const index = state.orphans.findIndex((orphan) => orphan && orphan.token === turnToken);
    if (index !== -1) {
      const orphans = [...state.orphans.slice(0, index), ...state.orphans.slice(index + 1)];
      writeCompletedHookState(stateDir, statePath, { ...state, orphans });
    }
  }
}

// P04 — 실패 시 임시 파일을 지우고 다시 던진다(정리 없이 던지면 *.tmp 잔재가 남는다).
function writeCompletedHookState(stateDir, statePath, updated) {
  const temporary = `${statePath}.${process.pid}.tmp`;
  fs.mkdirSync(stateDir, { recursive: true });
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(updated)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, statePath);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
  try { fs.chmodSync(statePath, 0o600); } catch {}
}

function summary(agent, text) {
  ensureLog();
  withLock(STATE, () => {
    const s = loadState();
    const from = s.lastSummarized + 1;
    const to = s.next - 1;
    if (to < from) {
      process.stdout.write('요약할 새 항목이 없습니다.\n');
      return;
    }
    fs.appendFileSync(LOG, `## [요약 #${from}~${to}] ${today()} · ${agent}\n${sanitizeLogText(text)}\n\n`);
    s.lastSummarized = to;
    saveState(s);
    process.stdout.write(`요약됨 [#${from}~${to}].\n`);
  });
}

function catchup(agent) {
  ensureLog();
  withLock(STATE, () => {
    const s = loadState();
    const mark = s.bookmarks[agent] ?? 0;
    const latest = s.next - 1;
    if (latest <= mark) return; // 밀린 게 없으면 조용히 끝낸다

    const sm = s.lastSummarized;
    const blocks = fs
      .readFileSync(LOG, 'utf8')
      .split(/\n(?=## \[)/)
      .filter((b) => b.startsWith('## ['));
    const out = [];
    for (const b of blocks) {
      const e = b.match(/^## \[#(\d+)\]/);
      const g = b.match(/^## \[요약 #(\d+)~(\d+)\]/);
      if (g) {
        if (+g[2] > mark) out.push(b.trim()); // 밀린 구간을 덮는 요약
      } else if (e) {
        if (+e[1] > Math.max(mark, sm)) out.push(b.trim()); // 아직 요약 안 된 최근 턴
      }
    }
    if (out.length) {
      process.stdout.write(`── 작업 일지 따라잡기 (${agent} 책갈피 #${mark} → #${latest}) ──\n\n`);
      process.stdout.write(out.join('\n\n') + '\n');
    }
    s.bookmarks[agent] = latest;
    saveState(s);
  });
}

// recent — 세션 시작과 컴팩션 직후에 최근 맥락을 주입한다. catchup과 달리 책갈피를
// 소비하지 않는(읽기 전용) 명령이라 병렬·연속 세션이 모두 동일하게 받는다. 시점별 기억만으로는
// 놓치기 쉬운 번복·폐기를 시간순 로그로 메운다. 결정: D-프로젝트-기억-분담(결정 3·4).
// 출력은 최근 턴 8개와, 그 8턴보다 앞 구간을 덮는 요약들이다. 요약은 3턴마다 직전 3턴만 덮어
// 최신 요약이 늘 최근 8턴과 겹치므로, 8턴 안쪽만 덮는 요약은 넣지 않는다. 훅이 묶어 적은
// 백그라운드 알림 항목은 모델이 쓴 기록과 겹치고 주입 칸만 차지해 뺀다.
const RECENT_TURNS = 8;
const RECENT_SUMMARY_MAX = 5;
const RECENT_SUMMARY_CHARS = 3000;
const RECENT_TOTAL_CHARS = 9000; // 훅 출력 상한(10,000자) 안에 머문다
const NOTICE_BUNDLE_MARK = '사용자 턴 사이에 도착한 백그라운드 작업 알림을 훅이 묶어 기록함';

function recent(mode) {
  if (!fs.existsSync(LOG)) return;
  const blocks = fs
    .readFileSync(LOG, 'utf8')
    .split(/\n(?=## \[)/)
    .filter((b) => b.startsWith('## ['))
    .map((b) => b.trim());
  if (!blocks.length) return;
  const turns = [];
  const summaries = [];
  for (const block of blocks) {
    const turn = block.match(/^## \[#(\d+)\]/);
    const range = block.match(/^## \[요약 #(\d+)~(\d+)\]/);
    if (turn && !block.includes(NOTICE_BUNDLE_MARK)) turns.push({ n: Number(turn[1]), text: block });
    else if (range) summaries.push({ from: Number(range[1]), to: Number(range[2]), text: block });
  }
  const recentTurns = turns.slice(-RECENT_TURNS);
  const windowStart = recentTurns.length ? recentTurns[0].n : Infinity;
  const picked = [];
  let summaryChars = 0;
  for (const summary of summaries.filter((s) => s.from < windowStart).sort((a, b) => b.to - a.to)) {
    if (picked.length >= RECENT_SUMMARY_MAX || summaryChars + summary.text.length > RECENT_SUMMARY_CHARS) break;
    picked.push(summary);
    summaryChars += summary.text.length;
  }
  picked.sort((a, b) => a.to - b.to);
  let parts = [...picked.map((s) => s.text), ...recentTurns.map((t) => t.text)];
  while (parts.join('\n\n').length > RECENT_TOTAL_CHARS && parts.length > 1) parts = parts.slice(1);
  if (!parts.length) return;
  const summaryCount = parts.length - Math.min(parts.length, recentTurns.length);
  const turnCount = parts.length - summaryCount;
  const title = mode === 'compact' ? '컴팩션 전 기록' : '이전 세션 최근 맥락';
  process.stdout.write(`── ${title} (worklog 앞 구간 요약 ${summaryCount} + 최근 턴 ${turnCount}) ──\n\n`);
  process.stdout.write(parts.join('\n\n') + '\n');
}

// --commit "<메시지>" 를 인자에서 분리 (append 직후 작업 커밋에 함께 태운다)
const argv = process.argv.slice(2);
function takeOption(name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1] ?? '';
  argv.splice(index, 2);
  return value;
}

let commitMsg = null;
commitMsg = takeOption('--commit');
const hookSessionId = takeOption('--session-id');
const hookTurnToken = takeOption('--turn-token');
const hookTurnId = takeOption('--turn-id');
const recentMode = takeOption('--mode');

// 기록을 커밋에 포함 → 순서 실수(커밋 먼저, 기록 나중)를 원천 차단
function gitCommitAll(msg) {
  try {
    execFileSync('git', ['add', '-A'], { cwd: ROOT, stdio: 'inherit' });
    execFileSync('git', ['commit', '-m', msg], { cwd: ROOT, stdio: 'inherit' });
  } catch {
    process.stderr.write('커밋 실패(또는 커밋할 변경 없음). 수동 확인 필요.\n');
    process.exit(1);
  }
}

const [cmd, agent, a, b] = argv;
if (!WHO.includes(agent)) {
  process.stderr.write('작성자는 claude 또는 codex 여야 합니다.\n');
  process.exit(1);
}
if (cmd === 'append') {
  const n = append(agent, a ?? '', b ?? '');
  completeHookTurn(hookSessionId, hookTurnToken, hookTurnId, n);
  if (commitMsg !== null) gitCommitAll(commitMsg);
} else if (cmd === 'summary') {
  summary(agent, a ?? '');
  if (commitMsg !== null) gitCommitAll(commitMsg);
} else if (cmd === 'catchup') catchup(agent);
else if (cmd === 'recent') recent(recentMode);
else {
  process.stderr.write('사용법: worklog <append|summary|catchup|recent> <claude|codex> ... [--commit "메시지"] [--session-id ID --turn-token TOKEN | --session-id ID --turn-id N] [--mode compact]\n');
  process.exit(1);
}
