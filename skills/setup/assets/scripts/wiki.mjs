#!/usr/bin/env node
// {{PROJECT_NAME}} 위키 CRUD. 스크립트는 구조(파일·프런트매터·인덱스·링크 무결성)를 관리하고,
// 노트 본문은 어시스턴트가 채운다. 링크 구문·해석은 wiki-lib.mjs(= wiki-links.mjs와 공용)와
// 완전히 같다 — 여기서 새로 정의하지 않는다.
//
// 사용:
//   node scripts/wiki.mjs new "<제목>" [--type concept|system|experiment|reference|guide] \
//        [--summary "..."] [--aliases "a,b"]
//   node scripts/wiki.mjs list
//   node scripts/wiki.mjs show <이름>
//   node scripts/wiki.mjs set <이름> [--status ...] [--summary ...] [--type ...] [--aliases ...]
//   node scripts/wiki.mjs rename <이전> <이후> [--title "새 제목"]
//   node scripts/wiki.mjs rm <이름> [--force]

import fs from 'node:fs';
import path from 'node:path';
import {
  DOCS, REQUIRED, TYPES, STATUSES,
  listMarkdown, relativeFile, noteId, isTemplate, isKnowledgeNote,
  parseFrontmatter, firstHeading, loadNote, key, buildCatalog,
  resolveTarget, maskMarkdown, extractLinks,
} from './wiki-lib.mjs';

const WIKI_DIR = path.join(DOCS, 'wiki');
const INDEX_FILE = path.join(WIKI_DIR, '_index.md');
const TEMPLATE_FILE = path.join(DOCS, 'templates', 'wiki.md');
const INDEX_START = '<!-- wiki:auto start -->';
const INDEX_END = '<!-- wiki:auto end -->';
// 필명·YAML 값에 이 글자들이 들어가면 안 된다 — _schema.md "파일 이름" 규칙(# | ^ : %% [[ ]]
// 금지)에 슬래시·백슬래시(경로 구분자)도 함께 막아 안전하게 잡는다.
const FORBIDDEN_BASE_RE = /[#|^:%[\]\\/]/;

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// P04와 같은 원자적 쓰기(임시파일+rename). 위키는 훅이 매 턴 쓰는 hot-path가 아니라
// tasks.mjs 같은 잠금은 생략한다(KISS) — 계획서 결정.
function atomicWriteFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
}

// --flag value 형태의 인자 파서. booleans에 든 키만 값 없이 true로 받는다(예: --force).
function parseFlags(argv, booleans = new Set()) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const name = argv[i].slice(2);
    if (booleans.has(name)) { out[name] = true; continue; }
    out[name] = argv[i + 1];
    i++;
  }
  return out;
}

function parseAliases(raw) {
  if (!raw) return [];
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
}

// 우리 프런트매터 파서(wiki-lib.mjs)는 이스케이프를 처리하지 않는 단순 구현이다(KISS).
// 큰따옴표나 줄바꿈이 값에 섞이면 왕복(round-trip)이 깨지므로 아예 막는다.
// |, [[, ]]도 막는다 — title·summary·aliases는 위키 링크 라벨([[id|라벨]])이나 인덱스
// 자동 블록(- [[id|제목]] — 요약)에 그대로 삽입되므로, 이 문자들이 섞이면 렌더가 깨진다
// (재현: rename --title에 "|" 포함 시 인덱스 링크 라벨이 깨짐, summary에 "[[...]]" 포함 시
// 존재하지 않는 대상으로 wiki:check가 바로 실패함).
function assertSafeScalar(value, fieldName) {
  if (typeof value !== 'string') return;
  if (value.includes('"') || value.includes('\n')) {
    die(`${fieldName}에는 큰따옴표(")나 줄바꿈을 쓸 수 없습니다: ${value}`);
  }
  if (value.includes('|') || value.includes('[[') || value.includes(']]')) {
    die(`${fieldName}에는 |, [[, ]]를 쓸 수 없습니다(위키 링크·라벨 구문과 충돌): ${value}`);
  }
}

function slugify(title) {
  return title.trim().replace(/\s+/g, '-');
}

function assertValidBase(base) {
  if (!base || !base.trim()) die('빈 이름은 사용할 수 없습니다.');
  if (FORBIDDEN_BASE_RE.test(base)) {
    die(`파일 이름에 사용할 수 없는 문자가 있습니다(# | ^ : %% [[ ]] 및 경로 구분자 금지): ${base}`);
  }
}

// YAML 목록 필드 직렬화 — 항목이 없으면 " []"(_schema.md 예시와 같은 콜론+공백 형식),
// 있으면 들여쓴 "- \"항목\"" 줄들. wiki-lib.mjs의 parseFrontmatter가 이 두 형태를 모두
// 되읽을 수 있다(왕복 보장) — 앞의 공백 유무는 파서가 raw.trim()으로 흡수한다.
function yamlList(items) {
  if (!items || !items.length) return ' []';
  return '\n' + items.map((item) => `  - "${item}"`).join('\n');
}

// REQUIRED(스키마 필드 순서)를 그대로 써서 _schema.md 예시와 같은 순서로 낸다.
function serializeFrontmatter(data) {
  const lines = ['---'];
  for (const field of REQUIRED) {
    const value = data[field];
    if (Array.isArray(value)) lines.push(`${field}:${yamlList(value)}`);
    else if (field === 'title' || field === 'summary') lines.push(`${field}: "${value ?? ''}"`);
    else lines.push(`${field}: ${value ?? ''}`);
  }
  lines.push('---');
  return lines.join('\n');
}

function bodyAfterFrontmatter(note) {
  return note.content.split('\n').slice(note.frontmatter.endLine).join('\n');
}

// 프런트매터가 없거나(파싱 실패) 필수 항목·목록 타입이 깨진 노트는 조용히 넘기지 않고
// 바로 오류로 알린다(계획서 요구사항: "손상·부재 프런트매터는 오류로 알린다").
function requireValidFrontmatter(note) {
  const data = note.frontmatter.data;
  if (!data) die(`프런트매터가 없거나 손상됐습니다: ${relativeFile(note.file)}`);
  for (const field of REQUIRED) {
    if (!(field in data)) die(`필수 속성 ${field}이(가) 없습니다: ${relativeFile(note.file)}`);
  }
  for (const field of ['aliases', 'sources', 'related']) {
    if (!Array.isArray(data[field])) die(`${field}은(는) YAML 목록이어야 합니다: ${relativeFile(note.file)}`);
  }
  return data;
}

// 이름(제목·별칭·base·id) → 지식 노트 하나로 해석한다. wiki-links.mjs와 완전히 같은
// resolveTarget을 쓰되, 지식 노트(wiki/*.md, "_" 제외)로만 범위를 좁힌다.
function resolveNoteByName(name, catalog) {
  const { matches } = resolveTarget(name, catalog);
  const filtered = matches.filter((note) => isKnowledgeNote(note.file));
  if (!filtered.length) die(`노트를 찾을 수 없습니다: ${name}`);
  if (filtered.length > 1) {
    die(`이름이 여러 노트와 일치합니다: ${name}\n${filtered.map((n) => relativeFile(n.file)).join('\n')}`);
  }
  return filtered[0];
}

function loadAllNotes() {
  return listMarkdown(DOCS).map(loadNote);
}

function buildAutoBlockLines(notes) {
  const items = notes.filter((n) => isKnowledgeNote(n.file)).sort((a, b) => a.title.localeCompare(b.title, 'ko'));
  if (!items.length) return ['_노트 없음_'];
  return items.map((n) => {
    const data = n.frontmatter.data || {};
    const summary = data.summary ? ` — ${data.summary}` : '';
    return `- [[${n.id}|${data.title || n.title}]]${summary}`;
  });
}

// _index.md는 사람이 큐레이션하는 진입점이라 통째로 안 건드린다. 마커 사이의 자동
// 카탈로그 블록만 멱등 재생성한다. 마커가 없으면 문서 끝에 한 번 만든다.
function regenerateIndex(notes) {
  if (!fs.existsSync(INDEX_FILE)) return;
  const content = fs.readFileSync(INDEX_FILE, 'utf8');
  const body = buildAutoBlockLines(notes).join('\n');
  const block = `${INDEX_START}\n${body}\n${INDEX_END}`;
  const startIdx = content.indexOf(INDEX_START);
  const endIdx = content.indexOf(INDEX_END);
  let next;
  if (startIdx >= 0 && endIdx > startIdx) {
    next = content.slice(0, startIdx) + block + content.slice(endIdx + INDEX_END.length);
  } else {
    const sep = content.endsWith('\n') ? '' : '\n';
    next = `${content}${sep}\n## 전체 노트 (자동)\n\n${block}\n`;
  }
  if (next !== content) atomicWriteFile(INDEX_FILE, next);
}

// macOS(APFS 기본값) 등 대소문자를 구분하지 않는 파일시스템에서는 fs.existsSync가
// "MyNote.md"와 "mynote.md"를 같은 파일로 본다. 디렉터리 목록은 저장된 실제 이름을
// 그대로 돌려주므로, 정확한 대소문자 일치만 "이미 있음"으로 판정한다(W4 — 대소문자만
// 바꾸는 rename이 자기 자신과 충돌한다고 오판하던 문제).
function findExactCaseFile(dir, basename) {
  try {
    return fs.readdirSync(dir).includes(basename);
  } catch {
    return false;
  }
}

// [[대상]] / [[대상|라벨]] 하나를 { base(경로부분), fragment(#·^ 뒷부분), label } 로 나눈다.
function splitLinkRaw(raw) {
  const pipeIdx = raw.indexOf('|');
  const linkPart = pipeIdx >= 0 ? raw.slice(0, pipeIdx) : raw;
  const label = pipeIdx >= 0 ? raw.slice(pipeIdx + 1) : null;
  const hashIdx = linkPart.indexOf('#');
  const caretIdx = linkPart.indexOf('^');
  const cutCandidates = [hashIdx, caretIdx].filter((i) => i >= 0);
  const cut = cutCandidates.length ? Math.min(...cutCandidates) : -1;
  const base = cut >= 0 ? linkPart.slice(0, cut) : linkPart;
  const fragment = cut >= 0 ? linkPart.slice(cut) : '';
  return { base, fragment, label };
}

// oldNote로 정확히 resolve되는 [[링크]]만 newId로 재작성한다(표시 라벨 보존). 코드블록·
// HTML 주석 안은 wiki-lib.mjs의 maskMarkdown으로 걸러 손대지 않는다(원본 문자열은 그대로
// 살리고, 마스킹된 텍스트에서 위치만 찾아 판정한다 — 길이가 같아 인덱스가 그대로 맞는다).
function rewriteLinks(content, catalog, oldNote, newId) {
  const masked = maskMarkdown(content);
  const re = /!?\[\[([^\]\n]+)\]\]/g;
  let result = '';
  let cursor = 0;
  let count = 0;
  let match;
  while ((match = re.exec(masked))) {
    result += content.slice(cursor, match.index);
    const resolved = resolveTarget(match[1], catalog);
    if (resolved.matches.length === 1 && resolved.matches[0] === oldNote) {
      const { fragment, label } = splitLinkRaw(match[1]);
      const prefix = match[0].startsWith('!') ? '!' : '';
      const labelPart = label !== null ? `|${label}` : '';
      result += `${prefix}[[${newId}${fragment}${labelPart}]]`;
      count++;
    } else {
      result += content.slice(match.index, match.index + match[0].length);
    }
    cursor = match.index + match[0].length;
  }
  result += content.slice(cursor);
  return { content: result, count };
}

// note로 정확히 resolve되는 인바운드 링크 목록 — rm의 보호 검사와 --force 뒤 보고에 쓴다.
function findInboundLinks(note, notes, catalog) {
  const out = [];
  for (const other of notes) {
    if (other === note || isTemplate(other.file)) continue;
    const { links } = extractLinks(other, catalog);
    for (const link of links) {
      if (link.matches.length === 1 && link.matches[0] === note) {
        out.push({ file: other.file, line: link.line, raw: link.raw });
      }
    }
  }
  return out;
}

function cmdNew(rest) {
  const title = rest[0];
  const f = parseFlags(rest.slice(1));
  if (!title || !title.trim()) die('필수: wiki new "<제목>"');
  const type = f.type || 'concept';
  if (!TYPES.has(type)) die(`--type 값이 올바르지 않습니다: "${type}" (허용: ${[...TYPES].join(', ')})`);
  const summary = f.summary && f.summary.trim() ? f.summary : title;
  const aliases = parseAliases(f.aliases);
  assertSafeScalar(title, 'title');
  assertSafeScalar(summary, 'summary');
  for (const alias of aliases) assertSafeScalar(alias, 'aliases');

  if (!fs.existsSync(TEMPLATE_FILE)) die(`템플릿을 찾을 수 없습니다: ${relativeFile(TEMPLATE_FILE)}`);

  const notes = loadAllNotes();
  const catalog = buildCatalog(notes);
  const slug = slugify(title);
  assertValidBase(slug);
  const clash = catalog.names.get(key(slug)) || [];
  if (clash.length) {
    die(`이름 또는 별칭이 겹칩니다: "${slug}" → ${clash.map((n) => relativeFile(n.file)).join(', ')}`);
  }

  const file = path.join(WIKI_DIR, `${slug}.md`);
  if (fs.existsSync(file)) die(`이미 존재합니다: ${relativeFile(file)}`);

  const templateContent = fs.readFileSync(TEMPLATE_FILE, 'utf8');
  const { endLine } = parseFrontmatter(templateContent);
  const templateBody = templateContent.split('\n').slice(endLine).join('\n').replaceAll('{{title}}', title);
  const today = todayStr();
  const data = { title, aliases, type, status: 'draft', summary, created: today, updated: today, sources: [], related: [] };
  const newContent = `${serializeFrontmatter(data)}\n${templateBody}`;
  atomicWriteFile(file, newContent);
  regenerateIndex(loadAllNotes());
  console.log(`생성됨 ${relativeFile(file)}`);
}

function cmdList() {
  const notes = loadAllNotes().filter((n) => isKnowledgeNote(n.file));
  notes.sort((a, b) => a.title.localeCompare(b.title, 'ko'));
  if (!notes.length) { console.log('노트 없음.'); return; }
  console.log('id\t제목\t유형\t상태\t요약');
  for (const note of notes) {
    const data = note.frontmatter.data || {};
    console.log(`${note.id}\t${data.title || note.title}\t${data.type || '-'}\t${data.status || '-'}\t${data.summary || ''}`);
  }
}

function cmdShow(rest) {
  const name = rest[0];
  if (!name) die('필수: wiki show <이름>');
  const notes = loadAllNotes();
  const catalog = buildCatalog(notes);
  const note = resolveNoteByName(name, catalog);
  process.stdout.write(note.content.endsWith('\n') ? note.content : `${note.content}\n`);
}

function cmdSet(rest) {
  const name = rest[0];
  const f = parseFlags(rest.slice(1));
  if (!name) die('필수: wiki set <이름>');
  if (f.status !== undefined && !STATUSES.has(f.status)) {
    die(`--status 값이 올바르지 않습니다: "${f.status}" (허용: ${[...STATUSES].join(', ')})`);
  }
  if (f.type !== undefined && !TYPES.has(f.type)) {
    die(`--type 값이 올바르지 않습니다: "${f.type}" (허용: ${[...TYPES].join(', ')})`);
  }

  const notes = loadAllNotes();
  const catalog = buildCatalog(notes);
  const note = resolveNoteByName(name, catalog);
  const data = requireValidFrontmatter(note);

  const nextData = { ...data };
  if (f.status !== undefined) nextData.status = f.status;
  if (f.type !== undefined) nextData.type = f.type;
  if (f.summary !== undefined) { assertSafeScalar(f.summary, 'summary'); nextData.summary = f.summary; }
  // W1: new는 별칭마다 assertSafeScalar를 타는데 set은 안 탔다 — 비정상 YAML이 그대로
  // 적히던 것(재현: --aliases '나쁜"별칭'). new와 같은 검증을 거치게 맞춘다.
  if (f.aliases !== undefined) {
    const aliases = parseAliases(f.aliases);
    for (const alias of aliases) assertSafeScalar(alias, 'aliases');
    nextData.aliases = aliases;
  }
  nextData.updated = todayStr();

  const newContent = `${serializeFrontmatter(nextData)}\n${bodyAfterFrontmatter(note)}`;
  atomicWriteFile(note.file, newContent);
  console.log(`수정됨 ${relativeFile(note.file)}`);
}

function cmdRename(rest) {
  const oldName = rest[0];
  const newRaw = rest[1];
  const f = parseFlags(rest.slice(2));
  if (!oldName || !newRaw) die('필수: wiki rename <이전> <이후>');
  // new와 같은 규칙으로 슬러그화한다 — 명령마다 파일명 규칙이 달라지지 않게(공백→하이픈).
  const newBase = slugify(newRaw);
  assertValidBase(newBase);

  const notes = loadAllNotes();
  const catalog = buildCatalog(notes);
  const oldNote = resolveNoteByName(oldName, catalog);
  const newFile = path.join(path.dirname(oldNote.file), `${newBase}.md`);
  const renaming = newFile !== oldNote.file;

  if (renaming) {
    if (findExactCaseFile(path.dirname(newFile), path.basename(newFile))) {
      die(`이미 존재합니다: ${relativeFile(newFile)}`);
    }
    const clash = (catalog.names.get(key(newBase)) || []).filter((n) => n !== oldNote);
    if (clash.length) die(`이름이 겹칩니다: "${newBase}" → ${clash.map((n) => relativeFile(n.file)).join(', ')}`);
  }

  const newId = noteId(newFile);
  const oldData = requireValidFrontmatter(oldNote);

  // 1) 다른 문서에서 이 노트로 정확히 이어지는 링크를 새 id로 재작성한다(표시 라벨 보존).
  const writes = [];
  for (const other of notes) {
    if (other === oldNote || isTemplate(other.file)) continue;
    const { content, count } = rewriteLinks(other.content, catalog, oldNote, newId);
    if (count) writes.push({ file: other.file, content, count });
  }

  // 2) 노트 자신의 프런트매터·(옵션) 제목·updated 갱신.
  const nextData = { ...oldData, updated: todayStr() };
  let body = bodyAfterFrontmatter(oldNote);
  if (f.title) {
    assertSafeScalar(f.title, 'title');
    nextData.title = f.title;
    const heading = firstHeading(oldNote.content);
    if (heading) body = body.replace(`# ${heading}`, `# ${f.title}`);
  }
  const newContent = `${serializeFrontmatter(nextData)}\n${body}`;

  // 대소문자만 바꾸는 rename은 macOS(APFS, 대소문자 무시·보존)에서 rename(tmp, "mynote.md")을
  // 해도 커널이 기존 "MyNote.md"와 같은 항목으로 보고 실제 이름은 안 바꾼 채 내용만 덮어쓴다
  // (실측 확인). 완전히 다른 임시 이름을 한 번 거치면(우회 rename) 확실히 이름이 바뀐다 —
  // 대소문자를 구분하는 파일시스템에서도 이 우회는 안전(그냥 한 단계 더 거칠 뿐).
  if (renaming && key(path.basename(newFile)) === key(path.basename(oldNote.file))) {
    const detour = path.join(path.dirname(oldNote.file), `.wiki-rename-${process.pid}.tmp`);
    fs.renameSync(oldNote.file, detour);
    atomicWriteFile(newFile, newContent);
    fs.rmSync(detour, { force: true });
  } else {
    atomicWriteFile(newFile, newContent);
    if (renaming) {
      // 그 외의 경우도 대소문자 무시 파일시스템에서 newFile과 oldNote.file이 우연히
      // 같은 inode일 수 있다 — 방금 쓴 내용을 "옛 파일"이라며 지우면 사라진다.
      let sameInode = false;
      try {
        sameInode = fs.existsSync(oldNote.file) && fs.statSync(oldNote.file).ino === fs.statSync(newFile).ino;
      } catch {}
      if (!sameInode) fs.rmSync(oldNote.file, { force: true });
    }
  }
  for (const w of writes) atomicWriteFile(w.file, w.content);

  regenerateIndex(loadAllNotes());
  const updatedLinks = writes.reduce((acc, w) => acc + w.count, 0);
  console.log(`이름 변경 ${relativeFile(oldNote.file)} → ${relativeFile(newFile)} (참조 문서 ${writes.length}개·링크 ${updatedLinks}개 갱신)`);
}

function cmdRm(rest) {
  const name = rest[0];
  const f = parseFlags(rest.slice(1), new Set(['force']));
  if (!name) die('필수: wiki rm <이름>');

  const notes = loadAllNotes();
  const catalog = buildCatalog(notes);
  const note = resolveNoteByName(name, catalog);
  const inbound = findInboundLinks(note, notes, catalog);

  if (inbound.length && !f.force) {
    console.error('다른 문서가 이 노트를 링크하고 있어 삭제하지 않았습니다:');
    for (const item of inbound) console.error(`  ${relativeFile(item.file)}:${item.line} [[${item.raw}]]`);
    console.error('삭제하려면 --force를 쓰세요(끊긴 링크가 남습니다).');
    process.exit(1);
  }

  fs.rmSync(note.file, { force: true });
  regenerateIndex(loadAllNotes());
  console.log(`삭제됨 ${relativeFile(note.file)}`);
  if (inbound.length) {
    console.log(`끊긴 링크 ${inbound.length}건:`);
    for (const item of inbound) console.log(`  ${relativeFile(item.file)}:${item.line} [[${item.raw}]]`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);

try {
  if (cmd === 'new') cmdNew(rest);
  else if (cmd === 'list') cmdList();
  else if (cmd === 'show') cmdShow(rest);
  else if (cmd === 'set') cmdSet(rest);
  else if (cmd === 'rename') cmdRename(rest);
  else if (cmd === 'rm') cmdRm(rest);
  else {
    console.log('명령: new "<제목>" | list | show <이름> | set <이름> | rename <이전> <이후> | rm <이름>');
    process.exit(cmd ? 1 : 0);
  }
} catch (error) {
  console.error(`wiki: ${error.message}`);
  process.exit(1);
}
