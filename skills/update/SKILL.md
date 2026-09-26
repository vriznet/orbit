---
name: update
description: 이미 orbit:setup으로 설치된 저장소를 질문 없이·직접 수정한 파일은 보존한 채 최신 하네스로 조용히 갱신한다. "orbit 업데이트", "하네스 최신화", "orbit update" 요청에 사용한다. 처음 설치·온보딩은 orbit:setup을 쓴다.
---

# Orbit update

이미 설치된 하네스를 **질문 없이** 최신으로 갱신하는 얇은 스킬이다. 실제 갱신 로직은
orbit:setup의 `install.mjs update`에 있고, 이 스킬은 그것을 호출해 결과만 보고한다(companion).

## 전제

- 대상 저장소에 `.claude/orbit-manifest.json`이 있어야 한다(orbit:setup으로 먼저 설치).
  없으면 "먼저 orbit:setup으로 설치하세요"라고 안내하고 멈춘다.
- 설치기가 있는 orbit:setup 스킬이 같은 플러그인의 형제 디렉터리(`../orbit:setup`)에 있어야 한다.
- git과 Node.js 18 이상(npm 포함)이 있어야 한다. 코드 도구를 처음 받을 때는 네트워크가 필요하다. 없으면 orbit:setup의 "필수 도구 확인" 절대로 설치를
  안내하고, 사용자가 설치를 거부하면 갱신하지 않고 멈춘다.

## 절차

1. 현재 디렉터리가 대상 Git 저장소 루트인지 확인한다.
2. 다음을 실행한다. **아무것도 묻지 않는다** — 슬러그·표시 이름·모듈은 매니페스트가 안다.

   ```bash
   node "${CLAUDE_SKILL_DIR}/../setup/scripts/install.mjs" update --repo "$PWD"
   ```

3. 출력 JSON(summary)을 읽어 사용자에게 쉬운 말로 보고한다.
   - `files.update`·`files.create`: 갱신·생성된 파일 수.
   - `files.conflict`: **사용자가 직접 수정해 보존된 파일**이다(어느 파일인지 `conflicts`
     목록으로 알려준다). 이건 실패가 아니라 **의도된 보존**이다.
   - `merges.settingsJson` 등이 `update`면 훅·설정이 바뀌었다고 알린다.
   - `retired.removed`: 더 설치하지 않는 옛 산출물(예: 0.2.4에서 플러그인으로 옮긴 스킬 사본, 뺀 `/aside`·`/checkpoint`)을 설치 그대로라 지운 목록이다. `retired.kept`는 사용자가 고쳐 남긴 사본이다 — 지우지 않았다는 것과, 플러그인 스킬(`/<플러그인>:recall` 등)이 대신한다는 것을 알린다.
   - `codeTools.status`가 `failed`면 조용히 넘기지 않는다: 코드 개요·펼치기가 동작하지 않는다는 것, 원인(`codeTools.error`), 다시 받는 명령(`node "${CLAUDE_SKILL_DIR}/../setup/scripts/install.mjs" code-tools`)을 알린다. 나머지 갱신은 정상이다.
4. 훅·설정이 바뀌었으면 "새 세션(재시작)부터 적용된다"고 덧붙인다.

## 원칙

- 질문하지 않는다.
- 사용자가 직접 수정한 파일(conflict)은 절대 덮지 않는다.
- 설치·온보딩은 이 스킬의 일이 아니다 — 그건 orbit:setup이다.
- 이 스킬 자신의 배포(플러그인 릴리스)는 이 흐름의 범위가 아니다.
