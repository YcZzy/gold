const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

function loadEngine(options = {}) {
  let now = Date.parse(options.time || "2026-10-27T09:02:00+08:00");
  const tables = options.db ? options.tables : Object.fromEntries(Object.entries(options.tables || {}).map(([key, rows]) => [key, structuredClone(rows)]));
  for (const name of ["preferences", "subscriptions", "sendTasks", "quoteSnapshots"]) tables[name] ||= [];
  const sent = [];
  const logs = [];
  const matches = (row, filter) => filter && filter.op === "or" ? filter.value.some(part => matches(row, part)) : Object.entries(filter || {}).every(([key, value]) => {
    if (value && value.op === "lte") return row[key] <= value.value;
    if (value && value.op === "gte") return row[key] >= value.value;
    if (value && value.op === "gt") return row[key] > value.value;
    return row[key] === value;
  });
  const db = {
    command: Object.fromEntries(["lte", "gte", "gt", "inc"].map(op => [op, value => ({ op, value })])),
    collection(name) {
      if (!tables[name]) tables[name] = [];
      let filter = {}, start = 0, count = 100, orders = [];
      const rows = () => tables[name].filter(row => matches(row, filter)).sort((a, b) => {
        for (const [key, direction] of orders) {
          if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * (direction === "desc" ? -1 : 1);
        }
        return 0;
      }).slice(start, start + count);
      const query = {
        where(value) { filter = value; return query; },
        orderBy(key, direction) { orders.push([key, direction]); return query; },
        skip(value) { start = value; return query; },
        limit(value) { count = value; return query; },
        async get() { return { data: structuredClone(rows()) }; },
        async update({ data }) {
          if (options.beforeUpdate) options.beforeUpdate(name, filter, data, tables);
          const found = rows();
          for (const row of found) for (const [key, value] of Object.entries(data)) {
            row[key] = value && value.op === "inc" ? (row[key] || 0) + value.value : value;
          }
          return { stats: { updated: found.length } };
        },
        async add({ data }) {
          if (tables[name].some(row => row._id === data._id)) throw new Error("duplicate document");
          tables[name].push(structuredClone(data));
        },
        doc(id) {
          return {
            async get() {
              const row = tables[name].find(row => row._id === id);
              if (!row) throw Object.assign(new Error("document not found"), { errCode: -502001 });
              return { data: structuredClone(row) };
            },
            async set({ data }) {
              tables[name] = tables[name].filter(row => row._id !== id).concat({ _id: id, ...structuredClone(data) });
            },
            async update({ data }) { return db.collection(name).where({ _id: id }).update({ data }); }
          };
        }
      };
      return query;
    }
  };
  db.command.or = value => ({ op: "or", value });
  const https = {
    get(url, _opts, callback) {
      const request = new EventEmitter();
      request.setTimeout = () => request;
      request.destroy = error => request.emit("error", error);
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        callback(response);
        const fields = url.includes("118.AU") ? { f43: 90000, f60: 91000, f170: -110 }
          : url.includes("122.XAU") ? { f43: 400000, f60: 396000, f170: 101 } : { f43: 71000 };
        response.emit("data", JSON.stringify({ data: { f124: Math.floor(now / 1000), ...fields, ...options.quoteFields } }));
        response.emit("end");
      });
      return request;
    }
  };
  const cloud = {
    init() {}, database: () => options.db || db,
    getWXContext: () => ({ OPENID: options.openid }),
    callFunction: options.callFunction,
    openapi: { subscribeMessage: { async send(payload) {
      if (options.sendError) throw options.sendError;
      sent.push(structuredClone(payload));
      return { errCode: 0 };
    } } }
  };
  const context = {
    exports: {}, console: { error: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    Date: class extends Date { static now() { return now; } },
    require(name) {
      if (name === "https") return https;
      if (name === "wx-server-sdk") return cloud;
      if (name === "./rules") return require("../../cloudfunctions/sendTask/rules");
      if (name === "./asset-tasks") {
        const module = require("../../cloudfunctions/sendTask/asset-tasks");
        return { ...module, createAssetTasks: args => module.createAssetTasks({ ...args, now: () => now }) };
      }
      throw new Error("Unexpected dependency: " + name);
    }
  };
  vm.runInNewContext(readFileSync(join(__dirname, "../../cloudfunctions/sendTask/index.js"), "utf8"), context);
  return { main: context.exports.main, tables, sent, logs, advance(ms) { now += ms; }, now: () => now, db };
}
module.exports = { loadEngine };
