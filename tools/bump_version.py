"""Stamp a new version on every file the web page loads, so browsers fetch
fresh copies after an update instead of using cached old ones.

Run before pushing a website change:  python tools/bump_version.py
"""
import pathlib, re, time

DOCS = pathlib.Path(__file__).resolve().parent.parent / "docs"
version = time.strftime("%Y%m%d%H%M%S")

html = DOCS / "index.html"
text = re.sub(r'(href="style\.css|src="js/main\.js)(\?v=[^"]*)?"', rf'\1?v={version}"', html.read_text())
html.write_text(text)

for js in (DOCS / "js").glob("*.js"):
    src = js.read_text()
    new = re.sub(r'(from\s+"\./[\w-]+\.js)(\?v=[^"]*)?"', rf'\1?v={version}"', src)
    if new != src:
        js.write_text(new)

print("version", version)
