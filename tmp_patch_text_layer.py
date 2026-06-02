from pathlib import Path
path = Path('static/main.js')
text = path.read_text(encoding='utf-8')
old = '''        const textContent = await page.getTextContent()
        textContent.items.forEach((item) => {
            const span = document.createElement("span")
            span.textContent = item.str

            // Use PDF.js util to combine the page viewport transform with the
            // text item transform. This yields a 2D matrix that maps text item
            // coordinates directly into device (pixel) space so we can apply
            // the same transform in CSS. This is more accurate than trying to
            // guess font-size/ascent from item.height.
            const tm = pdfjsLib.Util.transform(viewport.transform, item.transform)

            // Place the span at the origin and apply the full matrix as a CSS
            // transform. Set transform-origin to top-left so the matrix's
            // translation components line up with the canvas pixel coordinates.
            span.style.left = `0px`
            span.style.top = `0px`
            // CSS matrix takes values: a, b, c, d, e, f
            // tm is already in the form [a, b, c, d, e, f] in device units.
            span.style.transform = `matrix(${tm[0].toFixed(6)}, ${tm[1].toFixed(6)}, ${tm[2].toFixed(6)}, ${tm[3].toFixed(6)}, ${tm[4].toFixed(2)}, ${tm[5].toFixed(2)})`
            span.style.transformOrigin = '0 0'

            // Use a tiny base font size, since the PDF transform matrix already
            // carries the final scale. The matrix will scale the 1px text up to
            // the correct visual size in device pixels.
            span.style.display = 'inline-block'
            span.style.fontSize = '1px'
            span.style.lineHeight = '1'
            span.style.whiteSpace = 'pre'
            span.style.pointerEvents = 'auto'
            span.className = "text-item"
            textLayer.appendChild(span)
        })
'''
new = '''        const textContent = await page.getTextContent()
        textContent.items.forEach((item) => {
            const wrapper = document.createElement("span")
            const span = document.createElement("span")
            span.textContent = item.str

            const tm = pdfjsLib.Util.transform(viewport.transform, item.transform)

            wrapper.style.position = 'absolute'
            wrapper.style.left = '0px'
            wrapper.style.top = '0px'
            wrapper.style.transform = `matrix(${tm[0].toFixed(6)}, ${tm[1].toFixed(6)}, ${tm[2].toFixed(6)}, ${tm[3].toFixed(6)}, ${tm[4].toFixed(2)}, ${tm[5].toFixed(2)})`
            wrapper.style.transformOrigin = '0 0'
            wrapper.style.pointerEvents = 'auto'
            wrapper.className = 'text-item-wrapper'

            span.style.display = 'inline-block'
            span.style.color = 'transparent'
            span.style.fontSize = '1px'
            span.style.lineHeight = '1'
            span.style.whiteSpace = 'pre'
            span.style.transform = 'scaleY(-1)'
            span.style.transformOrigin = '0 0'
            span.className = 'text-item'

            wrapper.appendChild(span)
            textLayer.appendChild(wrapper)
        })
'''
if old not in text:
    raise RuntimeError('Old block not found')
path.write_text(text.replace(old, new), encoding='utf-8')
print('Patched static/main.js')
