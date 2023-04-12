import type { ExtensionContext } from 'vscode'

function now() {
  return Math.floor(Date.now() / 1000)
}

// revamped from this respository https://github.com/Jakobud/vscode-cache

class Cache {
  context: ExtensionContext
  namespace: string
  cache: Record<string, any>

  constructor(context: ExtensionContext, namespace: string) {
    this.context = context
    this.namespace = namespace
    this.cache = this.context.globalState.get(this.namespace, {})
  }

  put(key: string, value: any, expiration?: number) {
    if (typeof key !== 'string' || typeof value === 'undefined') {
      return new Promise((resolve, reject) => {
        resolve(false)
      })
    }

    let obj: {
      value: any
      expiration?: number
    } = {
      value: value,
    }

    // Set expiration
    if (Number.isInteger(expiration) && expiration !== undefined) {
      obj.expiration = now() + expiration
    }

    // Save to local cache object
    this.cache[key] = obj

    // Save to extension's globalState
    return this.context.globalState.update(this.namespace, this.cache)
  }

  has(key: string) {
    if (typeof this.cache[key] === 'undefined') {
      return false
    } else {
      return this.isExpired(key) ? false : true
    }
  }

  get(key: string, defaultValue?: unknown) {
    // If doesn't exist
    if (typeof this.cache[key] === 'undefined') {
      // Return default value
      if (typeof defaultValue !== 'undefined') {
        return defaultValue
      } else {
        return undefined
      }
    } else {
      // Is item expired?
      if (this.isExpired(key)) {
        return undefined
      }
      // Otherwise return the value
      return this.cache[key].value
    }
  }

  forget(key: string) {
    if (typeof this.cache[key] === 'undefined') {
      return Promise.resolve(true)
    }

    delete this.cache[key]

    return this.context.globalState.update(this.namespace, this.cache)
  }

  keys() {
    return Object.keys(this.cache)
  }

  all() {
    let items: Record<string, any> = {}
    for (let key in this.cache) {
      items[key] = this.cache[key].value
    }
    return items
  }

  getAll() {
    return this.all()
  }

  flush() {
    this.cache = {}
    return this.context.globalState.update(this.namespace, undefined)
  }

  clearAll() {
    return this.flush()
  }

  getExpiration(key: string) {
    if (
      typeof this.cache[key] === 'undefined' ||
      typeof this.cache[key].expiration === 'undefined'
    ) {
      return undefined
    } else {
      return this.cache[key].expiration
    }
  }

  isExpired(key: string) {
    if (
      typeof this.cache[key] === 'undefined' ||
      typeof this.cache[key].expiration === 'undefined'
    ) {
      return false
    } else {
      return now() >= this.cache[key].expiration
    }
  }
}

export { Cache }
