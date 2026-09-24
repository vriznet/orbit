#!/usr/bin/env bash
# Codex를 켤 때 작업 일지 따라잡기를 시작 프롬프트에 담아 한 번에 넘긴다.
# 원리: $(...) 명령 치환으로 catchup 출력을 codex의 [PROMPT] 인자 안에 끼워 넣는다.
# 사용: npm run codex-catchup   (또는 bash scripts/codex-catchup.sh)

set -uo pipefail
cd "$(dirname "$0")/.."

WORKLOG_MD="{{DOCS_DIR}}/worklog.md"

# 밀린 일지를 먼저 뽑는다 (책갈피는 이때 최신으로 전진 — 정상 동작)
# worklog.mjs가 실패해도(손상 파일 등) Codex 실행 자체는 막지 않는다 — 따라잡기는 편의 기능이다.
if ! CATCHUP="$(node scripts/worklog.mjs catchup codex 2>&1)"; then
  echo "따라잡기 실패: ${CATCHUP}" >&2
  # 폴백: worklog.mjs 자체가 실패해도 원문(worklog.md) 마지막 80줄은 읽기 전용으로 볼 수 있다.
  # 책갈피는 건드리지 않는다(읽기만 하므로).
  if TAIL="$(tail -n 80 "${WORKLOG_MD}" 2>/dev/null)" && [ -n "${TAIL}" ]; then
    echo "따라잡기 실패 — 원문 꼬리로 대체합니다." >&2
    CATCHUP="(따라잡기 실패 — ${WORKLOG_MD} 마지막 80줄로 대체. 책갈피는 갱신되지 않았습니다.)

${TAIL}"
  else
    echo "폴백 읽기도 실패했습니다(무시하고 Codex를 그냥 시작합니다)." >&2
    CATCHUP=""
  fi
fi

if [ -z "${CATCHUP}" ]; then
  # 밀린 게 없으면 그냥 Codex만 켠다
  echo "따라잡을 새 일지가 없습니다. Codex를 그냥 시작합니다."
  exec codex
fi

# 따라잡기 내용을 시작 프롬프트로 담아 Codex 실행
exec codex "아래는 Claude와 진행된 작업 일지(따라잡기)다. 읽고 맥락을 파악해줘. 그다음 내가 이어서 물어볼게.

${CATCHUP}"
