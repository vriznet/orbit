#!/usr/bin/env node
// {{PROJECT_NAME}} 할일 원장 (GTD). 캐논은 {{DOCS_DIR}}/tasks.json, 사람이 읽는 뷰는 {{DOCS_DIR}}/tasks.md(자동 렌더).
// 완료분은 {{DOCS_DIR}}/tasks-done.md 로 아카이브.
//
// 손으로 tasks.md 를 고치지 말 것 — 이 스크립트로만 다룬다(그래야 안 깨진다).
//
// 사용:
//   node scripts/tasks.mjs add "<제목>" --owner ai|human|both --action next|planning|waiting|someday \
//        --urgency high|med|low --source "<출처>" [--due YYYY-MM-DD] [--wait "<대기이유>"] [--memo "<메모>"]
//   node scripts/tasks.mjs done <id>
//   node scripts/tasks.mjs drop <id> --reason "<이유>"   (이유가 사라진 할일 취소 — 완료와 구분해 취소 아카이브로)
//   node scripts/tasks.mjs edit <id> --key value ...   (같은 플래그로 수정)
//   node scripts/tasks.mjs list
//   node scripts/tasks.mjs review            (열린 Next Action + 기한 지난 Planning + Waiting 출력 + 미러 갱신)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, '{{DOCS_DIR}}', 'tasks.json');
const MD = path.join(ROOT, '{{DOCS_DIR}}', 'tasks.md');
const DONE_MD = path.join(ROOT, '{{DOCS_DIR}}', 'tasks-done.md');

const OWNER = { ai: '🤖 AI', human: '🧑 사람', both: '👥 공동' };
const URG = { high: '🔴 높음', med: '🟡 보통', low: '🟢 낮음' };
// 중요도(긴급과 별개 축). 선택 필드 — 미지정이면 '—'로 렌더. 아이콘은 긴급의 신호등과 겹치지 않게 별표.
const IMP = { high: '★ 높음', med: '☆ 보통', low: '· 낮음' };
const BUCKETS = [
  { key: 'next', title: '🔵 Next Action', hint: '다음 행동이 명확, 지금/곧' },
  { key: 'planning', title: '📅 Planning', hint: '예정일이 있는 것' },
  { key: 'waiting', title: '⏸️ Waiting', hint: '다른 할일·조건·사람을 기다림' },
  { key: 'someday', title: '💭 Someday', hint: '언젠가·미정' },
];

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// 병렬 워크트리에서 두 세션이 같은 순번(T001)을 발번하던 충돌을 없애기 위해, 새 ID는
// T-슬러그-YYMMDD-HHMMSS 형식으로 만든다. 슬러그가 앞에 와서 무슨 할일인지 먼저 읽히고,
// 일시가 붙어 선후·유일성이 확보된다. 기존 순번 ID는 그대로 두고 앞으로부터 새 형식을 쓴다.
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function slugify(title) {
  const s = String(title || '')
    .trim()
    .replace(/[\s—–_-]+/g, '-')          // 공백·대시류 → 하이픈
    .replace(/[^\p{L}\p{N}-]/gu, '')      // 문자·숫자·하이픈 외 제거(한글 등 유지)
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
  return s || 'task';
}

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
function acquireLock(target, timeoutMs = 15000, staleMs = 30000) {
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
        console.error(`잠금을 얻지 못했습니다(다른 프로세스가 tasks.json을 쓰는 중) — 잠시 후 다시 시도하세요: ${lockDir}`);
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
function withLock(target, fn) {
  const lockDir = acquireLock(target);
  try {
    return fn();
  } finally {
    releaseLock(lockDir);
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

function load() {
  if (!fs.existsSync(DATA)) return { seq: 0, open: [], done: [], dropped: [] };
  const raw = fs.readFileSync(DATA, 'utf8');
  try {
    const db = JSON.parse(raw);
    if (!Array.isArray(db.dropped)) db.dropped = []; // drop 명령 도입 전 원장 호환
    return db;
  } catch (error) {
    const backup = `${DATA}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(DATA, backup); } catch {}
    console.error(`${DATA} 파싱 실패 — 손상된 파일을 ${backup}로 복사해 뒀습니다. 직접 복구한 뒤 다시 시도하세요.\n${error.message}`);
    process.exit(1);
  }
}
// render(파생 뷰)는 persistData 직후 잠금을 쥔 채로 호출한다 — 잠금 밖에서 하면
// 두 프로세스가 얽혀 먼저 쓴 쪽의 db로 나중에 렌더해 원장과 파생 뷰가 어긋날 수 있다(R04).
// 임계구역이 길어지지만 실사용 동시성(2~3)에서는 무시할 수준이라 정합성을 우선한다.
function persistData(db) {
  atomicWriteFile(DATA, JSON.stringify(db, null, 2) + '\n');
}
function validateEnum(flag, value, allowed) {
  if (!allowed.includes(value)) {
    console.error(`--${flag} 값이 올바르지 않습니다: "${value}" (허용: ${allowed.join(', ')})`);
    process.exit(1);
  }
}

// --flag value 파서(값 없는 플래그 없음)
function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

// 백틱 코드 표시 밖의 <, > 만 HTML 엔티티로 바꾼다. 옵시디언이 맨몸 <무언가>를 태그로
// 해석해 그 뒤 서식을 삼키는 문제(2026-08-07 발견)를 막는다. 백틱 안(코드)은 그대로 둔다.
function escapeAnglesOutsideCode(text) {
  const parts = String(text).split('`');
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  return parts.join('`');
}
function esc(s) {
  return escapeAnglesOutsideCode(String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' '));
}

function rowExtra(t) {
  if (t.action === 'planning') return t.due || '';
  if (t.action === 'waiting') return t.wait || '';
  return '';
}

// 중요도 셀: 미지정이거나 알 수 없는 값이면 '—'(거짓 정밀 방지).
function impCell(t) {
  return t.importance && IMP[t.importance] ? IMP[t.importance] : '—';
}
// 담당·긴급 셀도 같은 이유로 안전장치를 둔다 — 허용 밖 값이 표에 "undefined"로 새지 않게.
function ownerCell(t) {
  return OWNER[t.owner] || '—';
}
function urgCell(t) {
  return URG[t.urgency] || '—';
}

function render(db) {
  const L = [];
  L.push('# {{PROJECT_NAME}} 할일 원장 (GTD)');
  L.push('');
  L.push('> ⚠️ 이 파일은 자동 생성된다. **손으로 고치지 말 것** — `scripts/tasks.mjs`로만 다룬다.');
  L.push('> 조건부·트리거 작업은 Waiting으로 등록하고(--wait에 트리거), [backlog.md](./backlog.md)에도 트리거 중심으로 함께 기록한다(task ID로 연결). 완료분은 [tasks-done.md](./tasks-done.md).');
  L.push(`> 갱신: ${today()} · 열린 할일 ${db.open.length}개`);
  L.push('');
  for (const b of BUCKETS) {
    const items = db.open.filter((t) => t.action === b.key);
    L.push(`## ${b.title}  (${b.hint})`);
    L.push('');
    if (items.length === 0) {
      L.push('_없음_');
      L.push('');
      continue;
    }
    const extraCol = b.key === 'planning' ? '예정일' : b.key === 'waiting' ? '대기이유' : '메모';
    if (b.key === 'planning' || b.key === 'waiting') {
      L.push(`| id | 할일 | 담당 | 긴급 | 중요 | 출처 | 생성 | ${extraCol} | 메모 |`);
      L.push('|----|------|------|------|------|------|------|------|------|');
      for (const t of items)
        L.push(`| ${t.id} | ${esc(t.title)} | ${ownerCell(t)} | ${urgCell(t)} | ${impCell(t)} | ${esc(t.source)} | ${t.created} | ${esc(rowExtra(t))} | ${esc(t.memo)} |`);
    } else {
      L.push('| id | 할일 | 담당 | 긴급 | 중요 | 출처 | 생성 | 메모 |');
      L.push('|----|------|------|------|------|------|------|------|');
      for (const t of items)
        L.push(`| ${t.id} | ${esc(t.title)} | ${ownerCell(t)} | ${urgCell(t)} | ${impCell(t)} | ${esc(t.source)} | ${t.created} | ${esc(t.memo)} |`);
    }
    L.push('');
  }
  fs.writeFileSync(MD, L.join('\n') + '\n');
  const D = ['# {{PROJECT_NAME}} 할일 — 완료 아카이브', '', '| id | 할일 | 담당 | 출처 | 생성 | 완료 |', '|----|------|------|------|------|------|'];
  for (const t of db.done)
    D.push(`| ${t.id} | ${esc(t.title)} | ${ownerCell(t)} | ${esc(t.source)} | ${t.created} | ${t.doneAt} |`);
  // 취소는 완료와 섞지 않는다 — 섞으면 "결과를 얻었다"는 완료 기록이 거짓이 된다(GTD의 휴지통에 해당).
  if (db.dropped.length) {
    D.push('', '## 취소 아카이브  (이유가 사라져 하지 않기로 한 할일)', '', '| id | 할일 | 담당 | 출처 | 생성 | 취소 | 이유 |', '|----|------|------|------|------|------|------|');
    for (const t of db.dropped)
      D.push(`| ${t.id} | ${esc(t.title)} | ${ownerCell(t)} | ${esc(t.source)} | ${t.created} | ${t.droppedAt} | ${esc(t.reason)} |`);
  }
  fs.writeFileSync(DONE_MD, D.join('\n') + '\n');
}

function reviewText(db) {
  const t = today();
  const nexts = db.open.filter((x) => x.action === 'next');
  const overdue = db.open.filter((x) => x.action === 'planning' && x.due && x.due < t);
  const dueToday = db.open.filter((x) => x.action === 'planning' && x.due === t);
  const waiting = db.open.filter((x) => x.action === 'waiting');
  const L = [`=== 할일 리뷰 (${t}) ===`];
  const dump = (label, arr) => {
    if (!arr.length) return;
    L.push(`\n[${label}] ${arr.length}건`);
    for (const x of arr) L.push(`  ${x.id} ${x.title} — ${ownerCell(x)} 긴급 ${urgCell(x)} · 중요 ${impCell(x)} (출처: ${x.source}${x.due ? ', 예정 ' + x.due : ''}${x.wait ? ', 대기: ' + x.wait : ''})`);
  };
  dump('기한 지남', overdue);
  dump('오늘 예정', dueToday);
  dump('Next Action', nexts);
  dump('Waiting', waiting);
  if (!overdue.length && !dueToday.length && !nexts.length && !waiting.length) L.push('열린 급한 할일 없음.');
  return L.join('\n');
}

// ── 명령 ──────────────────────────────────────────────
// 원장을 바꾸는 명령(add/done/drop/edit/init/review)은 load→mutate→원장 쓰기→render까지
// 잠금 안에서 한 번에 수행한다 — Claude·Codex가 동시에 실행해도 기록이 사라지거나
// 파생 뷰(tasks.md·미러)가 방금 persist한 db보다 오래된 것으로 덮어써지지 않는다(R04).
// list는 원장을 바꾸지 않으므로 잠금 밖에서 그대로 읽는다.
const [cmd, ...rest] = process.argv.slice(2);
const OWNER_KEYS = Object.keys(OWNER);
const URG_KEYS = Object.keys(URG);
const IMP_KEYS = Object.keys(IMP);
const ACTION_KEYS = BUCKETS.map((b) => b.key);

if (cmd === 'add') {
  const title = rest[0];
  const f = parseFlags(rest.slice(1));
  if (!title || !f.owner || !f.action || !f.urgency || !f.source) {
    console.error('필수: "<제목>" --owner --action --urgency --source');
    process.exit(1);
  }
  validateEnum('owner', f.owner, OWNER_KEYS);
  validateEnum('action', f.action, ACTION_KEYS);
  validateEnum('urgency', f.urgency, URG_KEYS);
  if (f.importance) validateEnum('importance', f.importance, IMP_KEYS);
  withLock(DATA, () => {
    const db = load();
    const id = `T-${slugify(title)}-${stamp()}`;
    db.open.push({
      id, title, owner: f.owner, action: f.action, urgency: f.urgency,
      importance: f.importance || null, // 선택 필드(긴급과 별개 축)
      source: f.source, created: today(),
      due: f.due || null, wait: f.wait || null, memo: f.memo || '',
    });
    persistData(db);
    render(db);
    console.log(`추가됨 ${id} [${f.action}] ${title}`);
  });
} else if (cmd === 'done') {
  const id = rest[0];
  withLock(DATA, () => {
    const db = load();
    const i = db.open.findIndex((t) => t.id === id);
    if (i < 0) { console.error(`없음: ${id}`); process.exit(1); }
    const t = db.open.splice(i, 1)[0];
    t.doneAt = today();
    db.done.push(t);
    persistData(db);
    render(db);
    console.log(`완료 ${id} ${t.title}`);
  });
} else if (cmd === 'drop') {
  const id = rest[0];
  const f = parseFlags(rest.slice(1));
  // 이유 없는 취소는 나중에 "왜 안 했지?"를 되짚을 수 없다 — 필수로 받는다.
  if (!id || !f.reason) {
    console.error('필수: drop <id> --reason "<이유>"');
    process.exit(1);
  }
  withLock(DATA, () => {
    const db = load();
    const i = db.open.findIndex((t) => t.id === id);
    if (i < 0) { console.error(`없음: ${id}`); process.exit(1); }
    const t = db.open.splice(i, 1)[0];
    t.droppedAt = today();
    t.reason = f.reason;
    db.dropped.push(t);
    persistData(db);
    render(db);
    console.log(`취소 ${id} ${t.title} — ${f.reason}`);
  });
} else if (cmd === 'edit') {
  const id = rest[0];
  const f = parseFlags(rest.slice(1));
  if (f.owner !== undefined) validateEnum('owner', f.owner, OWNER_KEYS);
  if (f.action !== undefined) validateEnum('action', f.action, ACTION_KEYS);
  if (f.urgency !== undefined) validateEnum('urgency', f.urgency, URG_KEYS);
  if (f.importance !== undefined) validateEnum('importance', f.importance, IMP_KEYS);
  withLock(DATA, () => {
    const db = load();
    const t = db.open.find((x) => x.id === id);
    if (!t) { console.error(`없음: ${id}`); process.exit(1); }
    for (const k of ['title', 'owner', 'action', 'urgency', 'importance', 'source', 'due', 'wait', 'memo'])
      if (f[k] !== undefined) t[k] = f[k];
    persistData(db);
    render(db);
    console.log(`수정 ${id}`);
  });
} else if (cmd === 'init') {
  // 빈 원장을 실제 파일로 만든다({{DOCS_DIR}}/tasks.json·tasks.md·미러). 이미 있으면 그대로 다시 써 idempotent.
  withLock(DATA, () => {
    const db = load();
    persistData(db);
    render(db);
  });
  console.log('원장 초기화 — {{DOCS_DIR}}/tasks.json·tasks.md 생성(할일 없으면 빈 원장).');
} else if (cmd === 'list') {
  console.log(reviewText(load()));
} else if (cmd === 'review') {
  withLock(DATA, () => {
    const db = load();
    render(db);
    console.log(reviewText(db));
  });
} else {
  console.log('명령: init | add | done <id> | drop <id> --reason | edit <id> | list | review');
}
