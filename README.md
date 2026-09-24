# orbit

> A **project harness** for AI-assisted repositories — memory, discipline, and delegation that live inside the repo.
> 세션이 바뀌어도 프로젝트가 궤도를 벗어나지 않게 하는 **프로젝트 하네스**.

Claude Code 같은 실행 환경(*에이전트 하네스*)이 AI에게 손발을 달아준다면, orbit은 저장소에 **기억과 규율**을 심는다. 세션이 끝날 때 사라지는 것들 — 결정의 이유, 하다 만 일, 품 들여 조사한 지식 — 을 파일 원장으로 남기고, 훅으로 강제한다.

용어: Claude Code 같은 실행 환경은 *에이전트 하네스*, 이 도구처럼 저장소를 일터로 만드는 것은 *프로젝트 하네스*.

## 설치

```
/plugin marketplace add vriznet/orbit
/plugin install orbit
```

## 빠른 시작

대상 저장소에서:

```
/orbit:setup
```

표시 이름·협업 방식·선택 모듈을 묻는 몇 가지 질문에 답하면 하네스가 설치된다. 이후 그 저장소에서는 —

- 새 세션이 이전 맥락(요약 1 + 최근 턴 8)을 자동으로 이어받고,
- 기록 없는 세션 종료가 Stop 훅으로 차단되고(백그라운드 작업 완료 알림은 사용자 턴으로 세지 않고 묶어 자동 기록한다),
- 문서를 고칠 때마다 링크·스키마 검사가 돌고,
- 위임이 아래 접근 모드로 정리된다.

갱신은 `/orbit:update` — 질문 없이, 직접 수정한 파일은 보존한 채.

## 위임 모드 — 접근 축(CLAUDE.md · 스킬 · MCP)

서브에이전트에게 무엇을 들려보낼지 고른다. 접근이 좁을수록 가볍고 예측 가능하다.

| 모드 | CLAUDE.md | 스킬 | MCP |
|---|---|---|---|
| `/orbit:clean-subagent` | — | — | — |
| `/orbit:claude-md-subagent` | ✓ | — | — |
| `/orbit:skill-subagent` | — | ✓ | — |
| `/orbit:mcp-subagent` | — | — | ✓ |
| `/orbit:skill-mcp-subagent` | — | ✓ | ✓ |
| `/orbit:claude-md-skill-subagent` | ✓ | ✓ | — |
| `/orbit:claude-md-mcp-subagent` | ✓ | — | ✓ |
| `/orbit:full-access-subagent` | ✓ | ✓ | ✓ |

```
/orbit:clean-subagent sonnet --parallel-count 13 "레딧에서 …을 조사해 각자 다른 관점으로 요약"
```

- 모델명 생략 → 슈퍼바이저와 같은 모델. `--parallel-count` 생략 → 슈퍼바이저가 작업을 보고 개수를 정한다.
- 프롬프트는 요약·번역 없이 **원문 그대로** 서브에이전트에게 전달된다.
- 위임 글은 설치되는 `<docs>/templates/subagent-brief.md` 양식을 따른다.
- `full-access-subagent`를 뺀 7개 모드는 `Agent` 도구가 막혀 하위 위임을 못 한다 — 서브에이전트가 넓은 모드를 다시 띄워 접근 제한을 우회하는 것을 막기 위해서다. 여러 에이전트로 나누는 일은 메인 세션이 한다.
- 위임받은 일의 원장 기록(worklog·할일·ADR)은 **메인 턴에서** 남긴다 — 서브에이전트에는 턴 훅이 없다.

### 정책 훅

orbit이 설치된 저장소(`.claude/orbit-manifest.json`이 있는 저장소)에서는 `general-purpose`와 `fork` 위임을 PreToolUse 훅이 거부하고 위 모드로 유도한다. 다른 프로젝트의 위임에는 끼어들지 않는다. 기능을 끄려면 환경변수 `ORBIT_AGENT_POLICY=off`.

## 요구사항

- **git** — 하네스는 Git 저장소에 설치된다.
- **Node.js 18 이상** — 설치기와 훅이 Node.js로 돈다. Claude 데스크톱 앱·IDE처럼 셸 설정을 읽지 않는 환경에서도 `node`가 PATH에 잡혀야 훅이 동작한다.
- **Claude Code v2.1.271+** — 서브에이전트의 `omitClaudeMd`(클린 모드)와 플러그인 네임스페이스에 필요. 이하 버전에서는 일부 설정이 조용히 무시된다.
- Codex 병행을 고르면 Codex CLI가 따로 필요하다.

`/orbit:setup`은 git이나 Node.js가 없으면 먼저 설치를 안내하고, 설치를 거부하면 orbit 설치를 취소한다.

## 저장소 구성

```
orbit/
├── skills/setup/      설치기 (plan/apply/update + 회귀 테스트)
├── skills/update/     무질문 갱신 companion
├── commands/          위임 모드 8종
├── agents/            위임 모드별 에이전트 정의 8종
└── hooks/             PreToolUse 에이전트 정책
```

## 라이선스

[MIT](LICENSE). 리뷰어 에이전트 5종과 `/aside`·`/checkpoint` 명령은 [ECC](https://github.com/affaan-m/ECC)(MIT)에서 가져왔다 — [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
