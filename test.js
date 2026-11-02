// تجربة محلية بدون انستا: node test.js
process.env.NODE_ENV = "test";
process.env.DRY_RUN = "true";
const { findRule, handleComment, normalize } = await import("./server.js");

const cases = [
  ["ممكن الرقم؟", true],
  ["رقْم 🙏", true],
  ["بكم السعر", true],
  ["حلو كلش", false],
  ["NUMBER please", true],
];

let ok = true;
for (const [text, expected] of cases) {
  const hit = !!findRule(text);
  console.log(`${hit === expected ? "✓" : "✗"} "${text}" → ${normalize(text)} → ${hit ? "يطابق" : "ما يطابق"}`);
  if (hit !== expected) ok = false;
}

await handleComment({ id: "c1", text: "الرقم لو سمحت", from: { id: "u1", username: "test" }, media: { id: "m1" } }, "owner");
await handleComment({ id: "c1", text: "الرقم لو سمحت", from: { id: "u1", username: "test" }, media: { id: "m1" } }, "owner"); // نفس التعليق: ما يتكرر

process.exit(ok ? 0 : 1);
