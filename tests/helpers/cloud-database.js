// 模拟文档事务的读版本校验与冲突重试，用于并发集成测试；不替代真实云环境验证。
function database() {
  const values = new Map(); const versions = new Map(); let conflicts = 0;
  const clone = value => value === undefined ? undefined : structuredClone(value);
  for (let n = 1; n <= 24; n++) values.set('dining_tables/' + String(n).padStart(2, '0'), { sessionId: '' });
  return {
    values,
    get conflicts() { return conflicts; },
    async runTransaction(callback, retries = 3) {
      for (let attempt = 0; attempt <= retries; attempt++) {
        const reads = new Map(); const writes = new Map();
        const tx = { collection: name => ({ doc: id => {
          const key = name + '/' + id;
          return {
            get: async () => { reads.set(key, versions.get(key) || 0); await Promise.resolve(); return { data: clone(writes.has(key) ? writes.get(key) : values.get(key)) }; },
            set: async ({ data }) => { writes.set(key, clone(data)); },
            update: async ({ data }) => { if (!reads.has(key)) reads.set(key, versions.get(key) || 0); writes.set(key, Object.assign({}, clone(values.get(key)), clone(data))); }
          };
        } }) };
        const result = await callback(tx);
        if ([...reads].some(([key, version]) => (versions.get(key) || 0) !== version)) { conflicts++; continue; }
        for (const [key, value] of writes) { values.set(key, value); versions.set(key, (versions.get(key) || 0) + 1); }
        return clone(result);
      }
      throw new Error('Transaction retry limit');
    }
  };
}
module.exports = { database };
