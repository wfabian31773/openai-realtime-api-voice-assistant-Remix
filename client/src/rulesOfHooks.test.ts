/**
 * The rules of hooks, checked over every component in the client.
 *
 * WHY: on 2026-11-26 the On-Call page's Schedule tab took the whole app down
 * ("Oops! Something went wrong") the moment its data arrived. ScheduleTab
 * returned early while loading and called three more hooks below that return,
 * so the loading render called 16 hooks and the next one 19, and React threw.
 * Nothing in the repo could see it: there is no ESLint here, so the
 * react-hooks plugin that normally catches this was never run.
 *
 * This is the narrow half of that plugin that bit us: inside a component (a
 * function whose name starts with a capital letter), once a top-level
 * statement can return, no later top-level statement may call a hook. A hook
 * is `useX(...)` or `React.useX(...)`. Calls inside nested functions (event
 * handlers, callbacks passed to hooks) are not counted, because they do not
 * run during render.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

const CLIENT_SRC = path.resolve(__dirname);

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) out.push(full);
  }
  return out;
}

function isHookName(name: string): boolean {
  return /^use[A-Z0-9]/.test(name);
}

function isHookCall(node: ts.CallExpression): boolean {
  const e = node.expression;
  if (ts.isIdentifier(e)) return isHookName(e.text);
  if (ts.isPropertyAccessExpression(e)) return isHookName(e.name.text);
  return false;
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isClassDeclaration(node)
  );
}

/** Hook calls in a statement, not counting calls inside nested functions. */
function hookCallsIn(stmt: ts.Node): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (n: ts.Node) => {
    if (n !== stmt && isFunctionLike(n)) return;
    if (ts.isCallExpression(n) && isHookCall(n)) found.push(n);
    ts.forEachChild(n, visit);
  };
  visit(stmt);
  return found;
}

/** Whether a statement can return from the component (not from a nested function). */
function canReturn(stmt: ts.Node): boolean {
  let yes = false;
  const visit = (n: ts.Node) => {
    if (yes) return;
    if (n !== stmt && isFunctionLike(n)) return;
    if (ts.isReturnStatement(n)) {
      yes = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(stmt);
  return yes;
}

interface Violation {
  file: string;
  component: string;
  line: number;
  hook: string;
}

function componentBodies(sf: ts.SourceFile): Array<{ name: string; body: ts.Block }> {
  const out: Array<{ name: string; body: ts.Block }> = [];
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name && /^[A-Z]/.test(n.name.text) && n.body) {
      out.push({ name: n.name.text, body: n.body });
    } else if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      /^[A-Z]/.test(n.name.text) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) &&
      ts.isBlock(n.initializer.body)
    ) {
      out.push({ name: n.name.text, body: n.initializer.body });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export function hookViolations(file: string, text: string): Violation[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Violation[] = [];
  for (const { name, body } of componentBodies(sf)) {
    let returned = false;
    for (const stmt of body.statements) {
      if (returned) {
        for (const call of hookCallsIn(stmt)) {
          out.push({
            file: path.relative(CLIENT_SRC, file),
            component: name,
            line: sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1,
            hook: call.expression.getText(sf),
          });
        }
      }
      if (canReturn(stmt)) returned = true;
    }
  }
  return out;
}

describe('the rules of hooks', () => {
  it('no component calls a hook after a statement that can return', () => {
    const violations = tsxFiles(CLIENT_SRC).flatMap((f) => hookViolations(f, fs.readFileSync(f, 'utf8')));
    expect(violations.map((v) => `${v.file}:${v.line} ${v.component} calls ${v.hook} after an early return`)).toEqual([]);
  });

  it('catches the ScheduleTab shape that crashed the On-Call page', () => {
    const src = `
      export function ScheduleTab() {
        const q = useOnCall('/schedule')
        const [a, setA] = React.useState(0)
        if (q.isLoading) return null
        const handler = () => { const x = useNotAHookHere() }
        const [saving, setSaving] = React.useState(false)
        const ref = React.useRef(a)
        return null
      }`;
    expect(hookViolations('ScheduleTab.tsx', src).map((v) => v.hook)).toEqual(['React.useState', 'React.useRef']);
  });

  it('allows hooks before the return, and hook-like calls inside handlers after it', () => {
    const src = `
      const Ok = () => {
        const [a] = useState(0)
        const m = React.useMemo(() => a, [a])
        if (!m) return null
        const onClick = () => useSomething()
        return <button onClick={onClick} />
      }`;
    expect(hookViolations('Ok.tsx', src)).toEqual([]);
  });
});
