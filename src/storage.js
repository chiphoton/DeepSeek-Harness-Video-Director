import { execFile } from 'node:child_process'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'

const LOCATION_FILE = '.video-director-storage.json'
const execute = promisify(execFile)

export function storageError(message, status = 400) {
  return Object.assign(new Error(message), { code: 'video-director/storage', status })
}

function absoluteDirectory(value) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f]/u.test(value)) {
    throw storageError('Enter an absolute folder path.')
  }
  const expanded = value.trim().replace(/^~(?=$|[/\\])/u, homedir())
  if (!isAbsolute(expanded)) throw storageError('Enter an absolute folder path, such as ~/Documents/Video Director Data.')
  return resolve(expanded)
}

// The small locator stays in the launch directory, so the choice survives restarts
// with the same configured dataDir. It is excluded from copies of the actual data.
export async function loadStorageLocation(initialDirectory) {
  const initial = resolve(initialDirectory)
  const settingsPath = join(initial, LOCATION_FILE)
  let saved
  try { saved = JSON.parse(await readFile(settingsPath, 'utf8')) }
  catch (error) {
    if (error.code === 'ENOENT') return { dataDir: initial, settingsPath }
    throw storageError(`Could not read the saved Video Director storage location: ${error.message}`)
  }
  if (saved?.version !== 1) throw storageError('Unsupported Video Director storage settings version.')
  const dataDir = absoluteDirectory(saved.dataDir)
  try {
    if (!(await stat(dataDir)).isDirectory()) throw new Error('Not a folder')
  } catch {
    throw storageError(`The saved Video Director data folder is unavailable: ${dataDir}. Reconnect its drive or restore the folder before starting Video Director.`)
  }
  return { dataDir, settingsPath }
}

export async function saveStorageLocation(settingsPath, dataDir) {
  const temporary = `${settingsPath}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, dataDir }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temporary, settingsPath)
  } finally { await rm(temporary, { force: true }) }
}

function contains(parent, child) {
  const suffix = relative(parent, child)
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
}

async function canonicalDestination(path) {
  try { return await realpath(path) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return join(await canonicalDestination(parent), basename(path))
  }
}

export async function copyCanvasData(source, requestedDirectory, { replaceDefault = false } = {}) {
  const current = await realpath(source)
  const destination = await canonicalDestination(absoluteDirectory(requestedDirectory))
  if (contains(current, destination) || contains(destination, current)) {
    throw storageError('Choose a different folder outside the current data folder. Parent and nested folders cannot be used.')
  }
  try {
    const entry = await lstat(destination)
    if (!entry.isDirectory() || (!replaceDefault && (await readdir(destination)).length > 0)) {
      throw storageError('Choose an empty folder or a new folder. Existing files will not be overwritten.')
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error }

  await mkdir(dirname(destination), { recursive: true })
  const staging = await mkdtemp(join(dirname(destination), '.canvas-copy-'))
  const stagedData = join(staging, 'data')
  let backupDataDir = null
  try {
    await cp(current, stagedData, {
      recursive: true, force: false, errorOnExist: true, preserveTimestamps: true, verbatimSymlinks: true,
      filter: path => path !== join(current, LOCATION_FILE),
    })
    if (replaceDefault) {
      // Keep using the current folder if activation fails after the replacement.
      await saveStorageLocation(join(stagedData, LOCATION_FILE), current)
      backupDataDir = `${destination}.backup-${randomUUID()}`
      try { await rename(destination, backupDataDir) }
      catch (error) { if (error.code !== 'ENOENT') throw error; backupDataDir = null }
    } else {
      // rmdir refuses a folder populated by another process during the copy.
      try { await rmdir(destination) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    try { await rename(stagedData, destination) }
    catch (error) {
      if (backupDataDir) await rename(backupDataDir, destination)
      throw error
    }
    return { dataDir: destination, backupDataDir }
  } finally { await rm(staging, { recursive: true, force: true }) }
}

/** Opens a native folder chooser; user paths are passed as data, never shell code. */
export async function chooseDataFolder(dataDir, { platform = process.platform, launch = execute, language = 'en', signal } = {}) {
  const title = language === 'zh' ? '选择新的 Video Director 数据文件夹' : 'Choose a new Video Director data folder'
  const options = { timeout: 300_000, windowsHide: true, shell: false, signal }
  let result
  try {
    if (platform === 'darwin') {
      const script = 'on run argv\ntry\nreturn POSIX path of (choose folder with prompt (item 2 of argv) default location (POSIX file (item 1 of argv)))\non error number -128\nreturn ""\nend try\nend run'
      result = await launch('osascript', ['-e', script, dataDir, title], options)
    } else if (platform === 'win32') {
      const script = `Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = $env:CANVAS_FOLDER_PICKER_TITLE
$dialog.SelectedPath = $env:CANVAS_FOLDER_PICKER_PATH
$dialog.ShowNewFolderButton = $true
try { if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::WriteLine($dialog.SelectedPath) } } finally { $dialog.Dispose() }`
      result = await launch('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        ...options, env: { ...process.env, CANVAS_FOLDER_PICKER_TITLE: title, CANVAS_FOLDER_PICKER_PATH: dataDir },
      })
    } else {
      try { result = await launch('zenity', ['--file-selection', '--directory', `--title=${title}`, `--filename=${dataDir}/`], options) }
      catch (error) {
        if (error.code !== 'ENOENT') throw error
        result = await launch('kdialog', ['--getexistingdirectory', dataDir, '--title', title], options)
      }
    }
  } catch (error) {
    if (error.name === 'AbortError' || (platform !== 'darwin' && platform !== 'win32' && error.code === 1)) return null
    throw storageError(platform === 'linux'
      ? 'Could not open the folder chooser. Install Zenity or KDialog and run Video Director in a desktop session.'
      : 'Could not open the folder chooser. Run Video Director in a desktop session and try again.')
  }
  const selected = String(result.stdout ?? '').trim()
  return selected ? absoluteDirectory(selected) : null
}

export function folderOpenLabel(platform = process.platform) {
  return platform === 'darwin' ? 'Open in Finder' : platform === 'win32' ? 'Open in File Explorer' : 'Open Folder'
}

export async function openDataFolder(dataDir, { platform = process.platform, launch = execute } = {}) {
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer.exe' : 'xdg-open'
  try { await launch(command, [dataDir], { timeout: 10_000, windowsHide: true, shell: false }) }
  catch (error) {
    // Explorer can return 1 after handing off to an existing Explorer process.
    if (platform === 'win32' && error.code === 1) return
    throw storageError(`Could not open the data folder. Open it manually at ${dataDir}.`)
  }
}
