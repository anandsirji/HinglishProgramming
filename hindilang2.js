/* HindiLang v2 — JavaScript port.
 * Python-style syntax (indentation + colons), Hindi keywords, symbols stay as symbols.
 * Runs entirely client-side.
 */

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
function normalizeSlices(expr) {
  // Matches arr[start:end:step] just like Python
  return expr.replace(
    /([A-Za-z_][A-Za-z0-9_]*)\s*

\[([^:\]

]*):([^:\]

]*)(?::([^:\]

]*))?\]

/g,
    (match, varName, start, end, step) => {
      const s = start.trim() || "null";
      const e = end.trim() || "null";
      const st = step ? step.trim() : "null";
      return `pySlice(${varName}, ${s}, ${e}, ${st})`;
    }
  );
}

// Python-like range() -> returns an array (sufficient for our loop usage)
function pyRange(a, b, c) {
  let start, stop, step;
  if (b === undefined) {
    start = 0; stop = a; step = 1;
  } else if (c === undefined) {
    start = a; stop = b; step = 1;
  } else {
    start = a; stop = b; step = c;
  }
  const out = [];
  if (step > 0) {
    for (let v = start; v < stop; v += step) out.push(v);
  } else if (step < 0) {
    for (let v = start; v > stop; v += step) out.push(v);
  }
  return out;
}
function pySlice(obj, start, end, step) {
  if (typeof obj === "string") obj = obj.split(""); // treat string like list of chars
  if (!Array.isArray(obj)) throw new Error("Slicing only works on lists/strings");

  const len = obj.length;
  start = start == null ? 0 : (start < 0 ? len + start : start);
  end = end == null ? len : (end < 0 ? len + end : end);
  step = step == null ? 1 : step;

  const result = [];
  if (step > 0) {
    for (let i = start; i < end; i += step) result.push(obj[i]);
  } else {
    for (let i = start; i > end; i += step) result.push(obj[i]);
  }
  return typeof obj[0] === "string" ? result.join("") : result;
}

class Interpreter {
  constructor(onPrint, onInput) {
    this.globals = {};
    this.onPrint = onPrint || (() => {});
    // onInput() -> Promise<string>
    this.onInput = onInput || (async () => "");
  }

  evalExpr(expr, scope, lineNo, lineText) {
    const normalized = normalizeExpr(expr);
    const sliced = normalizeSlices(normalized);
    const varNames = Object.keys(scope);
    const varValues = varNames.map((k) => {
      const v = scope[k];
      return v instanceof HindiFunction ? this._makeCallable(v) : v;
    });

    const builtinNames = ["range", "len", "str", "int", "float", "abs", "round", "min", "max", "sum"];
    const builtinValues = [
      pyRange,
      (x) => (Array.isArray(x) ? x.length : String(x).length),
      (x) => String(x),
      (x) => {
        const n = parseInt(x, 10);
        if (isNaN(n)) throw new Error(`int() ka kaam nahi kar saka: ${x}`);
        return n;
      },
      (x) => {
        const n = parseFloat(x);
        if (isNaN(n)) throw new Error(`float() ka kaam nahi kar saka: ${x}`);
        return n;
      },
      Math.abs,
      (x, n) => (n === undefined ? Math.round(x) : Math.round(x * 10 ** n) / 10 ** n),
      (...args) => Math.min(...(Array.isArray(args[0]) ? args[0] : args)),
      (...args) => Math.max(...(Array.isArray(args[0]) ? args[0] : args)),
      (arr) => arr.reduce((a, b) => a + b, 0),
      pySlice
    ];

    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function(
        ...builtinNames,
        ...varNames,
        `"use strict"; return (${normalized});`
      );
      return fn(...builtinValues, ...varValues);
    } catch (e) {
      if (e instanceof ReferenceError) {
        const match = /(\w+) is not defined/.exec(e.message);
        const varName = match ? match[1] : normalized;
        throw new HindiLangError(`'${varName}' defined nahi hai (not defined)`, lineNo, lineText);
      }
      if (e instanceof HindiLangError) throw e;
      throw new HindiLangError(
        `Expression samajh nahi aaya: '${normalized}' (${e.message})`,
        lineNo,
        lineText
      );
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
    this.onPrint(value);
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
        this.onPrint(value);
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
  module.exports = { Interpreter, HindiLangError };
}
