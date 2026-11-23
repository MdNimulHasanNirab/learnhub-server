const test = require("node:test");
const assert = require("node:assert/strict");
const { escapeRegex } = require("../src/utils/search");

test("catalog search escapes regex metacharacters as literal text", () => {
  const input = "Camera (Pro)+ [kit].*";
  const escaped = escapeRegex(input);
  assert.equal(new RegExp(escaped, "i").test(input), true);
  assert.equal(new RegExp(escaped, "i").test("Camera Pro kit"), false);
});
