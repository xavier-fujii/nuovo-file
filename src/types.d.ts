export interface FSLocation {
  relative: string
  absolute: string
}

export interface DirectoryOption {
  displayText: string
  fsLocation: FSLocation
}

export interface WorkspaceRoot {
  rootPath: string
  baseName: string
  multi: boolean
}

