#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SKILL_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ASSETS = path.join(SKILL_ROOT, 'assets');

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const action = argv.shift();
  if (!['plan', 'apply', 'update'].includes(action)) die('사용법: install.mjs <plan|apply|update> [options]');

  const options = {
    action, codex: false, reviewers: false,
    'no-githooks': false, 'keep-existing-scripts': false,
  };
  const booleans = new Set(['codex', 'reviewers', 'no-githooks', 'keep-existing-scripts']);
  // 값을 받는 옵션도 이름을 정해 둔다 — 모르는 옵션을 값 옵션으로 받아들이면 뒤따르는
  // 플래그를 값으로 삼켜 버린다(예: `--unknown --codex`에서 --codex가 사라짐).
  const valued = new Set(['repo', 'project-name', 'slug', 'mode']);

  while (argv.length) {
    const token = argv.shift();
    if (!token.startsWith('--')) die(`알 수 없는 인자: ${token}`);
    const key = token.slice(2);
    if (booleans.has(key)) {
      options[key] = true;
      continue;
    }
    if (!valued.has(key)) die(`알 수 없는 옵션: --${key}`);
    if (!argv.length || argv[0].startsWith('--')) die(`값이 필요합니다: --${key}`);
    options[key] = argv.shift();
  }

  // update는 매니페스트에서 슬러그·모드·모듈을 읽으므로 --repo만 필수다(아래에서 채운다).
  const required = action === 'update' ? ['repo'] : ['repo', 'project-name', 'slug', 'mode'];
  for (const key of required) {
    if (!options[key]) die(`필수 옵션이 없습니다: --${key}`);
  }
  if (options.slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.slug)) {
    die('슬러그는 영문 소문자, 숫자, 하이픈만 사용할 수 있습니다.');
  }
  if (options.mode && !['new', 'migrate', 'upgrade'].includes(options.mode)) {
    die('--mode는 new, migrate, upgrade 중 하나여야 합니다.');
  }
  return options;
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return structuredClone(fallback);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    die(`JSON을 읽지 못했습니다: ${file}: ${error.message}`);
  }
}

// 매니페스트는 손상·부재가 흔한 상황(구버전 설치·수동 삭제 등)이라 die하지 않고 null로
// 후퇴한다 — addFile 쪽에서 "매니페스트 해시 일치" 판정을 건너뛰는 보수적(fail-closed) 동작으로 이어진다.
function readJsonBestEffort(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function sha256Hex(buffer) {
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

// .mjs 대상 파일에 값을 꽂을 때 쓰는 JS 문자열 리터럴 이스케이프(N01) — 값에 따옴표·백틱·
// 개행이 섞여 있어도 렌더된 소스가 문법적으로 깨지지 않게 한다. 특수문자가 없는 값은
// 출력이 기존과 동일해 매니페스트 해시가 바뀌지 않는다.
function jsStringEscape(value) {
  return String(value)
    .replace(/[\\'"`]/g, '\\$&')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function renderText(text, vars, escapeFn = null) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) => {
    if (!(key in vars)) return whole;
    const value = vars[key];
    return escapeFn ? escapeFn(value) : value;
  });
}

// isJsTarget: 렌더 결과가 .mjs 파일로 쓰일 때만 JS 문자열 이스케이프를 적용한다. 다른
// 형식(Markdown·JSON·셸 등)은 기존과 동일하게 값 그대로 치환한다.
function renderedFile(file, vars, isJsTarget = false) {
  return Buffer.from(renderText(fs.readFileSync(file, 'utf8'), vars, isJsTarget ? jsStringEscape : null));
}

// 실행 부산물(파이썬 바이트코드 캐시, macOS 폴더 메타데이터)은 자산이 아니므로 복사하지 않는다.
const IGNORED_ASSET_DIRS = new Set(['__pycache__']);
const IGNORED_ASSET_FILES = /(^\.DS_Store$|\.py[co]$)/;

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_ASSET_DIRS.has(entry.name)) result.push(...walkFiles(full));
    } else if (entry.isFile() && !IGNORED_ASSET_FILES.test(entry.name)) {
      result.push(full);
    }
  }
  return result;
}

function sameBuffer(left, right) {
  return left.length === right.length && left.equals(right);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function signature(value) {
  return JSON.stringify(stable(value));
}

// P03 — 부분 문자열 판정(args.join(' ')에 마커가 포함되는지)은 사용자가 손으로 추가한
// 핸들러가 우연히(또는 문서화 목적으로) 같은 문자열 조각을 args에 담고 있어도 소유로
// 오인한다(예: ["-lc", "echo user docs: scripts/worklog-hook.mjs\""]). 그래서 소유 판정을
// 다음 세 갈래로 좁힌다:
//   ① 매니페스트에 기록된 이전 설치 핸들러 시그니처 목록과 완전 일치
//   ② 이번 incoming 핸들러 시그니처 집합과 완전 일치
//   ③ 구조 판정 — command가 bash·args[0]이 '-c'이고 args[1]이 우리 스크립트 호출로
//      **시작**할 때만(앵커드 정규식 — 부분 문자열 금지)
// ③은 매니페스트 유무와 무관하게 항상 적용한다. 계획서는 ③을 "매니페스트에 hookSignatures가
// 없을 때만"으로 잡았지만, 그렇게 하면 사용자가 하네스 핸들러의 timeout만 바꿔둔 설치본
// (H03/S10이 보증하는 교체 대상)을 소유로 못 잡아 업그레이드마다 중복이 쌓인다. ③은 명령
// 자체가 우리 스크립트 실행인 핸들러만 잡는 앵커드 판정이라, P03이 문제 삼은 "마커 문자열을
// 비앵커 위치에 담은 사용자 훅"은 여전히 절대 걸리지 않는다.
// observe.sh 갈래는 예전 버전이 선택 모듈로 심던 자동 학습 훅이다. 지금은 설치하지 않지만,
// 남아 있는 배선을 소유로 알아봐야 update가 연결을 정리한다.
const HARNESS_HANDLER_COMMAND_RE = /^(node "\$CLAUDE_PROJECT_DIR\/scripts\/(worklog|worklog-hook|wiki-hook|memory-hook)\.mjs" |bash "\$CLAUDE_PROJECT_DIR\/\.claude\/skills\/continuous-learning-v2\/hooks\/observe\.sh" )/;

function collectHandlerSignatures(hooksSpec) {
  const signatures = new Set();
  for (const groups of Object.values(hooksSpec.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (group && Array.isArray(group.hooks)) {
        for (const handler of group.hooks) signatures.add(signature(handler));
      }
    }
  }
  return signatures;
}

function isHarnessOwnedHandler(handler, manifestSignatures, incomingSignatures) {
  if (!handler) return false;
  const sig = signature(handler);
  if (manifestSignatures.has(sig) || incomingSignatures.has(sig)) return true;
  if (handler.type !== 'command' || handler.command !== 'bash') return false;
  if (!Array.isArray(handler.args) || handler.args[0] !== '-c') return false;
  const arg1 = handler.args[1];
  return typeof arg1 === 'string' && HARNESS_HANDLER_COMMAND_RE.test(arg1);
}

// 이벤트별로 (a) 기존 그룹들 안의 하네스 소유 핸들러를 제거(빈 그룹은 삭제),
// (b) 새 배선을 완전 동일 dedup으로 추가한다. 사용자 소유 핸들러·그룹은 절대 건드리지
// 않는다 — 같은 그룹(matcher)에 사용자 핸들러가 섞여 있어도 그 핸들러만 남긴다.
// H01(SessionStart→UserPromptSubmit 이동) 같은 일회성 마이그레이션도 이 규칙 하나로 처리된다.
function mergeHooks(targetSettings, incomingSettings, conflicts, stats, manifestSignatures, incomingSignatures) {
  targetSettings.hooks ??= {};
  if (!targetSettings.hooks || Array.isArray(targetSettings.hooks) || typeof targetSettings.hooks !== 'object') {
    conflicts.push('.claude/settings.json: hooks가 객체가 아닙니다.');
    return;
  }

  // N05 — incoming 이벤트만 순회하면, 다음 버전에서 이벤트 키 자체가 없어졌을 때 그
  // 이벤트에 심어둔 하네스 훅이 영영 안 지워진다. incoming과 현재 설정 두 쪽의 이벤트
  // 키를 합집합으로 순회해, incoming에 없는 이벤트에서도 하네스 소유 핸들러를 제거한다
  // (추가는 하지 않음 — incoming이 비어 있으니 자연히 그렇게 된다). 사용자 핸들러·그룹은
  // 이 경로에서도 절대 건드리지 않는다.
  const events = new Set([
    ...Object.keys(incomingSettings.hooks || {}),
    ...Object.keys(targetSettings.hooks || {}),
  ]);
  for (const event of events) {
    const incoming = (incomingSettings.hooks || {})[event] || [];
    if (!Array.isArray(incoming)) {
      conflicts.push(`훅 템플릿 오류: ${event}가 배열이 아닙니다.`);
      continue;
    }
    const current = targetSettings.hooks[event];
    if (current !== undefined && !Array.isArray(current)) {
      conflicts.push(`.claude/settings.json: hooks.${event}가 배열이 아닙니다.`);
      continue;
    }

    // P03 — 소유 판정은 매니페스트·incoming 시그니처 집합(둘 다 mergeHooks 밖에서 이번
    // 실행 전체 기준으로 한 번만 계산됨) 기준. "내용까지 완전히 같은 재설치"와 "실제로
    // 값이 바뀌는 교체"를 구분하는 것(F5)도 같은 incomingSignatures로 판단한다.
    const kept = [];
    for (const group of current || []) {
      if (!group || !Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const remainingHooks = group.hooks.filter((handler) => {
        const owned = isHarnessOwnedHandler(handler, manifestSignatures, incomingSignatures);
        if (owned && stats && !incomingSignatures.has(signature(handler))) {
          stats.hooksReplaced = (stats.hooksReplaced || 0) + 1;
        }
        return !owned;
      });
      if (remainingHooks.length === 0) continue; // 그룹이 하네스 핸들러만 있었으면 그룹째 삭제
      kept.push(remainingHooks.length === group.hooks.length ? group : { ...group, hooks: remainingHooks });
    }

    const seen = new Set(kept.map(signature));
    for (const item of incoming) {
      const key = signature(item);
      if (!seen.has(key)) {
        kept.push(item);
        seen.add(key);
      }
    }
    // 이벤트에 남는 그룹이 없으면(incoming에 없고 사용자 그룹도 없었던 이벤트) 키 자체를
    // 지운다 — 빈 배열을 settings.json에 남기지 않는다.
    if (kept.length === 0) delete targetSettings.hooks[event];
    else targetSettings.hooks[event] = kept;
  }
}

function isHarnessVault(dir) {
  return fs.existsSync(path.join(dir, 'worklog.md')) && fs.existsSync(path.join(dir, 'rules.md'));
}

// 매니페스트가 있고 그 안의 docsDir이 확인하려는 이름과 일치하면 확정 판별(참/거짓 모두
// 확정). 매니페스트가 없거나 깨졌으면 null을 돌려줘 호출자가 기존 휴리스틱으로 후퇴하게 한다(R09).
function isHarnessVaultManifestConfirmed(repoRoot, expectedDocsDir) {
  // 이관 호환: orbit-manifest.json이 없으면 옛 harness-setup의 harness-manifest.json도 본다.
  const orbitFile = path.join(repoRoot, '.claude/orbit-manifest.json');
  const legacyFile = path.join(repoRoot, '.claude/harness-manifest.json');
  const manifestFile = fs.existsSync(orbitFile) ? orbitFile : legacyFile;
  const manifest = readJsonBestEffort(manifestFile);
  if (!manifest || typeof manifest !== 'object') return null;
  return manifest.docsDir === expectedDocsDir;
}

function relativeFiles(sourceRoot, destinationRoot, legacyRoot = null) {
  return walkFiles(sourceRoot).map((source) => {
    const relative = path.relative(sourceRoot, source);
    return {
      source,
      destination: path.join(destinationRoot, relative),
      legacy: legacyRoot ? path.join(legacyRoot, relative) : null,
    };
  });
}

// N04 — chmod를 임시 파일에 먼저 적용하고 renameSync를 마지막 연산으로 둔다. rename 뒤에는
// 아무 연산도 없으므로 "rename은 성공했는데 그다음 단계에서 실패해 롤백 대상에서 빠진다"는
// 사후 실패 구간이 사라진다.
// P04 — 실패 시(예: rename 대상이 디렉터리라 EISDIR) 임시 파일을 지우고 다시 던진다.
// 정리 없이 그냥 던지면 *.orbit-*.tmp 잔재가 남는다.
function atomicWrite(file, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.orbit-${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

const options = parseArgs(process.argv.slice(2));
const repo = path.resolve(options.repo);
if (!fs.existsSync(path.join(repo, '.git'))) die(`Git 저장소 루트가 아닙니다: ${repo}`);

// plugin.json은 플러그인 루트(skills/setup의 두 단계 위)에 있다. 예전에는 SKILL_ROOT 아래에서 찾아
// 모든 설치본이 0.0.0으로 기록됐다. 옛 배치(스킬 폴더 안)도 받아 준다.
const pluginJson = readJsonBestEffort(path.join(SKILL_ROOT, '..', '..', '.claude-plugin/plugin.json'))
  || readJsonBestEffort(path.join(SKILL_ROOT, '.claude-plugin/plugin.json')) || {};
const skillVersion = pluginJson.version || '0.0.0';
// 이관 호환: 옛 harness-setup이 남긴 .claude/harness-manifest.json도 설치로 인정한다(흡수).
// orbit-manifest.json이 있으면 우선이며, 흡수한 경우 update 끝에서 옛 파일을 지우고
// summary.migratedFromHarness로 보고한다.
const orbitManifestFile = path.join(repo, '.claude/orbit-manifest.json');
const legacyHarnessManifestFile = path.join(repo, '.claude/harness-manifest.json');
const manifestFile = fs.existsSync(orbitManifestFile)
  ? orbitManifestFile
  : (fs.existsSync(legacyHarnessManifestFile) ? legacyHarnessManifestFile : orbitManifestFile);
const migratedFromHarness = manifestFile === legacyHarnessManifestFile;
const manifest = readJsonBestEffort(manifestFile); // 손상·부재 시 null → addFile이 보수적으로 후퇴

// update — 질문 없이 매니페스트 값으로 upgrade한다. 슬러그·모드를 채우고, 표시 이름은
// manifest.projectName → package.json name → 슬러그 순으로 해석한다. 아래 모듈 승계·docsName·
// vars 구성보다 앞에서 채운다. 매니페스트가 없으면 거부한다(먼저 orbit:setup으로 설치).
if (options.action === 'update') {
  if (!manifest || !manifest.slug) {
    die('update는 orbit:setup으로 먼저 설치한 저장소에서만 쓸 수 있습니다(.claude/orbit-manifest.json 또는 옛 .claude/harness-manifest.json 없음/손상).');
  }
  options.slug = manifest.slug;
  options.mode = 'upgrade';
  if (!options['project-name']) {
    const pkg = readJsonBestEffort(path.join(repo, 'package.json'));
    options['project-name'] = manifest.projectName || (pkg && pkg.name) || manifest.slug;
  }
}

// upgrade에서 이전 설치의 모듈 구성을 승계한다(F2) — 유효 모듈 = 매니페스트 modules ∪ CLI
// 플래그. CLI로 새 모듈을 추가로 켜는 건 허용하고, 끄는 기능(명시적 제거)은 이번 범위 밖이다.
// new·migrate 모드나 매니페스트가 없는 upgrade는 옵션값 그대로 쓴다. 이 아래 모든 사용처
// (directAssets 구성, mergeHooks의 incoming 결합, summary)보다 앞에서 한 번만 승계한다.
if (options.mode === 'upgrade' && manifest?.modules && typeof manifest.modules === 'object') {
  options.codex = options.codex || Boolean(manifest.modules.codex);
  options.reviewers = options.reviewers || Boolean(manifest.modules.reviewers);
}

const docsName = `${options.slug}-docs`;
const docsRoot = path.join(repo, docsName);
const legacyDocsRoot = path.join(repo, 'docs');
const hasDocs = fs.existsSync(docsRoot);
const hasLegacyDocsDir = fs.existsSync(legacyDocsRoot);
// docs/ 라는 이름만으로 "옛 하네스 볼트"로 단정하지 않는다. 매니페스트가 있으면 그걸로
// 확정 판별하고(R09), 없으면 worklog.md·rules.md 존재 여부(휴리스틱)로 후퇴한다.
const legacyVaultManifestVerdict = hasLegacyDocsDir ? isHarnessVaultManifestConfirmed(repo, 'docs') : null;
const legacyIsHarnessVault = hasLegacyDocsDir
  && (legacyVaultManifestVerdict !== null ? legacyVaultManifestVerdict : isHarnessVault(legacyDocsRoot));

if (options.mode === 'new' && (hasDocs || legacyIsHarnessVault)) {
  die('new 모드는 <slug>-docs/가 없어야 하고, 하네스가 설치된 docs/도 없어야 합니다.');
}
if (options.mode === 'migrate' && (!legacyIsHarnessVault || hasDocs)) {
  die(
    hasLegacyDocsDir && !legacyIsHarnessVault
      ? 'migrate 모드는 docs/가 하네스 볼트(worklog.md·rules.md 존재)여야 합니다. 무관한 docs/ 폴더로 보입니다.'
      : 'migrate 모드는 docs/가 있고 <slug>-docs/가 없어야 합니다.'
  );
}
if (options.mode === 'upgrade' && (!hasDocs || legacyIsHarnessVault)) {
  die('upgrade 모드는 <slug>-docs/만 존재해야 합니다.');
}

// CLAUDE.md 협업 절은 codex 모듈 여부에 맞춘다. 꺼진 설치본에 없는 AGENTS.md를 가리키지 않게 한다.
const collabHeading = options.codex ? '협업 (Codex와 턴제)' : '작업 일지 (세션·에이전트 사이 기록)';
const collabIntro = options.codex
  ? `Claude와 Codex는 대화 맥락을 공유 못 한다. \`${docsName}/worklog.md\`로 서로의 "왜"를 잇는다(Codex 진입점 \`AGENTS.md\`). 턴 시작 따라잡기는 훅이 자동 처리. 일지는 **덧붙이기만**(이견은 새 항목 "Codex의 #N에 반대 …").`
  : `새 세션과 다른 에이전트는 이 대화를 보지 못한다. \`${docsName}/worklog.md\`에 턴마다 물음과 결과를 남겨 "왜"를 잇는다. 세션 시작과 컴팩션 직후에는 훅이 최근 기록을 넣는다. 일지는 **덧붙이기만**(이견은 새 항목 "#N에 반대 …").`;
const vars = {
  PROJECT_NAME: options['project-name'],
  PROJECT_SLUG: options.slug,
  DOCS_DIR: docsName,
  REPO_ABS_PATH: repo,
  COLLAB_HEADING: collabHeading,
  COLLAB_INTRO: collabIntro,
};
const legacyVars = { ...vars, DOCS_DIR: 'docs' };
const conflicts = [];
const operations = [];

// 매니페스트에 기록된 해시가 현재 파일과 일치하면 "이전 버전 산출물"로 보고 update 허용.
function manifestHashMatches(manifestKey, currentBuffer) {
  if (!manifest || !manifest.files || typeof manifest.files !== 'object') return false;
  const recorded = manifest.files[manifestKey];
  if (!recorded) return false;
  return recorded === sha256Hex(currentBuffer);
}

// CLAUDE.md의 orbit 관리 구간. 사용자는 구간 밖에 지식 맵·프로젝트 규칙을 더하고, update는
// 구간 안만 새 판으로 바꾼다. 파일 전체를 해시로 비교하면 한 줄만 더한 설치본에도 새 규칙
// (Compact instructions 등)이 영영 들어가지 않았다. 결정: D-프로젝트-기억-분담(결정 9).
const ORBIT_BLOCK_BEGIN = '<!-- orbit:begin';
const ORBIT_BLOCK_END = '<!-- orbit:end -->';
const BLOCK_MANAGED_FILES = new Set(['CLAUDE.md']);

function findOrbitBlock(text) {
  const start = text.indexOf(ORBIT_BLOCK_BEGIN);
  if (start === -1) return null;
  const endAt = text.indexOf(ORBIT_BLOCK_END, start);
  if (endAt === -1) return null;
  const end = endAt + ORBIT_BLOCK_END.length;
  return { start, end, block: text.slice(start, end) };
}

// 구간이 있는 파일이면 {status, desired}를 돌려주고, 아니면 null(파일 단위 규칙으로 후퇴).
// 구간 안을 사용자가 고쳤으면(매니페스트의 구간 해시와 다름) 덮지 않고 충돌로 둔다.
function planBlockUpdate(manifestKey, currentPath, desired) {
  if (!BLOCK_MANAGED_FILES.has(manifestKey) || !fs.existsSync(currentPath)) return null;
  const currentText = fs.readFileSync(currentPath, 'utf8');
  const current = findOrbitBlock(currentText);
  const wanted = findOrbitBlock(desired.toString('utf8'));
  if (!current || !wanted) return null;
  const merged = currentText.slice(0, current.start) + wanted.block + currentText.slice(current.end);
  if (merged === currentText) return { status: 'skip', desired: Buffer.from(merged) };
  const recorded = manifest?.blocks?.[manifestKey];
  if (recorded && recorded !== sha256Hex(Buffer.from(current.block))) {
    conflicts.push(`${manifestKey}: orbit 구간 안을 고친 흔적이 있어 새 구간으로 바꾸지 않았습니다. 고친 내용을 구간 밖으로 옮긴 뒤 다시 update하세요.`);
    return { status: 'conflict', desired };
  }
  return { status: 'update', desired: Buffer.from(merged) };
}

function addFile(source, destination, legacy = null, currentOverride = null) {
  const isJsTarget = path.extname(destination) === '.mjs';
  let desired = renderedFile(source, vars, isJsTarget);
  const currentPath = currentOverride || destination;
  const manifestKey = path.relative(repo, destination);
  let status = 'create';
  const blockPlan = planBlockUpdate(manifestKey, currentPath, desired);

  if (blockPlan) {
    status = blockPlan.status;
    desired = blockPlan.desired;
  } else if (fs.existsSync(currentPath)) {
    const current = fs.readFileSync(currentPath);
    if (sameBuffer(current, desired)) {
      status = 'skip';
    } else if (manifestHashMatches(manifestKey, current)) {
      // 매니페스트가 없거나 깨졌으면 이 분기는 항상 거짓 — 보수적으로 conflict 쪽에 남는다.
      status = 'update';
    } else if (legacy && fs.existsSync(legacy) && sameBuffer(current, renderedFile(legacy, legacyVars, isJsTarget))) {
      status = 'update';
    } else {
      conflicts.push(BLOCK_MANAGED_FILES.has(manifestKey)
        ? `${path.relative(repo, currentPath)}: orbit 구간 표시가 없고 설치 뒤 고친 흔적이 있어 새 판을 넣지 않았습니다. 새 템플릿의 '<!-- orbit:begin' ~ '<!-- orbit:end -->' 구간을 붙여 넣으면 다음 update부터 구간만 바뀝니다.`
        : `${path.relative(repo, currentPath)}: 기존 내용이 후보와 다릅니다.`);
      status = 'conflict';
    }
  }

  operations.push({
    source,
    destination,
    desired,
    mode: fs.statSync(source).mode & 0o777,
    status,
    manifestKey,
  });
}

function addAssetTree(assetRelative, destination, legacyRelative = null, isDocsTree = false) {
  const sourceRoot = path.join(ASSETS, assetRelative);
  const legacyRoot = legacyRelative ? path.join(ASSETS, legacyRelative) : null;
  for (const item of relativeFiles(sourceRoot, destination, legacyRoot)) {
    let currentOverride = null;
    // migrate 모드에서는 destination(=docsRoot)이 아직 존재하지 않고 legacyDocsRoot(docs/)에
    // 실제 파일이 있다. isDocsTree로 이 트리인지 명시적으로 표시해 파일별 내용 비교가 실제로
    // 일어나게 한다(예전엔 destination 자체를 검사해 항상 거짓이라 충돌 감지가 죽어 있었다).
    if (options.mode === 'migrate' && isDocsTree) {
      const relative = path.relative(docsRoot, item.destination);
      currentOverride = path.join(legacyDocsRoot, relative);
    }
    addFile(item.source, item.destination, item.legacy, currentOverride);
  }
}

const directAssets = [
  ['CLAUDE.md.tmpl', path.join(repo, 'CLAUDE.md'), 'legacy/CLAUDE.md.tmpl'],
  ['scripts/worklog.mjs', path.join(repo, 'scripts/worklog.mjs'), 'legacy/scripts/worklog.mjs'],
  ['scripts/worklog-hook.mjs', path.join(repo, 'scripts/worklog-hook.mjs'), null],
  ['scripts/tasks.mjs', path.join(repo, 'scripts/tasks.mjs'), 'legacy/scripts/tasks.mjs'],
  ['scripts/wiki-lib.mjs', path.join(repo, 'scripts/wiki-lib.mjs'), null],
  ['scripts/wiki-links.mjs', path.join(repo, 'scripts/wiki-links.mjs'), null],
  ['scripts/wiki-context.mjs', path.join(repo, 'scripts/wiki-context.mjs'), null],
  ['scripts/wiki-hook.mjs', path.join(repo, 'scripts/wiki-hook.mjs'), null],
  ['scripts/wiki.mjs', path.join(repo, 'scripts/wiki.mjs'), null],
  ['scripts/worktree-merge-inspect.mjs', path.join(repo, 'scripts/worktree-merge-inspect.mjs'), null],
  ['scripts/memory-lib.mjs', path.join(repo, 'scripts/memory-lib.mjs'), null],
  ['scripts/redact.mjs', path.join(repo, 'scripts/redact.mjs'), null],
  ['scripts/memory.mjs', path.join(repo, 'scripts/memory.mjs'), null],
  ['scripts/memory-hook.mjs', path.join(repo, 'scripts/memory-hook.mjs'), null],
  ['scripts/claude-catchup.sh', path.join(repo, 'scripts/claude-catchup.sh'), null],
];

if (!options['no-githooks']) {
  directAssets.push(['githooks/commit-msg', path.join(repo, '.githooks/commit-msg'), 'legacy/githooks/commit-msg']);
}

if (options.codex) {
  directAssets.push(
    ['AGENTS.md.tmpl', path.join(repo, 'AGENTS.md'), 'legacy/AGENTS.md.tmpl'],
    ['scripts/codex-catchup.sh', path.join(repo, 'scripts/codex-catchup.sh'), null],
  );
}

for (const [source, destination, legacy] of directAssets) {
  addFile(
    path.join(ASSETS, source),
    destination,
    legacy ? path.join(ASSETS, legacy) : null,
  );
}

addAssetTree('docs', docsRoot, 'legacy/docs', true);
addAssetTree('claude/skills/decision-context', path.join(repo, '.claude/skills/decision-context'));
addAssetTree('claude/skills/worktree-merge', path.join(repo, '.claude/skills/worktree-merge'));
addFile(
  path.join(ASSETS, 'claude/agents/context-reader.md'),
  path.join(repo, '.claude/agents/context-reader.md'),
);

if (options.reviewers) {
  for (const source of walkFiles(path.join(ASSETS, 'claude/agents'))) {
    if (path.basename(source) === 'context-reader.md') continue;
    addFile(source, path.join(repo, '.claude/agents', path.basename(source)));
  }
}

// aside·checkpoint 같은 일반 명령은 항상 설치한다.
for (const source of walkFiles(path.join(ASSETS, 'claude/commands'))) {
  addFile(source, path.join(repo, '.claude/commands', path.basename(source)));
}

// N01 게이트 — 어떤 파일도 바꾸기 전에, 렌더된 .mjs 산출물이 전부 실제로 파싱 가능한지
// 확인한다. plan·apply 공통 경로(여기는 operations 구성 직후, conflicts 판정과 무관하게
// 항상 실행된다). 값에 따옴표·백틱 등이 섞여 렌더 결과가 깨지면 여기서 잡는다.
// P04 — die()는 process.exit()를 부르는데, process.exit()는 진행 중인 try/finally의
// finally를 건너뛴다(스크래치 정리가 실행되지 않고 잔재가 남는다). 그래서 실패를 모아뒀다가
// try/finally 블록이 정상적으로 끝나(스크래치 정리가 반드시 실행된) *뒤에* die한다.
function checkRenderedJsSyntax(items) {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-jscheck-'));
  const failures = [];
  try {
    for (const item of items) {
      if (path.extname(item.destination) !== '.mjs') continue;
      const temporary = path.join(scratchDir, `check-${crypto.randomBytes(6).toString('hex')}.mjs`);
      fs.writeFileSync(temporary, item.desired);
      try {
        execFileSync(process.execPath, ['--check', temporary], { stdio: 'pipe' });
      } catch (error) {
        const detail = error.stderr ? error.stderr.toString('utf8') : error.message;
        failures.push(`${path.relative(repo, item.destination)}\n${detail}`);
      }
    }
  } finally {
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch {}
  }
  if (failures.length) {
    die(`렌더된 스크립트가 문법 검사(node --check)를 통과하지 못했습니다:\n${failures.join('\n---\n')}`);
  }
}
checkRenderedJsSyntax(operations);

const packageFile = path.join(repo, 'package.json');
let packageJson;
if (fs.existsSync(packageFile)) {
  packageJson = readJson(packageFile, {});
  packageJson.scripts ??= {};
  if (!packageJson.scripts || Array.isArray(packageJson.scripts) || typeof packageJson.scripts !== 'object') {
    conflicts.push('package.json: scripts가 객체가 아닙니다.');
  }
} else {
  packageJson = JSON.parse(renderText(fs.readFileSync(path.join(ASSETS, 'package.json.tmpl'), 'utf8'), vars));
  if (!options.codex) delete packageJson.scripts['codex-catchup'];
}

const desiredScripts = {
  'claude-catchup': 'bash scripts/claude-catchup.sh',
  'wiki:check': 'node scripts/wiki-links.mjs check-all',
  'wiki:fix': 'node scripts/wiki-links.mjs fix',
  'wiki:context': 'node scripts/wiki-context.mjs',
  'wiki': 'node scripts/wiki.mjs',
  'memory': 'node scripts/memory.mjs',
};
if (options.codex) desiredScripts['codex-catchup'] = 'bash scripts/codex-catchup.sh';

const keptScripts = [];
for (const [name, command] of Object.entries(desiredScripts)) {
  const current = packageJson.scripts?.[name];
  if (current !== undefined && current !== command) {
    if (options['keep-existing-scripts']) {
      keptScripts.push(name); // 기존 스크립트를 그대로 두고 이 항목만 건너뛴다
    } else {
      conflicts.push(`package.json: scripts.${name}이 이미 다른 명령을 사용합니다.`);
    }
  } else if (packageJson.scripts) {
    packageJson.scripts[name] = command;
  }
}
const packageDesired = Buffer.from(`${JSON.stringify(packageJson, null, 2)}\n`);

const settingsFile = path.join(repo, '.claude/settings.json');
const settings = readJson(settingsFile, {});
const mergeStats = { hooksReplaced: 0 };
const baseHooks = readJson(path.join(ASSETS, 'claude/settings.hooks.base.json'), {});
// 심을 훅을 이벤트별로 하나의 incoming으로 모은 뒤 mergeHooks를 딱 1회 호출한다(F1).
// 여러 번 나눠 부르면 뒤 호출의 "소유 핸들러 전체 제거" 단계가 앞 호출이 방금 넣은
// 핸들러(예: wiki-hook post)를 삭제해버리는 자기잠식이 생긴다.
const incomingHooks = { hooks: {} };
function appendIncomingHooks(hooksSpec) {
  for (const [event, groups] of Object.entries(hooksSpec.hooks || {})) {
    incomingHooks.hooks[event] = [...(incomingHooks.hooks[event] || []), ...groups];
  }
}
appendIncomingHooks(baseHooks);
// P03 — 소유 판정에 쓸 두 시그니처 집합. manifestHookSignatures는 이전 설치가 심어둔
// 핸들러들의 시그니처(매니페스트에 없으면 빈 집합), incomingSignatureSet은 이번 실행이
// 새로 심으려는 핸들러들의 시그니처(위에서 만든 incomingHooks 기준).
// 두 집합 어디에도 없으면 isHarnessOwnedHandler의 앵커드 구조 판정이 최후 기준이 된다.
const manifestHookSignatures = new Set(Array.isArray(manifest?.hookSignatures) ? manifest.hookSignatures : []);
const incomingSignatureSet = collectHandlerSignatures(incomingHooks);
mergeHooks(settings, incomingHooks, conflicts, mergeStats, manifestHookSignatures, incomingSignatureSet);
const settingsDesired = Buffer.from(`${JSON.stringify(settings, null, 2)}\n`);

const gitignoreFile = path.join(repo, '.gitignore');
const gitignoreCurrent = fs.existsSync(gitignoreFile) ? fs.readFileSync(gitignoreFile, 'utf8') : '';
const ignoreRule = `/${docsName}/.obsidian/`;
const gitignoreDesired = Buffer.from(
  gitignoreCurrent.split(/\r?\n/).includes(ignoreRule)
    ? gitignoreCurrent
    : `${gitignoreCurrent}${gitignoreCurrent && !gitignoreCurrent.endsWith('\n') ? '\n' : ''}${ignoreRule}\n`,
);

let hooksPath = '';
let hooksPathWasUnset = false;
if (!options['no-githooks']) {
  try {
    hooksPath = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {}
  if (hooksPath && hooksPath !== '.githooks') {
    conflicts.push(`git core.hooksPath가 이미 ${hooksPath}을 가리킵니다.`);
  }
  if (!hooksPath) {
    hooksPathWasUnset = true;
    const nativeHooks = path.join(repo, '.git/hooks');
    if (fs.existsSync(nativeHooks)) {
      const active = fs.readdirSync(nativeHooks).filter((name) => !name.endsWith('.sample'));
      if (active.length) conflicts.push(`.git/hooks에 기존 훅이 있습니다: ${active.join(', ')}`);
    }
  }
}

function syntheticStatus(file, desired) {
  if (!fs.existsSync(file)) return 'create';
  return sameBuffer(fs.readFileSync(file), desired) ? 'skip' : 'update';
}

// 이관 호환: 옛 harness-setup 훅은 턴 상태를 .git/harness-state/worklog에 두었다. 지금 스크립트는
// orbit-state/worklog를 보므로, 옛 폴더가 남아 있으면 적용 끝에서 새 폴더로 옮긴다(진행 중 턴·orphan 보존).
// 경로는 훅과 같은 `git rev-parse --git-path`로 구한다(워크트리마다 다른 경로).
function gitPathIn(relative) {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-path', relative], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return path.resolve(repo, out);
  } catch {
    return null;
  }
}
const legacyStateDir = gitPathIn('harness-state/worklog');
const orbitStateDir = gitPathIn('orbit-state/worklog');
const legacyStateFiles = legacyStateDir && orbitStateDir && fs.existsSync(legacyStateDir)
  ? fs.readdirSync(legacyStateDir)
  : [];

// 같은 이름이 새 폴더에 이미 있으면 새 쪽(현재 훅이 쓴 것)을 남긴다. 실패해도 설치를 되돌리지 않는다.
function migrateLegacyWorklogState() {
  if (!legacyStateDir || !orbitStateDir || !fs.existsSync(legacyStateDir)) return;
  fs.mkdirSync(orbitStateDir, { recursive: true });
  for (const name of fs.readdirSync(legacyStateDir)) {
    const from = path.join(legacyStateDir, name);
    const to = path.join(orbitStateDir, name);
    if (fs.existsSync(to)) continue;
    fs.cpSync(from, to, { recursive: true, preserveTimestamps: true });
  }
  fs.rmSync(legacyStateDir, { recursive: true, force: true });
  const legacyParent = path.dirname(legacyStateDir);
  try {
    if (!fs.readdirSync(legacyParent).length) fs.rmdirSync(legacyParent);
  } catch {}
}

const summary = {
  action: options.action,
  repo,
  mode: options.mode,
  migratedFromHarness,
  docsDir: docsName,
  modules: {
    codex: options.codex,
    reviewers: options.reviewers,
  },
  partial: {
    noGithooks: options['no-githooks'],
    keepExistingScripts: options['keep-existing-scripts'],
    keptScripts,
  },
  files: {
    create: operations.filter((item) => item.status === 'create').length,
    update: operations.filter((item) => item.status === 'update').length,
    skip: operations.filter((item) => item.status === 'skip').length,
    conflict: operations.filter((item) => item.status === 'conflict').length,
  },
  // 상세 진단 요청 시 보여줄 파일별 목록(저장소 기준 상대경로). 개수만으로는
  // 무엇이 만들어지는지 알 수 없어 추가했다.
  fileList: operations.map((item) => ({
    path: path.relative(repo, item.destination),
    status: item.status,
  })),
  merges: {
    packageJson: syntheticStatus(packageFile, packageDesired),
    settingsJson: syntheticStatus(settingsFile, settingsDesired),
    gitignore: syntheticStatus(gitignoreFile, gitignoreDesired),
    gitHooksPath: options['no-githooks'] ? 'skipped' : (hooksPath || 'set .githooks'),
    hooksReplaced: mergeStats.hooksReplaced,
  },
  conflicts,
  // 옛 harness-state/worklog → orbit-state/worklog 이관 계획(null이면 옮길 것 없음).
  stateMigration: legacyStateDir && fs.existsSync(legacyStateDir)
    ? { from: path.relative(repo, legacyStateDir), to: path.relative(repo, orbitStateDir), files: legacyStateFiles.length }
    : null,
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

if (options.action === 'plan') process.exit(conflicts.length ? 2 : 0);
// update는 충돌(사용자 수정 파일)을 중단 사유로 보지 않고 보존한 채 나머지만 적용한다.
// 그 외(apply)는 기존대로 충돌이 있으면 아무 것도 바꾸지 않고 멈춘다.
if (conflicts.length && options.action !== 'update') die('충돌이 있어 아무 파일도 변경하지 않았습니다.');

// ── 여기부터는 실제로 파일을 바꾼다. 실패하면 undo를 역순으로 실행해 원상 복구한다(RC-E). ──
const undo = [];
let backupDir = null;
function ensureBackupDir() {
  if (!backupDir) backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-backup-'));
  return backupDir;
}
function backupFile(file) {
  const dir = ensureBackupDir();
  const key = file.replace(/[\\/]/g, '__');
  const backupPath = path.join(dir, `${key}.bak`);
  fs.copyFileSync(file, backupPath);
  return backupPath;
}
function cleanupBackupDir() {
  if (!backupDir) return;
  try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
}
// N04 — undo를 atomicWrite 호출 "전에" 등록한다(생성 케이스도 삭제-undo를 먼저 심는다).
// atomicWrite가 도중에 던지더라도 undo 배열에는 이미 이 파일의 복구 절차가 들어가 있으므로
// 실패한 파일 자신도 롤백 대상에서 빠지지 않는다.
function writeFileWithUndo(file, content, mode) {
  const hadFile = fs.existsSync(file);
  let backupPath = null;
  let prevMode = null;
  if (hadFile) {
    backupPath = backupFile(file);
    prevMode = fs.statSync(file).mode & 0o777;
  }
  undo.push(() => {
    if (hadFile) atomicWrite(file, fs.readFileSync(backupPath), prevMode);
    else { try { fs.rmSync(file, { force: true }); } catch {} }
  });
  atomicWrite(file, content, mode);
}

function writeManifest() {
  // 기존 매니페스트의 files를 밑에 깔고 이번 실행분으로 덮어쓴다(F2) — 이번에 손대지 않은
  // 이전 모듈(예: 플래그 없는 upgrade에서의 codex·리뷰어 산출물) 해시가 사라지지 않게 한다.
  const files = { ...(manifest?.files ?? {}) };
  for (const op of operations) {
    if (op.status === 'conflict') continue;
    files[op.manifestKey] = sha256Hex(op.desired);
  }
  // 관리 구간 해시 — 다음 update에서 사용자가 구간 안을 고쳤는지 가린다.
  const blocks = { ...(manifest?.blocks ?? {}) };
  for (const op of operations) {
    if (op.status === 'conflict' || !BLOCK_MANAGED_FILES.has(op.manifestKey)) continue;
    const found = findOrbitBlock(op.desired.toString('utf8'));
    if (found) blocks[op.manifestKey] = sha256Hex(Buffer.from(found.block));
  }
  const manifestOut = {
    schemaVersion: 1,
    skillVersion,
    slug: options.slug,
    projectName: options['project-name'],
    docsDir: docsName,
    files,
    blocks,
    modules: {
      codex: options.codex,
      reviewers: options.reviewers,
    },
    // P03 — 이번 실행이 심은 핸들러들의 시그니처. 다음 설치·업그레이드에서 훅 소유 판정의
    // 1차 근거가 된다(부분 문자열 대신 완전 일치).
    hookSignatures: [...incomingSignatureSet],
  };
  // N04 — 매니페스트도 writeFileWithUndo로 쓴다. 이 마지막 단계가 실패해도(예: 자리에
  // 디렉터리가 있음) 지금까지의 다른 파일 변경 전체가 undo 저널로 원복된다.
  writeFileWithUndo(orbitManifestFile, Buffer.from(`${JSON.stringify(manifestOut, null, 2)}\n`), 0o644);
}

try {
  if (options.mode === 'migrate') {
    fs.renameSync(legacyDocsRoot, docsRoot);
    undo.push(() => fs.renameSync(docsRoot, legacyDocsRoot));
  }

  for (const operation of operations) {
    // conflict(사용자 수정 파일)는 절대 덮지 않는다. apply는 위에서 이미 중단했고, update는
    // 충돌을 보존한 채 나머지만 적용한다.
    if (operation.status === 'skip' || operation.status === 'conflict') continue;
    writeFileWithUndo(operation.destination, operation.desired, operation.mode);
  }

  if (syntheticStatus(packageFile, packageDesired) !== 'skip') writeFileWithUndo(packageFile, packageDesired, 0o644);
  if (syntheticStatus(settingsFile, settingsDesired) !== 'skip') writeFileWithUndo(settingsFile, settingsDesired, 0o644);
  if (syntheticStatus(gitignoreFile, gitignoreDesired) !== 'skip') writeFileWithUndo(gitignoreFile, gitignoreDesired, 0o644);

  if (!options['no-githooks'] && hooksPathWasUnset) {
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: repo });
    undo.push(() => {
      try { execFileSync('git', ['config', '--unset', 'core.hooksPath'], { cwd: repo }); } catch {}
    });
  }

  writeManifest(); // 성공 경로 맨 끝 — 실패하면 위 undo로 전체 원복
  if (migratedFromHarness) {
    // 흡수 완료 — 옛 매니페스트는 제거한다(orbit-manifest가 이미 기록된 뒤라 롤백 대상 아님).
    try { fs.rmSync(legacyHarnessManifestFile, { force: true }); } catch {}
  }
  try {
    migrateLegacyWorklogState();
  } catch (error) {
    process.stderr.write(`옛 worklog 상태 이관 실패(설치는 유지, 수동 확인 필요): ${error.message}\n`);
  }
  cleanupBackupDir();
} catch (error) {
  process.stderr.write(`설치 중 오류가 발생했습니다 — 지금까지의 변경을 되돌립니다: ${error.message}\n`);
  for (let i = undo.length - 1; i >= 0; i--) {
    try {
      undo[i]();
    } catch (undoError) {
      process.stderr.write(`롤백 단계 실패(수동 확인 필요): ${undoError.message}\n`);
    }
  }
  cleanupBackupDir();
  process.exit(2);
}
