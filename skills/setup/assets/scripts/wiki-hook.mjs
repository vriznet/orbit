#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS_DIR = path.join(ROOT, '{{DOCS_DIR}}');
const CHECKER = path.join(ROOT, 'scripts', 'wiki-links.mjs');
const STATE_DIR = path.join(os.tmpdir(), '{{PROJECT_SLUG}}-wiki-hook');
const GENERATED_DOCUMENTS = new Set([
  '{{DOCS_DIR}}/tasks.md',
  '{{DOCS_DIR}}/tasks-done.md',
  '{{DOCS_DIR}}/worklog.md',
]);

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    fail(`wiki hook 입력을 읽지 못했습니다: ${error.message}`);
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function sessionStatePath(input) {
  const sessionId = String(input.session_id || 'unknown')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 180);
  return path.join(STATE_DIR, `${sessionId}.json`);
}

function readState(input) {
  const statePath = sessionStatePath(input);
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return { files: [] };
  }
}

function writeState(input, state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(sessionStatePath(input), `${JSON.stringify(state)}\n`);
}

function clearState(input) {
  fs.rmSync(sessionStatePath(input), { force: true });
}

function toRepoPath(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join('/');
}

function editedDocument(input) {
  const requestedPath = input.tool_input?.file_path;
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) return null;

  const absolutePath = path.resolve(input.cwd || ROOT, requestedPath);
  const insideDocs = absolutePath.startsWith(`${DOCS_DIR}${path.sep}`);
  if (!insideDocs || path.extname(absolutePath).toLowerCase() !== '.md') return null;

  return absolutePath;
}

function mayAutoFix(repoPath) {
  return !GENERATED_DOCUMENTS.has(repoPath)
    && !repoPath.startsWith('{{DOCS_DIR}}/templates/')
    && !repoPath.includes('/_templates/')
    // 확정된 ADR 파일은 훅이 스스로 고치지 않는다 — 검사만 한다("확정 ADR 불변" 규칙의 기술적 뒷받침).
    && !repoPath.startsWith('{{DOCS_DIR}}/decisions/');
}

function rememberDocument(input, repoPath) {
  const state = readState(input);
  const files = new Set(Array.isArray(state.files) ? state.files : []);
  files.add(repoPath);
  writeState(input, { files: [...files].sort() });
}

function runChecker(command, files) {
  const result = spawnSync(process.execPath, [CHECKER, command, ...files], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  if (result.error) {
    return { ok: false, output: result.error.message };
  }

  const output = [result.stdout, result.stderr]
    .filter(Boolean)
    .join('\n')
    .trim()
    .slice(0, 6000);
  return { ok: result.status === 0, output };
}

function emitPostContext(message) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: message,
    },
  })}\n`);
}

function handlePostToolUse(input) {
  const filePath = editedDocument(input);
  if (!filePath || !fs.existsSync(filePath)) return;

  const repoPath = toRepoPath(filePath);
  rememberDocument(input, repoPath);

  const before = fs.readFileSync(filePath, 'utf8');
  const command = mayAutoFix(repoPath) ? 'fix' : 'check';
  const result = runChecker(command, [repoPath]);
  if (!result.ok) {
    fail(result.output || `${repoPath} 위키 링크 검사에 실패했습니다.`);
  }

  const after = fs.readFileSync(filePath, 'utf8');
  const wasChanged = before !== after;
  const hasWarning = /warning|경고/i.test(result.output);
  if (wasChanged || hasWarning) {
    const summary = wasChanged
      ? `${repoPath}의 명확한 문서 참조를 위키 링크로 자동 정리했습니다.`
      : `${repoPath} 위키 링크 검사에서 경고가 발생했습니다.`;
    emitPostContext([summary, result.output].filter(Boolean).join('\n'));
  }
}

function handleStop(input) {
  const state = readState(input);
  const files = (Array.isArray(state.files) ? state.files : [])
    .filter((repoPath) => fs.existsSync(path.join(ROOT, repoPath)));

  if (files.length === 0) {
    clearState(input);
    return;
  }

  const result = runChecker('check', files);
  if (result.ok) {
    clearState(input);
    return;
  }

  const feedback = result.output || '이번 세션에서 변경한 문서의 위키 링크 검사에 실패했습니다.';
  if (!input.stop_hook_active) {
    fail(`${feedback}\n위 문제를 수정한 뒤 작업을 종료하세요.`);
  }

  clearState(input);
  process.stdout.write(`${JSON.stringify({
    systemMessage: `위키 링크 문제가 남아 있지만 종료 훅의 반복을 막기 위해 다시 차단하지 않습니다.\n${feedback}`,
  })}\n`);
}

const mode = process.argv[2];
const input = readHookInput();

if (mode === 'post') {
  handlePostToolUse(input);
} else if (mode === 'stop') {
  handleStop(input);
} else {
  fail('사용법: node scripts/wiki-hook.mjs <post|stop>');
}
