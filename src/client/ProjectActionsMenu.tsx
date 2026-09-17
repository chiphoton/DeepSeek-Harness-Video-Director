import { t, useLanguage } from './i18n'

export type ProjectAction = 'rename' | 'duplicate' | 'import' | 'export' | 'clear-previews' | 'discard' | 'delete'

export function ProjectActionsMenu(props: {
  disabled?: boolean
  hasProject: boolean
  busy?: boolean
  includeClearPreviews?: boolean
  onAction(action: ProjectAction): void
}) {
  useLanguage()
  const actions: Array<[ProjectAction, string]> = [
    ['rename', '重命名工程'], ['duplicate', '复制工程'], ['import', '导入工程'], ['export', '导出工程'],
    ...(props.includeClearPreviews ? [['clear-previews', '清除预览'] as [ProjectAction, string]] : []),
    ['discard', '放弃更改'], ['delete', '删除工程'],
  ]
  return <div className="vd-project-menu" role="menu" aria-label={t('工程菜单')}>
    {actions.map(([action, label]) => <button key={action} type="button" role="menuitem"
      className={action === 'delete' ? 'vd-project-delete' : undefined}
      disabled={props.disabled || (!props.hasProject && action !== 'import') || (props.busy && (action === 'discard' || action === 'delete'))}
      onClick={() => props.onAction(action)}>{t(label)}</button>)}
  </div>
}
