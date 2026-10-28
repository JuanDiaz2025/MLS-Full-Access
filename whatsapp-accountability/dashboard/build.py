"""Assembles whatsapp-accountability.html (the published artifact) from its parts."""
from pathlib import Path

here = Path(__file__).parent
page = (here / "page.src.html").read_text()
model = "\n".join((here / f).read_text() for f in ("model.js", "live.js", "email.js"))
app = (here / "app.js").read_text()
(here / "whatsapp-accountability.html").write_text(page.replace("/*MODEL*/", model).replace("/*APP*/", app))
print("Built whatsapp-accountability.html")
