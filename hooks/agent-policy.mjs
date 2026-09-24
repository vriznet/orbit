#!/usr/bin/env node
// orbit 에이전트 정책 훅 — Agent/Task 도구 호출을 검사해 위임 타입을 orbit 모드로 유도한다.
//
// 규칙:
// - orbit이 설치된 저장소(.claude/orbit-manifest.json이 있는 저장소)에서만 판단한다. 플러그인 훅은
//   설치한 사람의 모든 프로젝트에서 돌기 때문에, 다른 프로젝트의 위임에는 끼어들지 않는다.
// - general-purpose(타입 생략 시 기본)와 fork는 거부하고, 사유를 Claude에게 돌려준다 → Claude가 orbit 모드로 재시도한다.
// - orbit:* , Explore, Plan, claude, 그 외 알려지지 않은 타입은 그대로 허용한다(거부 목록 방식 — 오탐을 피한다).
// - ORBIT_AGENT_POLICY=off 이면 아무 판단도 하지 않는다(탈출구).
// - 훅은 절대 세션을 깨뜨리지 않는다: 어떤 오류가 나도 조용히 허용하고 exit 0.

import fs from 'node:fs';
import path from 'node:path';

// 프로젝트 폴더(없으면 훅 입력의 cwd)에서 저장소 루트까지 올라가며 orbit 매니페스트를 찾는다.
// 저장소 루트(.git이 있는 폴더)를 넘어 바깥 폴더까지는 보지 않는다.
function orbitInstalled(input) {
  const starts = [process.env.CLAUDE_PROJECT_DIR, input.cwd].filter(Boolean);
  for (const start of starts) {
    let dir = path.resolve(String(start));
    for (;;) {
      if (fs.existsSync(path.join(dir, '.claude', 'orbit-manifest.json'))) return true;
      if (fs.existsSync(path.join(dir, '.git'))) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return false;
}

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    if ((process.env.ORBIT_AGENT_POLICY || '').toLowerCase() === 'off') return;
    const input = JSON.parse(raw || '{}');
    const toolName = input.tool_name || '';
    if (toolName !== 'Agent' && toolName !== 'Task') return;
    const type = String((input.tool_input || {}).subagent_type || '');
    // 타입을 아예 주지 않은 호출은 내장 기본(general-purpose)으로 흐르므로 함께 거부한다.
    const effective = type || 'general-purpose';
    if (effective !== 'general-purpose' && effective !== 'fork') return;
    if (!orbitInstalled(input)) return;
    const reason =
      `orbit 정책: '${effective}' 타입 위임은 허용되지 않습니다. ` +
      '조사·일반 작업은 /orbit:clean-subagent(클린), 저장소 규칙이 필요하면 /orbit:claude-md-subagent, ' +
      '스킬·MCP 접근이 필요하면 /orbit:skill-subagent·/orbit:mcp-subagent, 전부 필요하면 /orbit:full-access-subagent로 다시 위임하세요. ' +
      '(끄기: ORBIT_AGENT_POLICY=off)';
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      }),
    );
  } catch {
    // 조용히 허용 — 훅 실패가 세션을 막아선 안 된다.
  }
});
