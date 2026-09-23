import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFaceRoster, firstJsonObject, createFaces } from "../src/faces.mjs";

test("parseFaceRoster: names + familiarity, first id wins", () => {
  const text =
    '[{"age":30,"gender":1,"name":"Alice","person_id":5,"relation":"family"},' +
    '{"age":0,"name":"stranger12","person_id":7,"relation":""},' +
    '{"age":40,"name":"Alice2","person_id":5,"relation":"family"}]';
  const roster = parseFaceRoster(text);
  assert.deepEqual(roster.get(5), { name: "Alice", familiar: true });
  assert.deepEqual(roster.get(7), { name: "stranger12", familiar: false }); // stranger\d+ ⇒ not familiar
  assert.equal(roster.size, 2); // duplicate id 5 kept the first row
});

test("parseFaceRoster: no matches ⇒ empty map", () => {
  assert.equal(parseFaceRoster("nothing here").size, 0);
});

test("firstJsonObject: skips leading junk + trailing padding", () => {
  assert.deepEqual(firstJsonObject('garbage {"data":[1,2]} trailing{'), { data: [1, 2] });
});

test("firstJsonObject: balances nested braces and braces inside strings", () => {
  assert.deepEqual(firstJsonObject('{"a":"}","b":{"c":1}}xxx'), { a: "}", b: { c: 1 } });
});

test("firstJsonObject: no object / malformed ⇒ undefined", () => {
  assert.equal(firstJsonObject("no braces"), undefined);
  assert.equal(firstJsonObject('{"a":}'), undefined);
});

test("enrichPersonName: resolves a known person, leaves others", () => {
  const ctx = { state: { faceNames: new Map([[5, { name: "Alice", familiar: true }]]) } };
  const { enrichPersonName } = createFaces(ctx);

  assert.deepEqual(enrichPersonName("personDetected", { person_id: 5 }), {
    person_id: 5,
    person_name: "Alice",
    recognized: true,
  });
  // unknown positive id ⇒ recognized:false, no name
  assert.deepEqual(enrichPersonName("personDetected", { person_id: 99 }), { person_id: 99, recognized: false });
  // person_id <= 0 ⇒ a person but no face match
  assert.deepEqual(enrichPersonName("personDetected", { person_id: -1 }), { person_id: -1, recognized: false });
  // a non-personDetected event is passed through untouched
  const motion = { deviceSn: "CAM1" };
  assert.equal(enrichPersonName("motion", motion), motion);
});
