/* 默认 RV32I，可选扩展需显式启用。解码失败仅表示不在本工具支持的规范编码范围内，
 * 不代表架构非法。CSR 仅校验编码，不检查特权级、访问权限或寄存器是否实现。
 */
(function (root) {
  'use strict';
  const MAX_WORD = 0xffffffffn;
  const EXTENSIONS = ['I', 'M', 'A', 'F', 'D', 'V', 'Zicsr', 'Zifencei'];
  const FLOAT_ABI = 'ft0 ft1 ft2 ft3 ft4 ft5 ft6 ft7 fs0 fs1 fa0 fa1 fa2 fa3 fa4 fa5 fa6 fa7 fs2 fs3 fs4 fs5 fs6 fs7 fs8 fs9 fs10 fs11 ft8 ft9 ft10 ft11'.split(' ');
  const ROUNDING = ['rne', 'rtz', 'rdn', 'rup', 'rmm', null, null, 'dyn'];
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

  for (const [suffix, extension, fmt] of [['s', 'F', 0], ['d', 'D', 1]]) {
    add('fl' + (fmt ? 'd' : 'w'), 'I', 'fload', 0x07 + (fmt + 2) * 0x1000, extension);
    add('fs' + (fmt ? 'd' : 'w'), 'S', 'fstore', 0x27 + (fmt + 2) * 0x1000, extension);
    const fp = (name, funct7, operandTypes, rounding = false, funct3 = 0, rs2 = null, rv64 = false) => {
      TABLE.push({ name, format:'R', kind:'fp', extension, rv64, operandTypes, rounding,
        match:BigInt(funct7) << 25n | BigInt(rs2 || 0) << 20n | BigInt(funct3) << 12n | 0x53n,
        fixedMask:0xfe00007fn | (rounding ? 0n : 0x7000n) | (rs2 === null ? 0n : 0x1f00000n) });
    };
    ['fadd','fsub','fmul','fdiv'].forEach((name, index) => fp(name + '.' + suffix, index * 4 + fmt, 'fff', true));
    fp('fsqrt.' + suffix, 44 + fmt, 'ff', true, 0, 0);
    ['fsgnj','fsgnjn','fsgnjx'].forEach((name, index) => fp(name + '.' + suffix, 16 + fmt, 'fff', false, index));
    ['fmin','fmax'].forEach((name, index) => fp(name + '.' + suffix, 20 + fmt, 'fff', false, index));
    ['fle','flt','feq'].forEach((name, index) => fp(name + '.' + suffix, 80 + fmt, 'xff', false, index));
    fp('fclass.' + suffix, 112 + fmt, 'xf', false, 1, 0);
    fp(fmt ? 'fmv.x.d' : 'fmv.x.w', 112 + fmt, 'xf', false, 0, 0, !!fmt);
    fp(fmt ? 'fmv.d.x' : 'fmv.w.x', 120 + fmt, 'fx', false, 0, 0, !!fmt);
    ['w','wu','l','lu'].forEach((integerType, index) => {
      fp('fcvt.' + integerType + '.' + suffix, 96 + fmt, 'xf', true, 0, index, index >= 2);
      fp('fcvt.' + suffix + '.' + integerType, 104 + fmt, 'fx', true, 0, index, index >= 2);
    });
    ['fmadd','fmsub','fnmsub','fnmadd'].forEach((name, index) => TABLE.push({ name:name + '.' + suffix, format:'R4', kind:'fp', extension, rv64:false,
      operandTypes:'ffff', rounding:true, fixedMask:0x0600007fn, match:BigInt(0x43 + index * 4) | BigInt(fmt) << 25n }));
  }
  for (const [name, funct7, rs2] of [['fcvt.s.d',32,1], ['fcvt.d.s',33,0]]) TABLE.push({ name, format:'R', kind:'fp', extension:'D', rv64:false, operandTypes:'ff', rounding:true,
    fixedMask:0xfff0007fn, match:BigInt(funct7) << 25n | BigInt(rs2) << 20n | 0x53n });

  function structured(name, extension, match, operands, controls, extra = {}) {
    let fixedMask = MAX_WORD;
    for (const [, , hi, lo] of operands) fixedMask &= ~(((1n << BigInt(hi - lo + 1)) - 1n) << BigInt(lo));
    if (extra.masked) fixedMask &= ~(1n << 25n);
    TABLE.push({ name, format:extension === 'A' ? 'AMO' : 'V', kind:'structured', extension, rv64:false,
      match:BigInt(match), fixedMask, operands, controls, ...extra });
  }
  const XRD = ['rd','x',11,7], XRS1 = ['rs1','x',19,15], XRS2 = ['rs2','x',24,20];
  const VD = ['vd','v',11,7], VS1 = ['vs1','v',19,15], VS2 = ['vs2','v',24,20];
  const BASE = ['rs1','base',19,15];
  for (const [size, funct3] of [['w',2],['d',3]]) {
    for (const [name, funct5] of [['lr',2],['sc',3],['amoswap',1],['amoadd',0],['amoxor',4],['amoand',12],['amoor',8],['amomin',16],['amomax',20],['amominu',24],['amomaxu',28]]) {
      for (const [suffix, order] of [['',0],['.aq',2],['.rl',1],['.aqrl',3]]) {
        structured(name + '.' + size + suffix, 'A', BigInt(funct5) << 27n | BigInt(order) << 25n | BigInt(funct3) << 12n | 0x2fn,
          name === 'lr' ? [XRD, BASE] : [XRD, XRS2, BASE],
          [['funct5',31,27],['aq',26,26],['rl',25,25], ...(name === 'lr' ? [['rs2=0',24,20]] : []), ['width',14,12],['opcode',6,0]], { rv64:size === 'd' });
      }
    }
  }
  const configControls = [['opcode',6,0], ['funct3',14,12]];
  structured('vsetvli', 'V', 0x7057n, [XRD, XRS1, ['vtypei','vtype',30,20]], [...configControls,['fixed',31,31]]);
  structured('vsetivli', 'V', 0xc0007057n, [XRD, ['uimm','u',19,15], ['vtypei','vtype',29,20]], [...configControls,['fixed',31,30]]);
  structured('vsetvl', 'V', 0x80007057n, [XRD, XRS1, XRS2], [...configControls,['funct7',31,25]]);
  const memControls = [['nf',31,29],['mew',28,28],['mop',27,26],['vm',25,25],['width',14,12],['opcode',6,0]];
  function vectorMemory(name, store, eew, nf, mop, mode, special = {}) {
    const operands = [[store ? 'vs3' : 'vd','v',11,7], BASE];
    if (mop === 2) operands.push(XRS2);
    else if (mop === 1 || mop === 3) operands.push(VS2);
    structured(name, 'V', BigInt(nf) << 29n | BigInt(mop) << 26n | BigInt(mode) << 20n | BigInt({8:0,16:5,32:6,64:7}[eew]) << 12n | BigInt(store ? 0x27 : 0x07) | (special.unmasked ? 1n << 25n : 0n),
      operands, [...memControls, ...(mop === 0 ? [[store ? 'sumop' : 'lumop',24,20]] : [])], { masked:!special.unmasked, ...special });
  }
  for (const eew of [8,16,32,64]) {
    for (let segments = 1; segments <= 8; segments++) {
      for (const store of [false,true]) {
        const prefix = store ? 'vs' : 'vl';
        vectorMemory(segments === 1 ? prefix + 'e' + eew + '.v' : prefix + 'seg' + segments + 'e' + eew + '.v', store, eew, segments - 1, 0, 0);
        vectorMemory(segments === 1 ? prefix + 'se' + eew + '.v' : prefix + 'sseg' + segments + 'e' + eew + '.v', store, eew, segments - 1, 2, 0);
        for (const [suffix, mop] of [['ux',1],['ox',3]]) vectorMemory(prefix + suffix + (segments === 1 ? 'ei' : 'seg' + segments + 'ei') + eew + '.v', store, eew, segments - 1, mop, 0);
      }
      vectorMemory(segments === 1 ? 'vle' + eew + 'ff.v' : 'vlseg' + segments + 'e' + eew + 'ff.v', false, eew, segments - 1, 0, 16);
    }
    for (const count of [1,2,4,8]) vectorMemory('vl' + count + 're' + eew + '.v', false, eew, count - 1, 0, 8, { unmasked:true, group:count });
  }
  for (const count of [1,2,4,8]) vectorMemory('vs' + count + 'r.v', true, 8, count - 1, 0, 8, { unmasked:true, group:count });
  vectorMemory('vlm.v', false, 8, 0, 0, 11, { unmasked:true });
  vectorMemory('vsm.v', true, 8, 0, 0, 11, { unmasked:true });
  function vectorAlu(name, funct6, forms, funct3Base = 0, unsigned = false) {
    for (const form of forms) {
      const funct3 = form === 'vv' || form === 'vs' ? funct3Base : form === 'vx' ? funct3Base + 4 : 3;
      const source = form === 'vx' ? XRS1 : form === 'vi' ? [unsigned ? 'uimm' : 'simm5',unsigned ? 'u' : 'i',19,15] : VS1;
      structured(name + '.' + form, 'V', BigInt(funct6) << 26n | BigInt(funct3) << 12n | 0x57n, [VD, VS2, source],
        [['funct6',31,26],['vm',25,25],['funct3',14,12],['opcode',6,0]], { masked:true });
    }
  }
  for (const [name, fn, forms, unsigned] of [
    ['vadd',0,['vv','vx','vi']], ['vsub',2,['vv','vx']], ['vrsub',3,['vx','vi']],
    ['vminu',4,['vv','vx']], ['vmin',5,['vv','vx']], ['vmaxu',6,['vv','vx']], ['vmax',7,['vv','vx']],
    ['vand',9,['vv','vx','vi']], ['vor',10,['vv','vx','vi']], ['vxor',11,['vv','vx','vi']],
    ['vrgather',12,['vv','vx','vi'],true], ['vslideup',14,['vx','vi'],true], ['vslidedown',15,['vx','vi'],true],
    ['vmseq',24,['vv','vx','vi']], ['vmsne',25,['vv','vx','vi']], ['vmsltu',26,['vv','vx']], ['vmslt',27,['vv','vx']],
    ['vmsleu',28,['vv','vx','vi']], ['vmsle',29,['vv','vx','vi']], ['vmsgtu',30,['vx','vi']], ['vmsgt',31,['vx','vi']],
    ['vsaddu',32,['vv','vx','vi']], ['vsadd',33,['vv','vx','vi']], ['vssubu',34,['vv','vx']], ['vssub',35,['vv','vx']],
    ['vsll',37,['vv','vx','vi'],true], ['vsmul',39,['vv','vx']], ['vsrl',40,['vv','vx','vi'],true], ['vsra',41,['vv','vx','vi'],true],
    ['vssrl',42,['vv','vx','vi'],true], ['vssra',43,['vv','vx','vi'],true]
  ]) vectorAlu(name, fn, forms, 0, unsigned);
  for (const [index, name] of ['vredsum','vredand','vredor','vredxor','vredminu','vredmin','vredmaxu','vredmax'].entries()) vectorAlu(name,index,['vs'],2);
  for (const [index, name] of ['vdivu','vdiv','vremu','vrem','vmulhu','vmul','vmulhsu','vmulh'].entries()) vectorAlu(name,32+index,['vv','vx'],2);
  for (const [suffix, source, funct3] of [['v',VS1,0],['x',XRS1,4],['i',['simm5','i',19,15],3]]) {
    structured('vmv.v.' + suffix, 'V', 0x5e000057n | BigInt(funct3) << 12n, [VD, source],
      [['funct6',31,26],['vm',25,25],['vs2=0',24,20],['funct3',14,12],['opcode',6,0]]);
  }
  function vectorReg(text) {
    if (!/^v(?:[0-9]|[12][0-9]|3[01])$/.test(text)) throw new Error('向量寄存器须为 v0–v31');
    return BigInt(text.slice(1));
  }
  function baseReg(text) {
    const match = /^(?:0)?\(\s*([a-z0-9]+)\s*\)$/.exec(text);
    if (!match) throw new Error('此访存使用 (rs1) 或 0(rs1)，不支持非零偏移');
    return reg(match[1]);
  }
  const LMUL = ['m1','m2','m4','m8',null,'mf8','mf4','mf2'];
  function vtype(args, size) {
    if (args.length === 1) return range(integer(args[0]), 0n, (1n << BigInt(size)) - 1n, 'vtype 立即数');
    count(args,4);
    const sew = /^e(8|16|32|64|128|256|512|1024)$/.exec(args[0]);
    const lmul = LMUL.indexOf(args[1]);
    if (!sew || lmul < 0 || !['ta','tu'].includes(args[2]) || !['ma','mu'].includes(args[3])) throw new Error('vtype 格式为 e32, m1, ta, ma（或原始无符号立即数）');
    return BigInt(Math.log2(Number(sew[1])) - 3) << 3n | BigInt(lmul) | (args[2] === 'ta' ? 64n : 0n) | (args[3] === 'ma' ? 128n : 0n);
  }
  function vtypeText(value) {
    const lmul = LMUL[Number(value & 7n)];
    if ((value >> 8n) !== 0n || !lmul) return ['0x' + value.toString(16)];
    return ['e' + (8 * 2 ** Number((value >> 3n) & 7n)), lmul, value & 64n ? 'ta' : 'tu', value & 128n ? 'ma' : 'mu'];
  }

  function floatReg(text) {
    if (/^f(?:[0-9]|[12][0-9]|3[01])$/.test(text)) return BigInt(text.slice(1));
    const index = FLOAT_ABI.indexOf(text);
    if (index < 0) throw new Error('未知浮点寄存器：' + text + '（支持 f0–f31 / 浮点 ABI 名称）');
    return BigInt(index);
  }
  function rounding(text = 'dyn') {
    const index = ROUNDING.indexOf(text);
    if (index < 0 || text === null) throw new Error('舍入模式须为 rne / rtz / rdn / rup / rmm / dyn');
    return BigInt(index);
  }

  function options(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置必须为对象');
    const { xlen = 32, extensions = ['I'] } = value;
    if (xlen !== 32 && xlen !== 64) throw new Error('XLEN 必须为 32 或 64');
    if (!Array.isArray(extensions) || extensions.some(e => !EXTENSIONS.includes(e)))
      throw new Error('支持的扩展为 I、M、A、F、D、V、Zicsr、Zifencei');
    return { xlen, extensions: new Set(['I', ...extensions, ...(extensions.includes('D') ? ['F'] : [])]) };
  }
  function enabled(d, o) { return (!d.rv64 || o.xlen === 64) && o.extensions.has(d.extension); }
  function width(d, o) { return d.rv64 ? 5 : o.xlen === 64 ? 6 : 5; }
  function mask(d, o) {
    if (d.fixedMask !== undefined) return d.fixedMask;
    if (d.kind === 'fixed') return MAX_WORD;
    if (d.kind === 'fence') return 0xf00fffffn;
    if (d.kind === 'R') return 0xfe00707fn;
    if (d.kind === 'shift') return width(d, o) === 6 ? 0xfc00707fn : 0xfe00707fn;
    return d.format === 'U' || d.format === 'J' ? 0x7fn : 0x707fn;
  }
  function integer(text) {
    if (typeof text !== 'string' || !/^[+-]?(?:0x[0-9a-f]+(?:_[0-9a-f]+)*|0b[01]+(?:_[01]+)*|[0-9]+(?:_[0-9]+)*)$/i.test(text))
      throw new Error('请输入十进制、0x 十六进制或 0b 二进制整数，允许数字间单个下划线，不支持符号名称或表达式');
    const sign = text[0] === '-' ? -1n : 1n;
    return sign * BigInt(text.replace(/^[+-]/, '').replaceAll('_', ''));
  }
  function range(n, min, max, label) {
    if (n < min || n > max) throw new Error(`${label}必须在 [${min}, ${max}] 范围内`);
    return n;
  }
  function parseWord(text) {
    if (typeof text !== 'string' || !/^(?:0x[0-9a-f]+(?:_[0-9a-f]+)*|0b[01]+(?:_[01]+)*|[0-9]+(?:_[0-9]+)*)$/i.test(text.trim()))
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
    if (name === 'fmv.s.x') name = 'fmv.w.x';
    if (name === 'fmv.x.s') name = 'fmv.x.w';
    if (/^f(mv|abs|neg)\.[sd]$/.test(name)) {
      count(a, 2);
      name = ({ fmv:'fsgnj', fabs:'fsgnjx', fneg:'fsgnjn' })[name.split('.')[0]] + '.' + name.split('.')[1];
      a = [a[0], a[1], a[1]];
    }
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
      case 'structured': {
        let masked = false;
        if (d.masked && a[a.length - 1] === 'v0.t') { masked = true; a = a.slice(0,-1); }
        const configIndex = d.operands.findIndex(operand => operand[1] === 'vtype');
        if (configIndex < 0) count(a, d.operands.length);
        else if (![configIndex + 1, configIndex + 4].includes(a.length)) throw new Error('配置指令需要 rd、AVL 和 vtype（立即数或 e32,m1,ta,ma）');
        d.operands.forEach(([, type, hi, lo], index) => {
          const size = hi - lo + 1;
          const value = type === 'x' ? reg(a[index]) : type === 'v' ? vectorReg(a[index]) : type === 'base' ? baseReg(a[index])
            : type === 'vtype' ? vtype(a.slice(index), size) : type === 'i' ? BigInt.asUintN(size, range(integer(a[index]), -(1n << BigInt(size - 1)), (1n << BigInt(size - 1)) - 1n, '有符号立即数'))
            : range(integer(a[index]), 0n, (1n << BigInt(size)) - 1n, '无符号立即数');
          put(value, lo);
        });
        if (d.masked && !masked) put(1n,25);
        break;
      }
      case 'fp': {
        const n = d.operandTypes.length;
        if (d.rounding && a.length === n) a.push('dyn');
        count(a, n + (d.rounding ? 1 : 0));
        [...d.operandTypes].forEach((type, index) => put(type === 'f' ? floatReg(a[index]) : reg(a[index]), [7,15,20,27][index]));
        if (d.rounding) put(rounding(a[n]), 12);
        break;
      }
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
      case 'load': case 'store': case 'fload': case 'fstore': case 'jalr': {
        let base, imm;
        if (d.kind === 'jalr' && a.length === 3) { base = reg(a[1]); imm = imm12(a[2]); }
        else { count(a, 2); [base, imm] = memory(a[1]); }
        put(base, 15); imm = BigInt.asUintN(12, imm);
        const dataReg = d.kind === 'fload' || d.kind === 'fstore' ? floatReg(a[0]) : reg(a[0]);
        if (d.kind === 'store' || d.kind === 'fstore') {
          put(dataReg, 20); put(bits(imm, 4, 0), 7); put(bits(imm, 11, 5), 25);
        } else { put(dataReg, 7); put(imm, 20); }
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
      const fieldMask = (1n << BigInt(hi - lo + 1)) - 1n;
      const fixedMask = (mask(d, o) >> BigInt(lo)) & fieldMask;
      const fixedValue = (d.match >> BigInt(lo)) & fixedMask;
      fields.push({ name, hi, lo, value: bits(word, hi, lo), category, description,
        fixedMask, fixedValue, fixed:fixedMask === fieldMask });
    }
    const fn = (name, hi, lo, description = '指令功能码，与其他固定字段共同确定操作') => field(name, hi, lo, 'function', description);
    const imm = (name, hi, lo) => field(name, hi, lo, 'immediate', '立即数的原始编码位（无符号片段，需拼接后按指令语义解释）');
    const rd = () => field('rd', 11, 7, 'destination', '整数目标寄存器编号，对应 x0–x31');
    const rs1 = () => field('rs1', 19, 15, 'source', '第一整数源寄存器或访存基址寄存器编号');
    const rs2 = () => field('rs2', 24, 20, 'source', '第二整数源寄存器编号；存储指令中提供待写入数据');
    if (d.kind === 'structured') {
      const descriptions = { x:'整数寄存器 x0–x31', v:'向量寄存器 v0–v31；寄存器组约束还需结合 LMUL / EMUL', base:'整数基址寄存器，无立即数偏移', i:'5 位有符号立即数，使用补码', u:'无符号立即数', vtype:'vtype 原始配置：vlmul[2:0]、vsew[5:3]、vta[6]、vma[7]；不支持的配置可令 vill 置位' };
      for (const [name,type,hi,lo] of d.operands) field(name,hi,lo, ['i','u','vtype'].includes(type) ? 'immediate' : name === 'rd' || name === 'vd' ? 'destination' : 'source', descriptions[type]);
      const controls = { vm:'0 使用 v0.t 掩码；1 不屏蔽元素（部分指令固定为 1）', aq:'Acquire 顺序约束，不等同于完整内存屏障', rl:'Release 顺序约束，不等同于完整内存屏障', nf:'段字段数减一，整寄存器访存中为寄存器数减一', mew:'扩展内存元素宽度位；当前仅支持 0', mop:'访存模式：0 单位步长、1 无序索引、2 固定步长、3 有序索引', width:'访问 EEW 编码；索引访存中表示索引宽度而不是数据宽度' };
      for (const [name,hi,lo] of d.controls) field(name,hi,lo,name === 'opcode' ? 'opcode' : 'function', controls[name] || '固定编码字段，与其他位共同识别指令');
      return fields.sort((a,b) => b.hi - a.hi);
    }
    field('opcode', 6, 0, 'opcode', '指令主操作码，用于区分指令大类');
    if (d.kind === 'fp') {
      [...d.operandTypes].forEach((type, index) => {
        const lo = [7,15,20,27][index];
        field(index === 0 ? 'rd' : 'rs' + index, lo + 4, lo, index === 0 ? 'destination' : 'source', (type === 'f' ? '浮点寄存器 f0–f31' : '整数寄存器 x0–x31') + '编号');
      });
      if (d.operandTypes.length === 2) fn('rs2-fixed', 24, 20, '此转换 / 单源指令的固定编码');
      if (d.rounding) field('rm', 14, 12, 'function', '舍入模式：0 RNE、1 RTZ、2 RDN、3 RUP、4 RMM、7 dyn；5/6 保留');
      else fn('funct3', 14, 12);
      if (d.format === 'R4') fn('fmt', 26, 25, '浮点格式：0 单精度、1 双精度');
      else fn('funct7', 31, 25);
      return fields.sort((a,b) => b.hi - a.hi);
    }
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
        rs1();
        if (d.kind === 'fstore') field('rs2', 24, 20, 'source', '浮点存储源寄存器 f0–f31'); else rs2();
        if (d.format === 'S') { imm('imm[4:0]', 11, 7); imm('imm[11:5]', 31, 25); }
        else {
          imm('imm[11]', 7, 7); imm('imm[4:1]', 11, 8);
          imm('imm[10:5]', 30, 25); imm('imm[12]', 31, 31);
        }
      } else {
        if (d.kind === 'fload') field('rd', 11, 7, 'destination', '浮点加载目标寄存器 f0–f31'); else rd();
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
    if (d.kind === 'fp' && d.rounding && ROUNDING[Number(bits(word,14,12))] === null) throw new Error('浮点舍入模式 rm=5/6 为保留编码');
    const imm = signed(bits(word, 31, 20), 12);
    let a, offset;
    switch (d.kind) {
      case 'structured': {
        if (d.group && Number(bits(word,11,7)) % d.group !== 0) throw new Error('整寄存器访存组起始寄存器必须按寄存器数对齐');
        a = d.operands.flatMap(([,type,hi,lo]) => {
          const value = bits(word,hi,lo);
          if (type === 'vtype') return vtypeText(value);
          return [type === 'x' || type === 'v' ? type + value : type === 'base' ? `(x${value})` : type === 'i' ? signed(value, hi - lo + 1) : value];
        });
        if (d.masked && bits(word,25,25) === 0n) a.push('v0.t');
        break;
      }
      case 'fp':
        a = [...d.operandTypes].map((type, index) => type + bits(word, [11,19,24,31][index], [7,15,20,27][index]));
        if (d.rounding) a.push(ROUNDING[Number(bits(word,14,12))]);
        break;
      case 'fload': a = [`f${bits(word,11,7)}`, `${imm}(${rs1})`]; break;
      case 'fstore': a = [`f${bits(word,24,20)}`, `${signed((bits(word,31,25) << 5n) | bits(word,11,7),12)}(${rs1})`]; break;
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
    if (d.extension === 'V') result.note = '仅解析 V 1.0 编码；不推断 VL/VTYPE、LMUL/EMUL、寄存器重叠、对齐、掩码及实际内存权限是否满足执行条件。';
    if (d.extension === 'A') result.note = '仅解析 A 编码与 aq/rl；不模拟 reservation、原子性、对齐、PMA/PMP 或访问权限。';
    if (offset !== undefined) result.offset = offset;
    return result;
  }
  function definitions(opts) {
    const o = options(opts);
    return TABLE.filter(d => enabled(d, o)).map(d => ({ name: d.name, format: d.format,
      extension: d.extension, syntax: d.name + (d.kind === 'structured' ? ' ' + d.operands.map(([,type]) => ({ x:'x1', v:'v8', base:'(x2)', i:'-1', u:'1', vtype:'e32, m1, ta, ma' })[type]).join(', ') : d.kind === 'fp' ? ' ' + [...d.operandTypes].map((type,index) => type + [1,2,3,4][index]).join(', ') + (d.rounding ? ', dyn' : '') : d.kind === 'fload' || d.kind === 'fstore' ? ' f1, 0(x2)' : SYNTAX[d.kind] ? ' ' + SYNTAX[d.kind] : '') }));
  }
  const api = Object.freeze({ parseWord, assemble, decode, definitions });
  root.RISCVCodec = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
