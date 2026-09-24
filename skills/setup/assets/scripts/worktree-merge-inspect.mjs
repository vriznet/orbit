#!/usr/bin/env node
// 워크트리(브랜치)를 master에 병합하기 전, 무엇이 들어오고 어디가 부딪히는지 진단해
// "표 + 위험도" 형태로 보고한다. 읽기 전용 — 실제 병합·재번호는 하지 않는다.
// worktree-merge 스킬이 이 출력을 사용자에게 보여주고 진행/중단을 받는다.
//
// 사용: node scripts/worktree-merge-inspect.mjs <branch>
//   예: node scripts/worktree-merge-inspect.mjs feature-branch

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = '{{DOCS_DIR}}';
const WORKLOG = `${DOCS}/worklog.md`;

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}
function gitSafe(args) {
  try { return git(args); } catch { return null; }
}

// worklog 텍스트에서 턴 번호(## [#N])를 모두 뽑는다.
function turnNumbers(text) {
  const nums = [];
  const re = /^## \[#(\d+)\]/gm;
  let m;
  while ((m = re.exec(text || ''))) nums.push(Number(m[1]));
  return nums;
}

// git diff --name-status 한 줄을 { status, path } 로 (rename은 도착 경로를 path로).
function parseDiffLine(line) {
  const parts = line.split('\t');
  const status = parts[0][0]; // A/M/D/R…
  const filePath = parts[parts.length - 1];
  return { status, path: filePath };
}

function classify(changes) {
  const out = { decisions: [], wikiNew: [], docsModified: [], ledgers: [], products: [], other: [] };
  for (const c of changes) {
    const p = c.path;
    if (p.startsWith(`${DOCS}/decisions/D`) && c.status === 'A') out.decisions.push(p);
    else if (p.startsWith(`${DOCS}/wiki/`) && c.status === 'A' && !p.includes('_index')) out.wikiNew.push(p);
    else if (p === WORKLOG || p === `${DOCS}/worklog-state.json`) out.ledgers.push(p);
    else if (p === `${DOCS}/tasks.json` || p === `${DOCS}/tasks.md` || p === `${DOCS}/tasks-done.md`) out.ledgers.push(p);
    else if (p.startsWith(`${DOCS}/`) && c.status === 'M') out.docsModified.push(p);
    else if (c.status === 'A') out.products.push(p);
    else out.other.push(`${c.status} ${p}`);
  }
  return out;
}

// tasks.json 두 판본의 열린 id 집합을 비교해 새 할일 개수와 ID 충돌(순번 겹침)을 본다.
function taskDelta(mergeBase, branch) {
  const read = (ref) => {
    const raw = gitSafe(['show', `${ref}:${DOCS}/tasks.json`]);
    if (!raw) return { open: [], done: [] };
    try { return JSON.parse(raw); } catch { return { open: [], done: [] }; }
  };
  // dropped(취소 아카이브)도 ID 공간을 차지한다 — 빼먹으면 취소된 할일과 같은 ID의 충돌을 놓친다.
  const allIds = (db) => [...(db.open || []), ...(db.done || []), ...(db.dropped || [])].map((t) => t.id);
  const baseIds = new Set(allIds(read(mergeBase)));
  const branchDb = read(branch);
  const added = allIds(branchDb).filter((id) => !baseIds.has(id));
  const masterDb = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, DOCS, 'tasks.json'), 'utf8')); } catch { return { open: [], done: [] }; }
  })();
  const masterAdded = allIds(masterDb).filter((id) => !baseIds.has(id));
  const idCollision = added.filter((id) => masterAdded.includes(id));
  return { added, idCollision };
}

function decisionCollision(mergeBase, branch) {
  // 새 형식(D-슬러그-일시)은 충돌하지 않는다. 옛 순번(D\d+)만 양쪽이 같은 번호를 새로 만들면 충돌.
  const listNew = (ref) => {
    const base = gitSafe(['ls-tree', '-r', '--name-only', mergeBase, `${DOCS}/decisions/`]) || '';
    const cur = gitSafe(['ls-tree', '-r', '--name-only', ref, `${DOCS}/decisions/`]) || '';
    const baseSet = new Set(base.split('\n').filter(Boolean));
    return cur.split('\n').filter(Boolean).filter((f) => !baseSet.has(f));
  };
  const branchNew = listNew(branch);
  const masterNew = listNew('master');
  const seqOf = (f) => (f.match(/\/D(\d+)-/) ? f.match(/\/D(\d+)-/)[1] : null);
  const branchSeqs = branchNew.map(seqOf).filter(Boolean);
  const masterSeqs = masterNew.map(seqOf).filter(Boolean);
  return branchSeqs.filter((s) => masterSeqs.includes(s));
}

function riskRow(where, problem, fix, risk) {
  return `| ${where} | ${problem} | ${fix} | ${risk} |`;
}

function main() {
  const branch = process.argv[2];
  if (!branch) {
    console.error('사용: node scripts/worktree-merge-inspect.mjs <branch>');
    process.exit(1);
  }
  if (!gitSafe(['rev-parse', '--verify', branch])) {
    console.error(`브랜치를 찾을 수 없습니다: ${branch}\n현재 브랜치 목록:\n${git(['branch', '--format=%(refname:short)'])}`);
    process.exit(1);
  }

  const mergeBase = git(['merge-base', 'master', branch]);
  const masterHead = git(['rev-parse', 'master']);
  const isFF = mergeBase === masterHead;
  const behind = git(['rev-list', '--count', `${branch}..master`]);
  const ahead = git(['rev-list', '--count', `master..${branch}`]);

  if (ahead === '0') {
    console.log(`■ ${branch}\n\n병합할 새 커밋이 없습니다(master가 이미 포함). 병합 불필요.`);
    return;
  }

  const changes = git(['diff', '--name-status', `${mergeBase}..${branch}`]).split('\n').filter(Boolean).map(parseDiffLine);
  const c = classify(changes);
  const tasks = taskDelta(mergeBase, branch);
  const adrSeqCollision = decisionCollision(mergeBase, branch);

  // worklog 번호 겹침
  const baseLog = gitSafe(['show', `${mergeBase}:${WORKLOG}`]) || '';
  const branchLog = gitSafe(['show', `${branch}:${WORKLOG}`]) || '';
  const masterLog = (() => { try { return fs.readFileSync(path.join(ROOT, WORKLOG), 'utf8'); } catch { return ''; } })();
  const baseMax = Math.max(0, ...turnNumbers(baseLog));
  const branchNew = turnNumbers(branchLog).filter((n) => n > baseMax);
  const masterNew = turnNumbers(masterLog).filter((n) => n > baseMax);
  const overlap = branchNew.filter((n) => masterNew.includes(n));

  // ── 보고 출력 ──
  const L = [];
  L.push(`/워크트리병합 ${branch}`);
  L.push('');
  L.push(`분기 유형: ${isFF ? 'fast-forward (master가 브랜치의 조상 — 쉬움)' : `병렬 분기 (master가 ${behind}커밋 앞섬 — 재번호 필요)`}`);
  L.push('');

  L.push('■ 들어오는 산출물');
  L.push('| 종류 | 내용 | 개수 |');
  L.push('|---|---|---|');
  if (c.decisions.length) L.push(`| 결정(ADR) | ${c.decisions.map((f) => f.split('/').pop()).join(', ')} | ${c.decisions.length} |`);
  if (c.wikiNew.length) L.push(`| 위키(신규) | ${c.wikiNew.map((f) => f.split('/').pop().replace('.md', '')).join(', ')} | ${c.wikiNew.length} |`);
  if (tasks.added.length) L.push(`| 할일 | ${tasks.added.slice(0, 6).join(', ')}${tasks.added.length > 6 ? '…' : ''} | ${tasks.added.length} |`);
  if (c.products.length) L.push(`| 산출물(새 파일) | ${c.products.slice(0, 4).map((f) => f.split('/').pop()).join(', ')}${c.products.length > 4 ? '…' : ''} | ${c.products.length} |`);
  if (c.docsModified.length) L.push(`| 문서 수정 | ${c.docsModified.slice(0, 4).map((f) => f.split('/').pop()).join(', ')}${c.docsModified.length > 4 ? '…' : ''} | ${c.docsModified.length} |`);
  if (c.other.length) L.push(`| 기타 | ${c.other.slice(0, 4).join(', ')}${c.other.length > 4 ? '…' : ''} | ${c.other.length} |`);
  L.push('');

  L.push('■ 충돌과 해소 계획');
  L.push('| 위치 | 문제 | 해소 | 위험 |');
  L.push('|---|---|---|---|');
  const rows = [];
  if (overlap.length) rows.push(riskRow('worklog', `번호 ${overlap.length}개 겹침(#${Math.min(...overlap)}~#${Math.max(...overlap)})`, '도착 순서로 재번호', '🟢'));
  else if (branchNew.length) rows.push(riskRow('worklog', `브랜치 항목 ${branchNew.length}개 추가(겹침 없음)`, isFF ? '그대로 이어붙임' : '뒤로 재번호', '🟢'));
  if (c.ledgers.some((p) => p.endsWith('worklog-state.json'))) rows.push(riskRow('worklog-state', 'next 값 다름', '자동 복구(최대 번호+1)', '🟢'));
  if (adrSeqCollision.length) rows.push(riskRow('ADR', `옛 순번 ${adrSeqCollision.map((s) => 'D' + s).join(',')} 충돌`, '수동 재번호 필요', '🔴'));
  if (tasks.idCollision.length) rows.push(riskRow('tasks', `순번 ID ${tasks.idCollision.join(',')} 충돌`, '수동 재번호 필요', '🔴'));
  if (c.docsModified.length) rows.push(riskRow('문서', `기존 문서 ${c.docsModified.length}개를 양쪽이 수정 가능성`, '병합 시 텍스트 충돌 확인', '🟡'));
  if (!rows.length) rows.push(riskRow('—', '공유 원장 충돌 없음', '새 파일만 들어옴', '🟢'));
  L.push(...rows);
  L.push('');

  const worstRisk = rows.some((r) => r.includes('🔴')) ? '🔴' : rows.some((r) => r.includes('🟡')) ? '🟡' : '🟢';
  L.push(`되돌리기: ${isFF ? '가능(병합 커밋 되돌림)' : '가능(병합 전 지점으로 복귀)'}`);
  L.push(`종합 위험: ${worstRisk}`);
  L.push('');
  L.push('진행할까요?');

  console.log(L.join('\n'));
}

main();
