"""
Builds the web app's help page from the user guide.

    pip install markdown
    python docs/build-user-guide.py

Reads docs/USER-GUIDE.md and writes frontend/public/user-guide.html, which the web app's
Help menu opens. Run it again after editing the guide.
"""
import html
import pathlib
import re

import markdown

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "docs" / "USER-GUIDE.md"
TARGET = ROOT / "frontend" / "public" / "user-guide.html"


def box(cx, cy, label, kind="plain"):
    """One state box: plain, final (shaded) or done (accent)."""
    cls = {"plain": "b", "final": "b final", "done": "b done"}[kind]
    weight = " class='strong'" if kind != "plain" else ""
    return (f"<rect class='{cls}' x='{cx - 88}' y='{cy - 24}' width='176' height='48' rx='8'/>"
            f"<text x='{cx}' y='{cy + 4}' text-anchor='middle'{weight}>{label}</text>")


def label(x, y, words, anchor="middle"):
    return f"<text class='q' x='{x}' y='{y}' text-anchor='{anchor}'>{words}</text>"


# The same picture as the request-states diagram in the shared guide, as plain SVG.
DIAGRAM = (
    "<figure class='diagram'><svg viewBox='0 0 800 384' role='img' "
    "aria-label='Every request ends in one of four states'>"
    "<defs><marker id='arrow' viewBox='0 0 10 10' refX='9' refY='5' markerWidth='6' markerHeight='6' "
    "orient='auto-start-reverse'><path d='M0 0L10 5L0 10z' class='head'/></marker></defs>"
    "<text class='title' x='20' y='30'>Every request ends in one of four states</text>"
    "<g class='lines'>"
    + "".join(f"<path d='{d}' marker-end='url(#arrow)'/>" for d in [
        "M108 134V158", "M196 184H210", "M388 184H402", "M580 184H594", "M300 160V84H402",
        "M88 208V278", "M128 280V210", "M300 208V278", "M196 304H210", "M492 208V278"])
    + "</g>"
    + label(108, 126, "You submit")
    + box(108, 184, "Interpreting") + box(300, 184, "Awaiting confirmation") + box(492, 184, "Provisioning")
    + box(684, 184, "Completed", "done") + box(492, 84, "Duplicate", "final")
    + box(108, 304, "Awaiting clarification") + box(300, 304, "Cancelled", "final") + box(492, 304, "Failed", "final")
    + label(203, 150, "spec complete") + label(395, 150, "you confirm") + label(587, 150, "VM boots")
    + label(352, 76, "already exists") + label(82, 248, "missing", "end")
    + label(134, 248, "you answer", "start") + label(306, 248, "cancel, or no reply in 24 h", "start")
    + label(498, 248, "a step fails, VM rolled back", "start")
    + label(20, 364, "Shaded boxes are final states. Cancel works in either waiting state.", "start")
    + "</svg></figure>"
)

STYLE = """
:root { --bg:#f6f5f1; --card:#fff; --ink:#1d1d1b; --quiet:#6b6a64; --line:#e2e0d8; --accent:#2f5bd3;
        --tint:#ecebe6; color-scheme: light dark; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#161615; --card:#20201e; --ink:#ecebe6; --quiet:#a09f98; --line:#34332f; --accent:#7c9cf0; --tint:#2b2a27; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif; }
.page { max-width: 860px; margin: 0 auto; padding: 24px 16px 64px; }
.top { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
.top a { font-size: 14px; }
h1 { font-size: 28px; margin: 12px 0 4px; }
h2 { font-size: 20px; margin: 40px 0 8px; padding-top: 8px; border-top: 1px solid var(--line); }
h3 { font-size: 16px; margin: 24px 0 6px; }
p.updated { color: var(--quiet); margin-top: 0; }
nav.toc { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 18px; margin: 20px 0; }
nav.toc ol { margin: 6px 0 0; padding-left: 20px; columns: 2; column-gap: 32px; }
nav.toc strong { font-size: 13px; color: var(--quiet); text-transform: uppercase; letter-spacing: .04em; }
@media (max-width: 600px) { nav.toc ol { columns: 1; } }
a { color: var(--accent); }
code, pre { font-family: ui-monospace, Consolas, monospace; font-size: 13px; }
code { background: var(--tint); padding: 1px 5px; border-radius: 4px; }
pre { background: var(--card); border: 1px solid var(--line); padding: 12px; border-radius: 8px; overflow-x: auto; }
pre code { background: none; padding: 0; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; margin: 10px 0 16px; background: var(--card); }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 13px; color: var(--quiet); font-weight: 600; }
figure.diagram { margin: 16px 0; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 8px; }
figure.diagram svg { width: 100%; height: auto; display: block; font: 13px system-ui,-apple-system,"Segoe UI",sans-serif; }
svg text { fill: var(--ink); } svg text.q { fill: var(--quiet); font-size: 11.5px; }
svg text.title { font-size: 15px; font-weight: 600; } svg text.strong { font-weight: 600; }
svg .b { fill: none; stroke: var(--quiet); stroke-width: 1.25; }
svg .b.final { fill: var(--tint); } svg .b.done { fill: color-mix(in srgb, var(--accent) 14%, transparent); stroke: var(--accent); stroke-width: 2; }
svg .lines path { fill: none; stroke: var(--quiet); stroke-width: 1.25; } svg .head { fill: var(--quiet); }
"""


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def main():
    md = SOURCE.read_text(encoding="utf-8")
    title = md.splitlines()[0].lstrip("# ").strip()
    body = markdown.markdown(md, extensions=["tables", "fenced_code"])
    body = body.replace("<p><!-- request-states-diagram --></p>", DIAGRAM).replace("<!-- request-states-diagram -->", DIAGRAM)
    body = re.sub(r"<h1>.*?</h1>", "", body, count=1)

    # Anchors on sections, and a contents list built from them.
    sections = []

    def anchor(m):
        text = re.sub(r"<[^>]+>", "", m.group(1))
        sections.append((slug(text), text))
        return f"<h2 id='{slug(text)}'>{m.group(1)}</h2>"

    body = re.sub(r"<h2>(.*?)</h2>", anchor, body)
    body = body.replace("<table>", "<div class='table-wrap'><table>").replace("</table>", "</table></div>")
    toc = "".join(f"<li><a href='#{s}'>{t}</a></li>" for s, t in sections)

    page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title>
<style>{STYLE}</style>
</head>
<body>
<!-- Generated from docs/USER-GUIDE.md by docs/build-user-guide.py. Edit the Markdown, then rebuild. -->
<div class="page">
<div class="top"><a href="/">&larr; Back to the app</a><a href="/swagger-ui.html">API documentation (Swagger)</a></div>
<h1>{html.escape(title)}</h1>
{body.split('</p>', 1)[0].replace('<p>', '<p class="updated">', 1)}</p>
<nav class="toc" aria-label="Contents"><strong>Contents</strong><ol>{toc}</ol></nav>
{body.split('</p>', 1)[1]}
</div>
</body>
</html>
"""
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(page, encoding="utf-8")
    print(f"Wrote {TARGET.relative_to(ROOT)} ({len(page):,} bytes, {len(sections)} sections)")


if __name__ == "__main__":
    main()
