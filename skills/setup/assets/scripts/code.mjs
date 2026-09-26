#!/usr/bin/env node
// 코드 개요·펼치기 — 큰 파일을 통째로 읽지 않고 필요한 정의만 읽게 돕는다.
//   outline <파일>              함수·클래스·메서드·타입 등 정의 목록을 줄 범위와 함께
//   unfold <파일> <심볼>        그 정의만 줄 번호와 함께(Class.method처럼 점으로 좁힐 수 있다)
// 코드 언어와 JSON은 tree-sitter(WASM, 네이티브 빌드 없음)로 구문을 분석한다. Markdown(제목)과
// YAML(키)은 미리 빌드된 호환 WASM 문법이 없어 줄 단위로 읽는다.
// tree-sitter 런타임·문법은 orbit setup/update가 orbit 전용 폴더에 받아 둔다(사용자 package.json은
// 건드리지 않음). 결정: D-코드개요-tree-sitter.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const CODE_TOOLS_KEY = 'vscode-tree-sitter-wasm-0.3.1+tree-sitter-json-0.24.8';
export function codeToolsDir() {
  return process.env.ORBIT_CODE_TOOLS_DIR || path.join(os.homedir(), '.cache', 'orbit', 'code-tools', CODE_TOOLS_KEY);
}

const GRAMMARS = {
  typescript: ['.ts', '.mts', '.cts'],
  tsx: ['.tsx'],
  javascript: ['.js', '.mjs', '.cjs', '.jsx'],
  python: ['.py', '.pyi'],
  go: ['.go'],
  rust: ['.rs'],
  java: ['.java'],
  bash: ['.sh', '.bash'],
  'c-sharp': ['.cs'],
  cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.h'],
  css: ['.css'],
  php: ['.php'],
  ruby: ['.rb'],
  powershell: ['.ps1'],
  json: ['.json'],
};
const LINE_PARSED = { markdown: ['.md', '.markdown'], yaml: ['.yaml', '.yml'] };

export function languageOf(file) {
  const ext = path.extname(String(file)).toLowerCase();
  for (const [lang, exts] of Object.entries({ ...GRAMMARS, ...LINE_PARSED })) if (exts.includes(ext)) return lang;
  return null;
}

// 정의로 보는 노드 종류. 이름은 대부분 'name' 필드에서 얻는다.
const DEFINITIONS = new Set([
  'function_declaration', 'generator_function_declaration', 'class_declaration', 'abstract_class_declaration',
  'method_definition', 'interface_declaration', 'type_alias_declaration', 'enum_declaration', 'module',
  'internal_module', 'function_definition', 'class_definition', 'decorated_definition', 'method_declaration',
  'type_spec', 'function_item', 'impl_item', 'struct_item', 'enum_item', 'trait_item', 'mod_item', 'macro_definition',
  'constructor_declaration', 'record_declaration', 'annotation_type_declaration', 'class_specifier', 'struct_specifier',
  'namespace_definition', 'namespace_declaration', 'struct_declaration', 'method', 'singleton_method', 'class', 'trait_declaration',
  'rule_set', 'function_statement', 'class_statement',
]);
const ARROW_VALUES = new Set(['arrow_function', 'function_expression', 'function', 'class']);

let runtime = null;
async function loadParser(lang) {
  const dir = codeToolsDir();
  const base = path.join(dir, 'wasm');
  const runtimeFile = path.join(base, 'tree-sitter.js');
  if (!fs.existsSync(runtimeFile)) {
    throw new Error(`orbit 코드 도구(tree-sitter)가 설치되지 않았습니다: ${dir}\n  orbit update(또는 setup)를 다시 실행하면 받아 둡니다.`);
  }
  if (!runtime) {
    const require = createRequire(import.meta.url);
    runtime = require(runtimeFile);
    await runtime.Parser.init({ locateFile: (name) => path.join(base, name) });
  }
  const language = await runtime.Language.load(path.join(base, `tree-sitter-${lang}.wasm`));
  const parser = new runtime.Parser();
  parser.setLanguage(language);
  return parser;
}

function nodeName(node, source) {
  const named = node.childForFieldName?.('name');
  if (named) return named.text;
  if (node.type === 'decorated_definition') {
    const inner = node.childForFieldName?.('definition') || node.namedChildren.find((child) => DEFINITIONS.has(child.type));
    return inner ? nodeName(inner, source) : null;
  }
  if (node.type === 'impl_item') {
    const type = node.childForFieldName?.('type');
    const trait = node.childForFieldName?.('trait');
    return type ? `${trait ? `${trait.text} for ` : ''}${type.text}` : '(이름 없음)';
  }
  if (node.type === 'pair') return node.childForFieldName?.('key')?.text?.replace(/^"|"$/g, '') || null;
  return null;
}

function kindOf(node) {
  return node.type.replace(/_(declaration|definition|item|specifier|statement|spec)$/, '').replace(/_/g, ' ');
}

// 정의 트리를 만든다. const foo = () => … 같은 변수 정의도 함수로 본다. JSON은 두 단계 키까지.
function collect(node, source, lang, depth = 0, out = []) {
  for (const child of node.namedChildren) {
    let entry = null;
    if (lang === 'json') {
      if (child.type === 'pair' && depth < 2) entry = { kind: 'key', name: nodeName(child, source), node: child };
    } else if (child.type === 'decorated_definition') {
      // 데코레이터가 붙은 정의: 범위는 데코레이터부터, 종류·이름·안쪽 정의는 감싼 정의에서.
      const inner = child.childForFieldName?.('definition') || child.namedChildren.find((c) => DEFINITIONS.has(c.type));
      if (inner) entry = { kind: kindOf(inner), name: nodeName(inner, source) || '(이름 없음)', node: child, body: inner };
    } else if (DEFINITIONS.has(child.type)) {
      const name = nodeName(child, source);
      if (name) entry = { kind: kindOf(child), name, node: child };
    } else if (child.type === 'variable_declarator') {
      // const foo = () => … 도 함수로 본다(선언문은 재귀로 여기까지 내려온다).
      const value = child.childForFieldName?.('value');
      if (value && ARROW_VALUES.has(value.type)) {
        entry = { kind: value.type === 'class' ? 'class' : 'function', name: child.childForFieldName('name')?.text || '(이름 없음)', node: child, body: value };
      }
    }
    if (entry) {
      const item = { kind: entry.kind, name: entry.name, start: entry.node.startPosition.row + 1, end: entry.node.endPosition.row + 1, depth, children: [] };
      out.push(item);
      collect(entry.body || child, source, lang, depth + 1, item.children);
    } else {
      collect(child, source, lang, depth, out);
    }
  }
  return out;
}

function markdownOutline(source) {
  const lines = source.split('\n');
  const heads = [];
  let fence = null;
  lines.forEach((line, index) => {
    const marker = line.match(/^\s*(```+|~~~+)/);
    if (marker) { fence = fence && marker[1][0] === fence[0] ? null : (fence || marker[1]); return; }
    if (fence) return;
    const head = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (head) heads.push({ level: head[1].length, name: head[2], start: index + 1 });
  });
  const out = [];
  heads.forEach((head, index) => {
    let end = lines.length;
    for (let next = index + 1; next < heads.length; next += 1) if (heads[next].level <= head.level) { end = heads[next].start - 1; break; }
    out.push({ kind: `h${head.level}`, name: head.name, start: head.start, end, depth: head.level - 1, children: [] });
  });
  return out;
}

function yamlOutline(source) {
  const lines = source.split('\n');
  const keys = [];
  lines.forEach((line, index) => {
    const match = line.match(/^( {0,2})([A-Za-z0-9_."'-][^:#]*?):(\s|$)/);
    if (match && !line.trimStart().startsWith('#') && !line.trimStart().startsWith('- ')) keys.push({ depth: match[1].length ? 1 : 0, name: match[2].trim(), start: index + 1 });
  });
  return keys.map((key, index) => {
    let end = lines.length;
    for (let next = index + 1; next < keys.length; next += 1) if (keys[next].depth <= key.depth) { end = keys[next].start - 1; break; }
    return { kind: 'key', name: key.name, start: key.start, end, depth: key.depth, children: [] };
  });
}

export async function outlineOf(file) {
  const lang = languageOf(file);
  if (!lang) throw new Error(`개요를 지원하지 않는 파일입니다: ${file}`);
  const source = fs.readFileSync(file, 'utf8');
  const lineCount = source.split('\n').length;
  if (lang === 'markdown') return { lang, lineCount, items: markdownOutline(source) };
  if (lang === 'yaml') return { lang, lineCount, items: yamlOutline(source) };
  const parser = await loadParser(lang);
  const tree = parser.parse(source);
  return { lang, lineCount, items: collect(tree.rootNode, source, lang) };
}

export function flatten(items, out = []) {
  for (const item of items) { out.push(item); flatten(item.children, out); }
  return out;
}

export function formatOutline(file, result, { limit = 200 } = {}) {
  const flat = flatten(result.items);
  const shown = flat.slice(0, limit);
  const lines = [`${file} — ${result.lang}, ${result.lineCount}줄, 정의 ${flat.length}개`];
  for (const item of shown) lines.push(`${'  '.repeat(item.depth)}L${item.start}-${item.end}  ${item.kind} ${item.name}`);
  if (flat.length > shown.length) lines.push(`…외 ${flat.length - shown.length}개`);
  return lines.join('\n');
}

// Class.method처럼 점으로 이어진 이름은 바깥 정의 안에서 좁혀 찾는다.
export function findSymbol(items, symbol) {
  const parts = String(symbol).split('.');
  let scope = items;
  let found = null;
  for (const part of parts) {
    found = flatten(scope).find((item) => item.name === part || item.name.endsWith(` ${part}`));
    if (!found) return null;
    scope = found.children;
  }
  return found;
}

async function main(argv) {
  const [command, file, symbol] = argv;
  if (command === 'outline' && file) {
    process.stdout.write(`${formatOutline(file, await outlineOf(file))}\n`);
  } else if (command === 'unfold' && file && symbol) {
    const result = await outlineOf(file);
    const found = findSymbol(result.items, symbol);
    if (!found) throw new Error(`'${symbol}' 정의를 찾지 못했습니다. outline으로 이름을 확인하세요.`);
    const lines = fs.readFileSync(file, 'utf8').split('\n').slice(found.start - 1, found.end);
    const shown = lines.slice(0, 400);
    const width = String(found.end).length;
    process.stdout.write(`${file}:${found.start}-${found.end} ${found.kind} ${found.name}\n${shown.map((line, index) => `${String(found.start + index).padStart(width)}\t${line}`).join('\n')}\n${lines.length > shown.length ? `…(앞 400줄만 — 나머지는 Read offset/limit으로)\n` : ''}`);
  } else {
    process.stderr.write('사용법: code.mjs outline <파일> | code.mjs unfold <파일> <심볼>\n');
    process.exit(1);
  }
}

function realPath(file) {
  try { return fs.realpathSync(file); } catch { return path.resolve(file); }
}
if (process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
