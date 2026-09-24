---
description: 저장소 규칙이 필요한 위임. CLAUDE.md만 참조하고 스킬·MCP는 쓰지 않는다. `/orbit:claude-md-subagent` 커맨드가 사용한다.
argument-hint: "[모델명] [--parallel-count N] <프롬프트>"
---

# /orbit:claude-md-subagent 위임

`/orbit:claude-md-subagent [모델명] [--parallel-count N] <프롬프트>` — 서브에이전트 유형 `orbit:claude-md-subagent`을 띄운다. 접근 범위: CLAUDE.md만 참조 — 스킬·MCP 없음. 하위 위임(Agent 도구) 불가 — 여러 에이전트로 나누는 일은 메인 세션이 한다.

## 문법 (그대로 따른다)

- 옵션과 모델명은 **맨 앞에서만** 읽는다. 첫 본문 토큰부터 끝까지는 전부 프롬프트이며, 요약·번역·수정 없이 **원문 그대로** 전달한다.
- 첫 토큰이 모델명(`sonnet`·`opus`·`haiku`·`fable`·`inherit` 또는 `claude-`로 시작하는 전체 ID)이면 모델로 읽는다. 아니면 모델은 `inherit`.
- `--parallel-count N`: N은 1 이상 정수. 생략하면 **네가(슈퍼바이저) 작업을 보고 개수를 정한다.** Claude Code의 동시 실행 한도(기본 20, `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`)를 넘겨 시도하지 않는다.
- 모르는 옵션·잘못된 값·모르는 모델명이면 추측하지 말고 **멈춰서** 문법과 유효 값을 보여주고 되묻는다.

## 절차

1. 파싱한다 — 모델, 개수(옵션), 프롬프트(원문).
2. 같은 턴에 `Agent` 도구로 띄운다. 개수가 N이면 N개를 한 턴에 병렬로:

   - `subagent_type`: `orbit:claude-md-subagent`
   - `model`: 파싱한 모델
   - `prompt`: 프롬프트 원문

3. 결과를 취합해 보고한다. **위임받은 일의 worklog·원장 기록은 메인(너)의 턴에서 남긴다** — 서브에이전트에는 턴 훅이 없다.
