import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const stylesUrl = new URL('../src/client/styles.css', import.meta.url)

function ruleBody(css, selector) {
  const marker = `${selector} {`
  const start = css.indexOf(marker)
  assert.notEqual(start, -1, `missing CSS rule: ${selector}`)
  const bodyStart = start + marker.length
  const bodyEnd = css.indexOf('}', bodyStart)
  assert.notEqual(bodyEnd, -1, `unterminated CSS rule: ${selector}`)
  return css.slice(bodyStart, bodyEnd)
}

test('artifact images are fitted into a definite preview viewport', async () => {
  const css = await readFile(stylesUrl, 'utf8')
  const viewport = ruleBody(css, '.vd-artifact-dialog-content.is-image')
  const image = ruleBody(css, '.vd-artifact-dialog-content.is-image img')

  assert.match(viewport, /position:\s*relative;/)
  assert.match(image, /position:\s*absolute;/)
  assert.match(image, /inset:\s*24px;/)
  assert.match(image, /width:\s*calc\(100%\s*-\s*48px\);/)
  assert.match(image, /height:\s*calc\(100%\s*-\s*48px\);/)
  assert.match(image, /object-fit:\s*contain;/)
})

test('reference thumbnails fill a definite paint box', async () => {
  const css = await readFile(stylesUrl, 'utf8')
  const frame = ruleBody(css, '.vd-prompt-reference-thumbnail-media')
  const media = ruleBody(css, '.vd-prompt-reference-thumbnail-media img, .vd-prompt-reference-thumbnail-media video')

  assert.match(frame, /position:\s*relative;/)
  assert.match(media, /position:\s*absolute;/)
  assert.match(media, /inset:\s*0;/)
  assert.match(media, /width:\s*100%;/)
  assert.match(media, /height:\s*100%;/)
  assert.match(media, /object-fit:\s*cover;/)
})
