/* 默认 RV32I，可选扩展需显式启用。解码失败仅表示不在本工具支持的规范编码范围内，
 * 不代表架构非法。CSR 仅校验编码，不检查特权级、访问权限或寄存器是否实现。
 */
(function (root) {
  'use strict';
  const MAX_WORD = 0xffffffffn;
  const EXTENSIONS = ['I', 'M', 'Zicsr', 'Zifencei'];
  const ABI = ('zero ra sp gp tp t0 t1 t2 s0 s1 a0 a1 a2 a3 a4 a5 a6 a7 ' +
    's2 s3 s4 s5 s6 s7 s8 s9 s10 s11 t3 t4 t5 t6').split(' ');
  const CSRS = new Map(Object.entries({
    fflags: 0x001, frm: 0x002, fcsr: 0x003, sstatus: 0x100, stvec: 0x105,
    sepc: 0x141, scause: 0x142, stval: 0x143, satp: 0x180, mstatus: 0x300,
    misa: 0x301, mie: 0x304, mtvec: 0x305, mepc: 0x341, mcause: 0x342,
    mtval: 0x343, mip: 0x344
  }));
  const SYNTAX = {
    R: 'rd, rs1, rs2', I: 'rd, rs1, imm', shift: 'rd, rs1, shamt',
    load: 'rd, imm(rs1)', store: 'rs2, imm(rs1)', jalr: 'rd, imm(rs1)',
    B: 'rs1, rs2, offset', U: 'rd, imm20', J: 'rd, offset',
    csr: 'rd, csr, rs1', csri: 'rd, csr, zimm', fence: 'pred, succ', fixed: ''
  };
  const TABLE = [];
  function add(name, format, kind, match, extension = 'I', rv64 = false) {
    TABLE.push({ name, format, kind, match: BigInt(match), extension, rv64 });
  }
  ['lui', 'auipc'].forEach((n, i) => add(n, 'U', 'U', [0x37, 0x17][i]));
  add('jal', 'J', 'J', 0x6f);
  add('jalr', 'I', 'jalr', 0x67);
  [['beq', 0], ['bne', 1], ['blt', 4], ['bge', 5], ['bltu', 6], ['bgeu', 7]]
    .forEach(([n, f]) => add(n, 'B', 'B', 0x63 + f * 0x1000));
  [['lb', 0], ['lh', 1], ['lw', 2], ['lbu', 4], ['lhu', 5], ['ld', 3], ['lwu', 6]]
    .forEach(([n, f]) => add(n, 'I', 'load', 3 + f * 0x1000, 'I', f === 3 || f === 6));
  ['sb', 'sh', 'sw', 'sd'].forEach((n, f) => add(n, 'S', 'store', 0x23 + f * 0x1000, 'I', f === 3));
  [['addi', 0], ['slti', 2], ['sltiu', 3], ['xori', 4], ['ori', 6], ['andi', 7]]
    .forEach(([n, f]) => add(n, 'I', 'I', 0x13 + f * 0x1000));
  add('addiw', 'I', 'I', 0x1b, 'I', true);
  for (const [n, f, high] of [['slli', 1, 0], ['srli', 5, 0], ['srai', 5, 0x40000000]]) {
    add(n, 'I', 'shift', high + f * 0x1000 + 0x13);
    add(n + 'w', 'I', 'shift', high + f * 0x1000 + 0x1b, 'I', true);
  }
  for (const [n, f, high] of [
    ['add', 0, 0], ['sub', 0, 0x40000000], ['sll', 1, 0], ['slt', 2, 0],
    ['sltu', 3, 0], ['xor', 4, 0], ['srl', 5, 0], ['sra', 5, 0x40000000],
    ['or', 6, 0], ['and', 7, 0]
  ]) {
    add(n, 'R', 'R', high + f * 0x1000 + 0x33);
    if (['add', 'sub', 'sll', 'srl', 'sra'].includes(n))
      add(n + 'w', 'R', 'R', high + f * 0x1000 + 0x3b, 'I', true);
  }
  ['mul', 'mulh', 'mulhsu', 'mulhu', 'div', 'divu', 'rem', 'remu'].forEach((n, f) => {
    add(n, 'R', 'R', 0x02000033 + f * 0x1000, 'M');
    if (f === 0 || f >= 4) add(n + 'w', 'R', 'R', 0x0200003b + f * 0x1000, 'M', true);
  });
  [['csrrw', 1], ['csrrs', 2], ['csrrc', 3], ['csrrwi', 5], ['csrrsi', 6], ['csrrci', 7]]
    .forEach(([n, f]) => add(n, 'I', f < 4 ? 'csr' : 'csri', 0x73 + f * 0x1000, 'Zicsr'));
  add('fence', 'I', 'fence', 0x0f);
  add('fence.i', 'I', 'fixed', 0x100f, 'Zifencei');
  add('ecall', 'I', 'fixed', 0x73);
  add('ebreak', 'I', 'fixed', 0x100073);

  function options(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置必须为对象');
    const { xlen = 32, extensions = ['I'] } = value;
    if (xlen !== 32 && xlen !== 64) throw new Error('XLEN 必须为 32 或 64');
    if (!Array.isArray(extensions) || extensions.some(e => !EXTENSIONS.includes(e)))
      throw new Error('支持的扩展为 I、M、Zicsr、Zifencei');
    return { xlen, extensions: new Set(['I', ...extensions]) };
  }
  function enabled(d, o) { return (!d.rv64 || o.xlen === 64) && o.extensions.has(d.extension); }
  function width(d, o) { return d.rv64 ? 5 : o.xlen === 64 ? 6 : 5; }
  function mask(d, o) {
    if (d.kind === 'fixed') return MAX_WORD;
    if (d.kind === 'fence') return 0xf00fffffn;
    if (d.kind === 'R') return 0xfe00707fn;
    if (d.kind === 'shift') return width(d, o) === 6 ? 0xfc00707fn : 0xfe00707fn;
    return d.format === 'U' || d.format === 'J' ? 0x7fn : 0x707fn;
  }
  function integer(text) {
    if (typeof text !== 'string' || !/^[+-]?(?:0x[0-9a-f]+|0b[01]+|[0-9]+)$/i.test(text))
      throw new Error('请输入十进制、0x 十六进制或 0b 二进制整数，不支持符号名称或表达式');
    const sign = text[0] === '-' ? -1n : 1n;
    return sign * BigInt(text.replace(/^[+-]/, ''));
  }
  function range(n, min, max, label) {
    if (n < min || n > max) throw new Error(`${label}必须在 [${min}, ${max}] 范围内`);
    return n;
  }
  function parseWord(text) {
    if (typeof text !== 'string' || !/^(?:0x[0-9a-f]+|0b[01]+|[0-9]+)$/i.test(text.trim()))
      throw new Error('机器码须为无符号十进制、0x 十六进制或 0b 二进制整数');
    return range(integer(text.trim()), 0n, MAX_WORD, '32 位机器码');
  }
  function reg(text) {
    if (/^x(?:[0-9]|[12][0-9]|3[01])$/.test(text)) return BigInt(text.slice(1));
    const index = text === 'fp' ? 8 : ABI.indexOf(text);
    if (index < 0) throw new Error(`无效寄存器：${text}，请使用 x0–x31 或 ABI 别名`);
    return BigInt(index);
  }
  function csr(text) {
    return range(CSRS.has(text) ? BigInt(CSRS.get(text)) : integer(text), 0n, 4095n, 'CSR 地址');
  }
  function memory(text) {
    const m = /^([^()\s]+)\s*\(\s*([a-z0-9]+)\s*\)$/.exec(text);
    if (!m) throw new Error('访存操作数格式须为 imm(rs1)，例如 8(sp)');
    return [reg(m[2]), range(integer(m[1]), -2048n, 2047n, '12 位有符号立即数')];
  }
  function fenceSet(text) {
    if (text === '0') return 0n;
    if (!/^[iorw]+$/.test(text) || new Set(text).size !== text.length)
      throw new Error('屏障集合须由不重复的 i/o/r/w 字母组成，空集合请写 0');
    return [...text].reduce((v, c) => v | ({ i: 8n, o: 4n, r: 2n, w: 1n })[c], 0n);
  }
  function fenceText(n) { return [...'iorw'].filter(c => (fenceSet(c) & n) !== 0n).join('') || '0'; }
  function count(args, n) {
    if (args.length !== n) throw new Error(`需要 ${n} 个操作数，多个操作数之间用逗号分隔`);
  }
  function pseudo(name, a) {
    const arities = { nop: 0, mv: 2, not: 2, neg: 2, negw: 2, j: 1, jr: 1, ret: 0,
      beqz: 2, bnez: 2, csrr: 2, csrw: 2, csrwi: 2, csrsi: 2, csrci: 2, li: 2 };
    if (!Object.hasOwn(arities, name)) return null;
    count(a, arities[name]);
    const [x, y] = a;
    switch (name) {
      case 'nop': return ['addi', 'x0', 'x0', '0'];
      case 'mv': return ['addi', x, y, '0'];
      case 'not': return ['xori', x, y, '-1'];
      case 'neg': return ['sub', x, 'x0', y];
      case 'negw': return ['subw', x, 'x0', y];
      case 'j': return ['jal', 'x0', x];
      case 'jr': return ['jalr', 'x0', `0(${x})`];
      case 'ret': return ['jalr', 'x0', '0(x1)'];
      case 'beqz': return ['beq', x, 'x0', y];
      case 'bnez': return ['bne', x, 'x0', y];
      case 'csrr': return ['csrrs', x, y, 'x0'];
      case 'csrw': return ['csrrw', 'x0', x, y];
      case 'csrwi': return ['csrrwi', 'x0', x, y];
      case 'csrsi': return ['csrrsi', 'x0', x, y];
      case 'csrci': return ['csrrci', 'x0', x, y];
      case 'li': {
        const n = integer(y);
        if (n < -2048n || n > 2047n) throw new Error('li 仅支持 12 位有符号立即数（−2048 … 2047），不支持展开为多条指令');
        return ['addi', x, 'x0', y];
      }
    }
  }
  const bits = (word, hi, lo) => (word >> BigInt(lo)) & ((1n << BigInt(hi - lo + 1)) - 1n);
  const signed = (value, size) => BigInt.asIntN(size, value);
  function assemble(text, opts) {
    const o = options(opts);
    if (typeof text !== 'string' || /[\r\n;]/.test(text)) throw new Error('请输入单条指令，不支持汇编指示符、注释或多行程序');
    const m = /^([a-z][a-z0-9.]*)\b(?:\s+(.*))?$/i.exec(text.trim());
    if (!m) throw new Error('请输入指令助记符');
    let name = m[1].toLowerCase();
    let a = m[2] === undefined ? [] : m[2].toLowerCase().split(',').map(s => s.trim());
    if (a.some(s => !s)) throw new Error('操作数为空或逗号位置错误');
    const p = pseudo(name, a);
    if (p) { name = p[0]; a = p.slice(1); }
    const d = TABLE.find(row => row.name === name);
    if (!d) throw new Error(`暂不支持的指令：${name}`);
    if (!enabled(d, o)) throw new Error(`${name} 需要${d.rv64 ? '使用 RV64 并' : ''}启用 ${d.extension} 扩展`);
    let word = d.match;
    const put = (n, lo) => { word |= n << BigInt(lo); };
    const imm12 = t => range(integer(t), -2048n, 2047n, '12 位有符号立即数');
    let immediate;
    switch (d.kind) {
      case 'fixed': count(a, 0); break;
      case 'fence':
        if (!a.length) a = ['iorw', 'iorw'];
        count(a, 2); put(fenceSet(a[0]), 24); put(fenceSet(a[1]), 20); break;
      case 'R':
        count(a, 3); put(reg(a[0]), 7); put(reg(a[1]), 15); put(reg(a[2]), 20); break;
      case 'I': case 'shift':
        count(a, 3); put(reg(a[0]), 7); put(reg(a[1]), 15);
        immediate = d.kind === 'I' ? BigInt.asUintN(12, imm12(a[2])) :
          range(integer(a[2]), 0n, (1n << BigInt(width(d, o))) - 1n, '移位量');
        put(immediate, 20); break;
      case 'csr': case 'csri':
        count(a, 3); put(reg(a[0]), 7); put(csr(a[1]), 20);
        put(d.kind === 'csr' ? reg(a[2]) : range(integer(a[2]), 0n, 31n, 'CSR 无符号立即数 zimm'), 15); break;
      case 'load': case 'store': case 'jalr': {
        let base, imm;
        if (d.kind === 'jalr' && a.length === 3) { base = reg(a[1]); imm = imm12(a[2]); }
        else { count(a, 2); [base, imm] = memory(a[1]); }
        put(base, 15); imm = BigInt.asUintN(12, imm);
        if (d.kind === 'store') {
          put(reg(a[0]), 20); put(bits(imm, 4, 0), 7); put(bits(imm, 11, 5), 25);
        } else { put(reg(a[0]), 7); put(imm, 20); }
        break;
      }
      case 'U':
        count(a, 2); put(reg(a[0]), 7);
        put(BigInt.asUintN(20, range(integer(a[1]), -524288n, 1048575n, 'U 型 20 位立即数')), 12); break;
      case 'B': case 'J': {
        count(a, d.kind === 'B' ? 3 : 2);
        const size = d.kind === 'B' ? 13 : 21;
        const limit = 1n << BigInt(size - 1);
        immediate = range(integer(a[a.length - 1]), -limit, limit - 2n, 'PC 相对偏移');
        if (immediate % 2n !== 0n) throw new Error('PC 相对偏移必须为偶数（以 2 字节为步长）');
        immediate = BigInt.asUintN(size, immediate);
        if (d.kind === 'B') {
          put(reg(a[0]), 15); put(reg(a[1]), 20);
          put(bits(immediate, 12, 12), 31); put(bits(immediate, 10, 5), 25);
          put(bits(immediate, 4, 1), 8); put(bits(immediate, 11, 11), 7);
        } else {
          put(reg(a[0]), 7); put(bits(immediate, 20, 20), 31);
          put(bits(immediate, 10, 1), 21); put(bits(immediate, 11, 11), 20);
          put(bits(immediate, 19, 12), 12);
        }
        break;
      }
    }
    return decode(word, opts);
  }

  function fieldsFor(d, word, o) {
    const fields = [];
    function field(name, hi, lo, category, description) {
      fields.push({ name, hi, lo, value: bits(word, hi, lo), category, description });
    }
    const fn = (name, hi, lo, description = '指令功能码，与其他固定字段共同确定操作') => field(name, hi, lo, 'function', description);
    const imm = (name, hi, lo) => field(name, hi, lo, 'immediate', '立即数的原始编码位（无符号片段，需拼接后按指令语义解释）');
    const rd = () => field('rd', 11, 7, 'destination', '整数目标寄存器编号，对应 x0–x31');
    const rs1 = () => field('rs1', 19, 15, 'source', '第一整数源寄存器或访存基址寄存器编号');
    const rs2 = () => field('rs2', 24, 20, 'source', '第二整数源寄存器编号；存储指令中提供待写入数据');
    field('opcode', 6, 0, 'opcode', '指令主操作码，用于区分指令大类');
    if (d.format === 'U') { rd(); imm('imm[31:12]', 31, 12); }
    else if (d.format === 'J') {
      rd(); imm('imm[19:12]', 19, 12); imm('imm[11]', 20, 20);
      imm('imm[10:1]', 30, 21); imm('imm[20]', 31, 31);
    } else {
      fn('funct3', 14, 12);
      if (d.kind === 'fixed' || d.kind === 'fence') {
        fn('rd', 11, 7, '本工具支持的规范编码要求此字段为 0');
        fn('rs1', 19, 15, '本工具支持的规范编码要求此字段为 0');
        if (d.kind === 'fence') {
          field('succ', 23, 20, 'immediate', '后序操作集合：i 设备输入、o 设备输出、r 内存读取、w 内存写入');
          field('pred', 27, 24, 'immediate', '前序操作集合：i 设备输入、o 设备输出、r 内存读取、w 内存写入');
          fn('fm', 31, 28, '屏障模式：目前仅支持普通模式（0）');
        } else fn(d.name === 'fence.i' ? 'reserved' : 'funct12', 31, 20,
          d.name === 'fence.i' ? '本工具支持的规范编码要求此字段为 0' : '系统操作编码：0 表示 ECALL，1 表示 EBREAK');
      } else if (d.format === 'S' || d.format === 'B') {
        rs1(); rs2();
        if (d.format === 'S') { imm('imm[4:0]', 11, 7); imm('imm[11:5]', 31, 25); }
        else {
          imm('imm[11]', 7, 7); imm('imm[4:1]', 11, 8);
          imm('imm[10:5]', 30, 25); imm('imm[12]', 31, 31);
        }
      } else {
        rd();
        if (d.kind === 'csri') field('zimm', 19, 15, 'immediate', '5 位无符号 CSR 立即数，范围为 0–31');
        else rs1();
        if (d.kind === 'R') { rs2(); fn('funct7', 31, 25); }
        else if (d.kind === 'shift') {
          const w = width(d, o);
          field('shamt', 19 + w, 20, 'immediate', `${w} 位无符号移位量`);
          fn(w === 6 ? 'funct6' : 'funct7', 31, 20 + w);
        } else if (d.kind === 'csr' || d.kind === 'csri') fn('csr', 31, 20, '12 位无符号 CSR 地址；不检查访问权限或是否实现');
        else imm('imm[11:0]', 31, 20);
      }
    }
    return fields.sort((a, b) => b.hi - a.hi);
  }
  function decode(word, opts) {
    const o = options(opts);
    if (typeof word !== 'bigint') throw new Error('decode 需要 32 位无符号 BigInt；文本输入请先调用 parseWord');
    range(word, 0n, MAX_WORD, '32 位机器码');
    const d = TABLE.find(row => (word & mask(row, o)) === row.match);
    if (!d) throw new Error('本工具无法识别该编码：可能为未支持、保留或非规范编码；这不代表已判定架构非法');
    if (!enabled(d, o)) throw new Error(`${d.name} 需要${d.rv64 ? '使用 RV64 并' : ''}启用 ${d.extension} 扩展`);
    const rd = `x${bits(word, 11, 7)}`, rs1 = `x${bits(word, 19, 15)}`, rs2 = `x${bits(word, 24, 20)}`;
    const imm = signed(bits(word, 31, 20), 12);
    let a, offset;
    switch (d.kind) {
      case 'R': a = [rd, rs1, rs2]; break;
      case 'I': a = [rd, rs1, imm]; break;
      case 'shift': a = [rd, rs1, bits(word, 19 + width(d, o), 20)]; break;
      case 'load': case 'jalr': a = [rd, `${imm}(${rs1})`]; break;
      case 'store': a = [rs2, `${signed((bits(word, 31, 25) << 5n) | bits(word, 11, 7), 12)}(${rs1})`]; break;
      case 'csr': case 'csri': a = [rd, `0x${bits(word, 31, 20).toString(16).padStart(3, '0')}`,
        d.kind === 'csr' ? rs1 : bits(word, 19, 15)]; break;
      case 'U': a = [rd, `0x${bits(word, 31, 12).toString(16).padStart(5, '0')}`]; break;
      case 'B':
        offset = signed((bits(word, 31, 31) << 12n) | (bits(word, 7, 7) << 11n) |
          (bits(word, 30, 25) << 5n) | (bits(word, 11, 8) << 1n), 13);
        a = [rs1, rs2, offset]; break;
      case 'J':
        offset = signed((bits(word, 31, 31) << 20n) | (bits(word, 19, 12) << 12n) |
          (bits(word, 20, 20) << 11n) | (bits(word, 30, 21) << 1n), 21);
        a = [rd, offset]; break;
      case 'fence': a = [fenceText(bits(word, 27, 24)), fenceText(bits(word, 23, 20))]; break;
      case 'fixed': a = []; break;
    }
    const result = { word, assembly: d.name + (a.length ? ' ' + a.join(', ') : ''),
      mnemonic: d.name, format: d.format, extension: d.extension, mask: mask(d, o), match: d.match,
      fields: fieldsFor(d, word, o) };
    if (offset !== undefined) result.offset = offset;
    return result;
  }
  function definitions(opts) {
    const o = options(opts);
    return TABLE.filter(d => enabled(d, o)).map(d => ({ name: d.name, format: d.format,
      extension: d.extension, syntax: d.name + (SYNTAX[d.kind] ? ' ' + SYNTAX[d.kind] : '') }));
  }
  const api = Object.freeze({ parseWord, assemble, decode, definitions });
  root.RISCVCodec = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
