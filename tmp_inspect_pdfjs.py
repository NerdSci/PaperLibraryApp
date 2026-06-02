import urllib.request
import re
from pathlib import Path
url = 'https://unpkg.com/pdfjs-dist@2.16.105/build/pdf.js'
print('Downloading', url)
text = urllib.request.urlopen(url).read().decode('utf-8', errors='ignore')
patterns = [
    'class TextLayerRenderTask',
    'function renderTextLayer',
    'function TextLayerRenderTask',
    'TextLayerRenderTask',
    'textDivs',
    'style.transform',
    'fontSize=',
    'fontSize',
    'textContentItemsStr',
]
for pat in patterns:
    m = re.search(re.escape(pat), text)
    if not m:
        continue
    start = max(0, m.start() - 200)
    end = min(len(text), m.end() + 600)
    print('===', pat, '===')
    print(text[start:end])
    print('---')
Path('pdfjs.js').write_text(text, encoding='utf-8')
print('Saved pdfjs.js', Path('pdfjs.js').stat().st_size)
