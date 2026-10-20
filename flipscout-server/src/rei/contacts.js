// Creating a contact in REI BlackBook.
//
// The web app saves the Add Contact form with:
//
//   POST /profitdial/profiles/saveProfileFieldValues/<profileId>
//   multipart/form-data
//
// and the body is not a tidy {firstName, email} object. REI echoes back the
// WHOLE field descriptor for every field on the form — type, key, label, icon,
// field_id, display_type and so on — with the typed values nested under
// [value]. So the reliable way to build it is not to invent that structure but
// to ask REI for a blank contact and fill the blanks in:
//
//   POST /profitdial/contacts/getNewContact {}   ->  the blank form's fields
//
// That survives REI renaming a field or changing an id, which hardcoding the
// ids observed on one day would not.
//
// VERIFICATION STATUS: the save call and its multipart shape were observed once
// from a real browser session (name field_id 65453, email 65454). The exact
// value sub-keys for phone and address were in the part of that body that was
// truncated when captured. buildSaveBody() therefore fills values through
// setValue(), which matches whatever shape getNewContact returns rather than
// assuming one — and `dryRun` lets the body be inspected before anything is
// sent. Run once against a real account with dryRun before trusting it.

/** Fields we know how to fill, matched on REI's own `key`. */
const WANT = {
  name: "name",
  email: "email",
  phone: "phone",
  address: "address"
};

/** Pull the field list out of whatever envelope REI wraps it in. */
export function fieldsOf(payload) {
  if (Array.isArray(payload)) return payload;
  for (const k of ["fields", "rows", "data", "items", "results", "profileFields"]) {
    const v = payload && payload[k];
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") {
      for (const k2 of ["fields", "rows", "data", "items"]) {
        if (Array.isArray(v[k2])) return v[k2];
      }
    }
  }
  if (payload && typeof payload === "object") {
    const vals = Object.values(payload).filter((x) => x && typeof x === "object" && ("field_id" in x || "field_key" in x));
    if (vals.length) return vals;
  }
  return [];
}

/** The form name REI uses for a field — the prefix every one of its keys wears. */
export function fieldKeyOf(f) {
  return f.field_key || (f.type && f.key ? f.type + "_" + f.key : f.key || "");
}

/**
 * Put `value` into a field's [value], following the shape the blank form uses:
 * an object of sub-keys (first_name, …) is filled per sub-key; a plain value is
 * set directly. Sub-keys REI did not offer are left alone rather than invented.
 */
export function setValue(field, wanted) {
  const cur = field.value;
  if (cur && typeof cur === "object" && !Array.isArray(cur)) {
    const out = { ...cur };
    for (const [k, v] of Object.entries(wanted)) {
      if (k in out) out[k] = v;
    }
    // A single-valued field (email, phone) often exposes exactly one blank
    // sub-key; when the caller passed {value: "..."} put it there.
    if ("value" in wanted && !("value" in cur)) {
      const blanks = Object.keys(cur).filter((k) => cur[k] === "" || cur[k] == null);
      if (blanks.length === 1) out[blanks[0]] = wanted.value;
    }
    field.value = out;
    return field;
  }
  field.value = "value" in wanted ? wanted.value : Object.values(wanted)[0];
  return field;
}

/** What each field we care about should hold, from one board lead. */
export function valuesFor(c) {
  const v = {};
  v[WANT.name] = {
    honorific: "",
    first_name: c.first || "",
    middle_initial: c.middle || "",
    last_name: c.last || ""
  };
  if (c.email) v[WANT.email] = { value: c.email, email: c.email, address: c.email };
  if (c.phone) {
    v[WANT.phone] = {
      value: c.phone, number: c.phone, phone: c.phone,
      // Bryan's standing rule (20 Oct): every pushed agent is a Mobile number.
      // REI refuses to save a phone without a type.
      type: "Mobile", phone_type: "Mobile", label: "Mobile"
    };
  }
  if (c.street || c.city || c.zip) {
    v[WANT.address] = {
      address: c.street || "", address_1: c.street || "", street: c.street || "",
      address_2: "", city: c.city || "", state: c.state || "", zip: c.zip || "",
      zip_code: c.zip || "", country: c.country || "United States",
      save_as_property: "", role: ""
    };
  }
  return v;
}

/** Flatten one field descriptor into multipart entries, as the web app sends it. */
export function appendField(fd, field) {
  const name = fieldKeyOf(field);
  if (!name) return;
  for (const [k, v] of Object.entries(field)) {
    if (k === "value") continue;
    if (v === null || v === undefined) { fd.append(name + "[" + k + "]", ""); continue; }
    if (typeof v === "object") continue;          // REI sends only scalars here
    fd.append(name + "[" + k + "]", String(v));
  }
  const val = field.value;
  if (val && typeof val === "object" && !Array.isArray(val)) {
    for (const [k, v] of Object.entries(val)) {
      fd.append(name + "[value][" + k + "]", v === null || v === undefined ? "" : String(v));
    }
  } else if (val !== undefined) {
    fd.append(name + "[value]", val === null ? "" : String(val));
  }
}

/** Build the multipart body for a new contact. Pure — easy to test and inspect. */
export function buildSaveBody(blankFields, contact) {
  const wanted = valuesFor(contact);
  const fd = new FormData();
  fd.append("removePending", "true");
  const filled = [];
  for (const raw of blankFields) {
    const field = { ...raw };
    const key = String(field.key || "").toLowerCase();
    if (wanted[key]) { setValue(field, wanted[key]); filled.push(key); }
    appendField(fd, field);
  }
  return { body: fd, filled };
}

export class ReiContacts {
  constructor(session, { profileId, log = console }) {
    this.s = session;
    this.profileId = profileId;
    this.log = log;
  }

  /** REI's own duplicate checks — the same two the form runs before saving. */
  async findDuplicates({ email, phone }) {
    const out = { email: null, phone: null };
    if (email) {
      out.email = await this.s.call("/profitdial/contacts/queryDuplicateEmails", { json: { q: email, contact_id: "" } });
    }
    if (phone) {
      const e164 = toE164(phone);
      out.phone = await this.s.call("/profitdial/contacts/queryDuplicatePhones", { json: { q: e164, contact_id: "" } });
    }
    return out;
  }

  async blankContact() {
    const payload = await this.s.call("/profitdial/contacts/getNewContact", { json: {} });
    const fields = fieldsOf(payload);
    if (!fields.length) {
      const e = new Error("REI returned no fields for a blank contact — the save shape cannot be built");
      e.code = "no_fields";
      throw e;
    }
    return fields;
  }

  /**
   * Create one contact. `dryRun` builds and returns the body without sending,
   * which is how to check the shape against a real account safely.
   */
  async create(contact, { dryRun = false, skipDuplicateCheck = false } = {}) {
    if (!contact || (!contact.first && !contact.last)) {
      const e = new Error("a contact needs at least a first or last name"); e.code = "bad_contact"; throw e;
    }
    let duplicates = null;
    if (!skipDuplicateCheck) {
      duplicates = await this.findDuplicates(contact).catch(() => null);
      if (hasDuplicate(duplicates)) {
        return { ok: false, code: "duplicate", duplicates };
      }
    }
    const fields = await this.blankContact();
    const { body, filled } = buildSaveBody(fields, contact);
    if (dryRun) return { ok: true, dryRun: true, filled, entries: [...body.keys()].length };

    const res = await this.s.call("/profitdial/profiles/saveProfileFieldValues/" + this.profileId, { form: body });
    const id = idOf(res);
    this.log.info?.("rei: created contact" + (id ? " " + id : "") + " (" + filled.join(", ") + ")");
    return { ok: true, id, filled, raw: res };
  }
}

function hasDuplicate(d) {
  if (!d) return false;
  const any = (x) => Array.isArray(x) ? x.length > 0 : !!(x && (x.total || x.count || (x.rows && x.rows.length)));
  return any(d.email) || any(d.phone);
}

function idOf(res) {
  if (!res || typeof res !== "object") return "";
  for (const k of ["contact_id", "contactId", "id"]) {
    if (res[k]) return String(res[k]);
  }
  for (const k of ["data", "contact", "result"]) {
    if (res[k] && typeof res[k] === "object") { const v = idOf(res[k]); if (v) return v; }
  }
  return "";
}

export function toE164(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return "+" + d;
}
