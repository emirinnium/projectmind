const r = /[[](){}^$+*?|]/;
const bs = String.fromCharCode(92);
console.log("source:", r.source);
console.log("test backslash:", r.test(bs));
console.log("test (:", r.test("("));
