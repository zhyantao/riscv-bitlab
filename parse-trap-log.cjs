const fs = require('node:fs');
const path = require('node:path');
const evidence = require('./trap-evidence.js');
try {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node parse-trap-log.cjs INPUT --xlen 64 --target M [--record 1] [--asm thread3.asm] [--output evidence.json]\n输出 JSON；不指定 --output 时输出到终端。输出文件必须不存在。');
  } else {
    const input = args.shift();
    if (!input || input.startsWith('--')) throw new Error('请指定日志路径；使用 --help 查看格式');
    const options = {};
    while (args.length) {
      const flag = args.shift(), value = args.shift();
      if (!['--xlen','--target','--record','--asm','--output'].includes(flag) || !value || options[flag] !== undefined) throw new Error('无效或重复参数：' + flag);
      options[flag] = value;
    }
    const xlen = Number(options['--xlen']), target = options['--target'];
    if (![32,64].includes(xlen) || !['M','S','VS'].includes(target)) throw new Error('必须显式指定 --xlen 32|64 和 --target M|S|VS');
    const result = evidence.fromLog(fs.readFileSync(input, 'utf8'), { xlen, target, record:options['--record'] === undefined ? undefined : Number(options['--record']), source:path.basename(input) });
    if (options['--asm']) {
      const epc = result.registers[{ M:'mepc', S:'sepc', VS:'vsepc' }[target]];
      if (!epc) throw new Error('缺少 EPC，无法关联反汇编');
      const matches = [...fs.readFileSync(options['--asm'], 'utf8').matchAll(/^\s*([0-9a-f]+):\s+([0-9a-f]{4}|[0-9a-f]{8})\s+([^\r\n]+)/gmi)].filter(match => BigInt('0x' + match[1]) === BigInt(epc));
      if (matches.length !== 1) throw new Error('反汇编中 EPC 匹配数量不是 1');
      result.instruction = { epc, word:'0x' + matches[0][2], assembly:matches[0][3].trim() };
      result.source.instructionFile = path.basename(options['--asm']);
      result.notes += '\n反汇编仅按 EPC 匹配；请另核对同轮 ELF 和 seed。';
    }
    evidence.validate(result);
    const json = JSON.stringify(result, null, 2) + '\n';
    if (options['--output']) fs.writeFileSync(options['--output'], json, { flag:'wx' });
    else process.stdout.write(json);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
