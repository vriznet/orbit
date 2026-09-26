# 제3자 고지

orbit에는 다른 오픈소스 프로젝트에서 가져온 파일이 들어 있다. 각 파일은 원래 라이선스를 따른다.

## ECC (affaan-m/ECC)

- 출처: https://github.com/affaan-m/ECC
- 라이선스: MIT
- 가져온 파일(설치 시 대상 저장소의 `.claude/`로 복사된다):
  - `skills/setup/assets/claude/agents/database-reviewer.md`
  - `skills/setup/assets/claude/agents/react-reviewer.md`
  - `skills/setup/assets/claude/agents/security-reviewer.md`
  - `skills/setup/assets/claude/agents/silent-failure-hunter.md`
  - `skills/setup/assets/claude/agents/typescript-reviewer.md`
  - `skills/setup/assets/claude/commands/aside.md`
  - `skills/setup/assets/claude/commands/checkpoint.md`

`database-reviewer.md`는 원본에 적힌 대로 Supabase Agent Skills(MIT)의 패턴을 바탕으로 한다.

```
MIT License

Copyright (c) 2026 Affaan Mustafa

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## tree-sitter WASM (설치 때 내려받음, 저장소에는 없음)

`/orbit:setup`·`/orbit:update`가 코드 개요·펼치기(`scripts/code.mjs`)를 위해 아래 npm 패키지를 판을 고정해 받고, 필요한 파일만 `~/.cache/orbit/code-tools/<판>/`에 둔다. 각 패키지의 라이선스 파일은 같은 폴더의 `licenses/`에 함께 보관한다.

- `@vscode/tree-sitter-wasm@0.3.1` — MIT, Copyright (c) Microsoft Corporation. https://github.com/microsoft/vscode-tree-sitter-wasm
  - 포함: tree-sitter 런타임(https://github.com/tree-sitter/tree-sitter, MIT — 패키지의 cgmanifest.json에 기록)과 미리 빌드한 문법 16종(TypeScript·TSX·JavaScript·Python·Go·Rust·Java·Bash·C#·C++·CSS·PHP·Ruby·PowerShell·INI·Regex). 문법별 원 라이선스는 각 tree-sitter 문법 저장소를 따른다.
- `tree-sitter-json@0.24.8` — MIT, Copyright (c) 2014 Max Brunsfeld. https://github.com/tree-sitter/tree-sitter-json

orbit의 `code.mjs`는 이 런타임을 불러 쓰는 코드를 직접 작성했으며, 다른 프로젝트의 코드를 옮겨 오지 않았다.
