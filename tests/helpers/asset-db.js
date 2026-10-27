const clone = value => structuredClone(value);
function memoryDb(seed = {}) {
  const tables = clone(seed);
  const command = Object.fromEntries(["gte", "lte", "gt", "inc"].map(op => [op, value => ({ op, value })]));
  const matches = (row, filter) => Object.entries(filter || {}).every(([key, value]) => {
    if (value && value.op === "gte") return row[key] >= value.value;
    if (value && value.op === "lte") return row[key] <= value.value;
    if (value && value.op === "gt") return row[key] > value.value;
    return row[key] === value;
  });
  function database(state) {
    return {
      command,
      collection(name) {
        state[name] ||= [];
        let filter = {}, offset = 0, count = 100, order = [];
        const rows = () => state[name].filter(row => matches(row, filter)).sort((a, b) => {
          for (const [key, direction] of order) if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * (direction === "desc" ? -1 : 1);
          return 0;
        }).slice(offset, offset + count);
        const query = {
          where(value) { filter = value; return query; },
          skip(value) { offset = value; return query; },
          limit(value) { count = value; return query; },
          orderBy(key, direction) { order.push([key, direction]); return query; },
          async get() { return { data: clone(rows()) }; },
          async add({ data }) {
            if (state[name].some(row => row._id === data._id)) throw new Error("duplicate document");
            state[name].push(clone(data));
          },
          async update({ data }) {
            const found = rows();
            for (const row of found) for (const [key, value] of Object.entries(data)) row[key] = value && value.op === "inc" ? row[key] + value.value : clone(value);
            return { stats: { updated: found.length } };
          },
          doc(id) {
            return {
              async get() {
                const row = state[name].find(row => row._id === id);
                if (!row) throw Object.assign(new Error("document does not exist"), { code: "DOCUMENT_NOT_FOUND" });
                return { data: clone(row) };
              },
              async set({ data }) { state[name] = state[name].filter(row => row._id !== id).concat({ _id: id, ...clone(data) }); },
              async update({ data }) { return database(state).collection(name).where({ _id: id }).update({ data }); }
            };
          }
        };
        return query;
      }
    };
  }
  const db = database(tables);
  let queue = Promise.resolve();
  db.runTransaction = fn => {
    const task = queue.then(async () => {
      const draft = clone(tables);
      const result = await fn(database(draft));
      for (const key of Object.keys(tables)) delete tables[key];
      Object.assign(tables, draft);
      return result;
    });
    queue = task.catch(() => {});
    return task;
  };
  return { db, tables };
}
module.exports = { memoryDb };
