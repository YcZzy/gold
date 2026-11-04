const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { card, parse } = require("../utils/share");

function read(path) {
  return parse(Object.fromEntries(new URL(path, "https://example.test").searchParams));
}

test("the whole supported list fits into a share and round-trips in order", () => {
  const ids = Array.from({ length: 30 }, (_, i) => "usTEST" + i);
  const { path } = card("watchlist", ids);
  assert.ok(path.length < 1024);
  assert.deepEqual(read(path), { kind: "watchlist", ids });
});

test("share routes carry only public asset identifiers", () => {
  assert.deepEqual(read(card("holdings", ["gold-au9999", "gold-au9999", "bad&amount=42"]).path),
    { kind: "holdings", ids: ["gold-au9999"] });
  assert.deepEqual(read(card("quote", ["gold-xauusd"]).path), { kind: "quote", ids: ["gold-xauusd"] });
  assert.deepEqual(read(card("reminders", ["gold-au9999"]).path), { kind: "reminders", ids: [] });
  assert.equal(parse({ kind: "quote", ids: "gold-au9999,gold-xauusd" }), null);
  assert.equal(parse({ kind: "watchlist", ids: "bad&amount=42" }), null);
});

test("share cards use dedicated covers instead of capturing private page content", () => {
  for (const kind of ["watchlist", "holdings", "quote", "reminders"]) {
    const { imageUrl } = card(kind);
    const png = fs.readFileSync(path.join(__dirname, "..", imageUrl));
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.equal(png.readUInt32BE(16) / png.readUInt32BE(20), 5 / 4);
  }
});

test("paper theme sends its own cover for every share type", () => {
  for (const kind of ["watchlist", "holdings", "quote", "reminders"]) {
    const { imageUrl } = card(kind, [], "", "paper");
    assert.match(imageUrl, /-paper\.png$/);
    assert.ok(fs.existsSync(path.join(__dirname, "..", imageUrl)));
  }
});
