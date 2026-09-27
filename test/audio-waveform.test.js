import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const bundle = await build({ entryPoints: ['src/client/audio-waveform.ts'], bundle: true, format: 'esm', platform: 'browser', write: false })
const { audioEnvelope, waveformPath, audioTime } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + '\n//# sourceURL=audio-waveform-tests.js').toString('base64')}`)

test('the waveform retains short transients and opposite-phase channels while silence stays silent', async () => {
  const left = new Float32Array(4000), right = new Float32Array(4000)
  left[0] = .75; right[0] = -.75
  right[2001] = .375
  const buffer = { duration: 1, length: left.length, numberOfChannels: 2, getChannelData: index => [left, right][index] }
  const waveform = await audioEnvelope(buffer, new AbortController().signal)
  assert.equal(waveform.duration, 1)
  assert.equal(waveform.peaks[0], 1)
  assert.equal(waveform.peaks[500], .5)
  assert.equal(waveform.peaks[100], 0)
  const path = waveformPath(waveform, -.5, 1, 10)
  assert.equal((path.match(/M/g) ?? []).length, 5, 'time before the clip must not display fabricated waveform bars')
  assert.equal(waveformPath(waveform, 2, 1), '')
  assert.equal(waveformPath(null, 0, 1), '')
})

test('waveform extraction aborts when its preview closes', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(audioEnvelope({ duration: 1, length: 8000, numberOfChannels: 1, getChannelData: () => new Float32Array(8000) }, controller.signal), { name: 'AbortError' })
})

test('the audio clock displays hundredths and long-track minutes without invalid values', () => {
  assert.equal(audioTime(110.58, true), '01:50.58')
  assert.equal(audioTime(5.18, true), '00:05.18')
  assert.equal(audioTime(110.58), '1:50')
  assert.equal(audioTime(NaN, true), '00:00.00')
  assert.equal(audioTime(-10), '0:00')
})
