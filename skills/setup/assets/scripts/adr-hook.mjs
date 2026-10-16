#!/usr/bin/env node
// ADR 감지 1단계(UserPromptSubmit) — 사용자 말 한 문장에 결정 선언("~로 하자", "앞으로", "~하지 마" …)이 있는지
// TypeSafe Jev(판단 전용 모델, 한 번에 약 0.2초)에게 묻고, 통과한 턴에만 2·3단계 체크리스트를 맥락에 넣는다.
// 결정이 없는 턴(대본 300턴 시험에서 약 82%)에는 ADR 규칙 글이 들어가지 않는다.
// AI가 스스로 대안을 고른 결정은 사용자 말에 없으므로 worklog --decision 기록 때 같은 체크리스트를 보여 준다(worklog.mjs).
// ADR은 만들지 않는다 — 체크리스트가 응답 끝에 "이걸 ADR로 남길까요?"라고 묻게 할 뿐이다.
//
// 키: 환경 변수 TYPESAFE_API_KEY, 없으면 ~/.config/orbit/typesafe.env(XDG_CONFIG_HOME 따름)의 TYPESAFE_API_KEY=…
//     키가 없으면 아무것도 하지 않는다(그때는 CLAUDE.md의 한 줄 규칙대로 AI가 스스로 판단한다).
// 끄기: ORBIT_ADR_GATE=off(/orbit:config adr-gate off). 문턱: ORBIT_ADR_GATE_THRESHOLD(기본 0.5).
// 실패·시간 초과는 조용히 지나간다(입력을 막지 않는다). 판정마다 .git/orbit-state/adr-gate.jsonl에 한 줄(점수·시간·주입 여부, 입력 글은 남기지 않음).
// 결정: D-ADR감지-3단계-Jev-261016-235900.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NOT_HUMAN } from './again-hook.mjs';
import { CHECKLIST, GATE_QUESTION, GATE_THRESHOLD, JEV_MODEL } from './adr-lib.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENDPOINT = process.env.ORBIT_ADR_GATE_ENDPOINT || 'https://api.typesafe.ai/v1/systemone'; // 바꾸는 건 시험용
const PROMPT_LIMIT = 4000;

function readInput() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

export function enabled(env = process.env) {
  return !['off', '0', 'false', 'no'].includes(String(env.ORBIT_ADR_GATE ?? 'on').toLowerCase());
}

export function threshold(env = process.env) {
  const value = Number(env.ORBIT_ADR_GATE_THRESHOLD);
  return value > 0 && value < 1 ? value : GATE_THRESHOLD;
}

// 키 값은 어디에도 찍지 않는다.
export function apiKey(env = process.env) {
  if (env.TYPESAFE_API_KEY) return env.TYPESAFE_API_KEY.trim();
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  try {
    const text = fs.readFileSync(path.join(base, 'orbit', 'typesafe.env'), 'utf8');
    const match = text.match(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*["']?([^"'\s]+)/m);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

export async function judge(prompt, { key, fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: JEV_MODEL, state: { user_message: prompt.slice(0, PROMPT_LIMIT) }, questions: { decision: { type: 'noul', instructions: GATE_QUESTION } } }),
      signal: controller.signal,
    });
    if (!response.ok) return { error: `Jev 응답 ${response.status}`, ms: Date.now() - started };
    const body = await response.json();
    const score = Number(body?.answers?.decision?.noul);
    if (!Number.isFinite(score)) return { error: 'Jev 답에 점수가 없음', ms: Date.now() - started };
    return { score, model: body.model || JEV_MODEL, ms: Date.now() - started };
  } catch (error) {
    return { error: error.name === 'AbortError' ? `시간 초과(${timeoutMs}ms)` : error.message, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

export function injection(score) {
  return `[orbit ADR 1단계] 이 입력에 결정 선언이 있습니다(Jev ${score.toFixed(2)}).\n${CHECKLIST}`;
}

function log(record) {
  try {
    const file = execFileSync('git', ['rev-parse', '--git-path', 'orbit-state/adr-gate.jsonl'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const full = path.isAbsolute(file) ? file : path.join(ROOT, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.appendFileSync(full, `${JSON.stringify(record)}\n`);
  } catch { /* 기록 실패는 입력을 막지 않는다 */ }
}

async function main() {
  if (process.env.ORBIT_AGAIN_CHILD) return;
  if (String(process.env.ORBIT_HOOKS || '').toLowerCase() === 'off') return;
  const input = readInput();
  const prompt = String(input.prompt ?? '').trim();
  if (!enabled() || prompt.length < 4 || NOT_HUMAN.test(prompt)) return;
  const key = apiKey();
  if (!key) return;
  const verdict = await judge(prompt, { key });
  const passed = verdict.score !== undefined && verdict.score >= threshold();
  log({ at: new Date().toISOString(), session: String(input.session_id || ''), chars: prompt.length, ...verdict, threshold: threshold(), injected: passed });
  if (verdict.error) process.stderr.write(`orbit ADR 1단계: ${verdict.error}\n`);
  if (passed) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: injection(verdict.score) } })}\n`);
}

function realPath(file) {
  try { return fs.realpathSync(file); } catch { return path.resolve(file); }
}
if (process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`orbit ADR 1단계 실패(입력은 그대로 진행): ${error.message}\n`);
  });
}
