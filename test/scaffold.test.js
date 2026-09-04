import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { apply, Config, name } from '../index.js'

const MAX_ASSET_BYTES = 200 * 1024 * 1024

test('exports the Cordis plugin entry point', () => {
  assert.equal(name, 'video-director')
  assert.equal(typeof apply, 'function')
})

test('caps decoded assets below the custom-channel request ceiling', () => {
  assert.equal(Config({}).maxAssetBytes, MAX_ASSET_BYTES)
  assert.equal(
    Config({ maxAssetBytes: MAX_ASSET_BYTES }).maxAssetBytes,
    MAX_ASSET_BYTES,
  )
  assert.throws(() => Config({ maxAssetBytes: MAX_ASSET_BYTES + 1 }))
})

test('accepts the MiniMax H3 license by default while allowing explicit opt-out', () => {
  assert.equal(Config({}).minimaxH3LicenseAccepted, true)
  assert.equal(Config({ minimaxH3LicenseAccepted: false }).minimaxH3LicenseAccepted, false)
})

test('declares the Harness bundle patch', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  )
  const patch = await readFile(
    new URL('../cordis.patch.yml', import.meta.url),
    'utf8',
  )

  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.match(patch, /id: video-director/)
  assert.match(patch, /name: dsh-video-director/)
  assert.match(patch, /maxAssetBytes: 209715200/)
  assert.match(patch, /minimaxH3LicenseAccepted: true/)
})
