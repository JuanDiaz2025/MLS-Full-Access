// The save body is built from REI's own blank-contact fields, so these tests
// feed it a blank form shaped the way the real one was observed and check what
// comes out. No network, no CRM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fieldsOf, fieldKeyOf, setValue, valuesFor, buildSaveBody, toE164 } from "../src/rei/contacts.js";

// Modelled on the real captured body: every descriptor key echoed back, values
// nested under [value].
const blank = () => ([
  { contact_id: "", profile_field_relation_id: "", type: "contact_name", key: "name", label: "Name",
    icon: "fa-user", system: 1, description: "", sort_order: 0, profile_id: "", display_type: "NameField",
    field_id: 65453, hidden: false, field_key: "contact_name_name",
    value: { honorific: "", first_name: "", middle_initial: "", last_name: "" } },
  { contact_id: "", type: "contact", key: "email", label: "Email", icon: "fa-envelope", system: 1,
    sort_order: 1, display_type: "EmailField", field_id: 65454, hidden: false, field_key: "contact_email",
    value: { email: "" } },
  { contact_id: "", type: "contact", key: "phone", label: "Phone", icon: "fa-phone", system: 1,
    sort_order: 2, display_type: "PhoneField", field_id: 65455, hidden: false, field_key: "contact_phone",
    value: { number: "", type: "" } },
  { contact_id: "", type: "contact_address", key: "address", label: "Mailing Address", system: 1,
    sort_order: 3, display_type: "AddressField", field_id: 65456, hidden: false, field_key: "contact_address_address",
    value: { address: "", address_2: "", city: "", state: "", zip: "", country: "", save_as_property: "", role: "" } }
]);

const lead = {
  first: "David", last: "Jones", email: "david.b.jones@northerncal-realestate.com",
  phone: "(916) 245-0729", street: "1427 76th Avenue", city: "Oakland", state: "CA", zip: "94621"
};

const read = (fd) => {
  const o = {};
  for (const [k, v] of fd.entries()) o[k] = v;
  return o;
};

test("the field list is found whatever envelope REI wraps it in", () => {
  const f = blank();
  assert.equal(fieldsOf(f).length, 4);
  assert.equal(fieldsOf({ fields: f }).length, 4);
  assert.equal(fieldsOf({ data: { rows: f } }).length, 4);
  assert.equal(fieldsOf({ a: f[0], b: f[1] }).length, 2);
  assert.deepEqual(fieldsOf(null), []);
});

test("a field's form name is its own field_key", () => {
  assert.equal(fieldKeyOf(blank()[0]), "contact_name_name");
  assert.equal(fieldKeyOf({ type: "contact", key: "email" }), "contact_email");
});

test("values go only into sub-keys REI actually offered", () => {
  const f = { value: { first_name: "", last_name: "" } };
  setValue(f, { first_name: "David", last_name: "Jones", nickname: "Dave" });
  assert.deepEqual(f.value, { first_name: "David", last_name: "Jones" });
  assert.equal("nickname" in f.value, false, "a sub-key REI never offered must not be invented");
});

test("a single blank sub-key takes a plain value", () => {
  const f = { value: { email: "" } };
  setValue(f, { value: "a@b.com" });
  assert.equal(f.value.email, "a@b.com");
});

test("the whole descriptor is echoed back, as the web app sends it", () => {
  const { body } = buildSaveBody(blank(), lead);
  const o = read(body);
  assert.equal(o.removePending, "true");
  assert.equal(o["contact_name_name[field_id]"], "65453");
  assert.equal(o["contact_name_name[display_type]"], "NameField");
  assert.equal(o["contact_name_name[field_key]"], "contact_name_name");
  assert.equal(o["contact_name_name[hidden]"], "false");
});

test("the lead's details land in the right places", () => {
  const o = read(buildSaveBody(blank(), lead).body);
  assert.equal(o["contact_name_name[value][first_name]"], "David");
  assert.equal(o["contact_name_name[value][last_name]"], "Jones");
  assert.equal(o["contact_email[value][email]"], lead.email);
  assert.equal(o["contact_phone[value][number]"], "(916) 245-0729");
  assert.equal(o["contact_address_address[value][city]"], "Oakland");
  assert.equal(o["contact_address_address[value][zip]"], "94621");
});

test("the phone type is always Mobile — REI refuses to save without one", () => {
  const o = read(buildSaveBody(blank(), lead).body);
  assert.equal(o["contact_phone[value][type]"], "Mobile");
});

test("a lead with no agent phone leaves the phone field blank, not half-filled", () => {
  const o = read(buildSaveBody(blank(), { first: "Ann", last: "Lee" }).body);
  assert.equal(o["contact_phone[value][number]"], "");
  assert.equal(o["contact_phone[value][type]"], "");
  assert.equal(o["contact_name_name[value][first_name]"], "Ann");
});

test("which fields were filled is reported back", () => {
  assert.deepEqual(buildSaveBody(blank(), lead).filled.sort(), ["address", "email", "name", "phone"]);
  assert.deepEqual(buildSaveBody(blank(), { first: "Ann" }).filled, ["name"]);
});

test("nested objects in the descriptor are not flattened into the form", () => {
  const f = blank();
  f[0].meta = { nope: 1 };
  const o = read(buildSaveBody(f, lead).body);
  assert.equal("contact_name_name[meta]" in o, false);
});

test("phone numbers reach REI's duplicate check in E.164", () => {
  assert.equal(toE164("(916) 245-0729"), "+19162450729");
  assert.equal(toE164("916-245-0729"), "+19162450729");
  assert.equal(toE164("19162450729"), "+19162450729");
  assert.equal(toE164(""), "");
});

test("a contact with no name at all is refused before any call is made", async () => {
  const { ReiContacts } = await import("../src/rei/contacts.js");
  const c = new ReiContacts({ call: () => { throw new Error("must not be called"); } }, { profileId: "1", log: {} });
  await assert.rejects(() => c.create({ email: "a@b.com" }), /first or last name/);
});

test("valuesFor leaves out fields the lead has nothing for", () => {
  const v = valuesFor({ first: "Ann", last: "Lee" });
  assert.equal("email" in v, false);
  assert.equal("phone" in v, false);
  assert.equal("address" in v, false);
  assert.equal(v.name.first_name, "Ann");
});
