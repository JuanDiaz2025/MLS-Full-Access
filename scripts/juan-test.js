// Pull the SHIPPED functions out of the published board and run them against
// stubs. Testing a copy would prove nothing about what Bryan actually uses.
const fs = require("fs");
const html = fs.readFileSync("/tmp/claude-0/-home-user-MLS-Full-Access/3a32f38f-9daf-53d9-943c-90ecbea25b3d/scratchpad/board-texttpl.html", "utf8");

const grab = (name) => {
  const i = html.indexOf("function " + name);
  if (i < 0) throw new Error("missing " + name);
  let j = html.indexOf("{", i), d = 0;
  for (let k = j; k < html.length; k++) {
    if (html[k] === "{") d++;
    else if (html[k] === "}") { d--; if (!d) return html.slice(i, k + 1); }
  }
};
const vars = html.slice(html.indexOf("var JUAN_COUNTIES"), html.indexOf("function juanText"));

// Stubs for what the gate leans on.
let STATUS = "New Lead", REMOVED = false, LIVE = true, COUNTY = "San Mateo";
const statusOf = () => STATUS, removedOf = () => REMOVED, isLive = () => LIVE, countyOf = () => COUNTY;

eval(vars + grab("juanText") + grab("juanWhyNot") + grab("juanWants"));

let pass = 0, fail = 0;
const t = (name, setup, lead, expect) => {
  STATUS = "New Lead"; REMOVED = false; LIVE = true; COUNTY = "San Mateo";
  setup && setup();
  const got = juanWhyNot(lead);
  const ok = expect instanceof RegExp ? expect.test(got) : got === expect;
  if (ok) { pass++; console.log("  ok   " + name + (got ? "  -> " + got : "")); }
  else { fail++; console.log("  FAIL " + name + "\n       got:  " + JSON.stringify(got) + "\n       want: " + expect); }
};

console.log("--- rule 3: nice houses, the Darwin Ct problem ---");
t("Darwin Ct: graded B on the single word 'vacant'", null, {why: "vacant"}, /only motivation signals \(vacant\)/);
t("renovated + vacant still refused", null, {why: "vacant, price cut 21%", remarks: "Fully renovated and staged"}, /already renovated/);
t("turnkey", null, {remarks: "Turn-key, move-in ready"}, /already renovated/);
t("a real fixer passes", null, {remarks: "Fixer, needs work throughout"}, "");
t("as-is passes", null, {why: "as-is sale, deferred maintenance"}, "");
t("dry rot passes", null, {remarks: "dry rot in the subfloor"}, "");

console.log("--- the scan's own skip flags ---");
t("scored on refresh", null, {why: "scored on refresh, vacant"}, /skipped the condition check/);
t("photo check off", null, {why: "photo check off"}, /skipped the condition check/);
t("judged by eye", null, {why: "judged by eye"}, /skipped the condition check/);
t("skip flag loses to real evidence", null, {why: "scored on refresh", remarks: "needs work"}, "");
t("nice beats everything", null, {why: "needs work", remarks: "fully remodeled kitchen"}, /already renovated/);
t("remodeled (past tense) caught", null, {remarks: "beautifully remodeled throughout"}, /already renovated/);
t("renovations caught", null, {remarks: "recent renovations"}, /already renovated/);
t("updated caught", null, {remarks: "updated kitchen and baths"}, /already renovated/);
t("staging caught", null, {remarks: "professionally staged"}, /already renovated/);

console.log("--- needs-updating is work, not a nice house ---");
t("needs updating passes", null, {remarks: "needs updating throughout"}, "");
t("could use a remodel passes", null, {remarks: "could use a remodel"}, "");
t("ready for renovation passes", null, {why: "ready for renovation"}, "");
t("needs some work passes", null, {remarks: "needs some work"}, "");
t("needs updating BUT remodeled kitchen refused", null, {remarks: "needs updating; remodeled kitchen"}, /already renovated/);

console.log("--- motivation is never condition ---");
t("built 1946 alone", null, {why: "built 1946, 28 days on market"}, /only motivation signals/);
t("price cut alone", null, {why: "price cut 21%"}, /only motivation signals/);
t("first time on the market", null, {why: 'first time on the market'}, /only motivation signals/);
t("probate alone", null, {why: "probate"}, /only motivation signals/);
t("nothing at all", null, {}, "nothing says anyone looked at the condition");

console.log("--- rule 2: San Francisco and the Peninsula ---");
t("San Mateo (Peninsula) ok", () => COUNTY = "San Mateo", {remarks: "fixer"}, "");
t("San Francisco ok", () => COUNTY = "San Francisco", {remarks: "fixer"}, "");
t("Santa Clara refused by name", () => COUNTY = "Santa Clara", {remarks: "fixer"}, "Santa Clara County is outside San Francisco and the Peninsula");
t("Alameda refused", () => COUNTY = "Alameda", {remarks: "fixer"}, /Alameda County is outside/);
t("unknown area refused", () => COUNTY = "Other", {remarks: "fixer"}, "outside San Francisco and the Peninsula");

console.log("--- rule 1: pass status ---");
t("passed", () => STATUS = "Pass", {remarks: "fixer"}, "the team passed on this one");
t("removed", () => REMOVED = true, {remarks: "fixer"}, "the team passed on this one");
t("pass beats a perfect lead", () => { STATUS = "Pass"; COUNTY = "San Francisco"; }, {remarks: "gut rehab"}, "the team passed on this one");
t("off market", () => LIVE = false, {remarks: "fixer"}, "no longer on the market");

console.log("--- order: pass is checked before area ---");
t("passed AND out of area -> says passed", () => { STATUS = "Pass"; COUNTY = "Alameda"; }, {remarks: "fixer"}, "the team passed on this one");

console.log("--- junk in, no crash ---");
t("null lead", null, null, "no lead");
t("non-string fields ignored", null, {why: 42, note: null, remarks: ["x"]}, "nothing says anyone looked at the condition");
t("juanWants agrees", null, {remarks: "fixer"}, "");
if (juanWants({remarks: "fixer"}) !== true) { fail++; console.log("  FAIL juanWants true case"); } else { pass++; console.log("  ok   juanWants(fixer) === true"); }
if (juanWants({why: "vacant"}) !== false) { fail++; console.log("  FAIL juanWants false case"); } else { pass++; console.log("  ok   juanWants(vacant) === false"); }

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
