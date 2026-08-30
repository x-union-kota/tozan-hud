#!/usr/bin/env python3
import os, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
src, dist = root/'src', root/'dist'
dist.mkdir(exist_ok=True)
rd = lambda p: (src/p).read_text(encoding='utf-8')
html = rd('template.html')
import datetime
build_id = datetime.datetime.utcnow().strftime('%m%d-%H%M') + 'J'  # UTC表記だが識別用途なので簡易
html = html.replace('{{BUILD}}', build_id)
html = html.replace('{{CSS}}', rd('style.css').strip())
html = html.replace('{{ROUTES}}', rd('routes.js').strip())
html = html.replace('{{STARS}}', rd('stars.js').strip())
html = html.replace('{{ASTRO}}', rd('astro.js').strip())
html = html.replace('{{CORE}}', rd('core.js').strip())
html = html.replace('{{APP}}', rd('app.js').strip())
(dist/'index.html').write_text(html, encoding='utf-8')
print(f"dist/index.html {len(html.encode())/1024:.1f}KB  build {build_id}")
