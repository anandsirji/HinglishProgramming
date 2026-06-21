/* HindiLang v3 — Python-style semantics in JS
 * Supports list slicing, negative indices, floor division, list methods, etc.
 * Keywords remain Hindi.
 */

class HindiLangError extends Error {
  constructor(message, lineNo, lineText) {
    super(message);
    this.lineNo = lineNo;
    this.lineText = lineText;
  }
  toString() {
    return `❌ Error (line ${this.lineNo}) -> ${this.message}`;
  }
}

class ReturnSignal {
  constructor(value) { this.value = value; }
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
// Helpers for Python-like behavior
// ---------------------------------------------------------------------------

function pyRange(a, b, c) {
  let start, stop, step;
  if (b === undefined) { start = 0; stop = a; step = 1; }
  else if (c === undefined) { start = a; stop = b; step = 1; }
  else { start = a; stop = b; step = c; }
  const out = [];
  if (step > 0) for (let v = start; v < stop; v += step) out.push(v);
  else for (let v = start; v > stop; v += step) out.push(v);
  return out;
}

function pySlice(obj, start, end, step) {
  if (typeof obj === "string") obj = obj.split("");
  if (!Array.isArray(obj)) throw new Error("Slicing only works on lists/strings");
  const len = obj.length;
  start = start == null ? 0 : (start < 0 ? len + start : start);
  end = end == null ? len : (end < 0 ? len + end : end);
  step = step == null ? 1 : step;
  const result = [];
  if (step > 0) for (let i = start; i < end; i += step) result.push(obj[i]);
  else for (let i = start; i > end; i += step) result.push(obj[i]);
  return typeof obj[0] === "string" ? result.join("") : result;
}

function pyFloorDiv(a, b) { return Math.floor(a / b); }

function pyIndex(obj, idx) {
  if (typeof obj === "string") obj = obj.split("");
  if (idx < 0) idx = obj.length + idx;
  return obj[idx];
}

// ---------------------------------------------------------------------------
// Expression evaluator (Python-like)
// ---------------------------------------------------------------------------

function evalPythonExpr(expr, scope) {
  // Replace Hindi booleans/operators
  expr = expr.replace(/\baur\b/g, "&&")
             .replace(/\bya\b/g, "||")
             .replace(/\bnahi\b/g, "!")
             .replace(/\bsahi\b/g, "true")
             .replace(/\bgalat\b/g, "false");

  // Handle slicing arr[a:b:c]
  expr = expr.replace(/([A-Za-z_][A-Za-z0-9_]*)\s*

\[([^\]

]*)\]

/g,
    (match, varName, inside) => {
      if (inside.includes(":")) {
        const parts = inside.split(":");
        const s = parts[0].trim() || "null";
        const e = parts.length > 1 && parts[1].trim() ? parts[1].trim() : "null";
        const st = parts.length > 2 && parts[2].trim() ? parts[2].trim() : "null";
        return `pySlice(${varName}, ${s}, ${e}, ${st})`;
      } else {
        return `pyIndex(${varName}, ${inside.trim()})`;
      }
    });

  // Handle floor division //
  expr = expr.replace(/(\S+)\s*\/\/\s*(\S+)/g,
    (match, a, b) => `pyFloorDiv(${a}, ${b})`);

  const builtin = {
    range: pyRange,
    len: (x) => Array.isArray(x) || typeof x === "string" ? x.length : 0,
    str: (x) => String(x),
    int: (x) => parseInt(x, 10),
    float: (x) => parseFloat(x),
    abs: Math.abs,
    round: Math.round,
    min: Math.min,
    max: Math.max,
    sum: (arr) => arr.reduce((a, b) => a + b, 0),
    pySlice, pyFloorDiv, pyIndex
  };

  try {
    const fn = new Function(...Object.keys(builtin), ...Object.keys(scope),
      `"use strict"; return (${expr});`);
    return fn(...Object.values(builtin), ...Object.values(scope));
  } catch (e) {
    throw new HindiLangError(`Expression samajh nahi aaya: '${expr}' (${e.message})`);
  }
}

// ---------------------------------------------------------------------------
// Interpreter (statements remain same as v2, only evalExpr changed)
// ---------------------------------------------------------------------------

class Interpreter {
  constructor(onPrint, onInput) {
    this.globals = {};
    this.onPrint = onPrint || (() => {});
    this.onInput = onInput || (async () => "");
  }

  evalExpr(expr, scope, lineNo, lineText) {
    return evalPythonExpr(expr, scope);
  }

  // Keep your existing executeBlock, handleIfChain, handleWhile, etc.
  // Replace only evalExpr calls with this new one.
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { Interpreter, HindiLangError };
}
