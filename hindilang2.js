/* HindiLang v2 — JavaScript port.
 * Python-style syntax (indentation + colons), Hindi keywords, symbols stay as symbols.
 * Runs entirely client-side.
 */

// ============================================================
// Embedded Python-expression engine (tokenizer + parser + evaluator)
// Implements real Python semantics (slicing, negative indexing,
// // floor division, ** power, list/string methods) instead of
// relying on JS's own eval/new Function, which diverges from Python.
// ============================================================
/* pyeval.js — a real Python-expression tokenizer/parser/evaluator written in JS.
 * This replaces relying on JS's own `eval`/`new Function`, because Python and JS
 * diverge on: slicing (a[1:3]), negative indexing, // floor division, ** power,
 * list/string methods (.append, .upper, etc), and more.
 *
 * Supports a practical subset of Python expressions:
 *   - numbers, strings (single/double quote), true/false/none
 *   - lists: [1, 2, 3]
 *   - indexing: a[0], a[-1]
 *   - slicing: a[1:3], a[:3], a[2:], a[::-1], a[::2]
 *   - arithmetic: + - * / // % **
 *   - comparisons: == != < > <= >=
 *   - logical: && || ! (already normalized from aur/ya/nahi upstream)
 *   - function calls: foo(1, 2)
 *   - method calls: a.append(4), s.upper(), s.split(",")
 *   - attribute-style builtins: len(), str(), int(), float(), range(), etc (as plain calls)
 */

class PyError extends Error {}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

const TOKEN_SPEC = [
  ["NUMBER", /\d+\.\d+|\d+/],
  ["STRING", /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/],
  ["IDENT", /[A-Za-z_][A-Za-z0-9_]*/],
  ["OP", /\*\*|\/\/|==|!=|<=|>=|&&|\|\||[-+*/%<>!()[\]{}.,:]/],
  ["WS", /\s+/],
];

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    let matched = false;
    for (const [type, regex] of TOKEN_SPEC) {
      const re = new RegExp("^(?:" + regex.source + ")");
      const m = re.exec(src.slice(i));
      if (m && m[0].length > 0) {
        if (type !== "WS") {
          tokens.push({ type, value: m[0] });
        }
        i += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      throw new PyError(`Unexpected character '${src[i]}' at position ${i}`);
    }
  }
  tokens.push({ type: "EOF", value: null });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser — produces a small AST
// ---------------------------------------------------------------------------

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() { return this.tokens[this.pos]; }
  next() { return this.tokens[this.pos++]; }

  expect(value) {
    const tok = this.peek();
    if (tok.value !== value) {
      throw new PyError(`Expected '${value}' but got '${tok.value === null ? "EOF" : tok.value}'`);
    }
    return this.next();
  }

  atEnd() { return this.peek().type === "EOF"; }

  parseExpression() {
    const node = this.parseOr();
    if (!this.atEnd()) {
      throw new PyError(`Unexpected token '${this.peek().value}'`);
    }
    return node;
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.peek().value === "||") {
      this.next();
      const right = this.parseAnd();
      left = { type: "LogicalOr", left, right };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseNot();
    while (this.peek().value === "&&") {
      this.next();
      const right = this.parseNot();
      left = { type: "LogicalAnd", left, right };
    }
    return left;
  }

  parseNot() {
    if (this.peek().value === "!") {
      this.next();
      const operand = this.parseNot();
      return { type: "Not", operand };
    }
    return this.parseComparison();
  }

  parseComparison() {
    let left = this.parseArith();
    const compOps = ["==", "!=", "<", ">", "<=", ">="];
    const parts = [left];
    const ops = [];
    while (compOps.includes(this.peek().value)) {
      ops.push(this.next().value);
      parts.push(this.parseArith());
    }
    if (ops.length === 0) return left;
    return { type: "Comparison", parts, ops };
  }

  parseArith() {
    let left = this.parseTerm();
    while (this.peek().value === "+" || this.peek().value === "-") {
      const op = this.next().value;
      const right = this.parseTerm();
      left = { type: "BinOp", op, left, right };
    }
    return left;
  }

  parseTerm() {
    let left = this.parseFactor();
    while (["*", "/", "//", "%"].includes(this.peek().value)) {
      const op = this.next().value;
      const right = this.parseFactor();
      left = { type: "BinOp", op, left, right };
    }
    return left;
  }

  parseFactor() {
    if (this.peek().value === "-" || this.peek().value === "+") {
      const op = this.next().value;
      const operand = this.parseFactor();
      return { type: "UnaryOp", op, operand };
    }
    return this.parsePower();
  }

  parsePower() {
    const base = this.parsePostfix();
    if (this.peek().value === "**") {
      this.next();
      const exponent = this.parseFactor(); // right-associative, allows unary after **
      return { type: "BinOp", op: "**", left: base, right: exponent };
    }
    return base;
  }

  parsePostfix() {
    let node = this.parsePrimary();
    for (;;) {
      const tok = this.peek();
      if (tok.value === "[") {
        node = this.parseSubscript(node);
      } else if (tok.value === "(") {
        node = this.parseCall(node);
      } else if (tok.value === ".") {
        this.next();
        const nameTok = this.next();
        if (nameTok.type !== "IDENT") {
          throw new PyError(`Expected attribute name after '.', got '${nameTok.value}'`);
        }
        node = { type: "Attribute", object: node, name: nameTok.value };
      } else {
        break;
      }
    }
    return node;
  }

  parseSubscript(objectNode) {
    this.expect("[");
    // Could be: index            -> expr
    //           slice            -> expr? ':' expr? (':' expr?)?
    let startExpr = null;
    if (this.peek().value !== ":" && this.peek().value !== "]") {
      startExpr = this.parseOr();
    }
    if (this.peek().value === ":") {
      // it's a slice
      this.next();
      let stopExpr = null;
      if (this.peek().value !== ":" && this.peek().value !== "]") {
        stopExpr = this.parseOr();
      }
      let stepExpr = null;
      if (this.peek().value === ":") {
        this.next();
        if (this.peek().value !== "]") {
          stepExpr = this.parseOr();
        }
      }
      this.expect("]");
      return { type: "Slice", object: objectNode, start: startExpr, stop: stopExpr, step: stepExpr };
    }
    // plain index
    this.expect("]");
    return { type: "Index", object: objectNode, index: startExpr };
  }

  parseCall(calleeNode) {
    this.expect("(");
    const args = [];
    if (this.peek().value !== ")") {
      args.push(this.parseOr());
      while (this.peek().value === ",") {
        this.next();
        args.push(this.parseOr());
      }
    }
    this.expect(")");
    return { type: "Call", callee: calleeNode, args };
  }

  parsePrimary() {
    const tok = this.peek();

    if (tok.type === "NUMBER") {
      this.next();
      return { type: "Literal", value: tok.value.includes(".") ? parseFloat(tok.value) : parseInt(tok.value, 10) };
    }
    if (tok.type === "STRING") {
      this.next();
      const raw = tok.value.slice(1, -1);
      const unescaped = raw.replace(/\\(.)/g, (m, c) => {
        if (c === "n") return "\n";
        if (c === "t") return "\t";
        if (c === '"') return '"';
        if (c === "'") return "'";
        if (c === "\\") return "\\";
        return c;
      });
      return { type: "Literal", value: unescaped };
    }
    if (tok.type === "IDENT") {
      if (tok.value === "true") { this.next(); return { type: "Literal", value: true }; }
      if (tok.value === "false") { this.next(); return { type: "Literal", value: false }; }
      if (tok.value === "null" || tok.value === "none") { this.next(); return { type: "Literal", value: null }; }
      this.next();
      return { type: "Name", name: tok.value };
    }
    if (tok.value === "(") {
      this.next();
      const inner = this.parseOr();
      this.expect(")");
      return inner;
    }
    if (tok.value === "[") {
      this.next();
      const elements = [];
      if (this.peek().value !== "]") {
        elements.push(this.parseOr());
        while (this.peek().value === ",") {
          this.next();
          if (this.peek().value === "]") break; // trailing comma
          elements.push(this.parseOr());
        }
      }
      this.expect("]");
      return { type: "ListLiteral", elements };
    }

    throw new PyError(`Unexpected token '${tok.value === null ? "EOF" : tok.value}'`);
  }
}

// (tokenizer/parser module.exports intentionally omitted here — combined export at end of file)
/* pyeval evaluator — walks the AST from tokenizer_parser.js and computes the result,
 * implementing Python semantics (not JS semantics) for the operators that differ.
 */

class PyRuntimeError extends Error {}

function pyTruthy(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(v);
}

// Python-style equality: in our subset, JS === is fine for number/string/bool,
// but we add array deep-equality since Python lists compare by value.
function pyEquals(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!pyEquals(a[i], b[i])) return false;
    }
    return true;
  }
  return a === b;
}

function pyNormalizeIndex(idx, length) {
  let i = idx;
  if (i < 0) i = length + i;
  return i;
}

function pyIndex(obj, idx, lineCtx) {
  if (typeof idx !== "number" || !Number.isInteger(idx)) {
    throw new PyRuntimeError(`Index ek integer hona chahiye, mila: ${JSON.stringify(idx)}`);
  }
  if (Array.isArray(obj) || typeof obj === "string") {
    const i = pyNormalizeIndex(idx, obj.length);
    if (i < 0 || i >= obj.length) {
      throw new PyRuntimeError(`Index ${idx} range ke bahar hai (length ${obj.length})`);
    }
    return obj[i];
  }
  throw new PyRuntimeError(`Yeh value index nahi ki ja sakti: ${JSON.stringify(obj)}`);
}

function pySlice(obj, startNode, stopNode, stepNode) {
  if (!Array.isArray(obj) && typeof obj !== "string") {
    throw new PyRuntimeError(`Yeh value slice nahi ki ja sakti: ${JSON.stringify(obj)}`);
  }
  const length = obj.length;
  const step = stepNode === null || stepNode === undefined ? 1 : stepNode;
  if (step === 0) throw new PyRuntimeError("Slice step zero nahi ho sakta");

  let start, stop;
  if (step > 0) {
    start = startNode === null || startNode === undefined ? 0 : pyNormalizeIndex(startNode, length);
    stop = stopNode === null || stopNode === undefined ? length : pyNormalizeIndex(stopNode, length);
    start = Math.max(0, Math.min(length, start));
    stop = Math.max(0, Math.min(length, stop));
  } else {
    start = startNode === null || startNode === undefined ? length - 1 : pyNormalizeIndex(startNode, length);
    stop = stopNode === null || stopNode === undefined ? -1 : pyNormalizeIndex(stopNode, length);
    start = Math.max(-1, Math.min(length - 1, start));
    stop = Math.max(-1, Math.min(length - 1, stop));
  }

  const result = [];
  if (step > 0) {
    for (let i = start; i < stop; i += step) result.push(obj[i]);
  } else {
    for (let i = start; i > stop; i += step) result.push(obj[i]);
  }
  return typeof obj === "string" ? result.join("") : result;
}

function pyFloorDiv(a, b) {
  if (b === 0) throw new PyRuntimeError("Zero se divide nahi kar sakte");
  return Math.floor(a / b);
}

function pyMod(a, b) {
  if (b === 0) throw new PyRuntimeError("Zero se divide nahi kar sakte");
  // Python's % follows the sign of the divisor, same as JS for our purposes
  // when both are reasonable numbers; align explicitly to be safe:
  const r = a % b;
  return (r !== 0 && (r < 0) !== (b < 0)) ? r + b : r;
}

function pyAdd(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return a.concat(b);
  if (typeof a === "string" || typeof b === "string") {
    if (typeof a === "string" && typeof b === "string") return a + b;
    throw new PyRuntimeError(`String aur number ko '+' se jod nahi sakte: ${JSON.stringify(a)} + ${JSON.stringify(b)}`);
  }
  return a + b;
}

function pyMul(a, b) {
  if (Array.isArray(a) && typeof b === "number") {
    let result = [];
    for (let i = 0; i < b; i++) result = result.concat(a);
    return result;
  }
  if (typeof a === "string" && typeof b === "number") {
    return a.repeat(Math.max(0, b));
  }
  return a * b;
}

// ---------------------------------------------------------------------------
// Built-in functions and methods (Python-compatible semantics)
// ---------------------------------------------------------------------------

function makeBuiltins(callUserFunction) {
  return {
    range: (...args) => {
      let start = 0, stop, step = 1;
      if (args.length === 1) { stop = args[0]; }
      else if (args.length === 2) { start = args[0]; stop = args[1]; }
      else { start = args[0]; stop = args[1]; step = args[2]; }
      const out = [];
      if (step > 0) for (let v = start; v < stop; v += step) out.push(v);
      else if (step < 0) for (let v = start; v > stop; v += step) out.push(v);
      return out;
    },
    len: (x) => {
      if (Array.isArray(x) || typeof x === "string") return x.length;
      throw new PyRuntimeError(`len() yeh type ke liye kaam nahi karta: ${JSON.stringify(x)}`);
    },
    str: (x) => pyStr(x),
    int: (x) => {
      const n = typeof x === "string" ? parseInt(x, 10) : Math.trunc(x);
      if (isNaN(n)) throw new PyRuntimeError(`int() mein convert nahi kar saka: ${JSON.stringify(x)}`);
      return n;
    },
    float: (x) => {
      const n = typeof x === "string" ? parseFloat(x) : x;
      if (isNaN(n)) throw new PyRuntimeError(`float() mein convert nahi kar saka: ${JSON.stringify(x)}`);
      return n;
    },
    abs: (x) => Math.abs(x),
    round: (x, n) => (n === undefined ? Math.round(x) : Math.round(x * 10 ** n) / 10 ** n),
    min: (...args) => Array.isArray(args[0]) ? Math.min(...args[0]) : Math.min(...args),
    max: (...args) => Array.isArray(args[0]) ? Math.max(...args[0]) : Math.max(...args),
    sum: (arr) => arr.reduce((a, b) => a + b, 0),
    sorted: (arr, ...rest) => {
      const copy = arr.slice();
      copy.sort((a, b) => (a > b ? 1 : a < b ? -1 : 0));
      return copy;
    },
    list: (x) => {
      if (Array.isArray(x)) return x.slice();
      if (typeof x === "string") return x.split("");
      throw new PyRuntimeError(`list() yeh type ke liye kaam nahi karta: ${JSON.stringify(x)}`);
    },
  };
}

function pyStr(x) {
  if (x === null || x === undefined) return "None";
  if (typeof x === "boolean") return x ? "True" : "False";
  if (Array.isArray(x)) return "[" + x.map(pyRepr).join(", ") + "]";
  return String(x);
}
function pyRepr(x) {
  if (typeof x === "string") return `'${x}'`;
  return pyStr(x);
}

// ---------------------------------------------------------------------------
// Method dispatch for list/string methods (a.append(x), s.upper(), etc.)
// Mutating list methods (append, insert, remove, pop, sort, reverse, clear,
// extend) mutate the underlying array in place, matching Python semantics.
// ---------------------------------------------------------------------------

function callMethod(obj, methodName, args) {
  if (Array.isArray(obj)) {
    switch (methodName) {
      case "append": obj.push(args[0]); return null;
      case "extend": { const more = Array.isArray(args[0]) ? args[0] : [args[0]]; for (const v of more) obj.push(v); return null; }
      case "insert": obj.splice(args[0], 0, args[1]); return null;
      case "remove": {
        const idx = obj.findIndex((v) => pyEquals(v, args[0]));
        if (idx === -1) throw new PyRuntimeError(`remove(): value list mein nahi mili`);
        obj.splice(idx, 1);
        return null;
      }
      case "pop": {
        const idx = args.length > 0 ? pyNormalizeIndex(args[0], obj.length) : obj.length - 1;
        if (idx < 0 || idx >= obj.length) throw new PyRuntimeError("pop(): index range ke bahar hai");
        return obj.splice(idx, 1)[0];
      }
      case "sort": obj.sort((a, b) => (a > b ? 1 : a < b ? -1 : 0)); return null;
      case "reverse": obj.reverse(); return null;
      case "clear": obj.length = 0; return null;
      case "index": {
        const idx = obj.findIndex((v) => pyEquals(v, args[0]));
        if (idx === -1) throw new PyRuntimeError(`index(): value list mein nahi mili`);
        return idx;
      }
      case "count": return obj.filter((v) => pyEquals(v, args[0])).length;
      case "copy": return obj.slice();
      default:
        throw new PyRuntimeError(`List ke paas '${methodName}' method nahi hai`);
    }
  }
  if (typeof obj === "string") {
    switch (methodName) {
      case "upper": return obj.toUpperCase();
      case "lower": return obj.toLowerCase();
      case "strip": return obj.trim();
      case "lstrip": return obj.replace(/^\s+/, "");
      case "rstrip": return obj.replace(/\s+$/, "");
      case "split": {
        const sep = args.length > 0 ? args[0] : null;
        return sep === null ? obj.trim().split(/\s+/).filter(Boolean) : obj.split(sep);
      }
      case "replace": return obj.split(args[0]).join(args[1]);
      case "startswith": return obj.startsWith(args[0]);
      case "endswith": return obj.endsWith(args[0]);
      case "find": return obj.indexOf(args[0]);
      case "count": {
        if (args[0] === "") return 0;
        return obj.split(args[0]).length - 1;
      }
      case "join": {
        const parts = args[0];
        if (!Array.isArray(parts)) throw new PyRuntimeError("join() ko ek list chahiye");
        return parts.map(pyStr).join(obj);
      }
      case "title": return obj.replace(/\w\S*/g, (t) => t[0].toUpperCase() + t.slice(1).toLowerCase());
      case "capitalize": return obj.length === 0 ? obj : obj[0].toUpperCase() + obj.slice(1).toLowerCase();
      case "isdigit": return /^\d+$/.test(obj);
      case "isalpha": return /^[A-Za-z]+$/.test(obj);
      default:
        throw new PyRuntimeError(`String ke paas '${methodName}' method nahi hai`);
    }
  }
  throw new PyRuntimeError(`'${methodName}' method yeh type par kaam nahi karta`);
}

// ---------------------------------------------------------------------------
// Main evaluator
// ---------------------------------------------------------------------------

function evaluate(node, scope, callables) {
  switch (node.type) {
    case "Literal":
      return node.value;

    case "Name": {
      if (Object.prototype.hasOwnProperty.call(scope, node.name)) return scope[node.name];
      if (callables && Object.prototype.hasOwnProperty.call(callables, node.name)) return callables[node.name];
      throw new PyRuntimeError(`'${node.name}' defined nahi hai (not defined)`);
    }

    case "ListLiteral":
      return node.elements.map((el) => evaluate(el, scope, callables));

    case "UnaryOp": {
      const val = evaluate(node.operand, scope, callables);
      if (node.op === "-") return -val;
      if (node.op === "+") return +val;
      throw new PyRuntimeError(`Unknown unary operator '${node.op}'`);
    }

    case "Not":
      return !pyTruthy(evaluate(node.operand, scope, callables));

    case "LogicalAnd": {
      const left = evaluate(node.left, scope, callables);
      if (!pyTruthy(left)) return left;
      return evaluate(node.right, scope, callables);
    }

    case "LogicalOr": {
      const left = evaluate(node.left, scope, callables);
      if (pyTruthy(left)) return left;
      return evaluate(node.right, scope, callables);
    }

    case "Comparison": {
      const values = node.parts.map((p) => evaluate(p, scope, callables));
      for (let i = 0; i < node.ops.length; i++) {
        const a = values[i], b = values[i + 1], op = node.ops[i];
        let result;
        switch (op) {
          case "==": result = pyEquals(a, b); break;
          case "!=": result = !pyEquals(a, b); break;
          case "<": result = a < b; break;
          case ">": result = a > b; break;
          case "<=": result = a <= b; break;
          case ">=": result = a >= b; break;
          default: throw new PyRuntimeError(`Unknown comparison operator '${op}'`);
        }
        if (!result) return false;
      }
      return true;
    }

    case "BinOp": {
      const a = evaluate(node.left, scope, callables);
      const b = evaluate(node.right, scope, callables);
      switch (node.op) {
        case "+": return pyAdd(a, b);
        case "-": return a - b;
        case "*": return pyMul(a, b);
        case "/": {
          if (b === 0) throw new PyRuntimeError("Zero se divide nahi kar sakte");
          return a / b;
        }
        case "//": return pyFloorDiv(a, b);
        case "%": return pyMod(a, b);
        case "**": return Math.pow(a, b);
        default: throw new PyRuntimeError(`Unknown operator '${node.op}'`);
      }
    }

    case "Index": {
      const obj = evaluate(node.object, scope, callables);
      const idx = evaluate(node.index, scope, callables);
      return pyIndex(obj, idx);
    }

    case "Slice": {
      const obj = evaluate(node.object, scope, callables);
      const start = node.start ? evaluate(node.start, scope, callables) : null;
      const stop = node.stop ? evaluate(node.stop, scope, callables) : null;
      const step = node.step ? evaluate(node.step, scope, callables) : null;
      return pySlice(obj, start, stop, step);
    }

    case "Attribute": {
      // Attribute access alone (not called) - only meaningful as a prelude to a Call
      // in our supported subset; evaluate the object and stash the method name.
      const obj = evaluate(node.object, scope, callables);
      return { __isBoundMethod: true, obj, name: node.name };
    }

    case "Call": {
      // Method call: obj.method(args)
      if (node.callee.type === "Attribute") {
        const obj = evaluate(node.callee.object, scope, callables);
        const args = node.args.map((a) => evaluate(a, scope, callables));
        return callMethod(obj, node.callee.name, args);
      }
      // Plain function call: could be a builtin, a user-defined function, or pucho()
      if (node.callee.type === "Name") {
        const fname = node.callee.name;
        const args = node.args.map((a) => evaluate(a, scope, callables));
        if (Object.prototype.hasOwnProperty.call(scope, fname) && typeof scope[fname] === "function") {
          return scope[fname](...args);
        }
        if (callables && Object.prototype.hasOwnProperty.call(callables, fname)) {
          return callables[fname](...args);
        }
        if (Object.prototype.hasOwnProperty.call(scope, fname)) {
          throw new PyRuntimeError(`'${fname}' function nahi hai, call nahi kar sakte`);
        }
        throw new PyRuntimeError(`'${fname}' defined nahi hai (not defined)`);
      }
      throw new PyRuntimeError("Yeh call nahi kiya ja sakta");
    }

    default:
      throw new PyRuntimeError(`Unknown node type '${node.type}'`);
  }
}

// (pyeval engine internals are exported together with Interpreter at the end of this file)


class HindiLangError extends Error {
  constructor(message, lineNo, lineText) {
    super(message);
    this.lineNo = lineNo;
    this.lineText = lineText;
  }
  toString() {
    if (this.lineNo != null) {
      let loc = ` (line ${this.lineNo})`;
      if (this.lineText) loc += `: ${this.lineText.trim()}`;
      return `❌ Error${loc} -> ${this.message}`;
    }
    return `❌ Error -> ${this.message}`;
  }
}

class ReturnSignal {
  constructor(value) {
    this.value = value;
  }
}

class HindiFunction {
  constructor(name, params, bodyLines, closureScope) {
    this.name = name;
    this.params = params;
    this.bodyLines = bodyLines;
    this.closureScope = closureScope;
  }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

function tokenizeLines(source) {
  const lines = [];
  const rawLines = source.split("\n");
  for (let idx = 0; idx < rawLines.length; idx++) {
    const raw = rawLines[idx];
    const stripped = raw.trim();
    if (stripped === "" || stripped.startsWith("#")) continue;
    const indentMatch = /^[ \t]*/.exec(raw);
    const indentStr = indentMatch[0].replace(/\t/g, "    ");
    lines.push({ lineNo: idx + 1, indent: indentStr.length, text: stripped, raw });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Expression normalization (skip inside string literals)
// ---------------------------------------------------------------------------

const EXPR_REPLACEMENTS = [
  [/\baur\b/g, "&&"],
  [/\bya\b/g, "||"],
  [/\bnahi\b/g, "!"],
  [/\bsahi\b/g, "true"],
  [/\bgalat\b/g, "false"],
];

function normalizeExpr(expr) {
  const e = expr.trim();
  const stringPattern = /("(?:[^"\\]|\\.)*")|('(?:[^'\\]|\\.)*')/g;
  let result = "";
  let lastEnd = 0;
  let m;
  while ((m = stringPattern.exec(e)) !== null) {
    let codeSegment = e.slice(lastEnd, m.index);
    for (const [pattern, repl] of EXPR_REPLACEMENTS) {
      codeSegment = codeSegment.replace(pattern, repl);
    }
    result += codeSegment + m[0];
    lastEnd = m.index + m[0].length;
  }
  let tail = e.slice(lastEnd);
  for (const [pattern, repl] of EXPR_REPLACEMENTS) {
    tail = tail.replace(pattern, repl);
  }
  result += tail;
  return result;
}

// (range() is now provided by the pyeval engine's makeBuiltins(), see pyeval section below)

class Interpreter {
  constructor(onPrint, onInput) {
    this.globals = {};
    this.onPrint = onPrint || (() => {});
    // onInput() -> Promise<string>
    this.onInput = onInput || (async () => "");
    this._builtins = makeBuiltins();
  }

  evalExpr(expr, scope, lineNo, lineText) {
    const normalized = normalizeExpr(expr);
    try {
      const tokens = tokenize(normalized);
      const parser = new Parser(tokens);
      const ast = parser.parseExpression();

      // Build the "callables" table: builtins + user-defined functions wrapped
      // as plain JS functions so the evaluator can call them uniformly.
      const callables = Object.assign({}, this._builtins);
      for (const key of Object.keys(scope)) {
        const v = scope[key];
        if (v instanceof HindiFunction) {
          callables[key] = this._makeCallable(v);
        }
      }

      // scope itself may also hold plain values; the evaluator checks scope
      // first (for Name lookups) and falls back to callables for function calls.
      return evaluate(ast, scope, callables);
    } catch (e) {
      if (e instanceof PyRuntimeError) {
        throw new HindiLangError(e.message, lineNo, lineText);
      }
      if (e instanceof PyError) {
        throw new HindiLangError(`Expression samajh nahi aaya: '${normalized}' (${e.message})`, lineNo, lineText);
      }
      if (e instanceof HindiLangError) throw e;
      throw new HindiLangError(`Expression samajh nahi aaya: '${normalized}' (${e.message})`, lineNo, lineText);
    }
  }

  _makeCallable(fn) {
    const self = this;
    return function (...args) {
      return self.callFunction(fn, args);
    };
  }

  async run(sourceCode) {
    const lines = tokenizeLines(sourceCode);
    await this.executeBlock(lines, 0, lines.length, this.globals, 0);
  }

  findBlockEnd(lines, start, end, baseIndent) {
    if (start + 1 >= end) return start + 1;
    const bodyIndent = lines[start + 1].indent;
    if (bodyIndent <= baseIndent) {
      throw new HindiLangError(
        "Indentation chahiye iske baad (expected an indented block)",
        lines[start].lineNo,
        lines[start].raw
      );
    }
    let i = start + 1;
    while (i < end && lines[i].indent >= bodyIndent) i += 1;
    return i;
  }

  async executeBlock(lines, start, end, scope, baseIndent) {
    let i = start;
    while (i < end) {
      const line = lines[i];
      const text = line.text;
      const lineNo = line.lineNo;
      const raw = line.raw;

      if (text.startsWith("agar ") && text.trimEnd().endsWith(":")) {
        i = await this.handleIfChain(lines, i, end, scope, baseIndent);
        continue;
      }
      if (text.startsWith("agar ") && !text.trimEnd().endsWith(":")) {
        throw new HindiLangError("'agar <condition>:' mein aakhir mein ':' chahiye", lineNo, raw);
      }

      if (text.startsWith("jab_tak ") && text.trimEnd().endsWith(":")) {
        i = await this.handleWhile(lines, i, end, scope, baseIndent);
        continue;
      }
      if (text.startsWith("jab_tak ") && !text.trimEnd().endsWith(":")) {
        throw new HindiLangError("'jab_tak <condition>:' mein aakhir mein ':' chahiye", lineNo, raw);
      }

      if (text.startsWith("loop ") && text.trimEnd().endsWith(":")) {
        i = await this.handleLoop(lines, i, end, scope, baseIndent);
        continue;
      }
      if (text.startsWith("loop ") && !text.trimEnd().endsWith(":")) {
        throw new HindiLangError("'loop <var> range(...):' mein aakhir mein ':' chahiye", lineNo, raw);
      }

      if (text.startsWith("kaam ") && text.trimEnd().endsWith(":")) {
        i = this.handleFuncDef(lines, i, end, scope, baseIndent);
        continue;
      }
      if (text.startsWith("kaam ") && !text.trimEnd().endsWith(":")) {
        throw new HindiLangError("'kaam <naam>(<params>):' mein aakhir mein ':' chahiye", lineNo, raw);
      }

      if (text.startsWith("warna_agar") || text === "warna:" || text === "warna") {
        throw new HindiLangError(
          "'warna_agar' / 'warna' sirf 'agar' ke baad turant aa sakta hai",
          lineNo,
          raw
        );
      }

      if (text.startsWith("wapas")) {
        const expr = text.slice("wapas".length).trim();
        const value = expr ? this.evalExpr(expr, scope, lineNo, raw) : null;
        throw new ReturnSignal(value);
      }

      if (text.startsWith("dikhao(") && text.endsWith(")")) {
        await this.handlePrint(text, scope, lineNo, raw);
        i += 1;
        continue;
      }

      if (/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*[^=]/.test(text) && !text.split("=")[0].includes("==")) {
        await this.handleAssign(text, scope, lineNo, raw);
        i += 1;
        continue;
      }

      // bare expression statement
      try {
        await this.evalExprAsync(text, scope, lineNo, raw);
      } catch (e) {
        if (e instanceof ReturnSignal) throw e;
        throw new HindiLangError(`Samajh nahi aaya command: '${text}'`, lineNo, raw);
      }
      i += 1;
    }
    return i;
  }

  // Wraps evalExpr but allows pucho(...) (async input) to work inside arbitrary
  // expressions by pre-resolving any pucho(...) calls textually first.
  async evalExprAsync(expr, scope, lineNo, lineText) {
    const resolvedExpr = await this.resolvePucho(expr, scope, lineNo, lineText);
    return this.evalExpr(resolvedExpr, scope, lineNo, lineText);
  }

  // Finds pucho("...") calls in the expression text, runs the async input flow,
  // and substitutes the literal result back into the expression string.
  async resolvePucho(expr, scope, lineNo, lineText) {
    const puchoCallPattern = /pucho\(([^()]*)\)/;
    let working = expr;
    let match;
    while ((match = puchoCallPattern.exec(working)) !== null) {
      const argExpr = match[1].trim();
      let promptValue = "";
      if (argExpr) {
        promptValue = this.evalExpr(argExpr, scope, lineNo, lineText);
      }
      const userVal = await this.onInput(String(promptValue));
      let resolvedVal;
      if (userVal !== "" && !isNaN(userVal)) {
        resolvedVal = userVal.includes(".") ? parseFloat(userVal) : parseInt(userVal, 10);
      } else {
        resolvedVal = userVal;
      }
      const literal = typeof resolvedVal === "string" ? JSON.stringify(resolvedVal) : String(resolvedVal);
      working = working.slice(0, match.index) + literal + working.slice(match.index + match[0].length);
    }
    return working;
  }

  async handleAssign(text, scope, lineNo, raw) {
    const idx = text.indexOf("=");
    const name = text.slice(0, idx).trim();
    const expr = text.slice(idx + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new HindiLangError(`'${name}' ek valid variable naam nahi hai`, lineNo, raw);
    }
    const value = await this.evalExprAsync(expr, scope, lineNo, raw);
    scope[name] = value;
  }

  async handlePrint(text, scope, lineNo, raw) {
    const inner = text.slice("dikhao(".length, -1);
    const value = inner.trim() ? await this.evalExprAsync(inner, scope, lineNo, raw) : "";
    this.onPrint(pyStr(value));
  }

  async handleIfChain(lines, idx, end, scope, baseIndent) {
    const branches = [];
    let i = idx;
    const headerIndent = lines[idx].indent;

    const firstText = lines[idx].text;
    let cond = firstText.slice("agar ".length).trim();
    cond = cond.endsWith(":") ? cond.slice(0, -1).trim() : cond;
    let bodyEnd = this.findBlockEnd(lines, idx, end, headerIndent);
    branches.push([cond, idx + 1, bodyEnd, lines[idx].lineNo, lines[idx].raw]);
    i = bodyEnd;

    while (i < end && lines[i].indent === headerIndent) {
      const text = lines[i].text;
      if (text.startsWith("warna_agar ") && text.trimEnd().endsWith(":")) {
        let c = text.slice("warna_agar ".length).trim();
        c = c.endsWith(":") ? c.slice(0, -1).trim() : c;
        bodyEnd = this.findBlockEnd(lines, i, end, headerIndent);
        branches.push([c, i + 1, bodyEnd, lines[i].lineNo, lines[i].raw]);
        i = bodyEnd;
      } else if (text === "warna:") {
        bodyEnd = this.findBlockEnd(lines, i, end, headerIndent);
        branches.push([null, i + 1, bodyEnd, lines[i].lineNo, lines[i].raw]);
        i = bodyEnd;
        break;
      } else {
        break;
      }
    }

    for (const [branchCond, bodyStart, branchBodyEnd, branchLineNo, branchRaw] of branches) {
      if (branchCond === null) {
        await this.executeBlock(lines, bodyStart, branchBodyEnd, scope, headerIndent);
        return i;
      }
      const result = await this.evalExprAsync(branchCond, scope, branchLineNo, branchRaw);
      if (result) {
        await this.executeBlock(lines, bodyStart, branchBodyEnd, scope, headerIndent);
        return i;
      }
    }

    return i;
  }

  async handleWhile(lines, idx, end, scope, baseIndent) {
    const text = lines[idx].text;
    const lineNo = lines[idx].lineNo;
    const raw = lines[idx].raw;
    let cond = text.slice("jab_tak ".length).trim();
    cond = cond.endsWith(":") ? cond.slice(0, -1).trim() : cond;
    const bodyEnd = this.findBlockEnd(lines, idx, end, baseIndent);

    let safety = 0;
    while (await this.evalExprAsync(cond, scope, lineNo, raw)) {
      await this.executeBlock(lines, idx + 1, bodyEnd, scope, lines[idx].indent);
      safety += 1;
      if (safety > 200000) {
        throw new HindiLangError("Loop bahut zyada chal gaya (infinite loop?). Rok diya.", lineNo, raw);
      }
    }
    return bodyEnd;
  }

  async handleLoop(lines, idx, end, scope, baseIndent) {
    const text = lines[idx].text;
    const lineNo = lines[idx].lineNo;
    const raw = lines[idx].raw;
    const m = /^loop\s+([A-Za-z_][A-Za-z0-9_]*)\s+(range\(.*\))\s*:$/.exec(text);
    if (!m) {
      throw new HindiLangError(
        "'loop <var> range(<n>):' format follow karo. Jaise: loop i range(5):",
        lineNo,
        raw
      );
    }
    const varName = m[1];
    const rangeExpr = m[2];
    const rangeVal = this.evalExpr(rangeExpr, scope, lineNo, raw);
    const bodyEnd = this.findBlockEnd(lines, idx, end, baseIndent);

    for (const val of rangeVal) {
      scope[varName] = val;
      await this.executeBlock(lines, idx + 1, bodyEnd, scope, lines[idx].indent);
    }
    return bodyEnd;
  }

  handleFuncDef(lines, idx, end, scope, baseIndent) {
    const text = lines[idx].text;
    const lineNo = lines[idx].lineNo;
    const raw = lines[idx].raw;
    const m = /^kaam\s+([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)\s*:$/.exec(text);
    if (!m) {
      throw new HindiLangError(
        "'kaam <naam>(<params>):' format follow karo. Jaise: kaam jod(a, b):",
        lineNo,
        raw
      );
    }
    const fname = m[1];
    const paramsStr = m[2];
    const params = paramsStr.trim()
      ? paramsStr.split(",").map((p) => p.trim()).filter(Boolean)
      : [];
    const bodyEnd = this.findBlockEnd(lines, idx, end, baseIndent);
    const bodyLines = lines.slice(idx + 1, bodyEnd);

    const fn = new HindiFunction(fname, params, bodyLines, this.globals);
    scope[fname] = fn;

    return bodyEnd;
  }

  callFunction(fn, args) {
    if (args.length !== fn.params.length) {
      throw new HindiLangError(
        `'${fn.name}' ko ${fn.params.length} arguments chahiye, ${args.length} mile`
      );
    }
    const localScope = Object.assign({}, fn.closureScope);
    fn.params.forEach((pname, idx) => {
      localScope[pname] = args[idx];
    });
    try {
      this.executeBlockSync(fn.bodyLines, 0, fn.bodyLines.length, localScope, -1);
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      throw e;
    }
    return null;
  }

  // Synchronous variant of executeBlock used only inside function bodies.
  // Function bodies cannot use pucho() (input) in this version — keeping
  // function calls synchronous lets them compose inside any expression
  // (e.g. `jod(2,2) + 1`, `agar jod(a,b) == 4:`) without Promise leakage.
  executeBlockSync(lines, start, end, scope, baseIndent) {
    let i = start;
    while (i < end) {
      const line = lines[i];
      const text = line.text;
      const lineNo = line.lineNo;
      const raw = line.raw;

      if (text.startsWith("agar ") && text.trimEnd().endsWith(":")) {
        i = this.handleIfChainSync(lines, i, end, scope, baseIndent);
        continue;
      }
      if (text.startsWith("agar ") && !text.trimEnd().endsWith(":")) {
        throw new HindiLangError("'agar <condition>:' mein aakhir mein ':' chahiye", lineNo, raw);
      }

      if (text.startsWith("jab_tak ") && text.trimEnd().endsWith(":")) {
        i = this.handleWhileSync(lines, i, end, scope, baseIndent);
        continue;
      }

      if (text.startsWith("loop ") && text.trimEnd().endsWith(":")) {
        i = this.handleLoopSync(lines, i, end, scope, baseIndent);
        continue;
      }

      if (text.startsWith("kaam ") && text.trimEnd().endsWith(":")) {
        i = this.handleFuncDef(lines, i, end, scope, baseIndent);
        continue;
      }

      if (text.startsWith("warna_agar") || text === "warna:" || text === "warna") {
        throw new HindiLangError(
          "'warna_agar' / 'warna' sirf 'agar' ke baad turant aa sakta hai",
          lineNo,
          raw
        );
      }

      if (text.startsWith("wapas")) {
        const expr = text.slice("wapas".length).trim();
        const value = expr ? this.evalExpr(expr, scope, lineNo, raw) : null;
        throw new ReturnSignal(value);
      }

      if (text.startsWith("dikhao(") && text.endsWith(")")) {
        const inner = text.slice("dikhao(".length, -1);
        const value = inner.trim() ? this.evalExpr(inner, scope, lineNo, raw) : "";
        this.onPrint(pyStr(value));
        i += 1;
        continue;
      }

      if (/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*[^=]/.test(text) && !text.split("=")[0].includes("==")) {
        const idx = text.indexOf("=");
        const name = text.slice(0, idx).trim();
        const expr = text.slice(idx + 1).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          throw new HindiLangError(`'${name}' ek valid variable naam nahi hai`, lineNo, raw);
        }
        if (/\bpucho\(/.test(expr)) {
          throw new HindiLangError(
            "'pucho' (input) function ke andar use nahi ho sakta",
            lineNo,
            raw
          );
        }
        scope[name] = this.evalExpr(expr, scope, lineNo, raw);
        i += 1;
        continue;
      }

      try {
        this.evalExpr(text, scope, lineNo, raw);
      } catch (e) {
        if (e instanceof ReturnSignal) throw e;
        throw new HindiLangError(`Samajh nahi aaya command: '${text}'`, lineNo, raw);
      }
      i += 1;
    }
    return i;
  }

  handleIfChainSync(lines, idx, end, scope, baseIndent) {
    const branches = [];
    let i = idx;
    const headerIndent = lines[idx].indent;

    const firstText = lines[idx].text;
    let cond = firstText.slice("agar ".length).trim();
    cond = cond.endsWith(":") ? cond.slice(0, -1).trim() : cond;
    let bodyEnd = this.findBlockEnd(lines, idx, end, headerIndent);
    branches.push([cond, idx + 1, bodyEnd, lines[idx].lineNo, lines[idx].raw]);
    i = bodyEnd;

    while (i < end && lines[i].indent === headerIndent) {
      const text = lines[i].text;
      if (text.startsWith("warna_agar ") && text.trimEnd().endsWith(":")) {
        let c = text.slice("warna_agar ".length).trim();
        c = c.endsWith(":") ? c.slice(0, -1).trim() : c;
        bodyEnd = this.findBlockEnd(lines, i, end, headerIndent);
        branches.push([c, i + 1, bodyEnd, lines[i].lineNo, lines[i].raw]);
        i = bodyEnd;
      } else if (text === "warna:") {
        bodyEnd = this.findBlockEnd(lines, i, end, headerIndent);
        branches.push([null, i + 1, bodyEnd, lines[i].lineNo, lines[i].raw]);
        i = bodyEnd;
        break;
      } else {
        break;
      }
    }

    for (const [branchCond, bodyStart, branchBodyEnd, branchLineNo, branchRaw] of branches) {
      if (branchCond === null) {
        this.executeBlockSync(lines, bodyStart, branchBodyEnd, scope, headerIndent);
        return i;
      }
      if (this.evalExpr(branchCond, scope, branchLineNo, branchRaw)) {
        this.executeBlockSync(lines, bodyStart, branchBodyEnd, scope, headerIndent);
        return i;
      }
    }
    return i;
  }

  handleWhileSync(lines, idx, end, scope, baseIndent) {
    const text = lines[idx].text;
    const lineNo = lines[idx].lineNo;
    const raw = lines[idx].raw;
    let cond = text.slice("jab_tak ".length).trim();
    cond = cond.endsWith(":") ? cond.slice(0, -1).trim() : cond;
    const bodyEnd = this.findBlockEnd(lines, idx, end, baseIndent);

    let safety = 0;
    while (this.evalExpr(cond, scope, lineNo, raw)) {
      this.executeBlockSync(lines, idx + 1, bodyEnd, scope, lines[idx].indent);
      safety += 1;
      if (safety > 200000) {
        throw new HindiLangError("Loop bahut zyada chal gaya (infinite loop?). Rok diya.", lineNo, raw);
      }
    }
    return bodyEnd;
  }

  handleLoopSync(lines, idx, end, scope, baseIndent) {
    const text = lines[idx].text;
    const lineNo = lines[idx].lineNo;
    const raw = lines[idx].raw;
    const m = /^loop\s+([A-Za-z_][A-Za-z0-9_]*)\s+(range\(.*\))\s*:$/.exec(text);
    if (!m) {
      throw new HindiLangError(
        "'loop <var> range(<n>):' format follow karo. Jaise: loop i range(5):",
        lineNo,
        raw
      );
    }
    const varName = m[1];
    const rangeExpr = m[2];
    const rangeVal = this.evalExpr(rangeExpr, scope, lineNo, raw);
    const bodyEnd = this.findBlockEnd(lines, idx, end, baseIndent);

    for (const val of rangeVal) {
      scope[varName] = val;
      this.executeBlockSync(lines, idx + 1, bodyEnd, scope, lines[idx].indent);
    }
    return bodyEnd;
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    Interpreter, HindiLangError,
    tokenize, Parser, PyError, evaluate, makeBuiltins, pyTruthy, pyStr, PyRuntimeError, pyEquals,
  };
}
