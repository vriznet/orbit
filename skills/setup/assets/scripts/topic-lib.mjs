// 주제 흐름 — worklog 항목과 할일에 붙은 '주제'를 한 흐름(발견 → 완료 → 다시)으로 묶는다. 모델을 부르지 않는다.
// worklog.mjs(topics·thread·append 안내), again-hook.mjs('다시' 감지 뒤 흐름 주입), memory-hook.mjs(파일을 만질 때
// 연결된 주제의 상태)가 같이 쓴다. 원본은 worklog.md와 tasks.json뿐이고 색인 파일을 따로 두지 않는다(두 곳이 어긋나지 않게).
// 결정: D-주제흐름-다시-261014-235500.

import fs from 'node:fs';
import path from 'node:path';

// '다시'의 네 갈래. 번복=정한 것을 바꿈, 재발=고친 문제가 다시 나거나 끝낸 것이 되돌아감,
// 재요청=버리거나 미룬 것을 다시 꺼냄, 재작업=끝낸 일을 다시 손봄.
export const AGAIN_KINDS = ['번복', '재발', '재요청', '재작업'];

// "고쳤다·해결했다"류 — 확인 없이 적힌 완료 주장을 가려낸다(종료 훅 알림, 흐름의 '완료 기록' 표시).
export const FIX_CLAIM = /(고쳤|고침|고쳐\s?놓|수정했|수정함|수정\s?완료|해결했|해결함|해결됨|해결\s?완료|바로잡|fixed|resolved)/i;
// 부정·남의 일로 쓴 말("고친 것 없음", "고치지 않았다", "해결되지 않음")은 완료 주장이 아니다 — 확인 알림 오탐(r1 #514).
const NOT_FIXED = /(고친|고칠|수정한|수정할|해결한|해결할)\s*(것|게|건|데)?\s*(은|는|이|가)?\s*(없|아니|못)|(고치|수정하|해결하|바로잡)지\s*(않|못|말)|해결\s*(되지|안\s*됨|안\s*됐|못)|(not|never)\s+(fixed|resolved)/gi;
export function claimsFix(text) {
  return FIX_CLAIM.test(String(text ?? '').replace(NOT_FIXED, ' '));
}
// 흐름 표시용으로 조금 더 넓게 본 완료 주장(구현 완료·끝냄 포함).
const DONE_CLAIM = /(고쳤|고침|수정했|수정함|해결|완료|끝냈|마쳤|구현했|fixed|resolved|done)/i;

export function clip(text, limit) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, Math.max(0, limit - 1))}…` : value;
}

// 같은 주제를 조금 다르게 적어도(띄어쓰기·하이픈·대소문자) 한 주제로 본다.
export function normalizeTopic(name) {
  return String(name ?? '').normalize('NFC').toLowerCase().replace(/[\s\-_·.,/:'"`()[\]]+/g, '');
}

export function splitTopics(value) {
  return String(value ?? '')
    .split(/[,，、]/)
    .map((item) => item.trim())
    .filter((item) => normalizeTopic(item));
}

// worklog.md의 턴 항목(## [#N] …)만 읽는다. 요약 항목은 주제를 갖지 않는다.
export function parseEntries(text) {
  const out = [];
  for (const block of String(text ?? '').split(/\n(?=## \[)/)) {
    const head = block.match(/^## \[#(\d+)\] (\S+) · ([^·\n]+)/);
    if (!head) continue;
    const field = (label) => {
      const match = block.match(new RegExp(`^- ${label}: (.*)$`, 'm'));
      return match ? match[1].trim() : null;
    };
    out.push({
      n: Number(head[1]),
      date: head[2],
      agent: head[3].trim(),
      ask: field('물음') || '',
      result: field('결과') || '',
      decision: field('판단'),
      found: field('발견'),
      topics: splitTopics(field('주제')),
      again: field('다시'),
      verified: field('확인'),
    });
  }
  return out;
}

export function readEntries(docsDir) {
  try {
    return parseEntries(fs.readFileSync(path.join(docsDir, 'worklog.md'), 'utf8'));
  } catch {
    return [];
  }
}

export function readTasks(docsDir) {
  try {
    const db = JSON.parse(fs.readFileSync(path.join(docsDir, 'tasks.json'), 'utf8'));
    return { open: db.open || [], done: db.done || [], dropped: db.dropped || [] };
  } catch {
    return { open: [], done: [], dropped: [] };
  }
}

// 주제 키 → { key, name(처음 쓴 표기), names, entries(시간순), tasks(state 붙임) }
export function buildTopics(entries, tasks = { open: [], done: [], dropped: [] }) {
  const topics = new Map();
  const get = (name) => {
    const key = normalizeTopic(name);
    if (!key) return null;
    if (!topics.has(key)) topics.set(key, { key, name: name.trim(), names: new Set(), entries: [], tasks: [] });
    const topic = topics.get(key);
    topic.names.add(name.trim());
    return topic;
  };
  for (const entry of [...entries].sort((a, b) => a.n - b.n)) {
    for (const name of entry.topics) get(name)?.entries.push(entry);
  }
  for (const [state, list] of Object.entries(tasks)) {
    for (const task of list || []) for (const name of splitTopics(task.topic)) get(name)?.tasks.push({ ...task, state });
  }
  return topics;
}

export function loadTopics(docsDir) {
  return buildTopics(readEntries(docsDir), readTasks(docsDir));
}

export function findTopic(topics, name) {
  return topics.get(normalizeTopic(name)) || null;
}

function lastAt(topic) {
  const dates = [
    ...topic.entries.map((entry) => entry.date),
    ...topic.tasks.map((task) => task.reopens?.at(-1)?.at || task.doneAt || task.droppedAt || task.created || ''),
  ].filter(Boolean).sort();
  return dates.at(-1) || '';
}

function entryLabel(entry) {
  if (entry.again) return `다시(${entry.again})`;
  if (DONE_CLAIM.test(entry.result)) return entry.verified ? (/^미확인/.test(entry.verified) ? '완료 기록(미확인)' : '완료 기록(확인함)') : '완료 기록(확인 없음)';
  return '진행 기록';
}

// 한 줄 상태: 마지막 항목의 성격, '다시' 횟수, 할일 상태.
export function topicStatus(topic) {
  const parts = [];
  const last = topic.entries.at(-1);
  if (last) parts.push(`마지막 #${last.n}(${last.date}) ${entryLabel(last)}`);
  const again = topic.entries.filter((entry) => entry.again);
  if (again.length) parts.push(`다시 ${again.length}번(${[...new Set(again.map((entry) => entry.again))].join('·')})`);
  const open = topic.tasks.filter((task) => task.state === 'open').length;
  const done = topic.tasks.filter((task) => task.state === 'done').length;
  const reopened = topic.tasks.reduce((sum, task) => sum + (task.reopens?.length || 0), 0);
  if (topic.tasks.length) parts.push(`할일 열림 ${open}·완료 ${done}${reopened ? `·다시 열림 ${reopened}` : ''}`);
  return parts.join(' · ') || '기록 없음';
}

// 흐름: 항목과 할일 사건(완료·다시 열림·취소·열림)을 날짜순으로. 최근 limit개만, 앞은 개수로 알린다.
export function threadLines(topic, { limit = 8, width = 90 } = {}) {
  const events = [];
  for (const entry of topic.entries) {
    const verified = entry.verified ? ` (확인: ${clip(entry.verified, 50)})` : '';
    events.push({ date: entry.date, order: entry.n, text: `#${entry.n} ${entry.date} [${entryLabel(entry)}] ${clip(entry.ask, width)} → ${clip(entry.result, width)}${verified}` });
  }
  for (const task of topic.tasks) {
    for (const reopen of task.reopens || []) {
      const before = reopen.doneAt ? `${reopen.doneAt} 완료${reopen.evidence ? `(근거: ${clip(reopen.evidence, 40)})` : ''} → ` : '';
      events.push({ date: reopen.at, order: Infinity, text: `할일 ${task.id} ${before}${reopen.at} 다시 열림: ${clip(reopen.reason, 60)}` });
    }
    if (task.state === 'done') events.push({ date: task.doneAt || '', order: Infinity, text: `할일 ${task.id} ${task.doneAt || ''} 완료: ${clip(task.title, 50)} (근거: ${task.evidence ? clip(task.evidence, 60) : '없음'})` });
    else if (task.state === 'dropped') events.push({ date: task.droppedAt || '', order: Infinity, text: `할일 ${task.id} ${task.droppedAt || ''} 취소: ${clip(task.reason, 50)}` });
    else events.push({ date: task.created || '', order: Infinity, text: `할일 ${task.id} 열림(${task.action}): ${clip(task.title, 60)}` });
  }
  events.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.order - b.order);
  const shown = events.slice(-limit);
  const lines = shown.map((event) => `- ${event.text}`);
  if (events.length > shown.length) lines.unshift(`- (앞 ${events.length - shown.length}개 생략)`);
  return lines;
}

// 최근에 다룬 주제부터. again-hook이 Haiku에게 주는 후보 목록과 topics 명령이 쓴다.
export function recentTopics(topics, limit = 30) {
  return [...topics.values()].sort((a, b) => lastAt(b).localeCompare(lastAt(a)) || b.entries.length - a.entries.length).slice(0, limit);
}

function bigrams(name) {
  const key = normalizeTopic(name);
  const set = new Set();
  for (let index = 0; index < key.length - 1; index += 1) set.add(key.slice(index, index + 2));
  if (key.length === 1) set.add(key);
  return set;
}

// 새로 적은 주제와 비슷한 기존 주제(두 글자 묶음 겹침 또는 포함). 같은 주제를 다른 이름으로 갈라 적는 일을 줄인다.
export function similarTopics(name, topics, { min = 0.5, limit = 3 } = {}) {
  const key = normalizeTopic(name);
  const mine = bigrams(name);
  const out = [];
  for (const topic of topics.values()) {
    if (topic.key === key || !key) continue;
    const theirs = bigrams(topic.name);
    const shared = [...mine].filter((gram) => theirs.has(gram)).length;
    const score = topic.key.includes(key) || key.includes(topic.key) ? 1 : shared / Math.max(1, Math.min(mine.size, theirs.size));
    if (score >= min) out.push({ topic, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit).map((item) => item.topic);
}
