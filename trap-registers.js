(function (root) {
  const raw = (name, description, width = 'XLEN') => ({ id:name, name, width, fields:[['Value', width === 'XLEN' ? 63 : width - 1, 0, description, 'both']] });
  const registers = [
    raw('log-status', '日志 STATUS 保存槽位；不与 MSTATUS 合并，不假定是当前 CSR'),
    raw('log-x0', '日志 X0 槽位原值；不是架构 x0，非零需核对保存逻辑'),
    ...['satp', 'vsatp', 'hgatp'].map(name => raw(name, '完整分页 CSR；MODE / PPN 由对应位域定义解读')),
    { id:'mseccfg', name:'mseccfg', width:'XLEN', fields:[
      ['PMM',33,32,'Smmpm：M 模式指针屏蔽，0 禁用、2 PMLEN=7、3 PMLEN=16',64],
      ['MLPE',10,10,'Zicfilp：M 模式 landing pad 使能','both'],
      ['SSEED',9,9,'允许 S/HS 访问 seed','both'], ['USEED',8,8,'允许 U 访问 seed','both'],
      ['RLB',2,2,'绕过 PMP 锁定限制，受扩展规则约束','both'], ['MMWP',1,1,'M 模式未匹配 PMP 的访问策略','both'], ['MML',0,0,'机器模式锁定策略','both'] ] },
    ...['menvcfg','henvcfg','senvcfg'].map(name => ({ id:name, name, width:'XLEN', fields:[
      ...(name === 'senvcfg' ? [] : [['STCE',63,63,'Sstc 定时器比较寄存器使能',64], ['PBMTE',62,62,'Svpbmt 页内存类型使能',64], ['ADUE',61,61,'Svadu 硬件 A/D 更新使能',64], ...(name === 'menvcfg' ? [['CDE',60,60,'计数器委托使能',64]] : []), ['DTE',59,59,'监管级双重陷阱使能',64]]),
      ['PMM',33,32,'目标低特权级的指针屏蔽模式；0 禁用、2 PMLEN=7、3 PMLEN=16',64],
      ['CBZE',7,7,'CBO.ZERO 使能','both'], ['CBCFE',6,6,'CBO.CLEAN / FLUSH 使能','both'], ['CBIE',5,4,'CBO.INVAL 行为','both'],
      ['SSE',3,3,'影子栈使能','both'], ['LPE',2,2,'Landing pad 使能','both'], ['FIOM',0,0,'I/O fence 隐含内存顺序','both'] ] })),
    ...['mcounteren','hcounteren'].map(name => ({ id:name, name, width:'32', fields:[['HPM',31,3,'HPM3–31 计数器访问使能','both'],['IR',2,2,'instret 访问使能','both'],['TM',1,1,'time 访问使能','both'],['CY',0,0,'cycle 访问使能','both']] })),
    raw('mnscratch', 'RNMI 软件暂存'), raw('mnepc', 'RNMI 保存的 PC'),
    { id:'mncause', name:'mncause', width:'XLEN', fields:[['Interrupt',63,63,'RNMI 中断标志',64],['Code',62,0,'RNMI 原因编码',64],['Interrupt',31,31,'RNMI 中断标志',32],['Code',30,0,'RNMI 原因编码',32]] },
    { id:'mnstatus', name:'mnstatus', width:'XLEN', fields:[['MNPP',12,11,'RNMI 保存特权级：0 U、1 S、3 M','both'],['MNPV',7,7,'RNMI 保存虚拟化状态','both'],['NMIE',3,3,'RNMI 使能','both']] },
    raw('mntvec', '平台 / 草案 RNMI 向量现场；不假定与标准 mtvec 字段相同'),
    { id:'fflags', name:'fflags（日志 FFLAG）', width:'32', fields:[['NV',4,4,'无效操作','both'],['DZ',3,3,'除零','both'],['OF',2,2,'上溢','both'],['UF',1,1,'下溢','both'],['NX',0,0,'不精确','both']] },
    { id:'frm', name:'frm', width:'32', fields:[['frm',2,0,'浮点舍入：0 RNE、1 RTZ、2 RDN、3 RUP、4 RMM；其余需核对规范','both']] },
    { id:'vtype', name:'vtype', width:'XLEN', fields:[['vill',63,63,'非法 vtype',64],['vill',31,31,'非法 vtype',32],['vma',7,7,'掩码无关策略','both'],['vta',6,6,'尾部无关策略','both'],['vsew',5,3,'SEW = 8 × 2^vsew，支持范围依实现','both'],['vlmul',2,0,'LMUL 编码：0 m1、1 m2、2 m4、3 m8、5 mf8、6 mf4、7 mf2','both']] },
    ...['vl','vlenb','vstart'].map(name => raw(name, { vl:'本次有效元素数', vlenb:'向量寄存器长度（字节）', vstart:'恢复执行的起始元素索引' }[name])),
    { id:'vxsat', name:'vxsat', width:'32', fields:[['vxsat',0,0,'向量定点饱和标志','both']] },
    { id:'vxrm', name:'vxrm', width:'32', fields:[['vxrm',1,0,'定点舍入：0 RNU、1 RNE、2 RDN、3 ROD','both']] },
    { id:'vcsr', name:'vcsr', width:'32', fields:[['vxrm',2,1,'向量定点舍入模式','both'],['vxsat',0,0,'向量定点饱和标志','both']] },
    ...Array.from({ length:32 }, (_, i) => raw('f' + i, '浮点寄存器日志的完整 128 位保存槽位；不据此断言硬件 FLEN=128', 128)),
    ...Array.from({ length:32 }, (_, i) => raw('v' + i, '128 位向量原始现场；对应 VLENB=16，不按浮点格式解释', 128))
  ];
  root.TrapRegisters = registers;
  if (typeof module !== 'undefined' && module.exports) module.exports = registers;
})(globalThis);
