#!/usr/bin/env node
// orbit 설정 보기·바꾸기 — 설치한 뒤에 다시 온보딩하지 않고 저장소의 orbit 설정을 본다/바꾼다.
// config 스킬(/orbit:config)이 부른다. 모델을 부르지 않는다.
//
//   config.mjs show  --repo <저장소> [--json]
//   config.mjs set   --repo <저장소> <이름> <값> [옵션…]
//   config.mjs unset --repo <저장소> <이름>
//
// 바꿀 수 있는 것:
//   - 조절 스위치(환경변수): 저장소의 .claude/settings.local.json `env`에 적는다. 이 파일은 개인용이고
//     orbit update가 건드리지 않는다. unset이면 그 줄을 지워 기본값으로 돌린다.
//   - 선택 모듈(codex·reviewers): 켜기만 한다(install.mjs update에 플래그를 붙여 부른다).
//     끄기는 설치기가 아직 지원하지 않는다.
// 같은 폴더에 config-ext.mjs가 있으면 그 파일이 내놓는 항목을 더한다(orbit을 바탕으로 만든 판이 자기 설정을 붙이는 자리).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function die(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const onOff = (value) => {
  const v = String(value).toLowerCase();
  if (['on', '1', 'true', 'yes', '켬'].includes(v)) return 'on';
  if (['off', '0', 'false', 'no', '끔'].includes(v)) return 'off';
  return null;
};
const count = (value) => (/^\d+$/.test(String(value)) ? String(Number(value)) : null);

// 이름 → 환경변수. normalize가 null이면 거부한다.
export const SWITCHES = [
  { name: 'compact-worklog', env: 'ORBIT_COMPACT_WORKLOG', fallback: 'on', normalize: onOff, values: 'on|off',
    about: '컴팩션 직후 worklog 최근 기록을 다시 넣는다. off는 효과를 재 볼 때만 쓴다' },
  { name: 'found-min-tools', env: 'ORBIT_FOUND_MIN_TOOLS', fallback: '10', normalize: count, values: '0 이상의 수(0이면 끔)',
    about: "도구를 이만큼 쓴 턴에 worklog '발견' 칸이 비면 한 번 알린다" },
  { name: 'read-outline-min-lines', env: 'ORBIT_READ_OUTLINE_MIN_LINES', fallback: '300', normalize: count, values: '0 이상의 수(0이면 끔)',
    about: '이 줄 수가 넘는 코드 파일을 범위 없이 읽으면 개요를 먼저 보여 준다' },
  { name: 'agent-policy', env: 'ORBIT_AGENT_POLICY', fallback: 'off', normalize: onOff, values: 'on|off',
    about: 'on이면 general-purpose·fork 위임을 막고 orbit 위임 모드만 쓰게 한다' },
];
const MODULES = [
  { name: 'codex', about: 'Codex와 턴제 협업(AGENTS.md, 따라잡기 훅)' },
  { name: 'reviewers', about: '리뷰어 에이전트 5종' },
];

function parse(argv) {
  const action = argv.shift();
  if (!['show', 'set', 'unset'].includes(action)) die('사용법: config.mjs <show|set|unset> --repo <저장소> [이름] [값] [--json] [옵션…]');
  const out = { action, json: false, repo: null, positional: [], options: {} };
  while (argv.length) {
    const token = argv.shift();
    if (token === '--json') out.json = true;
    else if (token === '--force') out.options.force = true;
    else if (token.startsWith('--')) {
      if (!argv.length) die(`값이 필요합니다: ${token}`);
      const value = argv.shift();
      if (token === '--repo') out.repo = value; else out.options[token.slice(2)] = value;
    } else out.positional.push(token);
  }
  if (!out.repo) die('필수 옵션이 없습니다: --repo');
  out.repo = path.resolve(out.repo);
  return out;
}

function readJsonFile(file, { must = false } = {}) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (must) die(`${file}을 읽을 수 없습니다(JSON 오류: ${error.message}). 파일을 고친 뒤 다시 하세요.`);
    return null;
  }
}

function switchState(repo) {
  const local = readJsonFile(path.join(repo, '.claude/settings.local.json'))?.env || {};
  const shared = readJsonFile(path.join(repo, '.claude/settings.json'))?.env || {};
  return SWITCHES.map((item) => {
    const raw = local[item.env] ?? shared[item.env];
    const from = item.env in local ? '.claude/settings.local.json' : item.env in shared ? '.claude/settings.json' : '기본값';
    return { name: item.name, env: item.env, value: raw === undefined ? item.fallback : String(raw), from, values: item.values, about: item.about };
  });
}

function writeSwitch(repo, item, value) {
  const file = path.join(repo, '.claude/settings.local.json');
  const data = readJsonFile(file, { must: true }) || {};
  if (data.env !== undefined && (typeof data.env !== 'object' || Array.isArray(data.env))) die(`${file}의 env가 객체가 아닙니다. 파일을 고친 뒤 다시 하세요.`);
  data.env = data.env || {};
  if (value === null) {
    delete data.env[item.env];
    if (!Object.keys(data.env).length) delete data.env;
  } else data.env[item.env] = value;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(temp, file);
  return file;
}

async function loadExtension() {
  const file = path.join(HERE, 'config-ext.mjs');
  if (!fs.existsSync(file)) return null;
  return import(pathToFileURL(file).href);
}

const args = parse(process.argv.slice(2));
const manifest = readJsonFile(path.join(args.repo, '.claude/orbit-manifest.json'));
if (!manifest?.slug) die('이 저장소에는 orbit이 설치되어 있지 않습니다(.claude/orbit-manifest.json 없음). 먼저 setup으로 설치하세요.');
const ext = await loadExtension();
const context = { repo: args.repo, manifest, options: args.options, die, scriptsDir: HERE };

if (args.action === 'show') {
  const state = {
    repo: args.repo,
    version: manifest.skillVersion,
    projectName: manifest.projectName,
    slug: manifest.slug,
    docsDir: manifest.docsDir,
    modules: MODULES.map((item) => ({ name: item.name, value: manifest.modules?.[item.name] ? 'on' : 'off', about: item.about })),
    switches: switchState(args.repo),
    extra: ext ? await ext.show(context) : [],
  };
  if (args.json) { process.stdout.write(`${JSON.stringify(state, null, 2)}\n`); process.exit(0); }
  const lines = [`── orbit 설정: ${state.projectName} (${state.slug}) · 설치 판 ${state.version} · 문서 폴더 ${state.docsDir}/ ──`, '', '## 선택 모듈 (켜기만 가능)'];
  for (const item of state.modules) lines.push(`- ${item.name} = ${item.value} — ${item.about}`);
  lines.push('', '## 조절 스위치 (.claude/settings.local.json에 적힌다. unset이면 기본값)');
  for (const item of state.switches) lines.push(`- ${item.name} = ${item.value} (${item.from}) — ${item.about}. 값: ${item.values}`);
  for (const section of state.extra) {
    lines.push('', `## ${section.title}`);
    for (const item of section.items) lines.push(`- ${item.name} = ${item.value}${item.detail ? ` (${item.detail})` : ''}${item.about ? ` — ${item.about}` : ''}`);
  }
  lines.push('', '바꾸기: config.mjs set --repo <저장소> <이름> <값> · 기본값으로: config.mjs unset --repo <저장소> <이름>');
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(0);
}

const [name, value] = args.positional;
if (!name) die('바꿀 설정 이름이 없습니다. show로 이름을 확인하세요.');
const item = SWITCHES.find((entry) => entry.name === name || entry.env === name);
const moduleItem = MODULES.find((entry) => entry.name === name);

if (item) {
  if (args.action === 'unset') {
    const file = writeSwitch(args.repo, item, null);
    process.stdout.write(`${item.name}을 기본값(${item.fallback})으로 돌렸습니다: ${path.relative(args.repo, file)}에서 ${item.env}를 지움. 열려 있는 세션은 다시 시작해야 확실히 적용됩니다.\n`);
    process.exit(0);
  }
  if (value === undefined) die(`값이 없습니다. ${item.name}의 값: ${item.values}`);
  const normalized = item.normalize(value);
  if (normalized === null) die(`${item.name}에 쓸 수 없는 값입니다: ${value} (값: ${item.values})`);
  const file = writeSwitch(args.repo, item, normalized);
  process.stdout.write(`${item.name} = ${normalized} — ${path.relative(args.repo, file)}의 env.${item.env}에 적었습니다. 새 값은 파일을 저장한 뒤 도는 훅부터 적용됩니다.\n`);
  process.exit(0);
}

if (moduleItem) {
  if (args.action === 'unset' || onOff(value ?? '') === 'off') die(`${moduleItem.name} 모듈 끄기는 아직 지원하지 않습니다(설치기가 켜기만 한다). 꺼야 하면 그 모듈이 넣은 파일을 직접 정리해야 합니다.`, 2);
  if (onOff(value ?? '') !== 'on') die(`${moduleItem.name}의 값은 on만 받습니다.`);
  if (manifest.modules?.[moduleItem.name]) { process.stdout.write(`${moduleItem.name} 모듈은 이미 켜져 있습니다.\n`); process.exit(0); }
  const run = spawnSync(process.execPath, [path.join(HERE, 'install.mjs'), 'update', '--repo', args.repo, `--${moduleItem.name}`], { encoding: 'utf8' });
  if (run.status !== 0) die(`${moduleItem.name} 모듈을 켜지 못했습니다:\n${run.stderr || run.stdout}`);
  process.stdout.write(`${moduleItem.name} 모듈을 켰습니다(설치기 update 실행). 바뀐 파일은 git status로 확인하고 커밋하세요. 훅이 바뀌면 새 세션부터 적용됩니다.\n`);
  process.exit(0);
}

if (ext?.handles?.(name)) {
  const message = await ext.set(context, args.action, name, value, args.positional.slice(2));
  process.stdout.write(`${message}\n`);
  process.exit(0);
}

const known = [...MODULES.map((entry) => entry.name), ...SWITCHES.map((entry) => entry.name), ...(ext?.names?.() || [])];
die(`모르는 설정입니다: ${name}. 바꿀 수 있는 것: ${known.join(', ')}`, 2);
