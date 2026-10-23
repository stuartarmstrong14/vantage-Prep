"""Builds the in-app user guide (guide/guide.html) and its PDF (guide/guide.pdf).
Run from the repo root: python3 guide/src/build.py   (needs Pillow; the PDF also needs Playwright + Chromium).
Edit guide/src/guide-src.html; screenshots live in guide/src/shots/*.webp."""
import base64, os, re, sys
from PIL import Image
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, 'guide', 'src')
OUT = os.path.join(ROOT, 'guide')
SHOTS = {'home': 'home', 'stock': 'stock', 'sheettop': 'sheet-top', 'body': 'body', 'mech': 'mech', 'cosmetics': 'cosmetics',
         'add': 'add', 'notice': 'notice', 'popup': 'popup', 'reports': 'reports', 'alloys': 'alloys', 'checks': 'checks', 'dept': 'dept'}

def uri(path, mime):
    return 'data:%s;base64,%s' % (mime, base64.b64encode(open(path, 'rb').read()).decode())

def page():
    s = open(os.path.join(SRC, 'guide-src.html')).read()
    for k, f in SHOTS.items():
        p = os.path.join(SRC, 'shots', f + '.webp'); w, h = Image.open(p).size
        s = re.sub(r'src="\{\{%s\}\}"([^>]*?)width="\d+" height="\d+"' % k,
                   lambda m: 'src="%s"%swidth="%d" height="%d"' % (uri(p, 'image/webp'), m.group(1), w, h), s)
    s = s.replace('{{logo}}', uri(os.path.join(ROOT, 'public', 'logo.png'), 'image/png'))
    assert '{{' not in s, re.findall(r'\{\{\w+\}\}', s)
    return s

def site_html(s):
    # links back to the app and to the PDF, shown in the guide's top bar
    s = s.replace('<span class="url">www.145prepped.co.uk</span>',
                  '<span class="url gl"><a href="/">&larr; Back to 145 Prepped</a><a href="/guide.pdf">Download PDF</a></span>', 1)
    s = s.replace('</style>', '.gl{display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end}.gl a{color:var(--band-ink);text-decoration:none;border:1.5px solid var(--band-line);border-radius:999px;padding:6px 14px;font-weight:700}.gl a:hover{background:rgba(255,255,255,.2)}\n</style>', 1)
    head = ('<!doctype html><html lang="en-GB"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
            '<meta name="theme-color" content="#7C95AE"><link rel="icon" type="image/png" href="/icon-192.png">')
    return head + '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}[hidden]{display:none!important}img{max-width:100%}</style>' + s + '</body></html>'

PRINT_CSS = '''
:root{--font:'Urbanist','Inter','Segoe UI',system-ui,sans-serif}
@page{size:A4;margin:12mm 0 14mm}
@page:first{margin-top:0}
html{scroll-behavior:auto}
*{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{background:#FFFFFF}
.sec{break-before:page;box-shadow:none}
#start{break-before:auto}
.role,.shot,.phone,figure,tr,.steps li,.points li,.note,.mail,.line>li,.stack>h3{break-inside:avoid}
h2,h3{break-after:avoid}
.toc-link{font-size:13px;font-weight:700;color:var(--muted);text-decoration:none;align-self:flex-start}
.band .url a{color:inherit;text-decoration:none}
main .in{padding-block:24px 24px}
'''

def pdf_html(s):
    s = s.replace('</style>', PRINT_CSS + '</style>', 1)
    s = s.replace('<header class="band">', '<header class="band" id="top">', 1)
    s = s.replace('<span class="url">www.145prepped.co.uk</span>', '<span class="url"><a href="https://www.145prepped.co.uk">www.145prepped.co.uk</a></span>', 1)
    s = s.replace('Go to <b>www.145prepped.co.uk</b>', 'Go to <a href="https://www.145prepped.co.uk"><b>www.145prepped.co.uk</b></a>', 1)
    s = re.sub(r'(<div class="sec-h"><span class="eyebrow">)', r'<a class="toc-link" href="#top">&#8593; Contents</a>\1', s)
    s = s.replace('<p class="kicker">User guide</p>', '<p class="kicker">User guide &middot; tap a section to jump to it</p>', 1)
    return '<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>145 Prepped User Guide</title></head><body>' + s + '</body></html>'

if __name__ == '__main__':
    s = page()
    open(os.path.join(OUT, 'guide.html'), 'w').write(site_html(s))
    if '--no-pdf' not in sys.argv:
        from playwright.sync_api import sync_playwright
        tmp = os.path.join(OUT, '.print.html'); open(tmp, 'w').write(pdf_html(s))
        with sync_playwright() as p:
            b = p.chromium.launch(executable_path=os.environ.get('CHROMIUM', '/opt/pw-browsers/chromium'), args=['--no-sandbox'])
            pg = b.new_page(color_scheme='light')
            pg.goto('file://' + tmp); pg.wait_for_timeout(500); pg.emulate_media(media='print')
            pg.pdf(path=os.path.join(OUT, 'guide.pdf'), prefer_css_page_size=True, print_background=True, scale=0.72, outline=True, tagged=True)
            b.close()
        os.remove(tmp)
    print('built guide')
