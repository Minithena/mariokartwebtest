// The server browser's match filters, e.g. "dwc_mver = 90 and dwc_pid != 43 and (rk = 'vs')".
// A small evaluator: comparisons (= == != <> < <= > >=, like), and/or/not, parentheses, numbers,
// 'strings' and key names (looked up in the server's QR2 keys). Values compare as numbers when both
// sides are numeric. Malformed filters match nothing, so a parse error cannot bypass the game's
// player-count, game-mode or profile exclusions.

export function matchesFilter(filter, keys) {
  if (!filter || !filter.trim()) return true;
  try {
    const parser = new Parser(tokenize(filter), keys);
    const value = parser.expression();
    if (parser.pos !== parser.tokens.length) throw new Error('trailing input');
    return truthy(value);
  } catch (e) {
    console.log(`[wfc] filter not understood (${e.message}): ${filter}`);
    return false;
  }
}

function tokenize(s) {
  const tokens = [];
  const re = /\s*(?:(-?\d+(?:\.\d+)?)|'([^']*)'|"([^"]*)"|(<=|>=|!=|<>|==|=|<|>|\(|\)|&&|\|\|)|([A-Za-z_+][\w.+]*))/y;
  let m;
  while (re.lastIndex < s.length) {
    if (/^\s*$/.test(s.slice(re.lastIndex))) break;
    m = re.exec(s);
    if (!m) throw new Error(`unexpected "${s.slice(re.lastIndex, re.lastIndex + 10)}"`);
    if (m[1] !== undefined) tokens.push({ kind: 'value', value: m[1] });
    else if (m[2] !== undefined || m[3] !== undefined) tokens.push({ kind: 'value', value: m[2] ?? m[3] });
    else if (m[4] !== undefined) tokens.push({ kind: 'op', value: m[4] === '&&' ? 'and' : m[4] === '||' ? 'or' : m[4] });
    else {
      const word = m[5].toLowerCase();
      if (['and', 'or', 'not', 'like'].includes(word)) tokens.push({ kind: 'op', value: word });
      else tokens.push({ kind: 'name', value: m[5] });
    }
  }
  return tokens;
}

const truthy = (v) => v === true || (typeof v === 'string' && v !== '' && v !== '0');
const numeric = (v) => typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v);

function compare(op, a, b) {
  if (op === 'like') {
    const pattern = new RegExp('^' + String(b).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i');
    return pattern.test(String(a));
  }
  const both = numeric(a) && numeric(b);
  const x = both ? Number(a) : String(a);
  const y = both ? Number(b) : String(b);
  switch (op) {
    case '=': case '==': return x === y;
    case '!=': case '<>': return x !== y;
    case '<': return x < y;
    case '<=': return x <= y;
    case '>': return x > y;
    case '>=': return x >= y;
  }
  throw new Error(`operator ${op}`);
}

class Parser {
  constructor(tokens, keys) {
    this.tokens = tokens;
    this.keys = keys;
    this.pos = 0;
  }
  peek() { return this.tokens[this.pos]; }
  isOp(value) { const t = this.peek(); return t && t.kind === 'op' && t.value === value; }
  expression() {
    let left = this.conjunction();
    while (this.isOp('or')) { this.pos++; const right = this.conjunction(); left = truthy(left) || truthy(right); }
    return left;
  }
  conjunction() {
    let left = this.negation();
    while (this.isOp('and')) { this.pos++; const right = this.negation(); left = truthy(left) && truthy(right); }
    return left;
  }
  negation() {
    if (this.isOp('not')) { this.pos++; return !truthy(this.negation()); }
    return this.comparison();
  }
  comparison() {
    const left = this.operand();
    const t = this.peek();
    if (t && t.kind === 'op' && ['=', '==', '!=', '<>', '<', '<=', '>', '>=', 'like'].includes(t.value)) {
      this.pos++;
      return compare(t.value, left, this.operand());
    }
    return left;
  }
  operand() {
    const t = this.tokens[this.pos++];
    if (!t) throw new Error('unexpected end');
    if (t.kind === 'value') return t.value;
    if (t.kind === 'name') return this.keys[t.value] ?? '';
    if (t.kind === 'op' && t.value === '(') {
      const value = this.expression();
      if (!this.isOp(')')) throw new Error('missing )');
      this.pos++;
      return value;
    }
    throw new Error(`unexpected ${t.value}`);
  }
}
