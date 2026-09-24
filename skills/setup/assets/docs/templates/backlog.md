# backlog 항목 양식

> `backlog.md`는 "언제(트리거) 무엇을" 형식의 조건부·미착수 작업 원장이다.
> 조건부 작업은 tasks에도 Waiting으로 등록하고(`scripts/tasks.mjs add ... --wait "<트리거>"`)
> 그 task ID를 여기 함께 적어 연결한다.

## 항목 양식

```markdown
## 트리거: <이 조건이 되면> (예: 첫 사용자 10명 도달 시)

- <할 일 한 줄> — 왜 지금이 아닌지 한 구절, 짝 task: `T-슬러그-YYMMDD-HHMMSS`
```

- 트리거는 **관찰 가능한 조건**으로 쓴다("나중에"·"여유 되면" 금지).
- 항목을 닫을 때 짝 tasks 항목도 정리한다: 결과를 얻었으면 `done`, 트리거가 사라졌으면 `drop --reason`.
