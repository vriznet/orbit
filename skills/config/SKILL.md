---
name: config
description: 이미 orbit이 설치된 저장소의 orbit 설정을 보고 바꾼다(선택 모듈 켜기, 조절 스위치). "orbit 설정", "orbit config", "발견 칸 알림 기준 바꿔", "정책 훅 켜/꺼" 같은 요청에 사용한다. 처음 설치는 orbit:setup, 최신으로 갱신은 orbit:update를 쓴다.
argument-hint: "[바꿀 것 — 비우면 지금 설정을 보여 준다]"
---

# Orbit config

바꿀 것: $ARGUMENTS

설치할 때 정한 것과 조절 스위치를 나중에 다시 보고 바꾸는 스킬이다. 실제 일은 orbit:setup의 `config.mjs`가 한다.

## 전제

- 대상 저장소에 `.claude/orbit-manifest.json`이 있어야 한다. 없으면 "먼저 orbit:setup으로 설치하세요"라고 알리고 멈춘다.
- 현재 디렉터리가 대상 Git 저장소 루트인지 확인한다.

## 절차

1. 지금 설정을 본다.

   ```bash
   node "${CLAUDE_SKILL_DIR}/../setup/scripts/config.mjs" show --repo "$PWD"
   ```

2. 인자가 비었으면 출력을 쉬운 말로 정리해 보여 주고, 무엇을 바꿀지 묻는다. 인자가 있으면 그 요청을 아래 이름과 값으로 옮긴다. 어느 설정인지 분명하지 않으면 묻는다.
3. 바꾼다. 한 번에 하나씩 부른다.

   ```bash
   node "${CLAUDE_SKILL_DIR}/../setup/scripts/config.mjs" set --repo "$PWD" <이름> <값>
   node "${CLAUDE_SKILL_DIR}/../setup/scripts/config.mjs" unset --repo "$PWD" <이름>   # 기본값으로
   ```

4. 명령이 돌려준 말을 그대로 전하고, `show`를 다시 돌려 바뀐 값을 확인해 알려 준다.

## 바꿀 수 있는 것

| 이름 | 값 | 무엇 |
|---|---|---|
| `codex` | `on` | Codex와 턴제 협업 모듈. 켜기만 된다 |
| `reviewers` | `on` | 리뷰어 에이전트 5종. 켜기만 된다 |
| `compact-worklog` | `on`·`off` | 컴팩션 직후 worklog 최근 기록을 다시 넣을지(기본 on) |
| `found-min-tools` | 0 이상의 수 | 도구를 이만큼 쓴 턴에 '발견' 칸이 비면 알림(기본 10, 0이면 끔) |
| `read-outline-min-lines` | 0 이상의 수 | 큰 코드 파일 개요 안내 기준 줄 수(기본 300, 0이면 끔) |
| `agent-policy` | `on`·`off` | general-purpose·fork 위임을 막을지(기본 off) |

- 조절 스위치는 저장소의 `.claude/settings.local.json` `env`에 적힌다. 개인용 파일이라 커밋되지 않고 orbit update가 건드리지 않는다.
- 모듈을 켜면 설치기가 저장소 파일을 바꾼다. 바뀐 파일을 알려 주고, 커밋은 사용자가 요청할 때만 한다.
- 모듈 끄기는 지원하지 않는다. 명령이 그렇게 답하면 그대로 전한다.

## 원칙

- 표에 없는 것은 바꾸지 않는다. 명령이 "모르는 설정"이라고 답하면 그대로 전하고, 바꿀 수 있는 이름을 알려 준다.
- 슬러그·문서 폴더 이름·표시 이름은 설치 뒤에 바꾸지 않는다(파일 이름과 원장이 그 값에 묶여 있다).
- 설정 파일을 손으로 고치지 않고 명령으로만 바꾼다.
