#!/usr/bin/env node
// 작업 일지 엔진 — Claude와 Codex가 턴제로 협업할 때 서로의 맥락을 잇는다.
// 둘은 대화 맥락을 공유하지 못하므로, 각자의 "왜"를 이 파일에 남겨 이어붙인다.
//
// 저장 위치:
//   docs/worklog.md          사람과 기계가 함께 읽는 기록 (덧붙이기만)
//   docs/worklog-state.json  책갈피(각자 마지막 읽은 지점)와 카운터
//
// 명령:
//   append <작성자> "<물음>" "<결과>"   이번 턴을 기록하고, 그 작성자의 책갈피를 최신으로 옮긴다
//   append ... --commit "<커밋메시지>"  기록 직후 git add -A + 커밋까지 한 번에 (순서 실수 방지)
//   summary <작성자> "<요약>"           최근 턴들을 하나로 묶어 요약한다 (3턴마다)
//   catchup <작성자>                    책갈피 이후 밀린 내용을 보여주고 책갈피를 옮긴다 (없으면 조용)
//
// 안전 원칙: 책갈피는 "덜 옮기면 다시 읽기(무해)" 쪽으로만 실수하게. 앞질러 건너뛰지 않는다.
// --commit: worklog를 별도 커밋으로 뒤에 미루지 말고, 작업 커밋에 함께 태우기 위한 것.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOG = path.join(ROOT, 'docs', 'worklog.md');
const STATE = path.join(ROOT, 'docs', 'worklog-state.json');
const WHO = ['claude', 'codex'];

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return { next: 1, lastSummarized: 0, bookmarks: { claude: 0, codex: 0 } };
  }
}
function saveState(s) {
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n');
}
function ensureLog() {
  if (fs.existsSync(LOG)) return;
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

function append(agent, ask, result) {
  ensureLog();
  const s = loadState();
  const n = s.next;
  fs.appendFileSync(
    LOG,
    `## [#${n}] ${today()} · ${agent} · with:user\n- 물음: ${ask}\n- 결과: ${result}\n\n`
  );
  s.next = n + 1;
  s.bookmarks[agent] = n; // 자기가 쓴 것은 읽은 것으로 본다
  saveState(s);
  const since = n - s.lastSummarized; // 마지막 요약 이후 쌓인 턴 수
  process.stdout.write(
    since >= 3 ? `기록됨 [#${n}]. 이제 최근 ${since}턴을 요약할 때입니다.\n` : `기록됨 [#${n}].\n`
  );
}

function summary(agent, text) {
  ensureLog();
  const s = loadState();
  const from = s.lastSummarized + 1;
  const to = s.next - 1;
  if (to < from) {
    process.stdout.write('요약할 새 항목이 없습니다.\n');
    return;
  }
  fs.appendFileSync(LOG, `## [요약 #${from}~${to}] ${today()} · ${agent}\n${text}\n\n`);
  s.lastSummarized = to;
  saveState(s);
  process.stdout.write(`요약됨 [#${from}~${to}].\n`);
}

function catchup(agent) {
  ensureLog();
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
}

// --commit "<메시지>" 를 인자에서 분리 (append 직후 작업 커밋에 함께 태운다)
const argv = process.argv.slice(2);
let commitMsg = null;
const ci = argv.indexOf('--commit');
if (ci !== -1) {
  commitMsg = argv[ci + 1] ?? '';
  argv.splice(ci, 2);
}

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
  append(agent, a ?? '', b ?? '');
  if (commitMsg !== null) gitCommitAll(commitMsg);
} else if (cmd === 'summary') {
  summary(agent, a ?? '');
  if (commitMsg !== null) gitCommitAll(commitMsg);
} else if (cmd === 'catchup') catchup(agent);
else {
  process.stderr.write('사용법: worklog <append|summary|catchup> <claude|codex> ... [--commit "메시지"]\n');
  process.exit(1);
}
