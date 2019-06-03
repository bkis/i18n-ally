import { workspace, window } from 'vscode'
import { promises as fs, existsSync } from 'fs'
import { uniq, isObject, set } from 'lodash'
import * as path from 'path'
// @ts-ignore
import * as flat from 'flat'
import { Global } from './Common'
import EventHandler from './EventHandler'
import { MachinTranslate } from './MachineTranslate'
import { getKeyname, getFileInfo, replaceLocalePath, notEmpty } from './utils'
import { LocaleTree, LocaleLoaderEventType, ParsedFile, FlattenLocaleTree, Coverage, LocaleNode, LocaleRecord, PendingWrite } from './types'
import { AllyError, ErrorType } from './Errors'

function newTree (keypath = ''): LocaleTree {
  return {
    keypath,
    keyname: getKeyname(keypath),
    children: {},
    type: 'tree',
  }
}

export class LocaleLoader extends EventHandler<LocaleLoaderEventType> {
  files: Record<string, ParsedFile> = {}
  flattenLocaleTree: FlattenLocaleTree = {}
  localeTree: LocaleTree = newTree()

  async init () {
    await this.loadAll()
    this.update()
  }

  get localesPaths () {
    return Global.localesPaths
  }

  get locales () {
    return uniq(Object.values(this.files).map(f => f.locale))
  }

  getCoverage (locale: string, keys?: string[]): Coverage {
    keys = keys || Object.keys(this.flattenLocaleTree)
    const total = keys.length
    const translated = keys.filter(key => {
      return this.flattenLocaleTree[key] && this.flattenLocaleTree[key].getValue(locale)
    })
    return {
      locale,
      total,
      translated: translated.length,
      keys,
    }
  }

  getNodeByKey (keypath: string): LocaleNode | undefined {
    return this.flattenLocaleTree[keypath]
  }

  getTranslationsByKey (keypath: string, shadow = true) {
    const node = this.getNodeByKey(keypath)
    if (!node)
      return {}
    if (shadow)
      return this.getShadowLocales(node)
    else
      return node.locales
  }

  getTreeNodeByKey (keypath: string, tree?: LocaleTree): LocaleNode | LocaleTree | undefined {
    tree = tree || this.localeTree
    const keys = keypath.split('.')
    const root = keys[0]
    const remaining = keys.slice(1).join('.')
    const node = tree.children[root]
    if (!remaining)
      return node
    if (node && node.type === 'tree')
      return this.getTreeNodeByKey(remaining, node)
    return undefined
  }

  getClosestNodeByKey (keypath: string, tree?: LocaleTree): LocaleNode | LocaleTree | undefined {
    tree = tree || this.localeTree
    const keys = keypath.split('.')
    const root = keys[0]
    const remaining = keys.slice(1).join('.')
    const node = tree.children[root]

    if (node) {
      // end of the search
      if (node.type === 'node' || !remaining)
        return node
      // go deeper
      if (node.type === 'tree')
        return this.getClosestNodeByKey(remaining, node)
    }
    // still at the root, nothing found
    if (tree === this.localeTree)
      return undefined
    // return last node
    return tree
  }

  getDisplayingTranslateByKey (key: string): LocaleRecord | undefined {
    const node = this.getNodeByKey(key)
    return node && node.locales[Global.displayLanguage]
  }

  getFilepathsOfLocale (locale: string) {
    return Object.values(this.files)
      .filter(f => f.locale === locale)
      .map(f => f.filepath)
  }

  async requestMissingFilepath (locale: string, keypath: string) {
    const paths = this.getFilepathsOfLocale(locale)
    if (paths.length === 1)
      return paths[0]
    if (paths.length === 0) {
      return await window.showInputBox({
        prompt: `Enter the file path to store key "${keypath}"`,
        placeHolder: `path/to/${locale}.json`,
      })
    }
    return await window.showQuickPick(paths, {
      placeHolder: `Select which file to store key "${keypath}"`,
      ignoreFocusOut: true,
    })
  }

  private async MachineTranslateRecord (record: LocaleRecord, sourceLanguage: string): Promise<PendingWrite|undefined> {
    if (record.locale === sourceLanguage)
      throw new AllyError(ErrorType.translating_same_locale)
    const sourceNode = this.getNodeByKey(record.keypath)
    if (!sourceNode)
      throw new AllyError(ErrorType.translating_empty_source_value)
    const sourceRecord = sourceNode.locales[sourceLanguage]
    if (!sourceRecord || !sourceRecord.value)
      throw new AllyError(ErrorType.translating_empty_source_value)
    try {
      const result = await MachinTranslate(sourceRecord.value, sourceLanguage, record.locale)

      return {
        locale: record.locale,
        value: result,
        filepath: record.filepath,
        keypath: record.keypath,
      }
    }
    catch (e) {
      throw new AllyError(ErrorType.translating_unknown_error, undefined, e)
    }
  }

  private async MachineTranslateNode (node: LocaleNode, sourceLanguage: string): Promise<PendingWrite[]> {
    const tasks = Object.values(this.getShadowLocales(node))
      .filter(record => record.locale !== sourceLanguage)
      .map(record => this.MachineTranslateRecord(record, sourceLanguage))

    const pendings = await Promise.all(tasks)

    return pendings.filter(notEmpty)
  }

  async MachineTranslate (node: LocaleNode| LocaleRecord, sourceLanguage?: string) {
    sourceLanguage = sourceLanguage || Global.sourceLanguage
    if (node.type === 'node')
      return await this.MachineTranslateNode(node, sourceLanguage)

    const pending = await this.MachineTranslateRecord(node, sourceLanguage)

    return [pending].filter(notEmpty)
  }

  getShadowFilePath (keypath: string, locale: string) {
    const node = this.getNodeByKey(keypath)
    if (node) {
      const sourceRecord = node.locales[Global.sourceLanguage] || Object.values(node.locales)[0]
      if (sourceRecord && sourceRecord.filepath)
        return replaceLocalePath(sourceRecord.filepath, locale)
    }
    return undefined
  }

  getShadowLocales (node: LocaleNode) {
    const locales: Record<string, LocaleRecord> = {}
    this.locales.forEach(locale => {
      if (node.locales[locale]) {
        // locales already exists
        locales[locale] = node.locales[locale]
      }
      else {
        // create shadow locale
        locales[locale] = {
          locale,
          value: '',
          shadow: true,
          keyname: node.keyname,
          keypath: node.keypath,
          filepath: this.getShadowFilePath(node.keypath, locale),
          type: 'record',
        }
      }
    })
    return locales
  }

  async writeToSingleFile (pending: PendingWrite) {
    let filepath = pending.filepath
    if (!filepath)
      filepath = await this.requestMissingFilepath(pending.locale, pending.keypath)

    if (!filepath)
      throw new AllyError(ErrorType.filepath_not_specified)

    let original: object = {}
    if (existsSync(filepath)) {
      const originalRaw = await fs.readFile(filepath, 'utf-8')
      original = JSON.parse(originalRaw)
    }
    set(original, pending.keypath, pending.value)
    const writting = `${JSON.stringify(original, null, 2)}\n`
    await fs.writeFile(filepath, writting, 'utf-8')
  }

  async writeToFile (pendings: PendingWrite|PendingWrite[]) {
    if (!Array.isArray(pendings))
      pendings = [pendings]
    pendings = pendings.filter(i => i)
    for (const pending of pendings)
      await this.writeToSingleFile(pending)
  }

  private async loadFile (filepath: string) {
    try {
      console.log('LOADING', filepath)
      const { locale, nested } = getFileInfo(filepath)
      const raw = await fs.readFile(filepath, 'utf-8')
      const value = JSON.parse(raw)
      this.files[filepath] = {
        filepath,
        locale,
        value,
        nested,
        flatten: flat(value),
      }
    }
    catch (e) {
      this.unsetFile(filepath)
      console.error(e)
    }
  }

  private unsetFile (filepath: string) {
    delete this.files[filepath]
  }

  private async loadDirectory (rootPath: string) {
    const paths = await fs.readdir(rootPath)
    for (const filename of paths) {
      // filename starts with underscore will be ignored
      if (filename.startsWith('_'))
        continue

      const filePath = path.resolve(rootPath, filename)
      const isDirectory = (await fs.lstat(filePath)).isDirectory()

      if (!isDirectory && path.extname(filePath) !== '.json')
        continue

      if (!isDirectory) {
        await this.loadFile(filePath)
      }
      else {
        for (const p of await fs.readdir(filePath))
          await this.loadFile(path.resolve(filePath, p))
      }
    }
  }

  private async watchOn (rootPath: string) {
    const watcher = workspace.createFileSystemWatcher(`${rootPath}/**`)

    const updateFile = async (type: string, { fsPath: filepath }: { fsPath: string }) => {
      filepath = path.resolve(filepath)
      const { ext } = path.parse(filepath)
      if (ext !== '.json') return

      switch (type) {
        case 'del':
          delete this.files[filepath]
          this.update()
          break

        case 'change':
        case 'create':
          await this.loadFile(filepath)
          this.update()
          break
      }
    }
    watcher.onDidChange(updateFile.bind(this, 'change'))
    watcher.onDidCreate(updateFile.bind(this, 'create'))
    watcher.onDidDelete(updateFile.bind(this, 'del'))
  }

  private updateFlattenLocalesTree () {
    const tree: FlattenLocaleTree = {}
    for (const file of Object.values(this.files)) {
      for (const keypath of Object.keys(file.flatten)) {
        if (!tree[keypath])
          tree[keypath] = new LocaleNode(keypath)

        tree[keypath].locales[file.locale] = {
          keypath,
          keyname: getKeyname(keypath),
          value: file.flatten[keypath],
          locale: file.locale,
          filepath: file.filepath,
          type: 'record',
        }
      }
    }
    this.flattenLocaleTree = tree
  }

  private updateLocalesTree () {
    const subTree = (object: object, keypath: string, file: ParsedFile, tree?: LocaleTree) => {
      tree = tree || newTree(keypath)
      for (const [key, value] of Object.entries(object)) {
        const newKeyPath = keypath ? `${keypath}.${key}` : key

        if (isObject(value)) {
          let originalTree: LocaleTree|undefined
          if (tree.children[key] && tree.children[key].type === 'tree')
            originalTree = tree.children[key] as LocaleTree

          tree.children[key] = subTree(value, newKeyPath, file, originalTree)
          continue
        }

        if (!tree.children[key])
          tree.children[key] = new LocaleNode(newKeyPath)
        const node = tree.children[key]
        if (node.type === 'node') {
          node.locales[file.locale] = {
            keypath: newKeyPath,
            keyname: key,
            value,
            locale: file.locale,
            filepath: file.filepath,
            type: 'record',
          }
        }
      }
      return tree
    }

    const tree = newTree()
    for (const file of Object.values(this.files))
      subTree(file.value, '', file, tree)
    this.localeTree = tree
  }

  private update () {
    this.updateLocalesTree()
    this.updateFlattenLocalesTree()
    this.dispatchEvent('changed')
  }

  private async loadAll () {
    const rootPath = Global.rootPath
    if (!rootPath)
      return
    for (const pathname of this.localesPaths) {
      const fullpath = path.resolve(rootPath, pathname)
      await this.loadDirectory(fullpath)
      this.watchOn(fullpath)
    }
  }
}