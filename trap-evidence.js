(function (root) {
  'use strict';
  const extras = typeof module !== 'undefined' && module.exports ? require('./trap-registers.js') : root.TrapRegisters;
  const routing = 'mie mip sie sip vsie vsip medeleg mideleg hedeleg hideleg hie hip hvip hgeie hgeip'.split(' ');
  function mapping(target) {
    const prefix = { M:'m', S:'s', VS:'vs' }[target];
    return new Map([
      [prefix + 'cause', ['mcause', 'XLEN']], [prefix + 'epc', ['mepc', 'XLEN']], [prefix + 'tval', ['mtval', 'XLEN']],
      ['mstatus', ['status', 'XLEN']], ['sstatus', ['hsstatus', 'XLEN']], ['vsstatus', ['vsstatus', 'XLEN']],
      ['hstatus', ['hstatus', 'XLEN']], ['mstatush', ['mstatush', 32]],
      ...routing.map(name => [name, [name, 'XLEN']]),
      ...extras.map(reg => [reg.id, [reg.id, reg.width]]),
      ...Array.from({ length:32 }, (_, i) => ['x' + i, ['gpr-' + i, 'XLEN']]),
      ...(target === 'VS' ? [] : [[target === 'M' ? 'mtval2' : 'htval', ['mtval2', 'XLEN']], [target === 'M' ? 'mtinst' : 'htinst', ['trap-inst', 'XLEN']]])
    ]);
  }
  function object(value, label, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' 必须是对象');
    for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(label + '.' + key + '：未知字段');
  }
  function string(value, label, max = 10000) {
    if (typeof value !== 'string' || value.length > max) throw new Error(label + ' 必须是字符串且不超过 ' + max + ' 字符');
  }
  function number(value, bits, label) {
    string(value, label, 260);
    if (!/^(?:0x[0-9a-f]+(?:_[0-9a-f]+)*|0b[01]+(?:_[01]+)*|0o[0-7]+(?:_[0-7]+)*|[0-9]+(?:_[0-9]+)*)$/i.test(value)) throw new Error(label + ' 必须是无符号整数字符串（允许下划线分组）');
    const result = BigInt(value.replaceAll('_', ''));
    if (result >= (1n << BigInt(bits))) throw new Error(label + ' 超出 ' + bits + ' 位');
    return '0x' + result.toString(16);
  }
  function validate(value) {
    object(value, 'evidence', ['version','xlen','target','source','registers','instruction','snapshot','translation','physical','notes']);
    if (value.version !== 1) throw new Error('version 必须为 1');
    if (![32,64].includes(value.xlen)) throw new Error('xlen 必须为 32 或 64');
    if (!['M','S','VS'].includes(value.target)) throw new Error('target 必须为 M、S 或 VS');
    const inputs = Object.create(null);
    const warnings = [];
    const definitions = mapping(value.target);
    object(value.registers, 'registers', [...definitions.keys()]);
    for (const [name, raw] of Object.entries(value.registers)) {
      const [id, bits] = definitions.get(name);
      const normalized = number(raw, bits === 'XLEN' ? value.xlen : Number(bits), 'registers.' + name);
      if (name === 'mstatus' && value.target !== 'M') throw new Error('当前主状态输入不是 mstatus；请使用目标级 status，原 MSTATUS 可记录在 notes 中');
      inputs[id] = normalized;
    }
    if (value.target === 'S' && inputs.hsstatus !== undefined) inputs.status = inputs.hsstatus;
    if (value.target === 'VS' && inputs.vsstatus !== undefined) inputs.status = inputs.vsstatus;
    if (inputs['gpr-0'] && BigInt(inputs['gpr-0']) !== 0n) throw new Error('x0 必须为零；原日志非零槽位请放在 log-x0');
    if (inputs['log-x0'] && BigInt(inputs['log-x0']) !== 0n) warnings.push('原日志 X0 非零，仅保存在 log-x0，不当作架构 x0');
    if (value.source !== undefined) {
      object(value.source, 'source', ['file','testcase','seed','hart','loop','time','context','instructionFile']);
      for (const [name, raw] of Object.entries(value.source)) {
        string(raw, 'source.' + name, 1000);
        if (['seed','hart','loop','time','context'].includes(name)) number(raw, 64, 'source.' + name);
      }
    }
    if (value.notes !== undefined) string(value.notes, 'notes', 200000);
    if (value.instruction !== undefined) {
      object(value.instruction, 'instruction', ['epc','word','assembly']);
      inputs['instruction-epc'] = number(value.instruction.epc, value.xlen, 'instruction.epc');
      inputs['fault-instruction'] = number(value.instruction.word, 32, 'instruction.word');
      if (value.instruction.assembly !== undefined) string(value.instruction.assembly, 'instruction.assembly');
      if (inputs.mepc !== undefined && inputs.mepc !== inputs['instruction-epc']) warnings.push('instruction.epc 与陷阱 EPC 不一致');
    }
    if (value.snapshot !== undefined) {
      object(value.snapshot, 'snapshot', ['timing','gprSource']);
      for (const [name, allowed, id] of [['timing',['unknown','entry','before'],'snapshot-time'], ['gprSource',['unknown','saved','handler'],'gpr-snapshot']]) {
        if (value.snapshot[name] === undefined) continue;
        if (!allowed.includes(value.snapshot[name])) throw new Error('snapshot.' + name + ' 可选值：' + allowed.join(', '));
        inputs[id] = value.snapshot[name];
      }
    }
    if (value.translation !== undefined) {
      const t = value.translation;
      object(t, 'translation', ['stage','root','address','access','privilege','sum','mxr','ad','profile','ptes']);
      for (const [name, allowed, id] of [
        ['stage',['s','vs','g'],'walk-stage'], ['access',['auto','fetch','read','write'],'walk-access'],
        ['privilege',['unknown','S','U'],'walk-privilege'], ['sum',['unknown','0','1'],'walk-sum'],
        ['mxr',['unknown','0','1'],'walk-mxr'], ['ad',['unknown','fault','hardware'],'walk-ad'], ['profile',['unknown','base'],'walk-profile']
      ]) {
        if (t[name] === undefined && name !== 'stage') continue;
        if (!allowed.includes(t[name])) throw new Error('translation.' + name + ' 可选值：' + allowed.join(', '));
        inputs[id] = t[name];
      }
      if (t.root !== undefined) inputs['walk-root'] = number(t.root, value.xlen, 'translation.root');
      if (t.address !== undefined) inputs['walk-address'] = number(t.address, t.stage === 'g' ? 64 : value.xlen, 'translation.address');
      if (t.ptes !== undefined) {
        object(t.ptes, 'translation.ptes', ['0','1','2','3','4']);
        for (const [level, raw] of Object.entries(t.ptes)) inputs['pte-' + level] = raw === 'unreadable' ? raw : number(raw, value.xlen, 'translation.ptes.' + level);
      }
      const root = inputs[{ s:'satp', vs:'vsatp', g:'hgatp' }[t.stage]];
      if (root !== undefined && inputs['walk-root'] !== undefined && root !== inputs['walk-root']) warnings.push('translation.root 与对应分页 CSR 不一致');
    }
    if (value.physical !== undefined) {
      object(value.physical, 'physical', ['pa','sizeBytes','operation','failure','pmp','pma','bus','trace']);
      for (const [name, raw] of Object.entries(value.physical)) {
        if (name === 'pa' || name === 'sizeBytes') number(raw, 64, 'physical.' + name);
        else string(raw, 'physical.' + name);
      }
      if (value.physical.sizeBytes !== undefined && BigInt(value.physical.sizeBytes.replaceAll('_', '')) === 0n) throw new Error('physical.sizeBytes 必须大于零');
    }
    return { document:value, inputs, warnings };
  }
  function parse(text) {
    if (text.length > 500000) throw new Error('证据 JSON 超过 500000 字符');
    return validate(JSON.parse(text));
  }
  function fromLog(text, { xlen, target, record, source = 'trap.log' }) {
    const chunks = text.split(/(?=^\s*Loop:\s*\d+\s*,)/m).filter(chunk => /^\s*(?:MCAUSE|SCAUSE|VSCAUSE|CAUSE)\s*:/mi.test(chunk));
    if (!chunks.length) throw new Error('未找到包含 CAUSE 的故障现场');
    if (record === undefined && chunks.length !== 1) throw new Error('检测到 ' + chunks.length + ' 份现场，请使用 --record 指定 1 起始序号');
    const chosen = record === undefined ? 1 : record;
    if (!Number.isInteger(chosen) || chosen < 1 || chosen > chunks.length) throw new Error('--record 超出现场数量');
    const chunk = chunks[chosen - 1];
    if ((chunk.match(/^\s*Context\[\d+\]/gm) || []).length > 1) throw new Error('同一轮含多个 Context，请先按线程拆分日志');
    const prefix = { M:'m', S:'s', VS:'vs' }[target];
    const aliases = { CAUSE:prefix+'cause', EPC:prefix+'epc', TVAL:prefix+'tval', TVAL2:target === 'M' ? 'mtval2' : 'htval', STATUS:'log-status', FFLAG:'fflags' };
    const registers = Object.create(null), sourceInfo = { file:source }, notes = [];
    const defs = mapping(target);
    for (const match of chunk.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*)\s*:\s*(0x[0-9a-fA-F_]+|[0-9][0-9_]*)\s*$/gm)) {
      const key = match[1].toUpperCase(), raw = match[2];
      const name = key === 'X0' && BigInt(raw.replaceAll('_','')) !== 0n ? 'log-x0' : aliases[key] || key.toLowerCase();
      if (!defs.has(name)) { notes.push(match[0].trim()); continue; }
      const normalized = number(raw, /^[FV]\d+$/.test(key) ? 128 : xlen, key);
      if (registers[name] !== undefined && registers[name] !== normalized) throw new Error('同一现场重复寄存器 ' + name + ' 数值冲突');
      registers[name] = normalized;
    }
    const loop = /Loop:\s*(\d+)\s*,\s*seed:\s*(0x[\da-f]+)\s*,\s*testcase:\s*([^,\r\n]+),\s*time:\s*(0x[\da-f]+)/i.exec(chunk);
    if (loop) Object.assign(sourceInfo, { loop:loop[1], seed:loop[2], testcase:loop[3].trim(), time:loop[4] });
    const hart = /THREAD_ID:\s*(0x[\da-f]+|\d+)/i.exec(chunk);
    if (hart) sourceInfo.hart = hart[1];
    const context = /Context\[\d+\]:\s*(0x[\da-f]+)/i.exec(chunk);
    if (context) sourceInfo.context = context[1];
    if (registers['log-x0']) notes.push('X0 非零原始槽位已保留，未将其作为架构 x0。');
    notes.push('日志转换不证明采样时点、现场真实性或同 seed 的 ELF 归属；未推断指令、GPA 或 PTE。');
    const result = { version:1, xlen, target, source:sourceInfo, registers, snapshot:{ timing:'unknown', gprSource:'unknown' }, notes:notes.join('\n') };
    validate(result);
    return result;
  }
  const api = { mapping, validate, parse, fromLog };
  root.TrapEvidence = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
