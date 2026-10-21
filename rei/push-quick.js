// Two-stage push, built for speed (Bryan, 20 Oct):
//   STAGE 1  name + phone only -> Save. The contact exists in REI in seconds.
//   STAGE 2  then enrich it: tags Agent/Realtor + Twin Network, and opt in
//            phone and email.
//   STAGE 3  then the Property Address, on the contact panel (Bryan, 21 Oct):
//            contact first so it is callable, address as a follow-up.
// The old one-shot filled address, city, zip, state and country before it could
// save, and the state/country dropdowns alone cost most of the wait.
//
//   node push-quick.js <contact.json>
//
// Phone Type is always Mobile (Bryan's rule) and REI refuses to save without it.
// REI also refuses a save whose phone is already on file, answering 400
// {"success":false,"contact_phone1":"Phone already exists|<id>"} — that is not a
// failure, it is the contact we wanted, so stage 2 runs against that id.
const fs = require("fs");
const { chromium } = require("playwright");
const PROFILE = __dirname + "/profile";
const TAGS = ["Agent/Realtor", "Twin Network"];
const FILE = process.argv[2];
const out = (o) => console.log("RESULT " + JSON.stringify(o));
if (!FILE) { out({ ok: false, err: "usage: node push-quick.js <contact.json>" }); process.exit(1); }
const c = JSON.parse(fs.readFileSync(FILE, "utf8"));
const t0 = Date.now();
const at = () => Math.round((Date.now() - t0) / 100) / 10;

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true, executablePath: "/opt/pw-browsers/chromium",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1500, height: 1200 }
  });
  const pg = ctx.pages()[0] || (await ctx.newPage());
  let saveResp = null;
  pg.on("response", async (r) => {
    if (!/saveProfileFieldValues/.test(r.url())) return;
    try { saveResp = { status: r.status(), body: (await r.text()).slice(0, 1200) }; }
    catch (e) { saveResp = { status: r.status(), body: "" }; }
  });
  const step = {};
  const shot = (n) => pg.screenshot({ path: __dirname + "/quick-" + n + ".png" }).catch(() => {});
  const until = async (fn, ms, every) => {
    const end = Date.now() + (ms || 25000);
    while (Date.now() < end) {
      try { if (await fn()) return true; } catch (e) {}
      await pg.waitForTimeout(every || 300);
    }
    return false;
  };

  try {
    /* ---------- STAGE 1: the smallest contact REI will accept ---------- */
    await pg.goto("https://my.reiblackbook.com/contacts", { waitUntil: "domcontentloaded", timeout: 60000 });
    if (!(await until(async () => (await pg.locator('input[placeholder*="Search By Name"]').count()) > 0, 40000))) {
      out({ ok: false, err: "contacts page never finished loading" }); await ctx.close(); return;
    }
    if (/login|sign-?in/i.test(pg.url())) { out({ ok: false, err: "REI signed us out — needs a fresh login and its emailed code" }); await ctx.close(); return; }

    await pg.locator('button[id^="menu-button"]').filter({ hasText: "Add Contact" }).first().click({ timeout: 20000 });
    await until(async () => (await pg.locator('[role="menuitem"],.chakra-menu__menuitem').count()) > 0, 10000);
    await pg.locator('[role="menuitem"],.chakra-menu__menuitem').filter({ hasText: /^add contact$/i }).first().click();
    await until(async () => (await pg.locator('input[placeholder="Enter First Name..."]').count()) > 0, 25000);

    const typeIn = async (ph, v) => {
      if (!v) return;
      const el = pg.locator('input[placeholder="' + ph + '"]').first();
      if (await el.count()) { await el.click(); await el.fill(String(v)); }
    };
    await typeIn("Enter First Name...", c.first);
    await typeIn("Enter Last Name...", c.last);
    const sels = pg.locator("select"); const n = await sels.count();
    for (let i = 0; i < n; i++) {
      const s = sels.nth(i);
      if (await s.locator("option", { hasText: /^\s*Mobile\s*$/i }).count().catch(() => 0)) {
        await s.selectOption({ label: "Mobile" }).catch(() => s.selectOption("Mobile").catch(() => {})); break;
      }
    }
    const tel = pg.locator('input[type="tel"]').first();
    if (c.phone && (await tel.count())) { await tel.click(); await tel.type(String(c.phone).replace(/\D/g, ""), { delay: 15 }); }
    // Email belongs here, not in stage 2: this form has a plain text field,
    // while the edit dialog's Primary Email is a combobox that would not take
    // a new address — which left Lisa Deyoung (20683540) with no email, and so
    // nothing to opt in. One fill, no measurable cost; the slow fields are the
    // address, state and country typeaheads, and those still stay out.
    await typeIn("Enter Email...", c.email);

    saveResp = null;
    await pg.getByRole("button", { name: /^Save Contact$/ }).first().click({ timeout: 20000 });
    await until(async () => saveResp !== null, 30000, 200);
    step.saved = at();

    let id = null, existed = false;
    if (saveResp && saveResp.status >= 400) {
      let j = null; try { j = JSON.parse(saveResp.body); } catch (e) {}
      const dup = Object.keys(j || {}).map((k) => String(j[k]))
        .map((v) => /already exists\|(\d+)/i.exec(v)).filter(Boolean)[0];
      if (dup) { id = dup[1]; existed = true; }
      else {
        const why = j ? Object.keys(j).filter((k) => k !== "success").map((k) => k + ": " + j[k]).join(" · ") : (saveResp.body || "").slice(0, 200);
        await shot("refused");
        out({ ok: false, err: "REI refused the save (" + saveResp.status + ") — " + (why || "no reason given") });
        await ctx.close(); return;
      }
    } else if (!saveResp) {
      out({ ok: false, err: "no save call reached REI at all" }); await ctx.close(); return;
    } else {
      await pg.waitForTimeout(1500);
      const m = /\/contacts\/(\d+)/.exec(pg.url());
      if (m) id = m[1];
      if (!id) {
        // Look the contact up by phone. REI takes a moment to index a brand new
        // record, and looking once used to come back empty — which cost a whole
        // second run of this script per new agent. So keep asking until it
        // appears rather than giving up on the first miss.
        await pg.goto("https://my.reiblackbook.com/contacts", { waitUntil: "domcontentloaded", timeout: 60000 });
        await until(async () => (await pg.locator('input[placeholder*="Search By Name"]').count()) > 0, 30000);
        const box = pg.locator('input[placeholder*="Search By Name"]').first();
        const term = (c.first + " " + c.last).trim();
        const findRow = () => pg.evaluate((phone) => {
          for (const tr of Array.from(document.querySelectorAll("table tbody tr"))) {
            const a = tr.querySelector('a[href*="/contacts/"]');
            if (!a) continue;
            if (!phone || (tr.innerText || "").indexOf(phone) >= 0) {
              const m = /\/contacts\/(\d+)/.exec(a.getAttribute("href") || "");
              if (m) return m[1];
            }
          }
          return null;
        }, c.phone || "");
        await box.click(); await box.fill(term);
        await until(async () => { id = await findRow(); return !!id; }, 20000, 1500);
        if (!id) {                     // one re-type, in case the search box lost it
          await box.fill(""); await pg.waitForTimeout(400); await box.fill(term);
          await until(async () => { id = await findRow(); return !!id; }, 15000, 1500);
        }
      }
    }
    if (!id) { out({ ok: false, err: "saved, but could not work out which contact it became" }); await ctx.close(); return; }
    step.id = id; step.existed = existed;
    // Cherry can ring this contact from here on — say so now, before the
    // enrichment below, so the time to a callable record is visible.
    console.log("CALLABLE " + JSON.stringify({ id: id, existed: existed, seconds: at(),
      url: "https://my.reiblackbook.com/contacts/" + id }));

    /* ---------- STAGE 2: enrich ---------- */
    await pg.goto("https://my.reiblackbook.com/contacts/" + id, { waitUntil: "domcontentloaded", timeout: 60000 });
    if (!(await until(async () => (await pg.getByText("Primary Details").count()) > 0, 40000))) {
      out({ ok: true, id: id, existed: existed, complete: false, warn: "contact exists but its page would not load, so nothing was enriched", steps: step });
      await ctx.close(); return;
    }
    const panelText = () => pg.evaluate(() => {
      const lab = Array.from(document.querySelectorAll("*")).find(
        (e) => e.children.length === 0 && (e.innerText || "").trim() === "Tag(s)");
      if (!lab) return "";
      let n = lab; for (let i = 0; i < 6 && n.parentElement; i++) n = n.parentElement;
      return (n.innerText || "").replace(/\s+/g, " ");
    });
    const has = (t, s) => t.toLowerCase().includes(s.toLowerCase());

    // tags
    let panel = await panelText();
    const todo = TAGS.filter((t) => !has(panel, t));
    if (todo.length) {
      const plus = await pg.evaluate(() => {
        const lab = Array.from(document.querySelectorAll("*")).find(
          (e) => e.children.length === 0 && (e.innerText || "").trim() === "Tag(s)");
        if (!lab) return null;
        const lr = lab.getBoundingClientRect();
        const cand = Array.from(document.querySelectorAll("button")).filter((b) => b.offsetParent !== null)
          .map((b) => ({ r: b.getBoundingClientRect() }))
          .filter((o) => o.r.width > 8 && o.r.width < 46 && o.r.left < 400 && o.r.top > lr.top && o.r.top < lr.bottom + 70)
          .sort((a, z) => z.r.left - a.r.left);
        return cand.length ? { x: cand[0].r.x + cand[0].r.width / 2, y: cand[0].r.y + cand[0].r.height / 2 } : null;
      });
      if (plus) {
        await pg.mouse.click(plus.x, plus.y);
        const dlg = pg.locator('[role="dialog"],.chakra-modal__content').filter({ hasText: "Add/Remove Tags" }).first();
        if (await until(async () => (await dlg.count()) > 0, 12000)) {
          for (const t of todo) {
            const inp = dlg.locator('input[id^="react-select"]').first();
            await inp.click({ timeout: 8000 }).catch(() => {});
            await pg.keyboard.type(t, { delay: 40 });
            await until(async () => (await pg.locator('[id^="react-select"][id*="option"]').count()) > 0, 8000);
            const opts = await pg.evaluate(() => Array.from(document.querySelectorAll('[id^="react-select"][id*="option"]'))
              .filter((e) => e.offsetParent !== null).map((e) => (e.innerText || "").trim()));
            const i = opts.findIndex((x) => x.toLowerCase() === t.toLowerCase());
            if (i < 0) { for (let k = 0; k < t.length + 2; k++) await pg.keyboard.press("Backspace"); continue; }
            for (let k = 0; k < i; k++) await pg.keyboard.press("ArrowDown");
            await pg.keyboard.press("Enter");
            await pg.waitForTimeout(400);
          }
          await dlg.getByRole("button", { name: /^Add\/Remove Tags$/ }).first().click({ timeout: 12000 }).catch(() => {});
          await until(async () => (await dlg.count()) === 0, 12000);
        }
      }
    }
    step.tagged = at();

    // both opt-ins, in the edit dialog. Email is set at creation instead:
    // the field here is a combobox that will not accept a new address.
    const openEditor = async () => {
      await pg.mouse.click(342, 90);
      return until(async () => (await pg.getByText("Edit Contact Information").count()) > 0, 12000);
    };
    if (await openEditor()) {
      let changed = 0;
      for (let pass = 0; pass < 2; pass++) {
        const closed = await pg.evaluate(() => {
          const e = Array.from(document.querySelectorAll("div,p,span")).find((x) => {
            const t = (x.textContent || "").replace(/\s+/g, " ").trim();
            if (!/^Opt\s*-\s*Out$/i.test(t)) return false;
            const r = x.getBoundingClientRect();
            return r.width > 80 && r.width < 220 && r.height > 10;
          });
          if (!e) return null;
          const r = e.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        if (!closed) break;
        await pg.mouse.click(closed.x, closed.y);
        await pg.waitForTimeout(800);
        const opt = await pg.evaluate(() => {
          const cands = Array.from(document.querySelectorAll("*")).filter((x) => {
            const t = (x.textContent || "").replace(/\s+/g, " ").trim();
            if (!/^Opt\s*-\s*In$/i.test(t)) return false;
            if (x.children.length > 1) return false;
            const r = x.getBoundingClientRect();
            return r.width > 20 && r.height > 8;
          });
          if (!cands.length) return null;
          const r = cands[cands.length - 1].getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        if (!opt) { await pg.keyboard.press("Escape").catch(() => {}); break; }
        await pg.mouse.click(opt.x, opt.y);
        await pg.waitForTimeout(600);
        changed++;
      }
      const save = pg.getByRole("button", { name: /^Update Info$/ }).first();
      if (!(await save.isDisabled().catch(() => true))) {
        await save.click({ timeout: 12000 });
        await until(async () => (await pg.getByText("Edit Contact Information").count()) === 0, 15000);
      } else { await pg.keyboard.press("Escape").catch(() => {}); }
      step.optedIn = at();
    }


    /* ---------- STAGE 3: the property address, as a follow-up ---------- */
    // Deliberately last, and deliberately Property Address rather than Mailing
    // Address: the contact is the LISTING AGENT, so the lead's address is the
    // house they are selling, not where they live. It lives on the contact
    // panel ("Contacts (N)"), not in Edit Contact Information, which carries
    // no address fields at all. The state and country pickers are slow, which
    // is exactly why this runs after the contact is already callable.
    if (c.street) {
      const panelPencil = () => pg.evaluate(() => {
        const h = Array.from(document.querySelectorAll("*")).find(
          (e) => !e.children.length && /^Contacts \(\d+\)$/.test((e.textContent || "").trim()));
        if (!h) return null;
        const hr = h.getBoundingClientRect();
        const cand = Array.from(document.querySelectorAll("button,[role=button]"))
          .filter((b) => b.offsetParent !== null)
          .map((b) => ({ r: b.getBoundingClientRect() }))
          .filter((o) => o.r.width > 8 && o.r.width < 60 && Math.abs(o.r.top - hr.top) < 40 && o.r.left > hr.right)
          .sort((a, z) => z.r.left - a.r.left);
        return cand.length ? { x: cand[0].r.x + cand[0].r.width / 2, y: cand[0].r.y + cand[0].r.height / 2 } : null;
      });
      await pg.goto("https://my.reiblackbook.com/contacts/" + id, { waitUntil: "domcontentloaded", timeout: 60000 });
      await until(async () => (await pg.getByText("Primary Details").count()) > 0, 40000);
      await pg.waitForTimeout(1200);
      const pen = await panelPencil();
      if (pen) {
        await pg.mouse.click(pen.x, pen.y);
        const ok = await until(async () =>
          (await pg.locator('.chakra-modal__content,[role="dialog"]').filter({ hasText: "Property Address" }).count()) > 0, 15000);
        if (ok) {
          await pg.waitForTimeout(1200);
          // Every control between the "Property Address" and "Mailing Address"
          // captions INSIDE the modal — the same placeholders appear twice on
          // this form, and the page behind the modal carries them as well.
          const box = async () => pg.evaluate(() => {
            const dlg = document.querySelector(".chakra-modal__content") || document.querySelector('[role="dialog"]');
            if (!dlg) return null;
            const yOf = (t) => {
              const e = Array.from(dlg.querySelectorAll("*")).find(
                (x) => !x.children.length && (x.textContent || "").trim() === t);
              return e ? e.getBoundingClientRect().top : null;
            };
            const pa = yOf("Property Address"), ma = yOf("Mailing Address");
            if (pa === null || ma === null) return null;
            const pick = (ph) => {
              const e = Array.from(dlg.querySelectorAll("input")).find((x) => {
                if (x.offsetParent === null || x.placeholder !== ph) return false;
                const t = x.getBoundingClientRect().top;
                return t > pa && t < ma;
              });
              if (!e) return null;
              const r = e.getBoundingClientRect();
              return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            };
            // the State picker is a react-select: its input carries no
            // placeholder and sits on the second row, left-most.
            const blanks = Array.from(dlg.querySelectorAll("input")).filter((x) => {
              if (x.offsetParent === null || x.placeholder) return false;
              const t = x.getBoundingClientRect().top;
              return t > pa && t < ma;
            }).map((x) => { const r = x.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.left }; })
              .sort((a, z) => a.left - z.left);
            return { street: pick("Enter Address..."), city: pick("Enter City..."),
                     zip: pick("Enter Zip Code..."), state: blanks[0] || null };
          });
          const at3 = await box();
          // Select-all before typing. Without it a second run on the same lead
          // APPENDS to whatever is already in the field — which is how Eric Yee
          // (20683897) ended up with "1843 Felton S1843 Felton Street...".
          // Pressing it twice more is now harmless.
          const typeAt = async (pt, v) => {
            if (!pt || !v) return;
            await pg.mouse.click(pt.x, pt.y);
            await pg.keyboard.press("ControlOrMeta+a").catch(() => {});
            await pg.keyboard.press("Delete").catch(() => {});
            await pg.keyboard.type(String(v), { delay: 10 });
          };
          if (at3) {
            await typeAt(at3.street, c.street);
            await typeAt(at3.city, c.city);
            await typeAt(at3.zip, c.zip);
            if (at3.state && c.state) {
              // The picker lists full state names ("California"), so an
              // abbreviation has to be spelled out before it will filter.
              const FULL = { CA: "California", NV: "Nevada", AZ: "Arizona", OR: "Oregon", WA: "Washington", TX: "Texas", FL: "Florida" };
              const term = FULL[String(c.state).toUpperCase()] || String(c.state);
              await pg.mouse.click(at3.state.x, at3.state.y);
              await pg.keyboard.type(term, { delay: 40 });
              // Wait for the option ITSELF, not merely for something id'd
              // "option" to exist — reading the list too early was why the
              // state silently stayed unset while street, city and zip saved.
              const listed = await until(async () => pg.evaluate((t) =>
                Array.from(document.querySelectorAll('[id^="react-select"][id*="option"]'))
                  .filter((e) => e.offsetParent !== null)
                  .some((e) => (e.textContent || "").trim().toLowerCase() === t.toLowerCase()), term), 9000, 250);
              if (listed) {
                // Typing the full name leaves exactly one match, and
                // react-select highlights it, so Enter takes it.
                await pg.keyboard.press("Enter");
                await pg.waitForTimeout(500);
              } else {
                step.stateMissed = term;
                for (let k = 0; k < term.length + 2; k++) await pg.keyboard.press("Backspace");
                await pg.keyboard.press("Escape").catch(() => {});
              }
            }
            const saveBtn = pg.getByRole("button", { name: /^Save Records$/ }).first();
            if (await saveBtn.count()) {
              await saveBtn.click({ timeout: 15000 }).catch(() => {});
              await until(async () =>
                (await pg.locator('.chakra-modal__content,[role="dialog"]').filter({ hasText: "Property Address" }).count()) === 0, 20000);
              step.address = at();
            }
          }
        }
      }
      if (step.address === undefined) { await shot("addr"); step.addressFailed = true; }
    }

    /* ---------- prove it ---------- */
    await pg.goto("https://my.reiblackbook.com/contacts/" + id, { waitUntil: "domcontentloaded", timeout: 60000 });
    await until(async () => (await pg.getByText("Primary Details").count()) > 0, 30000);
    panel = await panelText();
    const tagsOk = TAGS.every((t) => has(panel, t));
    let optReads = [];
    if (await openEditor()) {
      optReads = await pg.evaluate(() => Array.from(document.querySelectorAll("p,div,span"))
        .filter((x) => {
          const t = (x.textContent || "").replace(/\s+/g, " ").trim();
          if (!/^Opt\s*-\s*(In|Out)$/i.test(t)) return false;
          const r = x.getBoundingClientRect();
          return r.width > 40 && r.width < 220 && r.height > 10;
        }).map((x) => (x.textContent || "").replace(/\s+/g, " ").trim()));
    }
    const optOk = optReads.length > 0 && optReads.every((v) => /opt\s*-\s*in/i.test(v));
    // read the Property Address back off the panel, not off the form we typed into
    let addrOk = null;
    if (c.street) {
      await pg.keyboard.press("Escape").catch(() => {});
      await pg.goto("https://my.reiblackbook.com/contacts/" + id, { waitUntil: "domcontentloaded", timeout: 60000 });
      await until(async () => (await pg.getByText("Primary Details").count()) > 0, 30000);
      // The panel's own fields render a beat after the page does; reading once
      // at a fixed delay reported "(still empty)" for an address that had in
      // fact saved, so wait for a real value to appear.
      // Read the whole panel block and find the caption's value in it. Walking
      // up from the caption element was brittle and reported an address that
      // had actually saved as "(still empty)".
      const readPanel = () => pg.evaluate(() => {
        const h = Array.from(document.querySelectorAll("*")).find(
          (e) => !e.children.length && /^Contacts \(\d+\)$/.test((e.textContent || "").trim()));
        if (!h) return "";
        let n = h;
        for (let i = 0; i < 7 && n.parentElement; i++) n = n.parentElement;
        return (n.innerText || "").trim();
      });
      const valueOf = (block, cap) => {
        const lines = block.split("\n").map((x) => x.trim()).filter(Boolean);
        const i = lines.indexOf(cap);
        if (i < 0 || i + 1 >= lines.length) return "";
        const v = lines[i + 1];
        return v === "-" ? "" : v;
      };
      let shown = "";
      await until(async () => {
        shown = valueOf(await readPanel(), "Property Address");
        return !!shown;
      }, 20000, 800);
      const num = (String(c.street).match(/^\d+/) || [""])[0];
      addrOk = !!shown && (num ? shown.indexOf(num) >= 0 : true);
      step.addressShown = shown || "(still empty)";
    }
    if (!tagsOk || !optOk || addrOk === false) await shot("verify");
    out({ ok: true, id: id, existed: existed,
          complete: !!(tagsOk && optOk && addrOk !== false),
          tags: tagsOk, optIn: optOk, address: addrOk, seconds: at(), steps: step,
          note: "the lead notes are still NOT written into REI" });
  } catch (e) {
    out({ ok: false, err: String(e.message || e).slice(0, 200), steps: step });
    await shot("fail");
  }
  await ctx.close();
})();
