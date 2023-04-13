import * as vscode from 'vscode'
import type { ExtensionContext } from 'vscode'
import * as path from 'path'
import sortBy from 'lodash/sortBy'
import compact from 'lodash/compact'
import startsWith from 'lodash/startsWith'
import flatten from 'lodash/flatten'
import type { DirectoryOption, FSLocation, WorkspaceRoot } from './types'
import { Cache } from './cache'
import * as fs from 'fs'
import braces from 'braces'
import { mkdirp } from 'mkdirp'
import gitignoreToGlob from 'gitignore-to-glob'

interface QuickPickItemWithOption extends vscode.QuickPickItem {
  option?: DirectoryOption
}

export function activate(context: ExtensionContext) {
  console.log('register command')
  let disposable = vscode.commands.registerCommand('nuovoFile.newFile', () =>
    command(context)
  )
  context.subscriptions.push(disposable)
}

function isFolderDescriptor(filepath: string): boolean {
  return filepath.charAt(filepath.length - 1) === path.sep
}

function configIgnoredGlobs(root: string): string[] {
  const configFilesExclude = Object.assign(
    [],
    vscode.workspace.getConfiguration('nuovoFile').get('exclude'),
    vscode.workspace.getConfiguration('files.exclude', vscode.Uri.file(root))
  )
  const a = vscode.workspace.getConfiguration('nuovoFile').get('exclude')
  const b = vscode.workspace.getConfiguration(
    'files.exclude',
    vscode.Uri.file(root)
  )

  return Object.keys(configFilesExclude).filter(
    (key) => configFilesExclude[key] === true
  )
}

function walkupGitignores(dir: string, found: string[] = []): string[] {
  const gitignore = path.join(dir, '.gitignore')
  if (fs.existsSync(gitignore)) {
    found.push(gitignore)
  }

  const parentDir = path.resolve(dir, '..')
  const reachedSystemRoot = dir === parentDir

  if (!reachedSystemRoot) {
    return walkupGitignores(parentDir, found)
  } else {
    return found
  }
}

function invertGlob(pattern: string): string {
  return pattern.replace(/^!/, '')
}

function gitignoreGlobs(root: string): string[] {
  const gitignoreFiles = walkupGitignores(root)
  return flatten(gitignoreFiles.map((g) => gitignoreToGlob(g)))
}

async function directoriesSync(root: string): Promise<FSLocation[]> {
  const globby = await import('globby')
  const ignoreFromgitignoreGlobs = gitignoreGlobs(root)
    .map(invertGlob)
    .map((p) => p.replace('//', '/'))
  const ignoreFromConfigGlobs = configIgnoredGlobs(root)

  const ignore = [...ignoreFromgitignoreGlobs, ...ignoreFromConfigGlobs]

  return globby
    .globbySync('**', {
      cwd: root,
      ignore,
      onlyDirectories: true,
    })
    .map((f): FSLocation => {
      return {
        relative: path.join(path.sep, f),
        absolute: path.join(root, f),
      }
    })
}

function convenienceOptions(roots: WorkspaceRoot[], cache: Cache) {
  const config: ('last' | 'current' | 'root')[] =
    vscode.workspace
      .getConfiguration('advancedNewFile')
      .get('convenienceOptions') ?? []

  const lastItem = buildQuickPickItem(lastSelection(cache), '- last selection')
  const curItem = buildQuickPickItem(
    currentEditorPathOption(roots),
    '- current file'
  )
  const optionsByName = {
    last: lastItem ? [lastItem] : [],
    current: curItem ? [curItem] : [],
    root: rootOptions(roots).map(
      (o) =>
        buildQuickPickItem(o, '- workspace root') as QuickPickItemWithOption
    ),
  }

  const optionsInter = config.map<QuickPickItemWithOption[]>(
    (c) => optionsByName[c]
  )
  const options = optionsInter.reduce(flatten)

  return compact<QuickPickItemWithOption>(options)
}

async function subdirOptionsForRoot(
  root: WorkspaceRoot
): Promise<DirectoryOption[]> {
  const dirs = await directories(root.rootPath)

  return dirs.map((dir: FSLocation): DirectoryOption => {
    const displayText = root.multi
      ? path.join(path.sep, root.baseName, dir.relative)
      : dir.relative

    return {
      displayText,
      fsLocation: dir,
    }
  })
}

export function showQuickPick(choices: Promise<QuickPickItemWithOption[]>) {
  return vscode.window.showQuickPick<QuickPickItemWithOption>(choices, {
    placeHolder:
      'First, select an existing path to create relative to ' +
      '(larger projects may take a moment to load)',
  })
}

export async function showInputBox(
  baseDirectory: DirectoryOption
): Promise<string> {
  try {
    const input = await vscode.window.showInputBox({
      prompt: `Relative to ${baseDirectory.displayText}`,
      placeHolder: 'Filename or relative path to file',
    })

    return path.join(baseDirectory.fsLocation.absolute, input ?? '')
  } catch (e) {
    return ''
  }
}

export function directories(root: string): Promise<FSLocation[]> {
  return new Promise((resolve, reject) => {
    const findDirectories = () => {
      try {
        resolve(Promise.resolve(directoriesSync(root)))
      } catch (error) {
        reject(error)
      }
    }

    const delayToAllowVSCodeToRender = 1
    setTimeout(findDirectories, delayToAllowVSCodeToRender)
  })
}

export function buildQuickPickItem(
  option?: DirectoryOption,
  description?: string
): QuickPickItemWithOption | undefined {
  if (!option) {
    return
  }

  return {
    label: option.displayText,
    description: description,
    option,
  }
}

export function currentEditorPath(): string | undefined {
  const activeEditor = vscode.window.activeTextEditor
  if (!activeEditor) {
    return
  }

  return path.dirname(activeEditor.document.fileName)
}

export function expandBraces(absolutePath: string): string[] {
  const shouldExpandBraces = vscode.workspace
    .getConfiguration('advancedNewFile')
    .get('expandBraces')

  if (!shouldExpandBraces) {
    return [absolutePath]
  }

  return braces.expand(absolutePath)
}

export function createFileOrFolder(absolutePath: string) {
  let directoryToFile = path.dirname(absolutePath)

  if (!fs.existsSync(absolutePath)) {
    if (isFolderDescriptor(absolutePath)) {
      mkdirp.sync(absolutePath)
    } else {
      mkdirp.sync(directoryToFile)
      fs.appendFileSync(absolutePath, '')
    }
  }
}

export async function openFile(absolutePath: string): Promise<void> {
  if (isFolderDescriptor(absolutePath)) {
    const showInformationMessages = vscode.workspace
      .getConfiguration('advancedNewFile')
      .get('showInformationMessages', true)

    if (showInformationMessages) {
      vscode.window.showInformationMessage(`Folder created: ${absolutePath}`)
    }
  } else {
    const textDocument = await vscode.workspace.openTextDocument(absolutePath)

    if (textDocument) {
      const shouldExpandBraces = vscode.workspace
        .getConfiguration('advancedNewFile')
        .get('expandBraces')

      if (shouldExpandBraces) {
        vscode.window.showTextDocument(textDocument, { preview: false })
      } else {
        vscode.window.showTextDocument(textDocument, vscode.ViewColumn.Active)
      }
    }
  }
}

export function lastSelection(cache: Cache) {
  if (!cache.has('last')) {
    return
  }
  const value = cache.get('last')

  if (typeof value === 'object') {
    return value
  } else {
    cache.forget('last')
    return
  }
}

export function workspaceRoots(): WorkspaceRoot[] {
  if (vscode.workspace.workspaceFolders) {
    const multi = vscode.workspace.workspaceFolders.length > 1

    return vscode.workspace.workspaceFolders.map((folder) => {
      return {
        rootPath: folder.uri.fsPath,
        baseName: folder.name || path.basename(folder.uri.fsPath),
        multi,
      }
    })
  } else if (vscode.workspace.rootPath) {
    return [
      {
        rootPath: vscode.workspace.rootPath,
        baseName: path.basename(vscode.workspace.rootPath),
        multi: false,
      },
    ]
  } else {
    return []
  }
}

export function rootOptions(roots: WorkspaceRoot[]): DirectoryOption[] {
  return roots.map((root): DirectoryOption => {
    return {
      displayText: root.multi ? path.join(path.sep, root.baseName) : path.sep,
      fsLocation: {
        relative: path.sep,
        absolute: root.rootPath,
      },
    }
  })
}

export function currentEditorPathOption(
  roots: WorkspaceRoot[]
): DirectoryOption | undefined {
  const currentFilePath = currentEditorPath()
  const currentFileRoot =
    currentFilePath &&
    roots.find((r) => currentFilePath.indexOf(r.rootPath) === 0)

  if (!currentFileRoot) {
    return
  }

  const rootMatcher = new RegExp(`^${currentFileRoot.rootPath}`)
  let relativeCurrentFilePath = currentFilePath.replace(rootMatcher, '')

  relativeCurrentFilePath =
    relativeCurrentFilePath === '' ? path.sep : relativeCurrentFilePath

  const displayText = currentFileRoot.multi
    ? path.join(path.sep, currentFileRoot.baseName, relativeCurrentFilePath)
    : relativeCurrentFilePath

  return {
    displayText,
    fsLocation: {
      relative: relativeCurrentFilePath,
      absolute: currentFilePath,
    },
  }
}

export async function dirQuickPickItems(roots: WorkspaceRoot[], cache: Cache) {
  const dirOptions = await Promise.all(
    roots.map(async (r) => await subdirOptionsForRoot(r))
  )
  let quickPickItems = dirOptions
    .reduce(flatten)
    .map((o) => buildQuickPickItem(o))
    .filter((i) => !!i) as QuickPickItemWithOption[]

  quickPickItems.unshift(...convenienceOptions(roots, cache))

  return quickPickItems
}

export function cacheSelection(
  cache: Cache,
  dir: DirectoryOption,
  root: WorkspaceRoot
) {
  cache.put('last', dir)

  let recentRoots = cache.get('recentRoots') || []

  const rootIndex = recentRoots.indexOf(root.rootPath)
  if (rootIndex >= 0) {
    recentRoots.splice(rootIndex, 1)
  }

  recentRoots.unshift(root.rootPath)
  cache.put('recentRoots', recentRoots)
}

export function sortRoots(
  roots: WorkspaceRoot[],
  desiredOrder: string[]
): WorkspaceRoot[] {
  return sortBy(roots, (root) => {
    const desiredIndex = desiredOrder.indexOf(root.rootPath)
    return desiredIndex >= 0 ? desiredIndex : roots.length
  })
}

export function rootForDir(roots: WorkspaceRoot[], dir: DirectoryOption) {
  return roots.find((r) => startsWith(dir.fsLocation.absolute, r.rootPath))
}

export async function command(context: ExtensionContext) {
  const roots = workspaceRoots()
  if (roots.length > 0) {
    const cacheName = roots.map((r) => r.rootPath).join(';')
    const cache = new Cache(context, `workspace:${cacheName}`)
    const sortedRoots = sortRoots(roots, [])

    const dirSelection = await showQuickPick(
      dirQuickPickItems(sortedRoots, cache)
    )

    if (!dirSelection) {
      return
    }
    const dir = dirSelection.option
    if (dir) {
      const selectedRoot = rootForDir(roots, dir)
      if (selectedRoot) {
        cacheSelection(cache, dir, selectedRoot)
      }
      const newFileInput = await showInputBox(dir)
      if (!newFileInput) {
        return
      }
      const newFileArray = expandBraces(newFileInput)
      for (let newFile of newFileArray) {
        createFileOrFolder(newFile)
        await openFile(newFile)
      }
    }
  } else {
    await vscode.window.showErrorMessage(
      "It doesn't look like you have a folder opened in your workspace. " +
        'Try opening a folder first.'
    )
  }
}

export function deactivate() {}
