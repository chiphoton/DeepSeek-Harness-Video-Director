import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const saved = new Map()
globalThis.localStorage = {
  getItem: key => saved.get(key) ?? null,
  setItem: (key, value) => saved.set(key, value),
}

const result = await build({
  stdin: {
    contents: `export * from './i18n';
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { SettingsDrawer } from './SettingsDrawer';
      import { LanguageSettings } from './LanguageSettings';
      export const renderSettings = () => renderToStaticMarkup(React.createElement(SettingsDrawer, { snapshot: { providers: [] }, director: {}, onClose() {} }));
      export const renderLanguages = () => renderToStaticMarkup(React.createElement(LanguageSettings));`,
    resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)), loader: 'tsx',
  },
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
})
const ui = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`)

test('Interface language honors a saved choice and otherwise follows the browser language', () => {
  assert.equal(ui.preferredLanguage('en', ['zh-CN']), 'en')
  assert.equal(ui.preferredLanguage('zh', ['en-US']), 'zh')
  assert.equal(ui.preferredLanguage(null, ['zh-TW']), 'zh')
  assert.equal(ui.preferredLanguage('invalid', ['fr-FR']), 'en')
  assert.equal(ui.preferredLanguage(null, []), 'en')
})

test('Language selection persists and translates settings in both directions without translating supplied content', () => {
  ui.setLanguage('en')
  const english = ui.renderSettings()
  assert.match(english, />Connections</u)
  assert.match(english, />Nodes &amp; Workflows</u)
  assert.match(english, />Storage</u)
  assert.match(english, />Language</u)
  assert.equal(saved.get(ui.LANGUAGE_KEY), 'en')
  assert.equal(ui.t('设置'), 'Settings')
  ui.setLanguage('zh')
  const chinese = ui.renderSettings()
  assert.match(chinese, />连接</u)
  assert.match(chinese, />节点与工作流</u)
  assert.match(chinese, />存储</u)
  assert.match(chinese, />语言</u)
  assert.equal(saved.get(ui.LANGUAGE_KEY), 'zh')
  assert.match(ui.renderLanguages(), /<input(?=[^>]*value="zh")(?=[^>]*checked="")[^>]*>/u)
  assert.equal(ui.t('Remove {0}', 'My bridge / 桥 {1}'), '移除 My bridge / 桥 {1}')
  assert.equal(ui.t('My custom workflow'), 'My custom workflow')
  ui.setLanguage('en')
  assert.match(ui.renderLanguages(), /<input(?=[^>]*value="en")(?=[^>]*checked="")[^>]*>/u)
  assert.equal(ui.t('Remove {0}', 'My bridge / 桥 {1}'), 'Remove My bridge / 桥 {1}')
})

test('Language switching still works when browser storage is unavailable', () => {
  globalThis.localStorage.setItem = () => { throw new Error('Storage disabled') }
  assert.doesNotThrow(() => ui.setLanguage('zh'))
  assert.equal(ui.getLanguage(), 'zh')
  assert.equal(ui.t('Change folder'), '更改文件夹')
  ui.setLanguage('en')
})

test('Video Director language is scoped to the plugin and preserves the Harness document language', () => {
  globalThis.document = { documentElement: { lang: 'fr' } }
  try {
    ui.setLanguage('zh')
    assert.equal(globalThis.document.documentElement.lang, 'fr')
    assert.equal(ui.LANGUAGE_KEY, 'dsh-video-director.language')
    ui.setLanguage('en')
    assert.equal(globalThis.document.documentElement.lang, 'fr')
  } finally { delete globalThis.document }
})
