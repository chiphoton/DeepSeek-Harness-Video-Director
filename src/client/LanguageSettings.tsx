import { getLanguage, setLanguage, t, useLanguage, type Language } from './i18n'

export function LanguageSettings() {
  useLanguage()
  return <div>
    <div className="vd-settings-intro">
      <strong>{t('Language')}</strong>
      <p>{t('Choose the interface language. Changes apply immediately and are remembered in this browser.')}</p>
    </div>
    <section className="vd-settings-card">
      <fieldset className="vd-language-options">
        <legend>{t('Interface language')}</legend>
        {([['en', 'English'], ['zh', '中文']] as const).map(([value, label]) => (
          <label key={value} lang={value === 'zh' ? 'zh-CN' : 'en'}>
            <input type="radio" name="canvas-language" value={value} checked={getLanguage() === value} onChange={() => setLanguage(value as Language)} />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
    </section>
  </div>
}
