#!/usr/bin/env node
// '다시' 감지(UserPromptSubmit) — 사용자 입력이 예전 일의 번복·재발·재요청·재작업이면, 그 주제의 흐름을
// 이번 턴 맥락에 넣는다. AI가 할일 원장이나 일지를 스스로 열어 보지 않아도 "예전에 끝냈다·정했다"는 기록과
// 그 근거가 눈앞에 오게 해, 낡은 '완료' 기록만 믿고 지나가는 일을 줄인다.
//
//   1차 거름(모델 없음): 신호 낱말(다시·또·여전히·원래·되돌…)이나 알려진 주제 이름이 든 입력만 넘긴다.
//   2차 판단(Haiku):    "다시 말해 줘"와 "자정 버그가 다시 났어"를 가른다. claude -p를 설정·훅·도구 없이 따로 띄운다
//                       (프로젝트·사용자 설정을 읽지 않으므로 이 훅이나 다른 orbit 훅이 다시 불리지 않는다).
//   주입(모델 없음):    판단이 '다시'면 주제 흐름(topic-lib)이나 기억 검색 상위 몇 개를 넣는다.
// 실패·시간 초과는 조용히 지나간다(입력을 막지 않는다). 끄기: ORBIT_AGAIN=off(/orbit:config again off).
// 같은 폴더에 again-monitor.mjs가 있으면 판단마다 기록을 넘긴다(orbit을 바탕으로 만든 판이 측정을 붙이는 자리).
// 결정: D-주제흐름-다시-261014-235500.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AGAIN_KINDS, clip, findTopic, loadTopics, normalizeTopic, recentTopics, threadLines, topicStatus } from './topic-lib.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = path.join(ROOT, '{{DOCS_DIR}}');
const PROMPT_LIMIT = 1500; // Haiku에게 넘기는 입력 앞부분
const TOPIC_CANDIDATES = 30;
const INJECT_LIMIT = 2200;

// 신호 낱말. 실제 사용자 입력 1,221개로 재 보니 약 21%가 걸리고 대부분은 '다시'가 아니었다(2026-10-14) —
// 그래서 걸린 것만 Haiku가 가른다. '또는·또한'은 뺀다.
export const SIGNAL = /(다시|또(?!는|한)|재발|도로|아직도|여전히|원래|예전|저번|지난번|되돌|롤백|번복|바꾸자|바꿔|취소하|안\s?하기로|하지\s?않기로|그만두|again|still|revert|undo|regress|roll\s?back|used to|previously)/i;

// 사람이 친 입력이 아닌 것(알림·세션 간 메시지·컴팩션 이어 받기·슬래시 명령 감싸기·곁가지 메모)은 보지 않는다.
const NOT_HUMAN = /^(<task-notification>|<cross-session-message|<system-reminder|<command-|<local-command|<bash-|\[Cross-session|This session is being continued|Stop hook feedback|Here is a note offered by a side agent|\[Artifact comment)/;

export const SYSTEM = `You classify ONE message a user sent to a coding agent in a project with a long work history.
Decide whether the message brings back something that was ALREADY handled or decided earlier in this project:
- 번복: the user changes or reverses an earlier decision, rule or setting ("포트 4318로 바꾸자", "그건 다시 JSON으로 돌리자").
- 재발: a problem that was fixed or work that was finished earlier is happening again, or seems undone/reverted ("자정 버그 또 났어", "고친 거 다시 깨졌어", "3월 합계가 또 안 맞아").
- 재요청: the user asks again for something earlier rejected, postponed or decided against ("Redis 캐시 다시 생각해 보자").
- 재작업: the user asks to redo or revisit work that was marked finished ("그 기능 다시 손보자").
- none: anything else. Words like 다시/또/아직/여전히/원래/바꿔 often appear without pointing back at earlier project work: "다시 말해 줘", "다시 시도해", "다시 한번 점검해봐", "또 하나 물어볼게", "아직 잘 이해가 안 가", "이 문구 바꿔봐", or a brand-new request.
Known topics of this project (name — last state) are listed. If the message is about one of them, return its exact name; otherwise null.
Answer with JSON only, no prose:
{"again": true|false, "kind": "번복"|"재발"|"재요청"|"재작업"|"none", "topic": "<known topic name>"|null, "query": "<2-5 keywords to search the project history, in the message's language>", "why": "<under 15 words>"}`;

function readInput() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function enabled() {
  return !['off', '0', 'false', 'no'].includes(String(process.env.ORBIT_AGAIN ?? 'on').toLowerCase());
}

// 1차 거름: 걸린 이유(낱말·주제 이름)를 돌려준다. 빈 배열이면 넘기지 않는다.
export function prefilter(prompt, topics) {
  const hits = [];
  const match = String(prompt).match(SIGNAL);
  if (match) hits.push(match[1]);
  const flat = normalizeTopic(prompt);
  for (const topic of topics.values()) {
    if (topic.key.length >= 2 && flat.includes(topic.key)) { hits.push(`주제:${topic.name}`); break; }
  }
  return hits;
}

// Haiku 응답에서 첫 JSON 객체를 꺼낸다(코드 울타리·앞뒤 글이 붙어도).
export function parseDecision(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const value = JSON.parse(raw.slice(start, end + 1));
    const kind = AGAIN_KINDS.includes(value.kind) ? value.kind : 'none';
    return { again: Boolean(value.again) && kind !== 'none', kind, topic: value.topic || null, query: String(value.query || '').slice(0, 120), why: String(value.why || '').slice(0, 200) };
  } catch {
    return null;
  }
}

function judge(prompt, topics) {
  const candidates = recentTopics(topics, TOPIC_CANDIDATES).map((topic) => `- ${topic.name} — ${topicStatus(topic)}`).join('\n') || '(none yet)';
  const message = `Known topics:\n${candidates}\n\nMessage:\n<<<\n${clip(prompt, PROMPT_LIMIT)}\n>>>`;
  const claude = process.env.ORBIT_AGAIN_CLAUDE || 'claude';
  const model = process.env.ORBIT_AGAIN_MODEL || 'haiku';
  const timeout = Number(process.env.ORBIT_AGAIN_TIMEOUT_MS) > 0 ? Number(process.env.ORBIT_AGAIN_TIMEOUT_MS) : 15000;
  const started = Date.now();
  // --effort low: 짧은 분류에 생각 토큰을 쓰지 않게 한다(실측: 생각 0, 출력 약 65토큰, 2.6~3.4초 — 기본값은 생각 80~110토큰).
  // 표준 입력은 닫아 둔다(열려 있으면 claude -p가 입력을 3초 기다린다).
  const effort = process.env.ORBIT_AGAIN_EFFORT || 'low';
  const run = spawnSync(claude, [
    '-p', '--model', model, '--effort', effort,
    '--setting-sources', '', '--strict-mcp-config', '--tools', '', '--disable-slash-commands',
    '--no-session-persistence', '--output-format', 'json', '--system-prompt', SYSTEM,
    message,
  ], { cwd: os.tmpdir(), encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ORBIT_AGAIN_CHILD: '1' }, maxBuffer: 4 * 1024 * 1024 });
  const wallMs = Date.now() - started;
  if (run.error || run.status !== 0) {
    const reason = run.error?.code === 'ETIMEDOUT' ? `시간 초과(${timeout}ms)` : clip(run.error?.message || run.stderr || `종료 코드 ${run.status}`, 200);
    return { error: reason, wallMs };
  }
  let envelope;
  try { envelope = JSON.parse(run.stdout); } catch { return { error: 'claude -p 출력이 JSON이 아님', wallMs }; }
  const decision = parseDecision(envelope.result);
  return {
    decision,
    error: decision ? null : 'Haiku 답에서 JSON을 못 찾음',
    wallMs,
    apiMs: envelope.duration_api_ms ?? null,
    usage: envelope.usage ? {
      input: envelope.usage.input_tokens || 0,
      output: envelope.usage.output_tokens || 0,
      cacheRead: envelope.usage.cache_read_input_tokens || 0,
      cacheWrite: envelope.usage.cache_creation_input_tokens || 0,
    } : null,
    costUsd: envelope.total_cost_usd ?? null,
    model: Object.keys(envelope.modelUsage || {})[0] || model,
  };
}

function searchHistory(query) {
  if (!query.trim()) return [];
  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'memory.mjs'), 'search', query, '--source', 'worklog,adr', '--limit', '3', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 8000 });
  if (run.status !== 0) return [];
  try {
    return JSON.parse(run.stdout).groups.flatMap((group) => group.items).slice(0, 4)
      .map((item) => `- ${item.ref}: ${clip(String(item.text).replace(/^## \[[^\]]*\][^\n]*\n?/, '').replace(/^- (물음|결과): /gm, ''), 150)}`);
  } catch {
    return [];
  }
}

export function injection(decision, topics) {
  const lines = [`[orbit 다시] 예전에 다룬 일이 다시 움직이는 입력으로 보입니다 — 갈래: ${decision.kind}${decision.why ? ` (Haiku 판단: ${decision.why})` : ''}`];
  const topic = decision.topic ? findTopic(topics, decision.topic) : null;
  if (topic) {
    lines.push(`주제 '${topic.name}' 흐름 — ${topicStatus(topic)}`, ...threadLines(topic, { limit: 8, width: 70 }));
  } else {
    const found = searchHistory(decision.query);
    if (found.length) lines.push(`관련 기록(검색: ${decision.query}):`, ...found);
    else lines.push(`관련 기록을 찾지 못했습니다(검색: ${decision.query || '없음'}). 필요하면 /orbit:recall로 찾으세요.`);
  }
  const name = topic ? topic.name : '<주제>';
  lines.push(`지난 '완료'·'결정' 기록만 믿지 말고 지금 상태를 직접 확인(재현·테스트·코드)한 뒤 진행하세요. 이번 턴 기록에는 \`--topic "${name}" --again ${decision.kind}\`를 붙입니다. 닫힌 할일이 다시 필요하면 \`node scripts/tasks.mjs reopen <id> --reason "<까닭>"\`.`);
  const text = lines.join('\n');
  return text.length > INJECT_LIMIT ? `${text.slice(0, INJECT_LIMIT - 1)}…` : text;
}

async function report(record) {
  let monitor;
  try {
    monitor = await import('./again-monitor.mjs');
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') return;
    process.stderr.write(`orbit 다시 감지: 측정 모듈을 못 불러옴(${error.message})\n`);
    return;
  }
  try { await monitor.record?.(ROOT, record); } catch (error) { process.stderr.write(`orbit 다시 감지: 측정 기록 실패(${error.message})\n`); }
}

async function main() {
  if (process.env.ORBIT_AGAIN_CHILD) return; // Haiku 판단용으로 띄운 claude 안에서는 아무것도 하지 않는다
  const input = readInput();
  const prompt = String(input.prompt ?? '').trim();
  if (!enabled() || prompt.length < 4 || NOT_HUMAN.test(prompt)) return;
  const topics = loadTopics(DOCS);
  const hits = prefilter(prompt, topics);
  const base = { at: new Date().toISOString(), session: String(input.session_id || ''), promptId: input.prompt_id ? String(input.prompt_id) : null, prompt, prefilter: hits, topicsKnown: topics.size };
  if (!hits.length) {
    await report({ ...base, called: false });
    return;
  }
  const verdict = judge(prompt, topics);
  const out = verdict.decision?.again ? injection(verdict.decision, topics) : '';
  await report({ ...base, called: true, ...verdict, injectedChars: out.length });
  if (verdict.error) process.stderr.write(`orbit 다시 감지: ${verdict.error}\n`);
  if (out) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: out } })}\n`);
}

function realPath(file) {
  try { return fs.realpathSync(file); } catch { return path.resolve(file); }
}
if (process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`orbit 다시 감지 실패(입력은 그대로 진행): ${error.message}\n`);
  });
}
